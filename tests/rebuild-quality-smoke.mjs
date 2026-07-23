import assert from 'node:assert/strict';

const {
    buildRebuildSegmentRanges,
    buildMissingRebuildSegmentPayloads,
    handleHistoryRebuildCommit,
    handleHistoryRebuildSegment,
    normalizeHistoryUserSummary,
    recoverEvidence,
    validateHistorySegment,
} = await import('../src/rebuild.js');
const { validateChapterArchive } = await import('../src/archive.js');
const { handleChapterSummaryJob, markChapterStaleForTurnSummaryEdit } = await import('../src/chapter.js');
const { displayNarrativeText, isUsableMemoryEntry } = await import('../src/quality.js');
const { normalizedTurnSummaries, uncoveredTurnSummaryGroups } = await import('../src/ui/panel.js');
const { renderL1Block } = await import('../src/render.js');
const { validateVolumeResult } = await import('../src/volume.js');

const sources = Array.from({ length: 25 }, (_, floor) => ({
    pair: { pairIndex: floor, floorKey: `floor-${floor}`, contentFingerprint: `fp-${floor}` },
    userText: floor === 3 ? '我只是不喜欢熟的鱼' : `我推进第 ${floor} 轮`,
    aiText: floor === 3 ? '林许记下偏好并调整了用餐安排。' : `角色回应并完成第 ${floor} 轮安排。`,
    sourceText: floor === 3 ? '我只是不喜欢熟的鱼\n林许记下偏好并调整了用餐安排。' : `我推进第 ${floor} 轮\n角色回应并完成第 ${floor} 轮安排。`,
    bodyMode: 'regex',
}));
assert.deepEqual(buildRebuildSegmentRanges(Array.from({ length: 57 }, (_, pairIndex) => ({ pairIndex })), 25),
    [[0, 12], [13, 24], [25, 37], [38, 49], [50, 56]],
    'each full chapter must be split into its own front and back segments');
const resumePairs = Array.from({ length: 25 }, (_, pairIndex) => ({ pairIndex }));
const resumeDone = new Set(resumePairs.map(pair => pair.pairIndex).filter(pairIndex => pairIndex !== 7));
assert.deepEqual(buildMissingRebuildSegmentPayloads(resumePairs, resumeDone, 25), [
    { startPair: 0, endPair: 12, pairIndexes: [7] },
], 'resume must request only the missing floor, not repay for its whole segment');
const completeFloors = sources.map(source => ({
    floor: source.pair.pairIndex,
    summary: `<user>推进第 ${source.pair.pairIndex} 轮，角色作出回应，安排得到确认。`,
    facts: source.pair.pairIndex === 3 ? [{
        slot: 'other', subject: '<user>', object: '', value: '不喜欢熟鱼，喜欢其他海鲜',
        evidence: '我只是不喜欢熟的鱼', why_persistent: '会影响后续饮食安排',
    }] : [],
}));

const validSegment = validateHistorySegment({ floors: completeFloors }, sources, '伯滔');
assert.equal(validSegment.ok, true, validSegment.errors.join('\n'));
assert.equal(validSegment.floors[3].facts[0].subject, '<user>');
assert.equal(validateHistorySegment({ floors: completeFloors.slice(0, -1) }, sources).ok, false,
    'missing the last floor must be rejected');
assert.equal(validateHistorySegment({ floors: completeFloors.map((item, index) => index === 24 ? { ...item, floor: 23 } : item) }, sources).ok, false,
    'duplicate floors must be rejected');
assert.equal(validateHistorySegment({ floors: completeFloors.map((item, index) => index === 24 ? { ...item, floor: 99 } : item) }, sources).ok, false,
    'out-of-range floors must be rejected');
const oneBadSummary = structuredClone(completeFloors);
oneBadSummary[7].summary = '林许独自完成了回应。';
const partialSegment = validateHistorySegment({ floors: oneBadSummary }, sources, '伯滔');
assert.equal(partialSegment.ok, false);
assert.equal(partialSegment.floors.length, 24, 'valid floors must survive a neighboring summary failure');
assert.deepEqual(partialSegment.failedFloors.map(item => item.floor), [7], 'only the bad floor should be retried');

