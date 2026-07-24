import assert from 'node:assert/strict';

let chatSaveCount = 0;
let metadataSaveCount = 0;
const extensionPromptCalls = [];

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
    bodyExtractionRegex: '',
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
    turn_summaries: [],
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
    setExtensionPrompt: (...args) => { extensionPromptCalls.push(args); },
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, NONE: -1 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
};

globalThis.SillyTavern = { getContext: () => context, libs: {} };

const { EMPTY_CHAT_DATA } = await import('../src/constants.js');
const { ensureMessageIds, getPairs } = await import('../src/ids.js');
const { normalizeExtractOutput, validateEntry } = await import('../src/validate.js');
const { mergeExtractResult, rollbackFloor } = await import('../src/merge.js');
const { renderL1Block, renderL2Block } = await import('../src/render.js');
const { updateInjection } = await import('../src/inject.js');
const { testAuxModelConnection } = await import('../src/aux-model.js');
const { extractAiBody } = await import('../src/body.js');

settings.depthL1 = 7;
settings.depthL2 = 9;
settings.depthL4 = 3;
updateInjection();
const l1Injection = extensionPromptCalls.find(([key]) => key === 'layered_memory_l1');
const l2Injection = extensionPromptCalls.find(([key]) => key === 'layered_memory_l2');
const l4Injection = extensionPromptCalls.find(([key]) => key === 'layered_memory_l4');
assert.deepEqual(l1Injection?.slice(2), [0, 0, false, 0], 'L1 必须作为 IN_PROMPT system 提示发送，旧 depth 设置不得生效');
assert.deepEqual(l2Injection?.slice(2), [0, 0, false, 0], 'L2 必须作为 IN_PROMPT system 提示发送，旧 depth 设置不得生效');
assert.equal(l2Injection?.[1], '', '未确定显式发送规则前，L2 必须保持为空');
assert.deepEqual(l4Injection?.slice(2), [1, 3, false, 0], 'L4 仍应使用 IN_CHAT 和可配置 depth');

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
const originalFingerprint = getPairs()[0].contentFingerprint;
context.chat[1].swipes = ['回复 0', '另一条回复'];
context.chat[1].swipe_id = 1;
assert.notEqual(getPairs()[0].contentFingerprint, originalFingerprint, '同一消息 ID 切换 swipe 后正文指纹必须变化');
context.chat[1].swipe_id = 0;

const raw = {
    turn_summary: '<user>请求周衡护送林晚，周衡答应将她送到北港。',
    promise: [{ subject: '周衡', object: '林晚', value: '护送她到北港', evidence: '周衡答应护送林晚到北港' }],
};
const normalized = normalizeExtractOutput(raw);
const merged = await mergeExtractResult(normalized, {
    pipeline: 'per_floor',
    sourceText: '周衡答应护送林晚到北港',
    stateTable: chatData.state_table,
    floorKey: 'floor-1',
    contentFingerprint: 'floor-1-content',
    pairIndex: 1,
    floorLabel: 1,
    source: 'auto',
});
assert.deepEqual(merged, { applied: 1, discarded: 0, conflicts: 0 });
assert.match(renderL1Block(chatData), /护送她到北港/);
assert.equal(chatData.turn_summaries.length, 1, '逐轮整理应同时保存剧情记录');
assert.equal(chatData.floor_events.length, 1, '逐轮整理应保存可供 Fork 重放的楼层事件');
assert.equal((await rollbackFloor('floor-1')), 1, '按楼回滚应移除变更');
assert.equal(chatData.state_table.entries.length, 0);
assert.equal(chatData.turn_summaries.length, 0, '按楼回滚必须同时移除剧情记录');
assert.equal(chatData.floor_events.length, 0, '按楼回滚必须同时移除 Fork 楼层事件');

chatData.state_table.entries.push({ id: 'e_0099', slot: 'relationship', topic: '双方关系状态', subject: '林晚', object: '周衡', value: '仍在冷战', evidence: '两人仍在冷战', source: 'auto' });
const conflicting = normalizeExtractOutput({
    turn_summary: '<user>询问两人的关系，周衡声称已经和解。',
    relationship: [{ topic: '双方关系状态', subject: '林晚', object: '周衡', old_value: '已经和解', new_value: '恢复亲近', evidence: '周衡声称已经和解' }],
});
const conflictResult = await mergeExtractResult(conflicting, {
    pipeline: 'per_floor', sourceText: '周衡声称已经和解', stateTable: chatData.state_table,
    floorKey: 'floor-conflict', contentFingerprint: 'conflict-fp', pairIndex: 2, floorLabel: 2, source: 'auto',
});
assert.deepEqual(conflictResult, { applied: 0, discarded: 1, conflicts: 1 });
assert.equal(chatData.state_table.entries.find(entry => entry.id === 'e_0099').value, '仍在冷战', 'old_value 冲突不得偷偷覆盖当前事实');
assert.equal(chatData.review_queue.at(-1).candidate_id != null, true, '冲突必须关联可审阅的事实发现');
await rollbackFloor('floor-conflict');
chatData.state_table.entries = chatData.state_table.entries.filter(entry => entry.id !== 'e_0099');

