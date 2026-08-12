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
const {
    clearResolvedNarrativeFailures,
    currentNarrativeSources,
    fallbackNarrativeSummary,
    reconcileNarrativeSummaries,
    validateNarrativeBatch,
} = await import('../src/narrative.js');
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
    { floor: 0, summary: '角色在开场说明了所处地点。', segments: [{ time_change: null, events: [{ text: '角色提到了开场消息。', evidence: 'MESSAGE_0' }] }] },
    { floor: 1, summary: '询问下一步该怎么做。', segments: [{ time_change: null, events: [{ text: '询问下一步。', evidence: 'MESSAGE_1' }] }] },
] }, allSources.slice(0, 2));
assert.equal(checked.ok, true, checked.errors.join('；'));
assert.match(checked.results[1].summary, /^<user>/u, '用户楼摘要必须统一使用 <user>');
assert.match(checked.results[1].segments[0].events[0].text, /^<user>/u,
    '用户楼原子事件也必须统一使用 <user>');

const crossingSource = {
    ...allSources[0],
    messageIndex: 88,
    text: '当晚，他们在旅店留宿。次日清晨，众人动身前往北门。',
    narrativeText: '当晚，他们在旅店留宿。次日清晨，众人动身前往北门。',
};
const crossing = validateNarrativeBatch({ floors: [{
    floor: 88,
    summary: '众人当晚留宿旅店，次日清晨前往北门。',
    segments: [{
        time_change: { label: '当晚', kind: 'time_of_day', evidence: '当晚' },
        events: [{ text: '众人在旅店留宿。', evidence: '他们在旅店留宿' }],
    }, {
        time_change: { label: '次日清晨', kind: 'relative', evidence: '次日清晨' },
        events: [{ text: '众人动身前往北门。', evidence: '众人动身前往北门' }],
    }],
}] }, [crossingSource]);
assert.equal(crossing.ok, true, crossing.errors.join('；'));
assert.equal(crossing.results[0].segments.length, 2, '一楼跨天必须保留多个有序时间分段');
assert.equal(crossing.results[0].storyTime.label, '次日清晨');

const reversedTime = validateNarrativeBatch({ floors: [{
    floor: 88,
    summary: '模型把两个明确时间点的顺序写反了。',
    segments: [{
        time_change: { label: '次日清晨', kind: 'relative', evidence: '次日清晨' },
        events: [{ text: '众人在旅店留宿。', evidence: '他们在旅店留宿' }],
    }, {
        time_change: { label: '当晚', kind: 'time_of_day', evidence: '当晚' },
        events: [{ text: '众人动身前往北门。', evidence: '众人动身前往北门' }],
    }],
}] }, [crossingSource]);
assert.equal(reversedTime.ok, false);
assert.match(reversedTime.errors.join('；'), /剧情时间顺序与原文不一致/u);

const invented = validateNarrativeBatch({ floors: [{
    floor: 88,
    summary: '模型编造了不存在的安排。',
    segments: [{
        time_change: { label: '第三天', kind: 'relative', evidence: '第三天' },
        events: [{ text: '众人决定进攻王都。', evidence: '进攻王都' }],
    }],
}] }, [crossingSource]);
assert.equal(invented.ok, false);
assert.match(invented.errors.join('；'), /无原文依据|缺少剧情正文证据/u);

const partial = validateNarrativeBatch({ floors: [{
    floor: 88,
    summary: '众人当晚留宿旅店，并在次日清晨动身。',
    segments: [{
        time_change: null,
        events: [
            { text: '众人在旅店留宿。', evidence: '他们在旅店留宿' },
            { text: '众人决定进攻王都。', evidence: '进攻王都' },
        ],
    }],
}] }, [crossingSource], { allowPartial: true });
assert.equal(partial.ok, true, partial.errors.join('；'));
assert.equal(partial.results[0].segments[0].events.length, 1,
    '第二次校验必须只丢弃无原文证据的事件');
assert.match(partial.warnings.join('；'), /已忽略该事件/u);

const compositeSource = {
    ...crossingSource,
    text: '他拉开矮凳，先看了一眼锅。随后伸手捏起一双筷子。\n*连血都没有。*\n*这是残渣。*',
    narrativeText: '他拉开矮凳，先看了一眼锅。随后伸手捏起一双筷子。\n*连血都没有。*\n*这是残渣。*',
    timeSourceText: '他拉开矮凳，先看了一眼锅。随后伸手捏起一双筷子。\n*连血都没有。*\n*这是残渣。*',
};
const composite = validateNarrativeBatch({ floors: [{
    floor: 88,
    summary: '他拉开矮凳拿起筷子，并在心中嫌弃食物。',
    segments: [{
        time_change: null,
        events: [
            { text: '他拉开矮凳并拿起筷子。', evidence: '他拉开矮凳……捏起一双筷子' },
            { text: '他认为食物连血都没有，只是残渣。', evidence: '连血都没有。这是残渣。' },
        ],
    }],
}] }, [compositeSource]);
assert.equal(composite.ok, true, composite.errors.join('；'));
assert.equal(composite.results[0].segments[0].events.length, 2,
    '有序多段引文和仅缺少 Markdown 强调符的引文应通过证据校验');

const resolvedFailureData = {
    narrative_summaries: [{
        messageKey: 'm44', contentFingerprint: 'fp44', summary: '第44楼已经补齐。',
    }],
    job_queue: { failed: [{
        id: 'old-failure', type: 'narrative_summary',
        payload: { messageKeys: ['m44'], fingerprints: ['fp44'] },
    }, {
        id: 'unrelated', type: 'proofread', payload: {},
    }] },
};
assert.equal(clearResolvedNarrativeFailures(resolvedFailureData), 1);
assert.deepEqual(resolvedFailureData.job_queue.failed.map(job => job.id), ['unrelated'],
    '补齐成功后只能清除已经解决的逐楼失败任务');
assert.equal(clearResolvedNarrativeFailures({}), 0, '缺少任务队列时清理必须安全跳过');

data.narrative_summaries.find(item => item.messageIndex === 25).segments = crossing.results[0].segments;
data.narrative_summaries.find(item => item.messageIndex === 25).story_time = crossing.results[0].storyTime;
data.narrative_summaries.find(item => item.messageIndex === 26).segments = [{
    time_change: { label: '次日清晨', kind: 'relative', evidence: '次日清晨' },
    events: [{ text: '<user>质疑领地归属。', evidence: 'MESSAGE_26' }],
}];
data.narrative_summaries.find(item => item.messageIndex === 26).summary =
    '<user>指出矿场和盐沼由自己打下，角色只在之后半年内扩建少量目标。';
const timedRendered = renderL2Block(data, { forInjection: true, narrativeSources: allSources });
assert.equal([...timedRendered.matchAll(/【剧情时间推进：次日清晨】/gu)].length, 1,
    '相邻楼重复的预设剧情时间只能注入一次');
assert.match(timedRendered, /【剧情时间推进：当晚】[\s\S]*众人在旅店留宿[\s\S]*【剧情时间推进：次日清晨】[\s\S]*众人动身前往北门/u);
assert.match(timedRendered, /本楼摘要：<user>指出矿场和盐沼由自己打下，角色只在之后半年内扩建少量目标。/u,
    '结构化事件不得替换并丢失信息更完整的逐楼总结');
assert.match(timedRendered, /补充事件：[\s\S]*<user>质疑领地归属。/u,
    '完整逐楼总结和经过证据校验的结构化事件应同时进入 L2');

console.log('visible-floor narrative smoke: chapters, current-user exclusion, atomic events, and cross-day time segments passed');
