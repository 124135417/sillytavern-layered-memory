import assert from 'node:assert/strict';

const message = (id, isUser, mes) => ({
    is_user: isUser,
    mes,
    send_date: id,
    extra: { layered_memory_id: id },
});

const chat = [
    message('u0', true, 'OLD_USER_0'),
    message('a1', false, 'OLD_ASSISTANT_1'),
    message('u2', true, 'OLD_USER_2'),
    message('a3', false, 'OLD_ASSISTANT_3'),
    message('u4', true, '（重置文风 阿尔德瑞斯不要这么机械化，活分一点！）\n\n我把钥匙放到桌上。'),
];
const data = {
    version: 6,
    state_table: { version: 1, entries: [], changelog: [] },
    narrative_summaries: [], narrative_chapters: [], narrative_volumes: [],
    turn_summaries: [], chapters: [], volumes: [], keyword_index: {},
    fact_ledger: [], fact_decisions: [], review_queue: [], notices: [], quarantined_entries: [],
    floor_events: [], manual_events: [], branch_checkpoints: [], branch_origin: null,
    pending_floors: [], extracted_keys: [], logs: [],
    job_queue: { scope_id: 'style-reset', paused: false, queued: [], running: [], failed: [] },
    progress: { baseline_pair: -1, last_chapter_end_pair: -1, pairs_since_proofread: 0, next_entry_seq: 1, next_chapter_seq: 1 },
};
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
const context = {
    chat,
    mainApi: 'openai',
    symbols: { ignore: Symbol.for('sillytavern.ignore') },
    extensionSettings: { layered_memory: settings },
    chatMetadata: { layered_memory: data },
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    setExtensionPrompt: () => {},
    name1: '用户',
    name2: '阿尔德瑞斯',
};
globalThis.SillyTavern = { getContext: () => context };

const {
    parseStyleResetCommand,
    resolveStyleReset,
    stripStyleResetCommands,
} = await import('../src/style-reset.js');
const {
    currentNarrativeSources,
    ensureStyleResetNarrativeCoverage,
    fallbackNarrativeSummary,
} = await import('../src/narrative.js');
const { buildCoreMemoryParts } = await import('../src/inject.js');

assert.equal(parseStyleResetCommand('（重置文风）'), null, '空指令不得触发');
assert.equal(parseStyleResetCommand('（重置文风没有空格）'), null, '关键词后没有空格不得触发');
assert.equal(parseStyleResetCommand('(重置文风 活分一点)'), null, '半角括号不得误触发');
assert.equal(parseStyleResetCommand('（重置文风 活分一点）')?.directive, '活分一点');
const stripped = stripStyleResetCommands(chat[4].mes);
assert.equal(stripped.text, '我把钥匙放到桌上。');
assert.equal(stripped.commands[0].directive, '阿尔德瑞斯不要这么机械化，活分一点！');

let reset = resolveStyleReset();
assert.equal(reset.messageIndex, 4);
assert.equal(reset.active, true);
assert.equal(reset.directive, '阿尔德瑞斯不要这么机械化，活分一点！');

const allSources = currentNarrativeSources({ includeTrailingUser: true });
assert.equal(allSources.at(-1).narrativeText, '我把钥匙放到桌上。');
assert.doesNotMatch(allSources.at(-1).timeSourceText, /重置文风|机械化/u,
    '控制指令不得进入楼层摘要或时间证据');
for (const source of allSources.slice(0, -1)) {
    data.narrative_summaries.push({
        messageKey: source.messageKey,
        messageIndex: source.messageIndex,
        role: source.role,
        contentFingerprint: source.contentFingerprint,
        summary: `SUMMARY_${source.messageIndex}`,
    });
}

const ready = await ensureStyleResetNarrativeCoverage();
assert.deepEqual(ready, { status: 'ready', resetFloor: 4, coveredThrough: 3 });

let generationSources = currentNarrativeSources().map(source => ({
    ...source,
    fallbackSummary: fallbackNarrativeSummary(source),
}));
let parts = buildCoreMemoryParts({ data, settings, context, narrativeSources: generationSources, pairs: [] });
assert.equal(parts.styleReset.messageIndex, 4);
assert.equal(parts.raw, '', '紧邻重置后的生成不得携带任何旧正文原文');
assert.match(parts.l2, /SUMMARY_3/u, '上一层必须由现有逐楼剧情记录承接');
assert.match(parts.l2, /摘要截至第 3 楼；紧随其后的完整原文从第 4 楼开始/u);

context.chat.push(message('a5', false, 'NEW_ASSISTANT_5'));
context.chat.push(message('u6', true, '继续当前剧情。'));
reset = resolveStyleReset();
assert.equal(reset.active, false, '下一轮普通用户消息不得重复注入上次文风要求');
generationSources = currentNarrativeSources().map(source => ({
    ...source,
    fallbackSummary: fallbackNarrativeSummary(source),
}));
parts = buildCoreMemoryParts({ data, settings, context, narrativeSources: generationSources, pairs: [] });
assert.equal(parts.rawWindow.startFloor, 4);
assert.match(parts.raw, /我把钥匙放到桌上。[\s\S]*NEW_ASSISTANT_5/u);
assert.doesNotMatch(parts.raw, /OLD_USER|OLD_ASSISTANT|重置文风|机械化/u,
    '边界以前的正文和控制指令都不得重新进入近期原文');

context.chat.pop();
assert.equal(resolveStyleReset({ excludeTrailingAssistant: true }).active, true,
    '划卡必须继续以同一条用户重置消息作为活动请求');

data.narrative_summaries = data.narrative_summaries.filter(item => item.messageIndex !== 3);
const { registerHandler } = await import('../src/queue.js');
registerHandler('narrative_summary', async payload => {
    for (let index = 0; index < payload.messageKeys.length; index += 1) {
        const source = allSources.find(item => item.messageKey === payload.messageKeys[index]
            && item.contentFingerprint === payload.fingerprints[index]);
        if (!source) continue;
        data.narrative_summaries.push({
            messageKey: source.messageKey,
            messageIndex: source.messageIndex,
            role: source.role,
            contentFingerprint: source.contentFingerprint,
            summary: `WAITED_SUMMARY_${source.messageIndex}`,
        });
    }
});
const waited = await ensureStyleResetNarrativeCoverage({ excludeTrailingAssistant: true, timeoutMs: 2_000 });
assert.deepEqual(waited, { status: 'ready', resetFloor: 4, coveredThrough: 3 });
assert.equal(data.narrative_summaries.find(item => item.messageIndex === 3)?.summary, 'WAITED_SUMMARY_3',
    '正文生成屏障必须真正等到优先楼层记录写入');

console.log('style reset smoke: parser, coverage gate, raw boundary, and swipe projection passed');