const badEvidence = structuredClone(completeFloors);
badEvidence[3].facts[0].evidence = '原文从未出现的句子';
const badEvidenceResult = validateHistorySegment({ floors: badEvidence }, sources);
assert.equal(badEvidenceResult.ok, true, 'an invalid optional fact must not reject the usable turn summary');
assert.equal(badEvidenceResult.floors[3].facts.length, 0, 'invented evidence must drop only its fact');
assert.match(badEvidenceResult.warnings.join('\n'), /不可靠事实/u);
const badRelationship = structuredClone(completeFloors);
badRelationship[3].facts = [{
    slot: 'relationship', subject: '<user>', object: '林许', value: '信任', old_value: '戒备',
    evidence: '林许记下偏好',
}];
const badRelationshipResult = validateHistorySegment({ floors: badRelationship }, sources);
assert.equal(badRelationshipResult.ok, true, 'an invalid relationship fact must not reject the summary');
assert.equal(badRelationshipResult.floors[3].facts.length, 0,
    'a relationship change without new_value must be dropped');

assert.equal(normalizeHistoryUserSummary('伯滔说明自己的饮食偏好。', '伯滔'), '<user>说明自己的饮食偏好。');
assert.equal(normalizeHistoryUserSummary('用户说明自己的饮食偏好。', '伯滔'), '<user>说明自己的饮食偏好。');
assert.equal(normalizeHistoryUserSummary('你说明自己的饮食偏好。', '伯滔'), '<user>说明自己的饮食偏好。');
assert.equal(recoverEvidence('“我只是不喜欢熟的鱼”', sources[3].sourceText), '我只是不喜欢熟的鱼');
assert.equal(recoverEvidence('我只是不喜欢熟的鱼，林许记下偏好并调整了用餐安排。', '我只是不喜欢熟的鱼\n林许记下偏好并调整了用餐安排。'),
    '我只是不喜欢熟的鱼\n林许记下偏好并调整了用餐安排。', 'whitespace and punctuation differences should recover original text');
const longEvidence = '这是原文中的一段连续证据'.repeat(8);
assert.equal([...recoverEvidence(longEvidence, longEvidence)].length, 50, 'long exact evidence should be safely shortened');

const segmentChat = [
    { is_user: true, mes: '我提出第零轮要求', send_date: 'su0', extra: { layered_memory_id: 'su0' } },
    { is_user: false, mes: '林许接受第零轮要求', send_date: 'sa0', extra: { layered_memory_id: 'sa0' } },
    { is_user: true, mes: '我提出第一轮要求', send_date: 'su1', extra: { layered_memory_id: 'su1' } },
    { is_user: false, mes: '林许接受第一轮要求', send_date: 'sa1', extra: { layered_memory_id: 'sa1' } },
];
const segmentStaging = {
    status: 'running', total: 2, completed: 0, baseline: 1, phase: '',
    turn_summaries: [], entries: [], fact_events: [], chapters: [], extracted_keys: [],
    unresolved_floors: [], warnings: [],
};
const segmentData = { history_rebuild: segmentStaging };
const segmentPrompts = [];
const segmentResponses = [
    { floors: [
        { floor: 0, summary: '伯滔提出第零轮要求，林许接受要求并准备执行。', facts: [{ slot: 'promise', subject: '林许', object: '', value: '接受第零轮要求', evidence: '模型编造的证据' }] },
        { floor: 1, summary: '林许接受了第一轮要求并准备执行。', facts: [] },
    ] },
    { floors: [{ floor: 1, summary: '用户提出第一轮要求，林许接受要求并准备执行。', facts: [] }] },
];
globalThis.SillyTavern = { getContext: () => ({
    chat: segmentChat,
    name1: '伯滔',
    chatMetadata: { layered_memory: segmentData },
    extensionSettings: { layered_memory: { memoryModelSource: 'current', bodyExtractionRegex: '' } },
    generateRaw: async ({ prompt }) => {
        segmentPrompts.push(prompt);
        return JSON.stringify(segmentResponses.shift());
    },
    saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
}) };
await handleHistoryRebuildSegment({ startPair: 0, endPair: 1, pairIndexes: [0, 1] });
assert.equal(segmentPrompts.length, 2, 'one bad floor should trigger one focused retry');
assert.match(segmentPrompts[1], /【第 1 轮】/u);
assert.doesNotMatch(segmentPrompts[1], /【第 0 轮】/u, 'the focused retry must not repay for a valid floor');
assert.deepEqual(segmentStaging.turn_summaries.map(item => item.pairIndex).sort((a, b) => a - b), [0, 1]);
assert.equal(segmentStaging.turn_summaries[0].summary.startsWith('<user>'), true);
assert.equal(segmentStaging.warnings.length, 1, 'the invented optional fact should become a warning');
assert.equal(segmentStaging.fact_events.length, 0, 'the invented fact must not enter staging');
assert.equal(segmentStaging.unresolved_floors.length, 0);

