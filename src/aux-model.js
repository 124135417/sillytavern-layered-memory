import { getContext, getSettings, appendLog } from './settings.js';

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
            appendLog('warn', `generateRaw 失败 (${purpose}): ${err?.message ?? err}`);
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
        appendLog('warn', `ConnectionManager 失败 (${purpose}): ${err?.message ?? err}`);
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

    throw new Error('副模型不可用：请配置 Connection Profile，或启用 fallback API');
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
