import assert from 'node:assert/strict';

let chatSaveCount = 0;
let metadataSaveCount = 0;

const settings = {
    enabled: true,
    connectionProfile: '',
    fallbackEnabled: false,
    fallbackBaseUrl: '',
    fallbackApiKey: '',
    fallbackModel: '',
    budgetL1: 2000,
    budgetL2: 5000,
    budgetL4: 1500,
    recentPairs: 2,
    chapterSize: 3,
    proofreadEvery: 75,
    depthL1: 100,
    depthL2: 100,
    depthL4: 4,
    volumeCompressConfirm: false,
    l4Enabled: false,
    migrationReviewMode: false,
    eval_cases: [],
};

const chatData = {
    version: 1,
    state_table: { version: 1, entries: [], changelog: [] },
    chapters: [], volumes: [], keyword_index: {}, review_queue: [],
    pending_floors: [], extracted_keys: [],
    job_queue: { scope_id: 'smoke', paused: false, queued: [], running: null, failed: [] },
    progress: { last_chapter_end_pair: -1, pairs_since_proofread: 0, next_entry_seq: 1, next_chapter_seq: 1, baseline_pair: -1 },
    logs: [],
};

const context = {
    chat: [],
    extensionSettings: { layered_memory: settings },
    chatMetadata: { layered_memory: chatData },
    saveMetadata: async () => { metadataSaveCount += 1; },
    saveChat: async () => { chatSaveCount += 1; },
    saveSettingsDebounced: () => {},
    generateRaw: async () => 'OK',
    setExtensionPrompt: () => {},
};

globalThis.SillyTavern = { getContext: () => context, libs: {} };

const { EMPTY_CHAT_DATA } = await import('../src/constants.js');
const { ensureMessageIds, getPairs } = await import('../src/ids.js');
const { normalizeExtractOutput, validateEntry } = await import('../src/validate.js');
const { mergeExtractResult, rollbackFloor } = await import('../src/merge.js');
const { renderL1Block } = await import('../src/render.js');
const { trimChatForGenerate } = await import('../src/inject.js');
const { testAuxModelConnection } = await import('../src/aux-model.js');

function setPairs(count) {
    context.chat = [];
    for (let i = 0; i < count; i += 1) {
        context.chat.push({ is_user: true, mes: `用户 ${i}`, send_date: `${i}-u`, extra: {} });
        context.chat.push({ is_user: false, mes: `回复 ${i}`, send_date: `${i}-a`, extra: {} });
    }
}

setPairs(6);
assert.equal(ensureMessageIds(), true, '首次应生成稳定消息 ID');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(chatSaveCount, 1, '稳定消息 ID 应明确保存一次');
assert.equal(ensureMessageIds(), false, '重复扫描不应再次改写 ID');
assert.equal(getPairs().length, 6, '六对消息应正确配对');

const raw = {
    promise: [{ subject: '周衡', object: '林晚', value: '护送她到北港', evidence: '周衡答应护送林晚到北港' }],
};
const normalized = normalizeExtractOutput(raw);
const merged = await mergeExtractResult(normalized, {
    pipeline: 'per_floor',
    sourceText: '周衡答应护送林晚到北港',
    stateTable: chatData.state_table,
    floorKey: 'floor-1',
    floorLabel: 1,
    source: 'auto',
});
assert.deepEqual(merged, { applied: 1, discarded: 0, conflicts: 0 });
assert.match(renderL1Block(chatData), /护送她到北港/);
assert.equal((await rollbackFloor('floor-1')), 1, '按楼回滚应移除变更');
assert.equal(chatData.state_table.entries.length, 0);

const invalid = validateEntry({ subject: '林晚', value: '错误事实', evidence: '不存在的证据' }, {
    pipeline: 'per_floor', sourceText: '本楼没有这句话', stateTable: chatData.state_table,
}, 'body');
assert.equal(invalid.ok, false, '伪造 evidence 必须被拒绝');

chatData.chapters = [{ id: 'ch_1', summary: '前三对摘要', floor_range: [0, 2], stale: false, demoted: false }];
chatData.progress.last_chapter_end_pair = 2;
const original = [...context.chat];
const regenerate = [...original];
trimChatForGenerate(regenerate, 'regenerate');
assert.equal(regenerate.length, original.length, 'regenerate 不得裁剪聊天');
const normal = [...original];
trimChatForGenerate(normal, 'normal');
assert.equal(normal.length, 6, '普通生成应保留章后缝隙三对');

const connection = await testAuxModelConnection({ timeoutMs: 1000 });
assert.equal(connection.ok, true);
assert.equal(connection.route, 'current_connection');
assert.equal(Object.hasOwn(connection, 'raw'), false, '连接测试不得返回原始响应');

const blank = EMPTY_CHAT_DATA();
assert.ok(blank.job_queue && Array.isArray(blank.job_queue.failed), '新聊天必须带持久队列结构');
assert.ok(metadataSaveCount >= 2, '合并与回滚必须保存 metadata');

console.log('core smoke: 11/11 passed');