const reviewData = {
    state_table: { version: 1, entries: [], changelog: [] },
    turn_summaries: [{ pairIndex: 77, summary: '仍在使用的正式旧结果' }],
    history_rebuild: {
        status: 'running', stage_mode: 'turns', total: 2, completed: 2, baseline: 1, startedAt: 1,
        turn_summaries: structuredClone(segmentStaging.turn_summaries), entries: [], fact_events: [], chapters: [], extracted_keys: [],
    },
    progress: { baseline_pair: 1 },
};
globalThis.SillyTavern = { getContext: () => ({
    chat: segmentChat,
    name1: '伯滔',
    chatMetadata: { layered_memory: reviewData },
    extensionSettings: { layered_memory: { chapterSize: 25 } },
    saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
}) };
await handleHistoryRebuildCommit();
assert.equal(reviewData.history_rebuild.status, 'review', 'turn generation must stop for user review before chapters');
assert.equal(reviewData.history_rebuild.stage_mode, 'turns');
assert.equal(reviewData.turn_summaries[0].pairIndex, 77, 'review drafts must not replace the formal old result');
assert.equal(reviewData.history_rebuild.chapters.length, 0, 'review transition must not generate chapters');

const chapterSummary = '本章按照时间顺序完整回顾了用户的行动、角色回应、因果结果与后续安排。'.repeat(14);
const coverage = sources.map((source, index) => ({ floor: source.pair.pairIndex, event_index: index < 13 ? 0 : 1 }));
const validChapter = {
    summary: chapterSummary,
    key_events: [
        { floor_range: [0, 12], text: '前半段事件得到推进并形成阶段性结果。' },
        { floor_range: [13, 24], text: '后半段继续发展并明确后续安排。' },
    ],
    coverage,
    keywords: ['林许', '安排', '饮食偏好'],
};
assert.equal(validateChapterArchive(validChapter, 0, 24).ok, true);
assert.equal(validateChapterArchive({ ...validChapter, coverage: coverage.slice(0, -1) }, 0, 24).ok, false,
    'chapter coverage must include every floor');
assert.equal(validateChapterArchive({ ...validChapter, key_events: [validChapter.key_events[0]] }, 0, 24).ok, false,
    'chapter events must cover the second half');

const usable = { slot: 'identity', subject: '<user>', object: '', value: '是诡秘之神', evidence: '你就是诡秘之神', source: 'auto' };
for (const entry of [
    { ...usable, subject: '' },
    { ...usable, value: '' },
    { ...usable, value: 'undefined' },
    { ...usable, slot: 'unknown' },
    { ...usable, evidence: '' },
]) assert.equal(isUsableMemoryEntry(entry), false);
assert.equal(isUsableMemoryEntry(usable), true);
assert.equal(displayNarrativeText('<user>说明偏好，林许作出回应。', { name1: '伯滔' }), '伯滔说明偏好，林许作出回应。',
    'stable internal user labels must be human-readable in the UI');
