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
export async function testAuxModelConnection({ timeoutMs = CONNECTION_TEST_TIMEOUT_MS } = {}) {
    const startedAt = Date.now();
    const settings = getSettings();
    const ctx = getContext();
    const boundedTimeoutMs = normalizeTimeout(timeoutMs);
    const preferredRoute = settings.connectionProfile ? 'connection_profile' : 'current_connection';
    let lastFailure = null;

    if (typeof ctx.generateRaw === 'function') {
        try {
            const args = {
                systemPrompt: CONNECTION_TEST_SYSTEM_PROMPT,
                prompt: CONNECTION_TEST_USER_PROMPT,
                temperature: 0,
            };
            if (settings.connectionProfile) {
                args.connectionProfile = settings.connectionProfile;
            }
            const result = await withTimeout(ctx.generateRaw(args), boundedTimeoutMs);
            if (hasUsableTestResponse(result)) {
                return connectionTestResult(true, preferredRoute, startedAt, 'success', '连接成功');
            }
            lastFailure = { route: preferredRoute, error: createConnectionTestError('empty_response') };
        } catch (error) {
            lastFailure = { route: preferredRoute, error };
        }
    }

    if (settings.connectionProfile) {
        const cms = getConnectionManagerService(ctx);
        if (cms && typeof cms.sendRequest === 'function') {
            try {
                const messages = [
                    { role: 'system', content: CONNECTION_TEST_SYSTEM_PROMPT },
                    { role: 'user', content: CONNECTION_TEST_USER_PROMPT },
                ];
                const result = await withTimeout(
                    cms.sendRequest(settings.connectionProfile, messages, null),
                    boundedTimeoutMs,
                );
                if (hasUsableTestResponse(extractTextFromCms(result))) {
                    return connectionTestResult(true, 'connection_profile', startedAt, 'success', '连接成功');
                }
                lastFailure = {
                    route: 'connection_profile',
                    error: createConnectionTestError('empty_response'),
                };
            } catch (error) {
                lastFailure = { route: 'connection_profile', error };
            }
        }
    }

    if (settings.fallbackEnabled && settings.fallbackBaseUrl && settings.fallbackApiKey) {
        try {
            const text = await fallbackTestFetch({
                baseUrl: settings.fallbackBaseUrl,
                apiKey: settings.fallbackApiKey,
                model: settings.fallbackModel || 'gpt-4o-mini',
                timeoutMs: boundedTimeoutMs,
            });
            if (hasUsableTestResponse(text)) {
                return connectionTestResult(true, 'fallback', startedAt, 'success', '连接成功');
            }
            lastFailure = { route: 'fallback', error: createConnectionTestError('empty_response') };
        } catch (error) {
            lastFailure = { route: 'fallback', error };
        }
    }

    if (!lastFailure) {
        return connectionTestResult(
            false,
            'unavailable',
            startedAt,
            'unavailable',
            '没有找到可用的记忆模型。请选择酒馆中的模型连接，或在高级设置中填写备用模型。',
        );
    }

    const failure = classifyConnectionTestError(lastFailure.error);
    return connectionTestResult(
        false,
        lastFailure.route,
        startedAt,
        failure.category,
        failure.message,
    );
}

/**
 * Call auxiliary model with clean context.
 * Priority: generateRaw (+ optional connectionProfile) → fallback fetch.
 */
export async function callAuxModel({ purpose, systemPrompt, userPrompt, jsonSchema = null, temperature = 0 }) {
    const settings = getSettings();
    const ctx = getContext();

    // Prefer ST generateRaw (uses Connection Manager when connectionProfile supported)
    if (typeof ctx.generateRaw === 'function') {
        try {
            const args = {
                systemPrompt,
                prompt: userPrompt,
                temperature,
            };
            if (jsonSchema) {
                args.jsonSchema = jsonSchema;
            }
            if (settings.connectionProfile) {
                args.connectionProfile = settings.connectionProfile;
            }
            const result = await ctx.generateRaw(args);
            if (result != null && String(result).trim() !== '' && String(result).trim() !== '{}') {
                return { text: String(result), via: 'generateRaw' };
            }
        } catch (err) {
            appendLog('warn', `generateRaw 失败 (${purpose}): ${safeAuxError(err)}`);
        }
    }

    // ConnectionManagerRequestService if exposed
    try {
        const cms = ctx.ConnectionManagerRequestService
            || globalThis.ConnectionManagerRequestService
            || SillyTavern?.libs?.ConnectionManagerRequestService;
        if (cms && settings.connectionProfile && typeof cms.sendRequest === 'function') {
            const messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ];
            const result = await cms.sendRequest(settings.connectionProfile, messages, null);
            const text = extractTextFromCms(result);
            if (text) {
                return { text, via: 'ConnectionManager' };
            }
        }
    } catch (err) {
        appendLog('warn', `ConnectionManager 失败 (${purpose}): ${safeAuxError(err)}`);
    }

    if (settings.fallbackEnabled && settings.fallbackBaseUrl && settings.fallbackApiKey) {
        const text = await fallbackFetch({
            baseUrl: settings.fallbackBaseUrl,
            apiKey: settings.fallbackApiKey,
            model: settings.fallbackModel || 'gpt-4o-mini',
            systemPrompt,
            userPrompt,
            temperature,
            jsonSchema,
        });
        return { text, via: 'fallback_fetch' };
    }

    throw new Error('记忆模型暂时不可用。请在插件设置中选择模型连接，或配置备用模型。');
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

async function fallbackFetch({ baseUrl, apiKey, model, systemPrompt, userPrompt, temperature, jsonSchema }) {
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
        body.response_format = {
            type: 'json_schema',
            json_schema: jsonSchema,
        };
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
        throw new Error(`fallback HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
}

async function fallbackTestFetch({ baseUrl, apiKey, model, timeoutMs }) {
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

function connectionTestResult(ok, route, startedAt, category, message) {
    return {
        ok,
        route,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        category,
        message,
    };
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
