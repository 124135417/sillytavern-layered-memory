import assert from 'node:assert/strict';

const { buildRebuildSegmentRanges, handleHistoryRebuildCommit, validateHistorySegment } = await import('../src/rebuild.js');
const { validateChapterArchive } = await import('../src/archive.js');
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

const badEvidence = structuredClone(completeFloors);
badEvidence[3].facts[0].evidence = '原文从未出现的句子';
assert.equal(validateHistorySegment({ floors: badEvidence }, sources).ok, false, 'invented evidence must be rejected');
const badRelationship = structuredClone(completeFloors);
badRelationship[3].facts = [{
    slot: 'relationship', subject: '<user>', object: '林许', value: '信任', old_value: '戒备',
    evidence: '林许记下偏好',
}];
assert.equal(validateHistorySegment({ floors: badRelationship }, sources).ok, false,
    'a relationship change without new_value must be rejected');

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
const commitData = {
    version: 3,
    state_table: { version: 1, entries: [preservedManual, preservedPinned, oldAuto], changelog: [] },
    turn_summaries: [{ pairIndex: 99, summary: '旧自动摘要' }],
    floor_events: [], manual_events: [], branch_checkpoints: [], branch_origin: null,
    history_backfill: { status: 'idle', total: 0, completed: 0 },
    chapters: [{ id: 'ch_004', summary: '用户人工改写章节', floor_range: [0, 1], pinned: false, manual_override: true, keywords: [] }],
    volumes: [{ id: 'vol_old', chapter_ids: [], summary: '旧长期摘要' }], keyword_index: {}, review_queue: [{ id: 'old', kind: 'proofread' }], notices: [],
    quarantined_entries: [], rebuild_backup: { marker: 'old-results-remain-recoverable' },
    history_rebuild: {
        status: 'running', total: 4, completed: 4, startedAt: 1, baseline: 3,
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
assert.equal(commitData.review_queue.length, 0);
assert.equal(commitData.floor_events.find(event => event.pairIndex === 2).entryChanges.length, 1,
    'rebuilt facts must produce fresh fork-replay events');
assert.equal(commitData.branch_checkpoints[0].anchorPairIndex, -1, 'fork replay must start from a clean rebuilt seed');

console.log('rebuild quality smoke: validation gates, visible turn records, and atomic replacement passed');