assert.doesNotMatch(renderL1Block({ state_table: { entries: [usable, { ...usable, id: 'bad', value: 'undefined' }] } }), /undefined/u,
    'injection must omit quarantined-quality entries');

const visibleTurns = normalizedTurnSummaries({ turn_summaries: [
    { pairIndex: 2, summary: '第三轮' }, { pairIndex: 0, summary: '第一轮' },
    { pairIndex: 1, summary: '第二轮' }, { pairIndex: 7, summary: '尾部第一轮' },
    { pairIndex: 8, summary: '尾部第二轮' }, { pairIndex: 9, summary: '' },
] });
assert.deepEqual(visibleTurns.map(item => item.pairIndex), [0, 1, 2, 7, 8],
    'visible per-turn records must be valid and chronologically ordered');
assert.deepEqual(uncoveredTurnSummaryGroups(visibleTurns, [{ floor_range: [0, 2] }]).map(group => group.map(item => item.pairIndex)), [[7, 8]],
    'records not yet merged into a chapter must remain visible as a contiguous tail group');

const chapters = [{ id: 'ch_001' }, { id: 'ch_002' }];
assert.equal(validateVolumeResult({ summary: '林许完整回顾', covered_chapter_ids: ['ch_001'] }, chapters, ['林许']).ok, false);
assert.equal(validateVolumeResult({ summary: '林许完整回顾', covered_chapter_ids: ['ch_001', 'ch_002'] }, chapters, ['林许']).ok, true);

const targetedData = {
    chapters: [
        { id: 'ch_001', floor_range: [0, 24], stale: false, volume_id: 'vol_1' },
        { id: 'ch_002', floor_range: [25, 49], stale: false, volume_id: null },
    ],
    volumes: [{ id: 'vol_1', stale: false }],
};
assert.deepEqual(markChapterStaleForTurnSummaryEdit(targetedData, 24), ['ch_001']);
assert.equal(targetedData.chapters[0].stale_reason, 'turn_summary_edit');
assert.equal(targetedData.chapters[1].stale, false, 'editing floor 24 must not invalidate the next chapter');
assert.equal(targetedData.volumes[0].stale, true, 'an owning long-term summary must be marked stale without auto-regeneration');