chatData.state_table.entries.push({
    id: 'e_pinned', slot: 'identity', topic: '组织职位', subject: '顾南', object: '',
    value: '调查员', evidence: '顾南仍是调查员', source: 'manual', pinned: true,
});
const pinnedResult = await mergeExtractResult(normalizeExtractOutput({
    turn_summary: '<user>询问顾南的职位，顾南称自己已升任队长。',
    identity: [{ topic: '组织职位', subject: '顾南', object: '', value: '队长', evidence: '顾南称自己已升任队长' }],
}), {
    pipeline: 'per_floor', sourceText: '顾南称自己已升任队长', stateTable: chatData.state_table,
    floorKey: 'floor-pinned', contentFingerprint: 'pinned-fp', pairIndex: 3, floorLabel: 3, source: 'auto',
});
assert.equal(pinnedResult.applied, 0);
assert.equal(chatData.state_table.entries.find(entry => entry.id === 'e_pinned').value, '调查员');
assert.equal(chatData.fact_ledger.some(candidate => candidate.fact?.subject === '顾南'
    && candidate.fact?.value === '队长'), true,
    'a value blocked by a pinned current fact must still remain visible in all discoveries');
await rollbackFloor('floor-pinned');
chatData.state_table.entries = chatData.state_table.entries.filter(entry => entry.id !== 'e_pinned');

const bodyMatch = extractAiBody('<thinking>忽略</thinking><content>真正正文</content><table>忽略</table>', '<content>([\\s\\S]*?)</content>');
assert.equal(bodyMatch.text, '真正正文');
assert.equal(bodyMatch.mode, 'regex');
const bodyFallback = extractAiBody('没有按标签输出的正文', '<content>([\\s\\S]*?)</content>');
assert.equal(bodyFallback.text, '没有按标签输出的正文');
assert.equal(bodyFallback.mode, 'fallback', '正文规则失配必须自动回退整条回复');

const invalid = validateEntry({ subject: '林晚', value: '错误事实', evidence: '不存在的证据' }, {
    pipeline: 'per_floor', sourceText: '本楼没有这句话', stateTable: chatData.state_table,
}, 'body');
assert.equal(invalid.ok, false, '伪造 evidence 必须被拒绝');

setPairs(6);
ensureMessageIds();
chatData.turn_summaries = Array.from({ length: 6 }, (_, pairIndex) => ({
    floorKey: getPairs()[pairIndex].floorKey,
    pairIndex,
    summary: `第${pairIndex}轮逐轮记录`,
    sourceMode: 'regex',
}));
chatData.chapters = [];
assert.match(renderL2Block(chatData), /第0轮逐轮记录[\s\S]*第5轮逐轮记录/);

chatData.chapters = [
    { id: 'ch_1', summary: '前三轮摘要', floor_range: [0, 2], stale: false, demoted: false },
    { id: 'ch_2', summary: '后三轮摘要', floor_range: [3, 5], stale: false, demoted: false },
];
assert.match(renderL2Block(chatData), /前三轮摘要[\s\S]*后三轮摘要/,
    '摘要渲染器应保留完整章节顺序');
assert.doesNotMatch(renderL2Block(chatData), /逐轮记录/,
    '完整章节存在时不得重复注入对应逐轮记录');

chatData.chapters = [{ id: 'ch_volume', summary: '不应重复出现的章节', floor_range: [0, 2], stale: false, demoted: true }];
chatData.volumes = [{ id: 'vol_1', summary: '更紧凑的长期摘要', chapter_ids: ['ch_volume'], stale: false }];
const volumeRender = renderL2Block(chatData);
assert.match(volumeRender, /更紧凑的长期摘要/);
assert.doesNotMatch(volumeRender, /不应重复出现的章节/, '有效卷存在时不得重复注入其章节');

const connection = await testAuxModelConnection({ timeoutMs: 1000 });
assert.equal(connection.ok, true);
assert.equal(connection.route, 'current_connection');
assert.equal(Object.hasOwn(connection, 'raw'), false, '连接测试不得返回原始响应');

const blank = EMPTY_CHAT_DATA();
assert.ok(blank.job_queue && Array.isArray(blank.job_queue.failed), '新聊天必须带持久队列结构');
assert.ok(metadataSaveCount >= 2, '合并与回滚必须保存 metadata');

console.log('core smoke: fact merge, memory rendering, and routing passed');
