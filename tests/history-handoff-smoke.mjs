import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ignore = Symbol.for('sillytavern.ignore');
const settings = {
    enabled: true,
    memoryModelSource: 'current',
    budgetL1: 2000,
    budgetL2: 5000,
    budgetL4: 1500,
    recentRawTokens: 16000,
    bodyExtractionRegex: '',
    chapterSize: 25,
    proofreadEvery: 75,
    l4Enabled: false,
};
const message = (id, isUser, mes, extra = {}) => ({
    is_user: isUser,
    mes,
    send_date: id,
    extra: { layered_memory_id: id, ...extra },
});
const storedChat = [
    message('u0', true, 'OLD_USER_TEXT'),
    message('a0', false, 'OLD_ASSISTANT_TEXT'),
    message('u1', true, 'CURRENT_USER_TEXT', { image: 'CURRENT_IMAGE' }),
];
const context = {
    chat: storedChat,
    mainApi: 'openai',
    symbols: { ignore },
    extensionSettings: { layered_memory: settings },
    chatMetadata: {},
    setExtensionPrompt: () => {},
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    name1: '用户',
    name2: '角色',
};
globalThis.SillyTavern = { getContext: () => context };

const { EMPTY_CHAT_DATA } = await import('../src/constants.js');
const { handOffManagedHistory, requestExcludesTrailingAssistant } = await import('../src/history-handoff.js');
const { buildCoreMemoryParts } = await import('../src/inject.js');
context.chatMetadata.layered_memory = EMPTY_CHAT_DATA();

function requestCopy(chat = storedChat) {
    return chat.map(item => ({ ...item, extra: { ...item.extra } }));
}

let request = requestCopy();
let handoff = handOffManagedHistory(request, 'normal');
assert.deepEqual(handoff, {
    status: 'handed_off',
    reason: 'managed_prefix',
    ignoredMessages: 2,
    keptMessages: 1,
    excludeTrailingAssistant: false,
});
assert.equal(request.length, storedChat.length, 'world-info depth must retain the original request length');
assert.deepEqual(request.map(item => item.mes), storedChat.map(item => item.mes),
    'ignored history must retain its text for world-info scanning');
assert.equal(request[0].extra[ignore], true);
assert.equal(request[1].extra[ignore], true);
assert.equal(request[2].extra[ignore], undefined, 'the current user message must remain native');
assert.equal(request[2].extra.image, 'CURRENT_IMAGE', 'the active message must retain multimodal metadata');
assert.equal(storedChat.some(item => item.extra[ignore]), false, 'stored chat extras must not be mutated');
assert.notEqual(request[0], storedChat[0]);
assert.notEqual(request[0].extra, storedChat[0].extra);
assert.deepEqual(request.filter(item => !item.extra[ignore]).map(item => item.mes), ['CURRENT_USER_TEXT'],
    'the provider-facing Chat History must retain only the active user request');

const continuedChat = [
    message('u0', true, 'OLD_USER_TEXT'),
    message('a0', false, 'OLD_ASSISTANT_TEXT'),
    message('u1', true, 'ACTIVE_USER_TEXT'),
    message('a1', false, 'ACTIVE_ASSISTANT_PREFIX', {
        tool_invocations: [{ id: 'tool-1', name: 'lookup', result: 'result' }],
    }),
];
context.chat = continuedChat;
request = requestCopy(continuedChat);
assert.equal(requestExcludesTrailingAssistant(request, 'continue'), true);
handoff = handOffManagedHistory(request, 'continue');
assert.equal(handoff.ignoredMessages, 2);
assert.deepEqual(request.filter(item => !item.extra[ignore]).map(item => item.extra.layered_memory_id), ['u1', 'a1'],
    'assistant-target generations must retain the active user/assistant pair');
assert.ok(Array.isArray(request[3].extra.tool_invocations), 'the active tool transaction must remain structured');
let parts = buildCoreMemoryParts({
    data: context.chatMetadata.layered_memory,
    settings,
    context,
    generationType: 'continue',
});
assert.match(parts.raw, /OLD_USER_TEXT[\s\S]*OLD_ASSISTANT_TEXT/u);
assert.doesNotMatch(parts.raw, /ACTIVE_USER_TEXT|ACTIVE_ASSISTANT_PREFIX/u,
    'plugin raw memory must use the same active-tail boundary as native history');

const pendingSwipe = message('a1', false, 'OLD_SWIPE_CANDIDATE', { swipes: ['OLD_SWIPE_CANDIDATE'], swipe_id: 1 });
context.chat = [
    message('u0', true, 'PREFIX_USER'),
    message('a0', false, 'PREFIX_ASSISTANT'),
    message('u1', true, 'SWIPE_USER_REQUEST'),
    pendingSwipe,
];
request = requestCopy(context.chat.slice(0, -1));
assert.equal(requestExcludesTrailingAssistant(request, 'swipe'), true);
handoff = handOffManagedHistory(request, 'swipe');
assert.deepEqual(request.filter(item => !item.extra[ignore]).map(item => item.extra.layered_memory_id), ['u1']);
assert.equal(request.some(item => item.mes === 'OLD_SWIPE_CANDIDATE'), false,
    'SillyTavern request projection and plugin handoff must both exclude the old swipe');

context.chat = storedChat;
request = requestCopy();
delete request[0].extra.layered_memory_id;
handoff = handOffManagedHistory(request, 'normal');
assert.equal(handoff.reason, 'message_mapping');
assert.equal(request.some(item => item.extra[ignore]), false, 'mapping uncertainty must fail closed');

request = requestCopy();
context.mainApi = 'textgenerationwebui';
handoff = handOffManagedHistory(request, 'normal');
assert.equal(handoff.reason, 'unsupported_backend');
assert.equal(request.some(item => item.extra[ignore]), false);
context.mainApi = 'openai';

const [manifestText, indexSource, handoffSource, constantsSource, settingsSource, panelSource] = await Promise.all([
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/history-handoff.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/constants.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
]);
const manifest = JSON.parse(manifestText);
assert.equal(manifest.generate_interceptor, 'layeredMemoryIntercept');
assert.match(indexSource, /globalThis\.layeredMemoryIntercept[\s\S]*handOffManagedHistory/u);
assert.doesNotMatch(handoffSource, /chat\.splice|\.mes\s*=/u,
    'handoff must preserve request length and text for downstream SillyTavern services');
for (const [name, source] of Object.entries({
    'src/constants.js': constantsSource,
    'src/settings.js': settingsSource,
    'src/ui/panel.js': panelSource,
})) {
    assert.doesNotMatch(source, /historyBudgetMode|historyTokenBudget|minRecentPairs|recentPairs|context_handoff/u,
        `${name} must not restore the removed context-percentage mechanism`);
}

console.log('history handoff smoke: prefix ignore, active tail, swipe, tools, and fail-closed paths passed');