const chat = [];
for (let index = 0; index < 4; index += 1) {
    chat.push({ is_user: true, mes: `用户 ${index}`, extra: { layered_memory_id: `u${index}` } });
    chat.push({ is_user: false, mes: `回复 ${index}`, extra: { layered_memory_id: `a${index}` } });
}
chat.push({ is_user: true, mes: '下一轮尚未回复', extra: { layered_memory_id: 'u4' } });
const preservedManual = { id: 'e_0007', slot: 'identity', subject: '<user>', object: '', value: '手动确认身份', source: 'manual', pinned: false };
const preservedPinned = { id: 'e_0008', slot: 'promise', subject: '林许', object: '', value: '保留约定', evidence: '保留约定', source: 'auto', pinned: true };
const oldAuto = { id: 'e_0009', slot: 'world', subject: '旧世界', object: '', value: '将被替换', evidence: '将被替换', source: 'auto', pinned: false };
const stagedSummary = index => ({ floorKey: `u${index}+a${index}`, pairIndex: index, contentFingerprint: `fp${index}`, summary: `<user>推进第 ${index} 轮。` });
const preservedManualTurn = { ...stagedSummary(0), summary: '<user>人工修正了第 0 轮剧情。', manual_override: true, updatedAt: 99 };
const commitData = {
    version: 3,
    state_table: { version: 1, entries: [preservedManual, preservedPinned, oldAuto], changelog: [] },
    turn_summaries: [preservedManualTurn, { pairIndex: 99, summary: '旧自动摘要' }],
    floor_events: [], manual_events: [], branch_checkpoints: [], branch_origin: null,
    history_backfill: { status: 'idle', total: 0, completed: 0 },
    chapters: [{ id: 'ch_004', summary: '用户人工改写章节', floor_range: [0, 1], pinned: false, manual_override: true, keywords: [] }],
    volumes: [{ id: 'vol_old', chapter_ids: [], summary: '旧长期摘要' }], keyword_index: {}, review_queue: [{ id: 'old', kind: 'proofread' }], notices: [],
    quarantined_entries: [], rebuild_backup: { marker: 'old-results-remain-recoverable' },
    history_rebuild: {
        status: 'running', stage_mode: 'chapters', total: 4, completed: 4, startedAt: 1, baseline: 3,
        turn_summaries: [0, 1, 2, 3].map(stagedSummary),
        entries: [{ slot: 'identity', subject: '林许', object: '', value: '是防卫局特工', evidence: '回复 2', source: 'auto', established_floor: 2, updated_floor: 2 }],
        fact_events: [{ floor: 2, fact: { slot: 'identity', subject: '林许', object: '', value: '是防卫局特工', evidence: '回复 2', source: 'auto' } }],
        chapters: [
            { id: 'staged_1', summary: '自动第一章', floor_range: [0, 1], keywords: ['第一章'], key_events: [], coverage: [] },
            { id: 'staged_2', summary: '自动第二章', floor_range: [2, 3], keywords: ['林许'], key_events: [], coverage: [] },
        ],
        extracted_keys: ['migrated:u0+a0', 'migrated:u1+a1', 'migrated:u2+a2', 'migrated:u3+a3'],
    },
    pending_floors: [], extracted_keys: [],
    job_queue: { scope_id: 'commit-test', paused: true, queued: [], running: null, failed: [] },
    progress: { baseline_pair: 3, last_chapter_end_pair: -1, next_entry_seq: 10, next_chapter_seq: 5, pairs_since_proofread: 0 },
    context_handoff: null, logs: [],
};
globalThis.SillyTavern = { getContext: () => ({
    chat,
    name1: '伯滔',
    chatMetadata: { layered_memory: commitData },
    extensionSettings: { layered_memory: { chapterSize: 2 } },
    saveMetadata: async () => {}, saveSettingsDebounced: () => {},
}) };
await handleHistoryRebuildCommit();
assert.equal(commitData.state_table.entries.some(entry => entry.value === '将被替换'), false);
assert.equal(commitData.state_table.entries.some(entry => entry.id === 'e_0007'), true, 'manual entries must survive the swap');
assert.equal(commitData.state_table.entries.some(entry => entry.id === 'e_0008'), true, 'pinned entries must survive the swap');
assert.equal(commitData.state_table.entries.some(entry => entry.value === '是防卫局特工'), true);
assert.equal(commitData.chapters.some(chapter => chapter.manual_override && chapter.floor_range[0] === 0), true,
    'manually edited chapters must survive the swap');
assert.equal(commitData.chapters.some(chapter => chapter.floor_range[0] === 2), true);
assert.deepEqual(commitData.rebuild_backup, { marker: 'old-results-remain-recoverable' });
assert.equal(commitData.history_rebuild.status, 'complete');
assert.equal(commitData.history_backfill.completed, 4);
assert.equal(commitData.turn_summaries.find(summary => summary.pairIndex === 0).summary, '<user>人工修正了第 0 轮剧情。',
    'a manual per-turn correction for unchanged source text must survive future rebuilds');
assert.equal(commitData.review_queue.length, 0);
assert.equal(commitData.floor_events.find(event => event.pairIndex === 2).entryChanges.length, 1,
    'rebuilt facts must produce fresh fork-replay events');
assert.equal(commitData.branch_checkpoints[0].anchorPairIndex, -1, 'fork replay must start from a clean rebuilt seed');

