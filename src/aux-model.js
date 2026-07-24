import { getContext, getSettings, appendLog } from './settings.js';

const CONNECTION_TEST_TIMEOUT_MS = 15_000;
const CONNECTION_TEST_SYSTEM_PROMPT = 'You are a connection health check. Follow the user instruction exactly.';
const CONNECTION_TEST_USER_PROMPT = 'Reply with exactly OK.';

/**
 * Test the effective auxiliary-model route without exposing provider details.
 *
 * The returned object is safe to render or log in the UI:
 * { ok, route, elapsedMs, category, message }
 *
 * route: connection_profile | current_connection | fallback | unavailable
 * category: success | unavailable | auth | rate_limit | timeout | network |
 *           not_found | bad_request | server_error | empty_response | request_failed
 */
export async function testAuxModelConnection({ timeoutMs = CONNECTION_TEST_TIMEOUT_MS, settings: settingsOverride = null } = {}) {
    const startedAt = Date.now();
    const settings = settingsOverride || getSettings();
    const ctx = getContext();
    const boundedTimeoutMs = normalizeTimeout(timeoutMs);
    const source = normalizeModelSource(settings.memoryModelSource);
    const route = source === 'direct' ? 'direct_api'
        : source === 'profile' ? 'connection_profile'
            : 'current_connection';
    try {
        let result;
        if (source === 'direct') {
            assertDirectSettings(settings);
            result = await directTestFetch({
                baseUrl: settings.directBaseUrl,
                apiKey: settings.directApiKey,
                model: settings.directModel,
                timeoutMs: boundedTimeoutMs,
            });
        } else if (source === 'profile') {
            result = await withTimeout(callConnectionProfile({
                ctx,
                profileId: settings.connectionProfile,
                modelOverride: settings.profileModelOverride,
                systemPrompt: CONNECTION_TEST_SYSTEM_PROMPT,
                userPrompt: CONNECTION_TEST_USER_PROMPT,
                temperature: 0,
            }), boundedTimeoutMs);
        } else {
            if (typeof ctx.generateRaw !== 'function') {
                throw createConnectionTestError('unavailable');
            }
            result = await withTimeout(ctx.generateRaw({
                systemPrompt: CONNECTION_TEST_SYSTEM_PROMPT,
                prompt: CONNECTION_TEST_USER_PROMPT,
                temperature: 0,
            }), boundedTimeoutMs);
        }
        if (!hasUsableTestResponse(result)) {
            throw createConnectionTestError('empty_response');
        }
        return connectionTestResult(true, route, startedAt, 'success', '连接成功', selectedModelLabel(settings));
    } catch (error) {
        const failure = classifyConnectionTestError(error);
        return connectionTestResult(false, route, startedAt, failure.category, failure.message, selectedModelLabel(settings));
    }
}

/**
 * Call auxiliary model with clean context.
 * The selected source is exclusive. A failure never silently switches models.
 */
export async function callAuxModel({ purpose, systemPrompt, userPrompt, jsonSchema = null, temperature = 0 }) {
    const settings = getSettings();
    const ctx = getContext();
    const source = normalizeModelSource(settings.memoryModelSource);
    try {
        if (source === 'direct') {
            assertDirectSettings(settings);
            const text = await directFetch({
                baseUrl: settings.directBaseUrl,
                apiKey: settings.directApiKey,
                model: settings.directModel,
                systemPrompt,
                userPrompt,
                temperature,
                jsonSchema,
            });
            if (!hasUsableTestResponse(text)) throw createConnectionTestError('empty_response');
            return { text, via: 'direct_api', model: settings.directModel };
        }
        if (source === 'profile') {
            const text = await callConnectionProfile({
                ctx,
                profileId: settings.connectionProfile,
                modelOverride: settings.profileModelOverride,
                systemPrompt,
                userPrompt,
                temperature,
                jsonSchema,
            });
            if (!hasUsableTestResponse(text)) throw createConnectionTestError('empty_response');
            return { text, via: 'connection_profile', model: settings.profileModelOverride || '' };
        }
        if (typeof ctx.generateRaw !== 'function') throw createConnectionTestError('unavailable');
        const result = await ctx.generateRaw({ systemPrompt, prompt: userPrompt, temperature, ...(jsonSchema ? { jsonSchema } : {}) });
        if (!hasUsableTestResponse(result) || String(result).trim() === '{}') throw createConnectionTestError('empty_response');
        return { text: String(result), via: 'current_connection' };
    } catch (err) {
        appendLog('warn', `记忆模型失败 (${purpose}, ${source}): ${safeAuxError(err)}`);
        throw err;
    }
}

