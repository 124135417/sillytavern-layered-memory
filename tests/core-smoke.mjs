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
    historyBudgetMode: 'custom',
    historyTokenBudget: 1800,
    minRecentPairs: 2,
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
const { getSettings } = await import('../src/settings.js');
const { normalizeExtractOutput, validateEntry } = await import('../src/validate.js');
const { mergeExtractResult, rollbackFloor } = await import('../src/merge.js');
const { renderL1Block, renderL2Block } = await import('../src/render.js');
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

setPairs(12);
ensureMessageIds();
chatData.chapters = [
    { id: 'ch_1', summary: '前三轮摘要', floor_range: [0, 2], stale: false, demoted: false },
    { id: 'ch_2', summary: '后三轮摘要', floor_range: [3, 5], stale: false, demoted: false },
];
chatData.progress.last_chapter_end_pair = 5;
const original = context.chat;
const cloneForRequest = () => original.map((message, index) => ({
    ...message,
    extra: { ...message.extra },
    // Simulate preset regex: old AI bodies are already reduced to a private summary tag.
    mes: !message.is_user && index < 12
        ? `<meow_FM>第${Math.floor(index / 2)}轮摘要</meow_FM>`
        : `${message.mes}${'剧情细节'.repeat(180)}`,
}));
const regenerate = cloneForRequest();
const regenerateResult = await trimChatForGenerate(regenerate, 'regenerate', 8000);
assert.equal(regenerate.length, original.length, 'regenerate 不得裁剪聊天');
assert.equal(regenerateResult.status, 'skipped');

const normal = cloneForRequest();
const normalResult = await trimChatForGenerate(normal, 'normal', 8000);
assert.equal(normal.length, 12, '普通生成只删除已有摘要覆盖的前六轮');
assert.equal(normalResult.removedThrough, 5, '裁剪边界必须对齐完整章节');
assert.equal(original.length, 24, '请求裁剪不得修改聊天存档');
assert.match(renderL2Block(chatData, { throughPair: 5 }), /前三轮摘要[\s\S]*后三轮摘要/,
    '应只渲染实际删除范围对应的摘要');
assert.doesNotMatch(renderL2Block(chatData, { throughPair: 2 }), /后三轮摘要/,
    '仍留在请求中的章节不得重复注入');

chatData.chapters = [{ id: 'ch_gap', summary: '有空洞的摘要', floor_range: [3, 5], stale: false }];
const gapRequest = cloneForRequest();
const gapResult = await trimChatForGenerate(gapRequest, 'normal', 8000);
assert.equal(gapRequest.length, original.length, '摘要不是从最早历史连续覆盖时不得裁剪');
assert.equal(gapResult.reason, 'summary_gap');

chatData.chapters = [{ id: 'ch_stale', summary: '过期摘要', floor_range: [0, 5], stale: true }];
const staleRequest = cloneForRequest();
assert.equal((await trimChatForGenerate(staleRequest, 'normal', 8000)).reason, 'summary_gap');
assert.equal(staleRequest.length, original.length, '过期摘要不得替代聊天历史');

chatData.chapters = [{ id: 'ch_huge', summary: '过长摘要'.repeat(2000), floor_range: [0, 5], stale: false }];
const hugeArchiveRequest = cloneForRequest();
const hugeArchiveResult = await trimChatForGenerate(hugeArchiveRequest, 'normal', 8000);
assert.equal(hugeArchiveResult.reason, 'archive_budget');
assert.equal(hugeArchiveRequest.length, original.length, '替代摘要会被截断时不得删除对应聊天');

chatData.chapters = [{ id: 'ch_valid', summary: '有效摘要', floor_range: [0, 5], stale: false }];
const missingIdRequest = cloneForRequest();
delete missingIdRequest[0].extra.layered_memory_id;
const missingIdResult = await trimChatForGenerate(missingIdRequest, 'normal', 8000);
assert.equal(missingIdResult.reason, 'message_mapping');
assert.equal(missingIdRequest.length, original.length, '稳定 ID 缺失时必须完整保留历史');

context.getTokenCountAsync = async text => String(text).length;
const exactRequest = cloneForRequest();
const exactResult = await trimChatForGenerate(exactRequest, 'normal', 8000);
assert.equal(exactResult.tokenizer, 'sillytavern', '可用时必须采用酒馆当前 tokenizer');
assert.equal(exactResult.removedThrough, 5);
delete context.getTokenCountAsync;

chatData.chapters = [{ id: 'ch_volume', summary: '不应重复出现的章节', floor_range: [0, 2], stale: false, demoted: true }];
chatData.volumes = [{ id: 'vol_1', summary: '更紧凑的长期摘要', chapter_ids: ['ch_volume'], stale: false }];
const volumeRender = renderL2Block(chatData, { throughPair: 2 });
assert.match(volumeRender, /更紧凑的长期摘要/);
assert.doesNotMatch(volumeRender, /不应重复出现的章节/, '有效卷存在时不得重复注入其章节');

delete settings.minRecentPairs;
settings.recentPairs = 9;
assert.equal(getSettings().minRecentPairs, 9, '旧设置的较大近楼保留值必须迁移保留');
settings.historyBudgetMode = 'unknown';
assert.equal(getSettings().historyBudgetMode, 'balanced', '未知的容量模式必须安全回到平衡档');

const connection = await testAuxModelConnection({ timeoutMs: 1000 });
assert.equal(connection.ok, true);
assert.equal(connection.route, 'current_connection');
assert.equal(Object.hasOwn(connection, 'raw'), false, '连接测试不得返回原始响应');

const blank = EMPTY_CHAT_DATA();
assert.ok(blank.job_queue && Array.isArray(blank.job_queue.failed), '新聊天必须带持久队列结构');
assert.ok(metadataSaveCount >= 2, '合并与回滚必须保存 metadata');

console.log('core smoke: 33/33 passed');
