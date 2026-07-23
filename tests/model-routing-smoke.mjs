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
    if (String(url).endsWith('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'model-b' }, { id: 'model-a' }] }) };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'DIRECT' } }] }) };
};

const { callAuxModel, listDirectModels } = await import('../src/aux-model.js');

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
assert.equal(generateRawCalls, 1, 'a selected direct API must not silently use the current chat model');

const models = await listDirectModels({ baseUrl: settings.directBaseUrl, apiKey: settings.directApiKey });
assert.deepEqual(models, ['model-a', 'model-b']);
assert.equal(fetchRequest.url, 'https://models.example/v1/models');

console.log('model routing smoke: 16/16 passed');