async function callConnectionProfile({ ctx, profileId, modelOverride, systemPrompt, userPrompt, temperature, jsonSchema = null }) {
    if (!profileId) throw createConnectionTestError('profile_missing');
    const cms = getConnectionManagerService(ctx);
    if (!cms || typeof cms.sendRequest !== 'function') throw createConnectionTestError('unavailable');
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ];
    const custom = {
        stream: false,
        extractData: true,
        includePreset: false,
        includeInstruct: false,
        temperature,
    };
    if (jsonSchema) custom.response_format = { type: 'json_schema', json_schema: jsonSchema };
    const overridePayload = modelOverride ? { model: modelOverride } : {};
    const result = await cms.sendRequest(profileId, messages, null, custom, overridePayload);
    return extractTextFromCms(result);
}

function extractTextFromCms(result) {
    if (!result) {
        return '';
    }
    if (typeof result === 'string') {
        return result;
    }
    if (result.content) {
        return String(result.content);
    }
    if (result.choices?.[0]?.message?.content) {
        return String(result.choices[0].message.content);
    }
    if (result.text) {
        return String(result.text);
    }
    return '';
}

function safeAuxError(error) {
    return String(error?.message ?? error ?? '未知错误')
        .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
        .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, 'sk-[已隐藏]')
        .slice(0, 300);
}

async function directFetch({ baseUrl, apiKey, model, systemPrompt, userPrompt, temperature, jsonSchema }) {
    const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
    const body = {
        model,
        temperature,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    };
    if (jsonSchema) {
        body.response_format = directResponseFormat(baseUrl, jsonSchema);
    }
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const t = await res.text();
        const error = new Error(`模型服务 HTTP ${res.status}: ${t.slice(0, 200)}`);
        error.status = res.status;
        throw error;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
}

function directResponseFormat(baseUrl, jsonSchema) {
    if (isOfficialDeepSeekUrl(baseUrl)) {
        // DeepSeek's public API documents JSON Object mode, not OpenAI's
        // Structured Outputs envelope. The prompts already require JSON only.
        return { type: 'json_object' };
    }
    return {
        type: 'json_schema',
        json_schema: normalizeOpenAiJsonSchema(jsonSchema),
    };
}

function isOfficialDeepSeekUrl(baseUrl) {
    try {
        return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com';
    } catch {
        return false;
    }
}

function normalizeOpenAiJsonSchema(jsonSchema) {
    const schema = jsonSchema?.schema || jsonSchema?.value || jsonSchema;
    return {
        name: String(jsonSchema?.name || 'memory_output'),
        ...(jsonSchema?.description ? { description: String(jsonSchema.description) } : {}),
        strict: Boolean(jsonSchema?.strict),
        schema,
    };
}

async function directTestFetch({ baseUrl, apiKey, model, timeoutMs }) {
    const url = baseUrl.replace(/\/$/, '') + '/chat/completions';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                temperature: 0,
                messages: [
                    { role: 'system', content: CONNECTION_TEST_SYSTEM_PROMPT },
                    { role: 'user', content: CONNECTION_TEST_USER_PROMPT },
                ],
            }),
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!res.ok) {
            const error = createConnectionTestError('http_error');
            error.status = res.status;
            throw error;
        }
        const data = await res.json();
        return data?.choices?.[0]?.message?.content ?? '';
    } finally {
        if (timeoutId != null) {
            clearTimeout(timeoutId);
        }
    }
}

function getConnectionManagerService(ctx) {
    return ctx.ConnectionManagerRequestService
        || globalThis.ConnectionManagerRequestService
        || globalThis.SillyTavern?.libs?.ConnectionManagerRequestService
        || null;
}

function hasUsableTestResponse(value) {
    return value != null && String(value).trim() !== '';
}

function normalizeTimeout(timeoutMs) {
    const parsed = Number(timeoutMs);
    if (!Number.isFinite(parsed)) {
        return CONNECTION_TEST_TIMEOUT_MS;
    }
    return Math.min(Math.max(Math.round(parsed), 1_000), 60_000);
}

function withTimeout(promise, timeoutMs) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
            () => reject(createConnectionTestError('timeout')),
            timeoutMs,
        );
    });
    return Promise.race([Promise.resolve(promise), timeout])
        .finally(() => clearTimeout(timeoutId));
}

function createConnectionTestError(code) {
    const error = new Error(code);
    error.connectionTestCode = code;
    return error;
}

