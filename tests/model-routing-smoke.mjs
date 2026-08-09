import assert from 'node:assert/strict';

const settings = {
    memoryModelSource: 'profile',
    connectionProfile: 'profile-1',
    profileModelOverride: 'chosen-model',
    directBaseUrl: 'https://models.example/v1',
    directApiKey: 'secret-for-test',
    directModel: 'direct-model',
};
let generateRawCalls = 0;
let profileArgs = null;
let fetchRequest = null;
let fetchStatus = 200;

const context = {
    extensionSettings: { layered_memory: settings },
    chatMetadata: {},
    saveSettingsDebounced() {},
    generateRaw: async () => {
        generateRawCalls += 1;
        return 'CURRENT';
    },
    ConnectionManagerRequestService: {
        sendRequest: async (...args) => {
            profileArgs = args;
            return { content: 'PROFILE' };
        },
    },
};
globalThis.SillyTavern = { getContext: () => context };
globalThis.fetch = async (url, init = {}) => {
    fetchRequest = { url, init };
    if (fetchStatus !== 200) {
        return { ok: false, status: fetchStatus, text: async () => 'provider failure' };
    }
    if (String(url).endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'model-b' }, { id: 'model-a' }] }) };
    }
    return {
        ok: true,
        json: async () => ({
            choices: [{ message: { content: 'DIRECT' } }],
            usage: {
                prompt_tokens: 3_000,
                completion_tokens: 500,
                total_tokens: 3_500,
                prompt_cache_hit_tokens: 1_000,
                prompt_cache_miss_tokens: 2_000,
                completion_tokens_details: { reasoning_tokens: 300 },
            },
        }),
    };
};

const { callAuxModel, listDirectModels, testAuxModelConnection } = await import('../src/aux-model.js');

const prompt = { purpose: 'test', systemPrompt: 'system', userPrompt: 'user' };
const profileResult = await callAuxModel(prompt);
assert.equal(profileResult.text, 'PROFILE');
assert.equal(generateRawCalls, 0, 'a selected profile must not silently use the current chat model');
assert.equal(profileArgs[0], 'profile-1');
assert.equal(profileArgs[3].includePreset, false);
assert.equal(profileArgs[3].includeInstruct, false);
assert.equal(profileArgs[4].model, 'chosen-model', 'profile model override must reach Connection Manager');

settings.memoryModelSource = 'current';
const currentResult = await callAuxModel(prompt);
assert.equal(currentResult.text, 'CURRENT');
assert.equal(generateRawCalls, 1);

settings.memoryModelSource = 'direct';
const directResult = await callAuxModel(prompt);
assert.equal(directResult.text, 'DIRECT');
assert.equal(fetchRequest.url, 'https://models.example/v1/chat/completions');
assert.equal(JSON.parse(fetchRequest.init.body).model, 'direct-model');
assert.equal(Object.hasOwn(JSON.parse(fetchRequest.init.body), 'thinking'), false,
    'generic OpenAI-compatible providers must not receive DeepSeek-only options');
assert.equal(generateRawCalls, 1, 'a selected direct API must not silently use the current chat model');

const schemaPrompt = {
    ...prompt,
    jsonSchema: {
        name: 'MemoryTest',
        description: 'test schema',
        strict: false,
        value: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
};
await callAuxModel(schemaPrompt);
const genericBody = JSON.parse(fetchRequest.init.body);
assert.equal(genericBody.response_format.type, 'json_schema');
assert.deepEqual(genericBody.response_format.json_schema.schema, schemaPrompt.jsonSchema.value);
assert.equal(Object.hasOwn(genericBody.response_format.json_schema, 'value'), false);

settings.directBaseUrl = 'https://api.deepseek.com';
settings.directModel = 'deepseek-v4-flash';
const deepSeekResult = await callAuxModel(schemaPrompt);
const deepSeekBody = JSON.parse(fetchRequest.init.body);
assert.deepEqual(deepSeekBody.response_format, { type: 'json_object' });
assert.deepEqual(deepSeekBody.thinking, { type: 'disabled' },
    'official DeepSeek memory calls must explicitly disable V4 default thinking');
assert.equal(deepSeekResult.usage.reasoningTokens, 300);
assert.equal(deepSeekResult.usage.estimatedCostCny, 0.00302);
assert.equal(deepSeekResult.usage.pricingVersion, 'deepseek-2026-08-09');
assert.equal(settings.usageHistory.at(-1).totalTokens, 3_500,
    'successful direct calls must persist provider-reported token usage');

const models = await listDirectModels({ baseUrl: settings.directBaseUrl, apiKey: settings.directApiKey });
assert.deepEqual(models, ['model-a', 'model-b']);
assert.equal(fetchRequest.url, 'https://api.deepseek.com/models');

const savedSnapshot = structuredClone(settings);
const temporarySettings = {
    ...savedSnapshot,
    memoryModelSource: 'direct',
    directBaseUrl: 'https://temporary.example/v1',
    directApiKey: 'temporary-key',
    directModel: 'temporary-model',
};
const temporaryTest = await testAuxModelConnection({ settings: temporarySettings, timeoutMs: 1000 });
assert.equal(temporaryTest.ok, true, 'temporary form settings should be testable');
assert.equal(fetchRequest.url, 'https://temporary.example/v1/chat/completions');
assert.equal(Object.hasOwn(JSON.parse(fetchRequest.init.body), 'thinking'), false);
assert.deepEqual(settings, savedSnapshot, 'testing temporary settings must not modify saved settings');

const officialTestSettings = {
    ...savedSnapshot,
    memoryModelSource: 'direct',
    directBaseUrl: 'https://api.deepseek.com',
    directApiKey: 'temporary-key',
    directModel: 'deepseek-v4-flash',
};
const officialTest = await testAuxModelConnection({ settings: officialTestSettings, timeoutMs: 1000 });
assert.equal(officialTest.ok, true);
assert.deepEqual(JSON.parse(fetchRequest.init.body).thinking, { type: 'disabled' },
    'official DeepSeek connection tests must also disable thinking');

fetchStatus = 402;
const balanceTest = await testAuxModelConnection({ settings: officialTestSettings, timeoutMs: 1000 });
assert.equal(balanceTest.ok, false);
assert.equal(balanceTest.category, 'balance');
assert.match(balanceTest.message, /余额不足/u);

console.log('model routing smoke: temporary settings are isolated from saved settings');
