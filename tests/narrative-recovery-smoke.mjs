import assert from 'node:assert/strict';

const settings = {
    enabled: true, memoryModelSource: 'direct',
    directBaseUrl: 'https://models.example/v1', directApiKey: 'test-only', directModel: 'test-model',
    chapterSize: 1000, bodyExtractionRegex: '',
};
let saves = 0;
const context = {
    chat: Array.from({ length: 26 }, (_, i) => ({
        is_user: i % 2 === 1, mes: `角色在第${i}楼决定前往北门。`,
        extra: { layered_memory_id: `recovery-${i}` },
    })),
    extensionSettings: { layered_memory: settings }, chatMetadata: {},
    saveMetadata: async () => { saves += 1; }, saveSettingsDebounced() {},
};
globalThis.SillyTavern = { getContext: () => context };
const { EMPTY_CHAT_DATA } = await import('../src/constants.js');
const data = EMPTY_CHAT_DATA();
data.job_queue = { scope_id: 'recovery', paused: true, queued: [], running: [], failed: [] };
context.chatMetadata.layered_memory = data;
const { currentNarrativeSources, handleNarrativeSummaryJob } = await import('../src/narrative.js');
const { validateChapterArchive, summarizeChapterNotes } = await import('../src/archive.js');
const sources = currentNarrativeSources();
const sourceByFloor = new Map(sources.map(source => [source.messageIndex, source]));
const payload = count => ({
    messageKeys: sources.slice(0, count).map(source => source.messageKey),
    fingerprints: sources.slice(0, count).map(source => source.contentFingerprint),
});
const calls = [];
let responseMode = 'normal';
globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const floorIds = [...body.messages[1].content.matchAll(/【第 (\d+) 楼｜/gu)].map(match => Number(match[1]));
    calls.push(floorIds);
    if (responseMode === 'truncate' && calls.length === 1) {
        return { ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"floors":[' } }] }) };
    }
    const returned = responseMode === 'partial' && calls.length === 1 ? floorIds.slice(0, -1) : floorIds;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ floors: returned.map(floor => {
        const source = sourceByFloor.get(floor);
        return { floor, summary: source.role === 'user' ? `<user>决定前往北门，编号${floor}。` : `角色决定前往北门，编号${floor}。`,
            segments: [{ time_change: null, events: [{ text: '决定前往北门。', evidence: source.narrativeText }] }] };
    }) }) } }] }) };
};

await handleNarrativeSummaryJob(payload(25));
assert.equal(data.narrative_summaries.length, 25, 'persisted 25-floor jobs must recover every floor');
assert.deepEqual(calls.map(batch => batch.length), [6, 6, 6, 6, 1], 'old persisted payloads must be rebatched at execution');
assert.ok(saves >= 5, 'each successful batch must be checkpointed');

calls.length = 0; data.narrative_summaries = []; responseMode = 'truncate';
await handleNarrativeSummaryJob(payload(6));
assert.deepEqual(calls.map(batch => batch.length), [6, 3, 3], 'truncated output must split the remaining sources instead of repeating the same request');
assert.equal(data.narrative_summaries.length, 6);
assert.match(data.logs.at(-3)?.message || data.logs.map(x => x.message).join('\n'), /截断/u);

calls.length = 0; data.narrative_summaries = []; responseMode = 'partial';
await handleNarrativeSummaryJob(payload(6));
assert.deepEqual(calls.map(batch => batch.length), [6, 1], 'validated floors must persist and only the missing floor should be retried');
assert.equal(data.narrative_summaries.length, 6);

const chapter = {
    summary: '完整剧情。'.repeat(100), keywords: ['北门', '角色', '决定'],
    key_events: [{ floor_range: [25, 48], text: '角色决定前往北门。' }],
    coverage: Array.from({ length: 25 }, (_, index) => ({ floor: 25 + index, event_index: 0 })),
};
const invalid = validateChapterArchive(chapter, 25, 49);
assert.equal(invalid.ok, false, 'listing the final floor without a matching event must still fail');
assert.match(invalid.errors.join('；'), /未覆盖第 49 楼/u);
assert.match(invalid.errors.join('；'), /第 49 楼的 coverage 引用事件 0.*25–48/u);
assert.equal(invalid.chapter.key_events[0].floor_range[1], 48, 'validation must not invent an event for the missing floor');
settings.memoryModelSource = 'current';
const chapterPrompts = [];
context.generateRaw = async ({ prompt }) => {
    chapterPrompts.push(prompt);
    return JSON.stringify(chapterPrompts.length === 1 ? chapter : { ...chapter, key_events: [{ floor_range: [25, 49], text: '角色决定前往北门。' }] });
};
const completed = await summarizeChapterNotes(
    Array.from({ length: 25 }, (_, index) => ({ pairIndex: 25 + index, summary: '角色决定前往北门。' })),
    25, 49, () => {}, { unit: 'floor' },
);
assert.equal(completed.coverage.at(-1).floor, 49);
assert.equal(chapterPrompts.length, 2);
assert.match(chapterPrompts[0], /最后的第 49 楼/u);
assert.match(chapterPrompts[1], /上次输出没有通过校验：.*未覆盖第 49 楼/u);
console.log('narrative-recovery-smoke: ok');
