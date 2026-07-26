import assert from 'node:assert/strict';

const chat = Array.from({ length: 44 }, (_, messageIndex) => ({
    is_user: messageIndex % 2 === 1,
    mes: `MESSAGE_${messageIndex}`,
    send_date: `date-${messageIndex}`,
    extra: { layered_memory_id: `message-${messageIndex}` },
}));
const data = {
    version: 5,
    state_table: { version: 1, entries: [], changelog: [] },
    turn_summaries: [],
    narrative_summaries: Array.from({ length: 44 }, (_, messageIndex) => ({
        messageKey: `message-${messageIndex}`,
        messageIndex,
        role: messageIndex % 2 === 1 ? 'user' : 'assistant',
        contentFingerprint: null,
        summary: `FLOOR_${String(messageIndex).padStart(2, '0')}`,
    })),
    narrative_chapters: [{
        id: 'nch_001', floor_range: [0, 24], summary: 'VISIBLE_CHAPTER_0_24', stale: false,
    }],
    narrative_volumes: [],
    chapters: [], volumes: [],
    job_queue: { scope_id: 'visible-floor', paused: true, queued: [], running: null, failed: [] },
    progress: { baseline_pair: -1 },
};
const context = {
    chat,
    extensionSettings: { layered_memory: { enabled: true, chapterSize: 25, bodyExtractionRegex: '' } },
    chatMetadata: { layered_memory: data },
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
};
globalThis.SillyTavern = { getContext: () => context };

const { getMessageFloors } = await import('../src/ids.js');
const { currentNarrativeSources, fallbackNarrativeSummary, reconcileNarrativeSummaries, validateNarrativeBatch } = await import('../src/narrative.js');
const { renderL2Block } = await import('../src/render.js');

const allSources = getMessageFloors({ includeTrailingUser: true }).map(source => ({
    ...source,
    fallbackSummary: fallbackNarrativeSummary(source),
}));
for (const record of data.narrative_summaries) {
    const source = allSources.find(item => item.messageIndex === record.messageIndex);
    record.contentFingerprint = source.contentFingerprint;
}

const rendered = renderL2Block(data, { forInjection: true, narrativeSources: allSources });
assert.match(rendered, /### 章节摘要｜第 0–24 楼[\s\S]*VISIBLE_CHAPTER_0_24/u);
assert.equal([...rendered.matchAll(/### 逐楼剧情记录｜/gu)].length, 19,
    '44 个已完成楼层必须折叠前 25 楼并保留后 19 条逐楼摘要');
assert.doesNotMatch(rendered, /FLOOR_24/u, '章节覆盖范围内不得重复注入逐楼摘要');
assert.match(rendered, /### 逐楼剧情记录｜第 25 楼[\s\S]*### 逐楼剧情记录｜第 43 楼/u);

const generationSources = currentNarrativeSources();
assert.equal(generationSources.length, 43, '生成下一楼时，末尾用户消息应继续由主提示原文承载');
assert.equal(generationSources.at(-1).messageIndex, 42);
const generationRendered = renderL2Block(data, {
    forInjection: true,
    narrativeSources: generationSources.map(source => ({ ...source, fallbackSummary: fallbackNarrativeSummary(source) })),
});
assert.equal([...generationRendered.matchAll(/### 逐楼剧情记录｜/gu)].length, 18);
assert.doesNotMatch(generationRendered, /第 43 楼/u, '当前用户楼不得以摘要形式重复注入');

const changedSource = { ...allSources[30], contentFingerprint: 'changed-fingerprint' };
const mixedSources = allSources.map(source => source.messageIndex === 30 ? changedSource : source);
data.narrative_chapters.push({ id: 'nch_002', floor_range: [25, 49], summary: 'LATER_CHAPTER', stale: false });
assert.equal(reconcileNarrativeSummaries(data, mixedSources), true);
assert.equal(data.narrative_summaries.some(item => item.messageIndex === 30), false,
    '编辑或 swipe 改变正文后必须丢弃旧楼摘要');
assert.equal(data.narrative_chapters[0].stale, false,
    '后段 swipe 改变不得让不相干的早期章节失效');
assert.equal(data.narrative_chapters[1].stale, true,
    '来源历史改变后对应章节必须失效并回退逐楼覆盖');

const checked = validateNarrativeBatch({ floors: [
    { floor: 0, summary: '角色在开场说明了所处地点。' },
    { floor: 1, summary: '询问下一步该怎么做。' },
] }, allSources.slice(0, 2));
assert.equal(checked.ok, true);
assert.match(checked.results[1].summary, /^<user>/u, '用户楼摘要必须统一使用 <user>');

console.log('visible-floor narrative smoke: 25-floor chapter, 19-floor tail, current-user exclusion, swipe invalidation passed');
