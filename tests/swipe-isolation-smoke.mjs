import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const oldSwipeText = 'OLD_SWIPE_MUST_NOT_CROSS';
const newSwipeText = 'NEW_SWIPE_ISOLATED';
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
const chat = [
    { is_user: true, mes: 'PREFIX_USER', send_date: 'u0', extra: { layered_memory_id: 'u0' } },
    { is_user: false, mes: 'PREFIX_ASSISTANT', send_date: 'a0', extra: { layered_memory_id: 'a0' } },
    { is_user: true, mes: 'CURRENT_USER_REQUEST', send_date: 'u1', extra: { layered_memory_id: 'u1' } },
    {
        is_user: false,
        mes: oldSwipeText,
        swipes: [oldSwipeText],
        swipe_id: 0,
        send_date: 'a1',
        extra: { layered_memory_id: 'a1' },
    },
];
let registeredMacro = null;
const extensionPromptCalls = [];
const context = {
    chat,
    extensionSettings: { layered_memory: settings },
    chatMetadata: {},
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    setExtensionPrompt: (...args) => extensionPromptCalls.push(args),
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, NONE: -1 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    registerMacro: (_name, callback) => { registeredMacro = callback; },
    chatCompletionSettings: {
        prompts: [{ identifier: 'recap', name: '前文回顾', role: 'assistant', content: '{{layered_memory_context}}' }],
        prompt_order: [{ identifier: 'recap', enabled: true }],
    },
    name1: '用户',
    name2: '角色',
    characters: [{ name: '角色' }],
    characterId: 0,
};
globalThis.SillyTavern = { getContext: () => context };

const { EMPTY_CHAT_DATA } = await import('../src/constants.js');
const { reconcileCurrentHistory } = await import('../src/branch.js');
const {
    getMessageFloors,
    getPairs,
    isPendingSwipeMessage,
} = await import('../src/ids.js');
const {
    buildCoreMemoryParts,
    clearActiveGenerationType,
    registerPresetMemoryMacro,
    setActiveGenerationType,
} = await import('../src/inject.js');
const { assertChatData } = await import('../src/settings.js');

const initialPairs = getPairs();
const prefixPair = initialPairs[0];
const oldSwipePair = initialPairs[1];
const data = EMPTY_CHAT_DATA();
data.progress.baseline_pair = -1;
data.state_table = {
    version: 2,
    entries: [
        { id: 'e_0001', slot: 'identity', topic: '共同身份', subject: '共同前缀', value: '应当保留', evidence: 'PREFIX_ASSISTANT', source: 'auto' },
        { id: 'e_0002', slot: 'other', topic: '旧候选事实', subject: '旧候选', value: oldSwipeText, evidence: oldSwipeText, source: 'auto' },
    ],
    changelog: [],
};
data.turn_summaries = [
    { floorKey: prefixPair.floorKey, pairIndex: 0, contentFingerprint: prefixPair.contentFingerprint, summary: '共同前缀' },
    { floorKey: oldSwipePair.floorKey, pairIndex: 1, contentFingerprint: oldSwipePair.contentFingerprint, summary: oldSwipeText },
];
data.floor_events = [{
    floorKey: oldSwipePair.floorKey,
    pairIndex: 1,
    contentFingerprint: oldSwipePair.contentFingerprint,
    recordedAt: 200,
    turnSummary: oldSwipeText,
    entryChanges: [{
        op: 'upsert',
        after: { id: 'e_0002', slot: 'other', topic: '旧候选事实', subject: '旧候选', value: oldSwipeText, evidence: oldSwipeText, source: 'auto' },
    }],
}];
data.extracted_keys = [prefixPair.floorKey, oldSwipePair.floorKey];
data.branch_checkpoints = [{
    id: 'cp-prefix',
    anchorFloorKey: prefixPair.floorKey,
    anchorPairIndex: 0,
    anchorFingerprint: prefixPair.contentFingerprint,
    prefixFingerprints: [{
        pairIndex: 0,
        floorKey: prefixPair.floorKey,
        contentFingerprint: prefixPair.contentFingerprint,
    }],
    stateTable: {
        version: 1,
        entries: [{ id: 'e_0001', slot: 'identity', topic: '共同身份', subject: '共同前缀', value: '应当保留', evidence: 'PREFIX_ASSISTANT', source: 'auto' }],
        changelog: [],
    },
    createdAt: 100,
    reason: 'test-prefix',
}];
context.chatMetadata.layered_memory = data;

