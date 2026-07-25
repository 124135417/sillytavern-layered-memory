import assert from 'node:assert/strict';

const settings = {
    enabled: true,
    budgetL1: 2000,
    budgetL2: 1,
    budgetL4: 1500,
    depthL4: 4,
    l4Enabled: false,
};

const data = {
    version: 4,
    state_table: { version: 1, entries: [], changelog: [] },
    turn_summaries: Array.from({ length: 60 }, (_, pairIndex) => ({
        pairIndex,
        summary: `TURN_${String(pairIndex + 1).padStart(3, '0')}`,
    })),
    chapters: [
        { id: 'ch_001', floor_range: [0, 24], summary: 'CHAPTER_001', stale: false, demoted: false },
        { id: 'ch_002', floor_range: [25, 49], summary: 'CHAPTER_002', stale: false, demoted: false },
    ],
    volumes: [],
    keyword_index: {},
    review_queue: [],
    pending_floors: [],
    extracted_keys: [],
    fact_ledger: [],
    quarantined_entries: [],
    job_queue: { scope_id: 'hierarchical-l2', paused: true, queued: [], running: null, failed: [] },
    progress: { last_chapter_end_pair: 49, pairs_since_proofread: 0, next_entry_seq: 1, next_chapter_seq: 3, baseline_pair: -1 },
    logs: [],
};

const extensionPromptCalls = [];
const context = {
    chat: [],
    extensionSettings: { layered_memory: settings },
    chatMetadata: { layered_memory: data },
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    setExtensionPrompt: (...args) => extensionPromptCalls.push(args),
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, NONE: -1 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
};

globalThis.SillyTavern = { getContext: () => context, libs: {} };

const { renderL2Block } = await import('../src/render.js');
const { updateInjection } = await import('../src/inject.js');
const { getQueueSnapshot } = await import('../src/queue.js');

const count = (text, pattern) => [...String(text).matchAll(pattern)].length;

const chapterAndTail = renderL2Block(data, { forInjection: true });
assert.match(chapterAndTail, /CHAPTER_001[\s\S]*CHAPTER_002[\s\S]*TURN_051[\s\S]*TURN_060/,
    '60 轮应按顺序注入两个完整章节和最后 10 条逐轮摘要');
assert.equal(count(chapterAndTail, /CHAPTER_/g), 2);
assert.equal(count(chapterAndTail, /TURN_/g), 10);
assert.doesNotMatch(chapterAndTail, /TURN_050/,
    '被章节摘要覆盖的逐轮内容不得重复注入');

data.chapters.forEach(chapter => { chapter.demoted = true; });
data.volumes = [{
    id: 'vol_001',
    summary: 'VOLUME_001',
    chapter_ids: ['ch_001', 'ch_002'],
    stale: false,
}];
const volumeAndTail = renderL2Block(data, { forInjection: true });
assert.match(volumeAndTail, /VOLUME_001[\s\S]*TURN_051[\s\S]*TURN_060/);
assert.equal(count(volumeAndTail, /VOLUME_/g), 1);
assert.equal(count(volumeAndTail, /CHAPTER_/g), 0);
assert.equal(count(volumeAndTail, /TURN_/g), 10);

data.volumes[0].chapter_ids = ['ch_001', 'ch_missing'];
const missingChapterFallback = renderL2Block(data, { forInjection: true });
assert.equal(count(missingChapterFallback, /VOLUME_/g), 0,
    '缺少引用章节的长期摘要必须失效');
assert.equal(count(missingChapterFallback, /CHAPTER_/g), 2,
    '长期摘要失效时，被降级章节必须恢复为候选');
assert.equal(count(missingChapterFallback, /TURN_/g), 10);

data.volumes[0].chapter_ids = ['ch_001', 'ch_002'];
data.volumes[0].stale = true;
data.chapters[1].stale = true;
const staleFallback = renderL2Block(data, { forInjection: true });
assert.equal(count(staleFallback, /VOLUME_/g), 0);
assert.equal(count(staleFallback, /CHAPTER_/g), 1);
assert.equal(count(staleFallback, /TURN_/g), 35,
    '第二章失效时必须用第 26–60 轮的 35 条逐轮摘要补齐');

data.chapters[1].stale = false;
data.chapters[1].summary = '   ';
const emptyChapterFallback = renderL2Block(data, { forInjection: true });
assert.equal(count(emptyChapterFallback, /CHAPTER_/g), 1);
assert.equal(count(emptyChapterFallback, /TURN_/g), 35,
    '空章节摘要必须按不存在处理并回退到逐轮摘要');

data.chapters[1].summary = 'CHAPTER_002';
data.chapters[1].floor_range = [26, 49];
data.volumes[0].stale = false;
const discontinuousVolumeFallback = renderL2Block(data, { forInjection: true });
assert.equal(count(discontinuousVolumeFallback, /VOLUME_/g), 0,
    '引用章节范围不连续的长期摘要必须失效');
assert.equal(count(discontinuousVolumeFallback, /CHAPTER_/g), 2);
assert.equal(count(discontinuousVolumeFallback, /TURN_/g), 11,
    '章节之间的未覆盖楼层和尾部楼层都必须用逐轮摘要补齐');

data.chapters[1].floor_range = [25, 49];
data.volumes[0].stale = false;
data.volumes[0].summary = '   ';
const emptyVolumeFallback = renderL2Block(data, { forInjection: true });
assert.equal(count(emptyVolumeFallback, /VOLUME_/g), 0);
assert.equal(count(emptyVolumeFallback, /CHAPTER_/g), 2);
assert.equal(count(emptyVolumeFallback, /TURN_/g), 10);

data.volumes = [];
updateInjection();
const l2Injection = extensionPromptCalls.find(([key]) => key === 'layered_memory_l2');
assert.deepEqual(l2Injection?.slice(2), [0, 0, false, 0],
    'L2 必须作为 IN_PROMPT system 提示发送');
assert.equal(l2Injection?.[1], chapterAndTail,
    'L2 注入必须使用完整的最高级覆盖结果');
assert.doesNotMatch(l2Injection?.[1], /已截断/,
    'budgetL2 再小也不得截断本轮 L2 注入');
assert.equal(getQueueSnapshot().queued.some(job => job.type === 'volume_compress'), true,
    '超过 budgetL2 时仍应触发长期摘要压缩任务');

console.log('hierarchical L2 injection smoke: complete priority fallback passed');
