import assert from 'node:assert/strict';

const settings = {
    enabled: true,
    budgetL1: 2000,
    budgetL2: 5000,
    budgetL4: 1500,
    depthL4: 4,
    l4Enabled: false,
};

const data = {
    version: 4,
    state_table: {
        version: 1,
        entries: [{
            id: 'fact_001',
            slot: 'identity',
            subject: '<user>',
            object: '',
            value: '仍持有旧宅钥匙',
            evidence: '钥匙还在我这里。',
            source: 'auto',
            established_floor: 1,
            updated_floor: 1,
        }],
        changelog: [],
    },
    turn_summaries: [{ pairIndex: 0, summary: '用户收起旧宅钥匙，角色确认此事。' }],
    chapters: [],
    volumes: [],
    keyword_index: {},
    review_queue: [],
    pending_floors: [],
    extracted_keys: [],
    fact_ledger: [],
    quarantined_entries: [],
    job_queue: { scope_id: 'preset-anchor', paused: true, queued: [], running: null, failed: [] },
    progress: { last_chapter_end_pair: -1, pairs_since_proofread: 0, next_entry_seq: 2, next_chapter_seq: 1, baseline_pair: -1 },
    logs: [],
};

const extensionPromptCalls = [];
let registeredMacro = null;
const promptSettings = {
    prompts: [{
        identifier: 'review-open',
        name: '前文回顾开头',
        role: 'assistant',
        content: '前文回顾开始\n{{layered_memory_context}}',
    }, {
        identifier: 'unused-review',
        name: '未启用的回顾',
        role: 'assistant',
        content: '{{layered_memory_context}}',
    }],
    prompt_order: [{
        character_id: 100001,
        order: [
            { identifier: 'review-open', enabled: false },
            { identifier: 'unused-review', enabled: false },
        ],
    }],
};
const context = {
    chat: [
        { is_user: true, mes: '钥匙还在我这里。', extra: { layered_memory_id: 'u1' } },
        { is_user: false, mes: '我记得。', extra: { layered_memory_id: 'a1' } },
    ],
    name1: '用户',
    name2: '角色',
    extensionSettings: { layered_memory: settings },
    chatMetadata: { layered_memory: data },
    chatCompletionSettings: promptSettings,
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    setExtensionPrompt: (...args) => extensionPromptCalls.push(args),
    registerMacro: (name, value, description) => { registeredMacro = { name, value, description }; },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, NONE: -1 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
};

globalThis.SillyTavern = { getContext: () => context, libs: {} };

const {
    getPresetAnchorStatus,
    registerPresetMemoryMacro,
    renderCoreMemoryPayload,
    updateInjection,
} = await import('../src/inject.js');
const { MEMORY_ANCHOR_TOKEN, inspectPresetAnchor } = await import('../src/preset-anchor.js');

assert.equal(MEMORY_ANCHOR_TOKEN, '{{layered_memory_context}}');
assert.equal(inspectPresetAnchor(context).state, 'missing', 'disabled prompt anchors must not activate anchor mode');
assert.equal(registerPresetMemoryMacro(), true);
assert.equal(registeredMacro?.name, 'layered_memory_context');
assert.equal(typeof registeredMacro?.value, 'function');
assert.equal(registeredMacro.value(), '', 'disabled anchors must expand to empty content');

updateInjection();
let l1Call = extensionPromptCalls.find(([key]) => key === 'layered_memory_l1');
let l2Call = extensionPromptCalls.find(([key]) => key === 'layered_memory_l2');
assert.match(l1Call?.[1], /仍持有旧宅钥匙/u, 'missing-anchor mode must keep the L1 compatibility injection');
assert.match(l2Call?.[1], /用户收起旧宅钥匙/u, 'missing-anchor mode must keep the L2 compatibility injection');

promptSettings.prompt_order[0].order[0].enabled = true;
assert.equal(getPresetAnchorStatus(context).mode, 'anchor');
const anchoredPayload = registeredMacro.value();
assert.match(anchoredPayload, /剧情记忆开始/u);
assert.match(anchoredPayload, /当前确立的事实/u);
assert.ok(anchoredPayload.indexOf('剧情记忆开始') < anchoredPayload.indexOf('当前确立的事实'),
    'anchored payload must put chronological L2 before current-state L1');
assert.equal(anchoredPayload, renderCoreMemoryPayload(), 'macro and preview must use the same core payload');

extensionPromptCalls.length = 0;
updateInjection();
l1Call = extensionPromptCalls.find(([key]) => key === 'layered_memory_l1');
l2Call = extensionPromptCalls.find(([key]) => key === 'layered_memory_l2');
assert.equal(l1Call?.[1], '', 'active anchor must suppress the legacy L1 prompt');
assert.equal(l2Call?.[1], '', 'active anchor must suppress the legacy L2 prompt');
assert.deepEqual(l1Call?.slice(2), [0, 0, false, 0]);

promptSettings.prompt_order[0].order[1].enabled = true;
assert.equal(getPresetAnchorStatus(context).state, 'duplicate');
assert.equal(getPresetAnchorStatus(context).activeCount, 2);
assert.equal(registeredMacro.value(), '', 'duplicate anchors must not duplicate core memory');

extensionPromptCalls.length = 0;
updateInjection();
l1Call = extensionPromptCalls.find(([key]) => key === 'layered_memory_l1');
l2Call = extensionPromptCalls.find(([key]) => key === 'layered_memory_l2');
assert.match(l1Call?.[1], /仍持有旧宅钥匙/u, 'duplicate-anchor mode must send L1 once through compatibility injection');
assert.match(l2Call?.[1], /用户收起旧宅钥匙/u, 'duplicate-anchor mode must send L2 once through compatibility injection');

console.log('preset anchor smoke: exact macro, fallback, de-duplication, and payload order passed');