const normalParts = buildCoreMemoryParts({ data, settings, context });
assert.match(normalParts.raw, new RegExp(oldSwipeText), 'ordinary continuation may retain the selected current swipe');

chat[3].swipe_id = chat[3].swipes.length;
assert.equal(isPendingSwipeMessage(chat[3]), true, 'a not-yet-generated right swipe must be recognized as pending');
const pendingPairs = getPairs();
assert.equal(pendingPairs.length, 2);
assert.equal(pendingPairs[0].sealed, true);
assert.equal(pendingPairs[1].sealed, false, 'the pending assistant slot must not seal the current pair');
assert.deepEqual(getMessageFloors().map(item => item.messageIndex), [0, 1],
    'pending assistant and its trailing user prompt must stay out of plugin raw-memory floors');

const staleData = context.chatMetadata.layered_memory;
const isolatedData = reconcileCurrentHistory(staleData, getPairs({ excludeTrailingAssistant: true }));
assert.notEqual(isolatedData, staleData, 'active swipe cleanup must replace the data object');
assert.equal(context.chatMetadata.layered_memory, isolatedData);
assert.throws(() => assertChatData(staleData), error => error?.code === 'CHAT_SCOPE_CHANGED',
    'an old in-flight job must lose permission to save after swipe cleanup');
assert.equal(isolatedData.state_table.entries.some(entry => entry.value === oldSwipeText), false,
    'facts derived from the old swipe must be removed');
assert.equal(isolatedData.state_table.entries.some(entry => entry.value === '应当保留'), true,
    'facts from the shared prefix must remain');

const generationData = reconcileCurrentHistory(isolatedData, getPairs({ excludeTrailingAssistant: true }));
assert.equal(generationData.state_table.entries.some(entry => entry.value === '应当保留'), true,
    'the generation-start defense must be idempotent after the awaited swipe event');
assert.equal(generationData.state_table.entries.some(entry => entry.value === oldSwipeText), false);

const pendingParts = buildCoreMemoryParts({ data: generationData, settings, context, generationType: 'swipe' });
const pendingPayload = [pendingParts.l1, pendingParts.l2, pendingParts.raw].join('\n\n');
assert.doesNotMatch(pendingPayload, new RegExp(oldSwipeText), 'new swipe injection must not contain the old candidate');
assert.doesNotMatch(pendingParts.raw, /CURRENT_USER_REQUEST/u,
    'the current user request remains in SillyTavern Chat History and must not be duplicated by the plugin');

registerPresetMemoryMacro();
setActiveGenerationType('swipe');
assert.equal(typeof registeredMacro, 'function');
assert.doesNotMatch(registeredMacro(), new RegExp(oldSwipeText),
    'the preset macro must use the same swipe projection as compatibility injection');
clearActiveGenerationType();

chat[3].swipes.push(newSwipeText);
chat[3].swipe_id = 1;
chat[3].mes = newSwipeText;
const completedData = reconcileCurrentHistory(generationData, getPairs());
const completedParts = buildCoreMemoryParts({ data: completedData, settings, context });
assert.match(completedParts.raw, new RegExp(newSwipeText), 'the completed new candidate may establish its own raw continuity');
assert.doesNotMatch(completedParts.raw, new RegExp(oldSwipeText), 'the old candidate must remain isolated after completion');

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.match(indexSource, /const historyMutationHandler = \(mesId\) =>[\s\S]*queueHistoryMutation/u,
    'swipe UI handling must return immediately after registering isolated cleanup');
assert.match(indexSource, /MESSAGE_RECEIVED[\s\S]*type === 'swipe'[\s\S]*queueHistoryMutation/u,
    'a completed generated swipe must reconcile against its own fingerprint');
assert.match(indexSource, /GENERATION_STARTED[\s\S]*\(type, _params, isDryRun\) =>[\s\S]*setActiveGenerationType\(type\)/u,
    'generation start must record the swipe type without blocking the foreground UI');
assert.match(indexSource, /layeredMemoryIntercept[\s\S]*await waitForGenerationHistory/u,
    'the final prompt interceptor must wait for swipe cleanup even if event timing changes');
assert.match(indexSource, /GENERATE_AFTER_DATA[\s\S]*isDryRun[\s\S]*clearGenerationState/u,
    'a Prompt Manager dry run must clear its temporary swipe generation state after prompt assembly');

console.log('swipe isolation smoke: pending slot, prefix facts, macro, task scope, and completed candidate passed');
