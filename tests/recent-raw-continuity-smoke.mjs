import assert from 'node:assert/strict';

const { estimateTokens } = await import('../src/tokens.js');
const { renderRecentRawBlock, selectRecentRawWindow } = await import('../src/recent-raw.js');

const source = (messageIndex, text = `RAW_FLOOR_${messageIndex}`) => ({
    messageIndex,
    messageKey: `message-${messageIndex}`,
    role: messageIndex % 2 ? 'user' : 'assistant',
    text,
    narrativeText: text,
    contentFingerprint: `fingerprint-${messageIndex}`,
    fallbackSummary: `SUMMARY_${messageIndex}`,
});

const largeSources = Array.from({ length: 10 }, (_, index) => source(index, `${index}:` + '剧情原文。'.repeat(700)));
for (const budget of [8000, 16000, 32000]) {
    const window = selectRecentRawWindow(largeSources, budget);
    assert.ok(window.tokens <= budget, `${budget} allowance must not be exceeded`);
    assert.equal(window.endFloor, largeSources.at(-1).messageIndex);
    assert.deepEqual(window.sources.map(item => item.messageIndex),
        Array.from({ length: window.sources.length }, (_, offset) => window.startFloor + offset),
        'raw history must be a continuous suffix of whole floors');
    for (const item of window.sources) assert.match(window.text, new RegExp(`${item.messageIndex}:剧情原文`));
}
assert.ok(selectRecentRawWindow(largeSources, 16000).sources.length
    >= selectRecentRawWindow(largeSources, 8000).sources.length);
assert.ok(selectRecentRawWindow(largeSources, 32000).sources.length
    >= selectRecentRawWindow(largeSources, 16000).sources.length);

const oneFloorTokens = estimateTokens(renderRecentRawBlock([largeSources.at(-1)]));
assert.deepEqual(selectRecentRawWindow(largeSources, oneFloorTokens - 1).sources, [],
    'an oversized newest floor must fall back to summary coverage instead of being cut');

const sources = Array.from({ length: 8 }, (_, index) => source(index));
const data = {
    state_table: { version: 1, entries: [{
        id: 'fact_001', slot: 'identity', subject: '阿尔德瑞思', object: '',
        value: '是深渊生物', evidence: '深渊生物', source: 'auto', established_floor: 0, updated_floor: 0,
    }], changelog: [] },
    narrative_summaries: sources.map(item => ({
        messageKey: item.messageKey,
        messageIndex: item.messageIndex,
        role: item.role,
        contentFingerprint: item.contentFingerprint,
        summary: item.fallbackSummary,
    })),
    narrative_chapters: [{ id: 'nch_001', floor_range: [0, 4], summary: 'CHAPTER_0_4', stale: false }],
    narrative_volumes: [],
    fact_ledger: [], fact_decisions: [],
};
const context = { name1: '用户', name2: '阿尔德瑞思' };
const settings = { budgetL1: 2000, budgetL2: 5000 };
const { buildCoreMemoryParts } = await import('../src/inject.js');

const lastThreeBudget = estimateTokens(renderRecentRawBlock(sources.slice(-3)));
let parts = buildCoreMemoryParts({
    data,
    settings: { ...settings, recentRawTokens: lastThreeBudget },
    context,
    pairs: [],
    narrativeSources: sources,
});
assert.equal(parts.rawWindow.startFloor, 5);
assert.match(parts.l2, /CHAPTER_0_4/u);
assert.doesNotMatch(parts.l2, /SUMMARY_5/u);
const payload = [parts.l1, parts.l2, parts.raw].filter(Boolean).join('\n\n');
assert.ok(payload.indexOf('当前确立的事实') < payload.indexOf('CHAPTER_0_4'));
assert.ok(payload.indexOf('CHAPTER_0_4') < payload.indexOf('RAW_FLOOR_5'));
assert.match(parts.l2, /摘要截至第 4 楼；紧随其后的完整原文从第 5 楼开始/u);

const lastFiveBudget = estimateTokens(renderRecentRawBlock(sources.slice(-5)));
parts = buildCoreMemoryParts({
    data,
    settings: { ...settings, recentRawTokens: lastFiveBudget },
    context,
    pairs: [],
    narrativeSources: sources,
});
assert.equal(parts.rawWindow.startFloor, 3);
assert.doesNotMatch(parts.l2, /CHAPTER_0_4/u,
    'a chapter crossing the raw cutoff must not overlap the raw window');
assert.match(parts.l2, /SUMMARY_0[\s\S]*SUMMARY_1[\s\S]*SUMMARY_2/u);
assert.doesNotMatch(parts.l2, /SUMMARY_3/u);
assert.match(parts.raw, /RAW_FLOOR_3[\s\S]*RAW_FLOOR_7/u);

console.log('recent raw continuity smoke: fixed budgets, whole floors, cutoff fallback, and payload order passed');