const incompleteChat = [];
for (let index = 0; index < 3; index += 1) {
    incompleteChat.push({ is_user: true, mes: `未完成用户 ${index}`, extra: { layered_memory_id: `iu${index}` } });
    incompleteChat.push({ is_user: false, mes: `未完成回复 ${index}`, extra: { layered_memory_id: `ia${index}` } });
}
const untouchedEntry = { id: 'old-safe', slot: 'identity', subject: '旧结果', object: '', value: '必须保留', evidence: '必须保留', source: 'auto' };
const incompleteData = {
    state_table: { version: 1, entries: [untouchedEntry], changelog: [] },
    turn_summaries: [{ pairIndex: 88, summary: '正式旧结果' }],
    history_rebuild: {
        status: 'running', total: 3, completed: 2, baseline: 2, startedAt: 1,
        turn_summaries: [0, 1].map(stagedSummary), entries: [], fact_events: [], chapters: [], extracted_keys: [],
    },
    progress: { baseline_pair: 2 },
};
globalThis.SillyTavern = { getContext: () => ({
    chat: incompleteChat,
    name1: '伯滔',
    chatMetadata: { layered_memory: incompleteData },
    extensionSettings: { layered_memory: { chapterSize: 25 } },
    saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
}) };
await handleHistoryRebuildCommit();
assert.equal(incompleteData.history_rebuild.status, 'error');
assert.match(incompleteData.history_rebuild.error, /第 2 轮/u);
assert.equal(incompleteData.state_table.entries[0].id, 'old-safe', 'an incomplete rebuild must not replace old facts');
assert.equal(incompleteData.turn_summaries[0].pairIndex, 88, 'an incomplete rebuild must not replace old summaries');

const targetedChapterPrompts = [];
const targetedChapterData = {
    state_table: { version: 1, entries: [], changelog: [] },
    turn_summaries: Array.from({ length: 50 }, (_, pairIndex) => ({ pairIndex, summary: `<user>推进第 ${pairIndex} 轮，林许回应并形成结果。` })),
    chapters: [
        { id: 'ch_keep_1', floor_range: [0, 24], summary: '需要更新的旧章节', keywords: ['旧章节'], key_events: [], coverage: [], stale: true, stale_reason: 'turn_summary_edit', manual_override: true },
        { id: 'ch_keep_2', floor_range: [25, 49], summary: '绝不能改变的相邻章节', keywords: ['相邻章节'], key_events: [], coverage: [], stale: false },
    ],
    volumes: [], keyword_index: {}, progress: { baseline_pair: 49, last_chapter_end_pair: 49, next_chapter_seq: 3 },
};
const regeneratedChapter = {
    summary: chapterSummary,
    key_events: validChapter.key_events,
    coverage: validChapter.coverage,
    keywords: validChapter.keywords,
};
globalThis.SillyTavern = { getContext: () => ({
    chat: [], name1: '伯滔',
    chatMetadata: { layered_memory: targetedChapterData },
    extensionSettings: { layered_memory: { memoryModelSource: 'current' } },
    generateRaw: async ({ prompt }) => {
        targetedChapterPrompts.push(prompt);
        return JSON.stringify(regeneratedChapter);
    },
    saveMetadata: async () => {}, saveSettingsDebounced: () => {}, saveChat: async () => {},
}) };
await handleChapterSummaryJob({ startPair: 0, endPair: 24, reason: 'turn_summary_edit' });
assert.equal(targetedChapterPrompts.length, 1, 'targeted regeneration must make exactly one chapter request');
assert.doesNotMatch(targetedChapterPrompts[0], /【第 25 轮】/u, 'targeted regeneration must not include the neighboring chapter');
assert.equal(targetedChapterData.chapters[0].id, 'ch_keep_1', 'targeted regeneration must preserve the chapter id');
assert.equal(targetedChapterData.chapters[0].stale, false);
assert.equal(targetedChapterData.chapters[0].stale_reason, null);
assert.equal(targetedChapterData.chapters[0].manual_override, false);
assert.equal(targetedChapterData.chapters[1].summary, '绝不能改变的相邻章节');

console.log('rebuild quality smoke: validation gates, visible turn records, and atomic replacement passed');