function classifyConnectionTestError(error) {
    const status = Number(error?.status);
    const code = String(error?.connectionTestCode || error?.code || '').toLowerCase();
    const name = String(error?.name || '').toLowerCase();
    // This text is only inspected for classification and is never returned.
    const diagnostic = String(error?.message || '').toLowerCase();

    if (code === 'profile_missing') {
        return { category: 'unavailable', message: '还没有选择酒馆中已保存的连接。' };
    }
    if (code === 'direct_incomplete') {
        return { category: 'unavailable', message: '请把模型服务地址、访问密钥和模型名称填写完整。' };
    }
    if (code === 'unavailable') {
        return { category: 'unavailable', message: '当前酒馆版本没有提供这条模型连接能力。' };
    }
    if (code === 'empty_response') {
        return { category: 'empty_response', message: '模型已经连接，但没有返回内容。请检查模型名称后再试一次。' };
    }
    if (code === 'timeout' || name === 'aborterror' || /timeout|timed out/.test(diagnostic)) {
        return { category: 'timeout', message: '模型等待太久仍未回复。请检查网络和服务状态，然后再试一次。' };
    }
    if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api.?key|authentication/.test(diagnostic)) {
        return { category: 'auth', message: '服务商拒绝了连接。请检查访问密钥和账户权限。' };
    }
    if (status === 429 || /rate.?limit|too many requests/.test(diagnostic)) {
        return { category: 'rate_limit', message: '请求过于频繁，或者账户额度不足。请稍后再试。' };
    }
    if (status === 404) {
        return { category: 'not_found', message: '找不到这个模型或服务地址。请检查模型名称和模型服务地址。' };
    }
    if (status === 400 || status === 422) {
        return { category: 'bad_request', message: '模型服务无法处理这次检查。请确认模型名称正确，并且服务支持常见的 OpenAI 请求格式。' };
    }
    if (status >= 500 && status < 600) {
        return { category: 'server_error', message: '模型服务暂时出了问题。请稍后再试。' };
    }
    if (
        name === 'typeerror'
        || /failed to fetch|network|cors|connection refused|econnrefused|enotfound/.test(diagnostic)
    ) {
        return { category: 'network', message: '浏览器无法连接模型服务。请检查网络和服务地址；如果仍然失败，服务商可能不允许浏览器直接连接。' };
    }
    return { category: 'request_failed', message: '这次没有连接成功。请检查模型连接设置后再试一次。' };
}

function connectionTestResult(ok, route, startedAt, category, message, model = '') {
    return {
        ok,
        route,
        model,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        category,
        message,
    };
}

function normalizeModelSource(value) {
    return ['direct', 'profile', 'current'].includes(value) ? value : 'current';
}

function assertDirectSettings(settings) {
    if (!settings.directBaseUrl || !settings.directApiKey || !settings.directModel) {
        throw createConnectionTestError('direct_incomplete');
    }
}

function selectedModelLabel(settings) {
    const source = normalizeModelSource(settings.memoryModelSource);
    if (source === 'direct') return settings.directModel || '尚未填写模型';
    if (source === 'profile') return settings.profileModelOverride || profileModelForId(settings.connectionProfile) || '由连接配置决定';
    return '当前聊天模型';
}

function profileModelForId(profileId) {
    const profile = listConnectionProfiles().find(item => String(item?.id ?? item?.name ?? item) === String(profileId || ''));
    return String(profile?.model || profile?.modelId || profile?.model_id || '');
}

export function parseJsonFromModel(text) {
    if (!text) {
        return null;
    }
    let s = String(text).trim();
    // strip fences
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
        s = fence[1].trim();
    }
    try {
        return JSON.parse(s);
    } catch {
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(s.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

/**
 * List connection profiles if ST exposes them.
 */
export function listConnectionProfiles() {
    const ctx = getContext();
    try {
        if (typeof ctx.getConnectionProfiles === 'function') {
            return ctx.getConnectionProfiles() || [];
        }
        const ext = ctx.extensionSettings?.connectionManager;
        if (ext?.profiles) {
            return ext.profiles;
        }
    } catch {
        // ignore
    }
    return [];
}

/** List models from an OpenAI-compatible direct API without persisting secrets. */
export async function listDirectModels({ baseUrl, apiKey, timeoutMs = CONNECTION_TEST_TIMEOUT_MS }) {
    if (!baseUrl || !apiKey) throw createConnectionTestError('direct_incomplete');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), normalizeTimeout(timeoutMs)) : null;
    try {
        const res = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
            ...(controller ? { signal: controller.signal } : {}),
        });
        if (!res.ok) {
            const error = new Error(`模型列表 HTTP ${res.status}`);
            error.status = res.status;
            throw error;
        }
        const data = await res.json();
        return [...new Set((data?.data || []).map(item => String(item?.id || '').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b));
    } finally {
        if (timeoutId != null) clearTimeout(timeoutId);
    }
}
