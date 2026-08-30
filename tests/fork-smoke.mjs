import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function fnv1a(value, seed = 0x811c9dc5) {
    let hash = seed;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function pair(index, aiText = `a${index}`) {
    const payload = [`u${index}`, `a${index}`, `u${index}`, aiText].join('\0');
    return {
        pairIndex: index,
        floorKey: `u${index}+a${index}`,
        contentFingerprint: `v1:${fnv1a(payload)}${fnv1a(payload, 0x9e3779b9)}:${payload.length}`,
        sealed: true,
    };
}

const blankQueue = () => ({ scope_id: 'parent-scope', paused: false, queued: [{ id: 'old-job', type: 'extract' }], running: null, failed: [] });
const parent = {
    version: 2,
    state_table: {
        version: 3,
        entries: [
            { id: 'e_0001', slot: 'identity', subject: '甲', value: '未来身份' },
            { id: 'e_0002', slot: 'possession', subject: '乙', value: '钥匙' },
        ],
        changelog: [],
    },
    turn_summaries: [0, 1, 2].map(i => ({ floorKey: `u${i}+a${i}`, pairIndex: i, contentFingerprint: pair(i).contentFingerprint, summary: `第${i}轮` })),
    floor_events: [
        { floorKey: 'u1+a1', pairIndex: 1, contentFingerprint: pair(1).contentFingerprint, recordedAt: 200, entryChanges: [{ op: 'upsert', after: { id: 'e_0002', slot: 'possession', subject: '乙', value: '钥匙' } }] },
        { floorKey: 'u2+a2', pairIndex: 2, contentFingerprint: pair(2).contentFingerprint, recordedAt: 300, entryChanges: [{ op: 'upsert', after: { id: 'e_0001', slot: 'identity', subject: '甲', value: '未来身份' } }] },
    ],
    manual_events: [],
    fact_ledger: [
        { id: 'fc1', floor: 1, floorKey: 'u1+a1', contentFingerprint: pair(1).contentFingerprint, fact: { slot: 'other', subject: '乙', object: '', value: '分支内发现' } },
        { id: 'fc2', floor: 2, floorKey: 'u2+a2', contentFingerprint: pair(2).contentFingerprint, fact: { slot: 'other', subject: '甲', object: '', value: '分支外发现' } },
    ],
    fact_decisions: [
        { id: 'fd1', candidateId: 'fc1', action: 'activate', anchorFloorKey: 'u1+a1', anchorPairIndex: 1, anchorFingerprint: pair(1).contentFingerprint },
        { id: 'fd2', candidateId: 'fc2', action: 'dismiss', anchorFloorKey: 'u2+a2', anchorPairIndex: 2, anchorFingerprint: pair(2).contentFingerprint },
    ],
    branch_checkpoints: [{
        id: 'cp0', anchorFloorKey: 'u0+a0', anchorPairIndex: 0, anchorFingerprint: pair(0).contentFingerprint, createdAt: 100, reason: 'seed',
        prefixFingerprints: [{ pairIndex: 0, floorKey: 'u0+a0', contentFingerprint: pair(0).contentFingerprint }],
        stateTable: { version: 1, entries: [{ id: 'e_0001', slot: 'identity', subject: '甲', value: '原身份' }], changelog: [{ op: 'old' }] },
    }],
    chapters: [
        { id: 'ch_1', floor_range: [0, 1], keywords: ['钥匙'], volume_id: 'vol_1', demoted: true },
        { id: 'ch_2', floor_range: [2, 3], keywords: ['未来'], volume_id: 'vol_2', demoted: true },
    ],
    volumes: [
        { id: 'vol_1', chapter_ids: ['ch_1'], summary: '过去' },
        { id: 'vol_2', chapter_ids: ['ch_2'], summary: '未来' },
    ],
    keyword_index: {},
    review_queue: [
        { id: 'r1', floorKey: 'u1+a1', kind: 'flag_conflict' },
        { id: 'r2', floorKey: 'u2+a2', kind: 'flag_conflict' },
    ],
    history_rebuild: { status: 'running', total: 3, completed: 2, turn_summaries: [{ pairIndex: 0 }] },
    rebuild_backup: { createdAt: 123 },
    pending_floors: [],
    extracted_keys: ['u0+a0', 'u1+a1', 'u2+a2'],
    job_queue: blankQueue(),
    progress: { baseline_pair: -1, last_chapter_end_pair: 3, next_entry_seq: 3, next_chapter_seq: 3 },
    logs: [],
};

const activeMetadata = { main_chat: 'Parent Chat' };
const activeChat = [
    { is_user: true, mes: 'u0', extra: { layered_memory_id: 'u0' } },
    { is_user: false, mes: 'a0', extra: { layered_memory_id: 'a0' } },
    { is_user: true, mes: 'u1', extra: { layered_memory_id: 'u1' } },
    { is_user: false, mes: 'a1', extra: { layered_memory_id: 'a1' } },
];
let saves = 0;
const context = {
    chat: activeChat,
    chatMetadata: activeMetadata,
    characterId: 0,
    groupId: null,
    characters: [{ name: '角色', avatar: 'avatar.png' }],
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveMetadata: async () => { saves += 1; },
    saveChat: async () => {},
};
let currentContext = context;
globalThis.SillyTavern = { getContext: () => currentContext };
globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/chats/get');
    assert.equal(JSON.parse(init.body).file_name, 'Parent Chat');
    return { ok: true, json: async () => [{ chat_metadata: { layered_memory: structuredClone(parent) } }] };
};

const { beginBranchRecovery, buildFreshBranchData, buildLegacyRebuildData, ensureCurrentBranchRecovery, reconcileCurrentHistory, replayBranchData, waitForBranchRecovery } = await import('../src/branch.js');
const { getMessageFloors, getPairs } = await import('../src/ids.js');
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const queueSource = await readFile(new URL('../src/queue.js', import.meta.url), 'utf8');
assert.match(indexSource, /layeredMemoryIntercept[\s\S]*await ensureCurrentBranchRecovery\(\)[\s\S]*await waitForBranchRecovery\(\)[\s\S]*updateInjection\(\{ generationType: type, excludeTrailingAssistant \}\)/u,
    'prompt interception must recover the active branch before updating injection');
assert.match(queueSource, /async function pump\(\)[\s\S]*await waitForBranchRecovery\(\)/u,
    'background jobs must wait for branch recovery');

const replayed = replayBranchData(parent, [pair(0), pair(1)], 'Parent Chat');
assert.deepEqual(replayed.state_table.entries.map(entry => [entry.id, entry.value]), [['e_0001', '原身份'], ['e_0002', '钥匙']]);
assert.deepEqual(replayed.turn_summaries.map(item => item.pairIndex), [0, 1]);
assert.deepEqual(replayed.chapters.map(item => item.id), ['ch_1']);
assert.deepEqual(replayed.volumes.map(item => item.id), ['vol_1']);
assert.deepEqual(replayed.review_queue.map(item => item.id), ['r1']);
assert.deepEqual(replayed.extracted_keys, ['u0+a0', 'u1+a1']);
assert.equal(replayed.job_queue.queued.length, 0);
assert.equal(replayed.history_rebuild, null, 'a fork must not inherit the parent branch rebuild workspace');
assert.equal(replayed.rebuild_backup, null, 'a fork must not expose the parent branch backup');
assert.deepEqual(replayed.fact_ledger.map(item => item.id), ['fc1'], 'fork must retain only discoveries grounded inside the verified prefix');
assert.deepEqual(replayed.fact_decisions.map(item => item.id), ['fd1'], 'fork must retain only decisions grounded inside the verified prefix');
assert.notEqual(replayed.job_queue.scope_id, 'parent-scope');
assert.equal(replayed.branch_origin.method, 'checkpoint_replay');
assert.equal(replayed.branch_checkpoints.every(point => point.stateTable.changelog.length === 0), true,
    'branch checkpoints must not recursively copy the changelog');

const backstageParent = structuredClone(parent);
backstageParent.backstage = {
    version: 2,
    activeSessionId: null,
    pendingGeneration: null,
    activeCarryover: {
        id: 'carry-1',
        text: '- 三轮后再揭晓幕后主使',
        sourceSessionId: 'session-1',
        sourceRevisionId: 'revision-1',
        anchorMessageKey: 'backstage-marker',
        createdAt: 1,
        updatedAt: 2,
    },
    sessions: [{
        id: 'session-1',
        anchorMessageKey: 'a1',
        markerMessageKey: 'backstage-marker',
        createdAt: 1,
        updatedAt: 2,
        status: 'generated',
        working: null,
        revisions: [{
            id: 'revision-1',
            messages: [{ id: 'm1', role: 'user', text: '三轮后再揭晓', createdAt: 1 }],
            rejectedDraft: '',
            createdAt: 1,
            markerMessageKey: 'backstage-marker',
            targetMessageKey: 'backstage-output',
            status: 'generated',
        }],
    }],
};
context.chat = [
    ...activeChat,
    {
        is_user: true,
        mes: '完整幕间输入',
        extra: {
            layered_memory_id: 'backstage-marker',
            layered_memory_backstage_marker: { sessionId: 'session-1', revisionId: 'revision-1' },
        },
    },
];
const backstageFork = replayBranchData(backstageParent, getPairs(), 'Parent Chat');
assert.equal(backstageFork.backstage.activeSessionId, 'session-1',
    '从幕间控制楼分支时必须恢复为待生成的活动幕间');
assert.equal(backstageFork.backstage.sessions[0].revisions[0].targetMessageKey, null,
    '新分支不得继续指向父分支中未包含的正文');
assert.deepEqual(backstageFork.backstage.sessions[0].working.messages.map(message => message.text), ['三轮后再揭晓'],
    '新分支必须保留原幕间全文，不要求玩家重新讨论');
assert.equal(backstageFork.backstage.activeCarryover.text, '- 三轮后再揭晓幕后主使',
    '锚点仍在分支内时必须继承持续后续约定');
const backstageForkReplay = replayBranchData(backstageFork, getPairs(), 'Parent Chat');
assert.equal(backstageForkReplay.backstage.activeSessionId, 'session-1',
    '同一分支的第二次历史核对不得丢失已恢复的幕间');
assert.deepEqual(backstageForkReplay.backstage.sessions[0].working.messages.map(message => message.text), ['三轮后再揭晓'],
    '反复核对分支时仍应保留幕间全文');
context.chat = activeChat;

const narrativeParent = structuredClone(parent);
const liveMessages = getMessageFloors({ includeTrailingUser: true });
narrativeParent.narrative_summaries = liveMessages.map(message => ({
    messageKey: message.messageKey,
    messageIndex: message.messageIndex,
    role: message.role,
    contentFingerprint: message.contentFingerprint,
    summary: `消息楼 ${message.messageIndex}`,
}));
narrativeParent.narrative_chapters = [{ id: 'nch_001', floor_range: [0, 3], summary: '四楼章节', stale: false }];
narrativeParent.narrative_volumes = [];
const narrativeReplay = replayBranchData(narrativeParent, getPairs(), 'Parent Chat');
assert.deepEqual(narrativeReplay.narrative_summaries.map(item => item.messageIndex), [0, 1, 2, 3],
    'fork must inherit every verified visible-message summary, not pair-shaped substitutes');
assert.deepEqual(narrativeReplay.narrative_chapters.map(item => item.id), ['nch_001']);
activeChat[3].swipes = ['a1', 'changed a1'];
activeChat[3].swipe_id = 1;
const changedNarrativeReplay = replayBranchData(narrativeParent, getPairs(), 'Parent Chat');
assert.deepEqual(changedNarrativeReplay.narrative_summaries.map(item => item.messageIndex), [0, 1],
    'a changed swipe must remove later visible-message summaries from the trusted fork prefix');
assert.equal(changedNarrativeReplay.narrative_chapters.length, 0,
    'a chapter may not survive when one of its source message fingerprints changed');
activeChat[3].swipe_id = 0;

const parentWithManualEdit = structuredClone(parent);
parentWithManualEdit.manual_events.push({
    id: 'manual-1', anchorFloorKey: 'u1+a1', anchorPairIndex: 1,
    anchorFingerprint: pair(1).contentFingerprint, op: 'upsert', recordedAt: 250,
    after: { id: 'e_0003', slot: 'other', subject: '用户', value: '手动记忆' },
});
const manualReplay = replayBranchData(parentWithManualEdit, [pair(0), pair(1)], 'Parent Chat');
assert.equal(manualReplay.state_table.entries.some(entry => entry.id === 'e_0003'), true,
    'manual edits anchored inside the branch must replay');
const manualOtherSwipe = replayBranchData(parentWithManualEdit, [pair(0), pair(1, '另一个 swipe')], 'Parent Chat');
assert.equal(manualOtherSwipe.state_table.entries.some(entry => entry.id === 'e_0003'), false,
    'manual edits anchored to a different swipe must not replay');

const parentWithBatchRemoval = structuredClone(parent);
parentWithBatchRemoval.manual_events.push(
    {
        id: 'manual-delete-1', anchorFloorKey: 'u1+a1', anchorPairIndex: 1,
        anchorFingerprint: pair(1).contentFingerprint, op: 'delete', reason: 'manual_retire', recordedAt: 250,
        before: { id: 'e_0001', slot: 'identity', subject: '甲', value: '原身份' },
    },
    {
        id: 'manual-delete-2', anchorFloorKey: 'u1+a1', anchorPairIndex: 1,
        anchorFingerprint: pair(1).contentFingerprint, op: 'delete', reason: 'manual_retire', recordedAt: 251,
        before: { id: 'e_0002', slot: 'possession', subject: '乙', value: '钥匙' },
    },
);
const batchRemovalReplay = replayBranchData(parentWithBatchRemoval, [pair(0), pair(1)], 'Parent Chat');
assert.equal(batchRemovalReplay.state_table.entries.length, 0,
    'every fact in one bulk removal must replay independently on a matching branch');
assert.deepEqual(batchRemovalReplay.manual_events.filter(event => event.reason === 'manual_retire').map(event => event.id),
    ['manual-delete-1', 'manual-delete-2']);

const parentWithArchiveRestore = structuredClone(parent);
parentWithArchiveRestore.retired_facts = [{
    id: 'retired-1',
    entry: { id: 'e_0004', slot: 'other', subject: '丙', value: '旧归档' },
    anchorFloorKey: 'u1+a1', anchorPairIndex: 1, anchorFingerprint: pair(1).contentFingerprint,
}];
parentWithArchiveRestore.manual_events.push({
    id: 'manual-restore-1', anchorFloorKey: 'u1+a1', anchorPairIndex: 1,
    anchorFingerprint: pair(1).contentFingerprint, op: 'upsert', reason: 'manual_restore_archived', recordedAt: 252,
    archiveKey: 'retired_facts', archiveId: 'retired-1',
    after: { id: 'e_0004', slot: 'other', subject: '丙', value: '旧归档' },
});
const archiveRestoreReplay = replayBranchData(parentWithArchiveRestore, [pair(0), pair(1)], 'Parent Chat');
assert.equal(archiveRestoreReplay.state_table.entries.some(entry => entry.id === 'e_0004'), true,
    'restoring an archived fact must replay into current memory');
assert.equal(archiveRestoreReplay.retired_facts.some(item => item.id === 'retired-1'), false,
    'a replayed restoration must not leave a duplicate in the archive');

activeMetadata.layered_memory = structuredClone(replayed);
const { rollbackFloor } = await import('../src/merge.js');
await rollbackFloor('u1+a1');
assert.equal(activeMetadata.layered_memory.state_table.entries.some(entry => entry.id === 'e_0002'), false,
    'a replayed floor must remain reversible after the fork');
delete activeMetadata.layered_memory;

const legacy = buildLegacyRebuildData([pair(0), pair(1)], 'Parent Chat');
assert.equal(legacy.state_table.entries.length, 0, 'unverifiable legacy state must never enter a new branch');
assert.equal(legacy.branch_origin.method, 'safe_rebuild');
assert.equal(legacy.progress.baseline_pair, -1);
assert.equal(legacy.review_queue.length, 0, 'status messages must not inflate actionable review count');
assert.equal(legacy.notices.some(item => item.kind === 'notice'), true);

const fresh = buildFreshBranchData([pair(0), pair(1)], 'Parent Without Memory');
assert.equal(fresh.branch_origin.method, 'fresh_start');
assert.equal(fresh.branch_origin.status, 'ready');
assert.equal(fresh.progress.baseline_pair, 1, 'a parent without plugin data must start from now, not auto-backfill');
assert.match(fresh.notices[0].note, /安全重建旧结果/u);

const alternateSwipe = replayBranchData(parent, [pair(0), pair(1, '另一个 swipe')], 'Parent Chat');
assert.equal(alternateSwipe.state_table.entries.some(entry => entry.id === 'e_0002'), false,
    'same message IDs with different active text must not reuse the old swipe fact');
assert.deepEqual(alternateSwipe.turn_summaries.map(item => item.pairIndex), [0]);
assert.deepEqual(alternateSwipe.extracted_keys, ['u0+a0']);
assert.equal(alternateSwipe.fact_ledger.length, 0, 'a discovery from another swipe must not cross into the branch');
assert.equal(alternateSwipe.fact_decisions.length, 0, 'a decision from another swipe must not cross into the branch');

const lateCheckpointParent = structuredClone(parent);
lateCheckpointParent.branch_checkpoints = [{
    id: 'cp-late', anchorFloorKey: 'u1+a1', anchorPairIndex: 1,
    anchorFingerprint: pair(1).contentFingerprint,
    prefixFingerprints: [
        { pairIndex: 0, floorKey: 'u0+a0', contentFingerprint: pair(0).contentFingerprint },
        { pairIndex: 1, floorKey: 'u1+a1', contentFingerprint: pair(1).contentFingerprint },
    ],
    stateTable: { version: 1, entries: [{ id: 'unsafe-old', slot: 'identity', subject: '甲', value: '旧分支事实' }], changelog: [] },
    createdAt: 500,
}];
const changedEarlyFloor = replayBranchData(lateCheckpointParent, [pair(0, '更早楼层已经改变'), pair(1)], 'Parent Chat');
assert.equal(changedEarlyFloor.branch_origin.method, 'safe_rebuild',
    'a matching checkpoint anchor must not hide a changed earlier floor');
assert.equal(changedEarlyFloor.state_table.entries.some(entry => entry.id === 'unsafe-old'), false,
    'facts embedded in a checkpoint with a mismatched prefix must never be restored');

const unverifiableOldCheckpoint = structuredClone(parent);
delete unverifiableOldCheckpoint.branch_checkpoints[0].prefixFingerprints;
assert.equal(replayBranchData(unverifiableOldCheckpoint, [pair(0), pair(1)], 'Parent Chat').branch_origin.method, 'safe_rebuild',
    'old checkpoints without a complete prefix proof must fail closed');

const legacyCandidateParent = structuredClone(parent);
legacyCandidateParent.floor_events = legacyCandidateParent.floor_events.filter(item => item.pairIndex !== 1);
legacyCandidateParent.turn_summaries = legacyCandidateParent.turn_summaries.filter(item => item.pairIndex !== 1);
legacyCandidateParent.fact_ledger = [{
    id: 'legacy-unanchored', floor: 1, floorKey: null, contentFingerprint: null,
    source: 'legacy', fact: { slot: 'identity', subject: '甲', object: '', value: '旧分支身份' },
}];
legacyCandidateParent.fact_decisions = [{
    id: 'legacy-decision', candidateId: 'legacy-unanchored', action: 'activate',
    anchorFloorKey: 'u2+a2', anchorPairIndex: 2, anchorFingerprint: pair(2).contentFingerprint,
}];
legacyCandidateParent.manual_events = [{
    id: 'legacy-activation', anchorFloorKey: 'u2+a2', anchorPairIndex: 2,
    anchorFingerprint: pair(2).contentFingerprint, op: 'upsert', reason: 'candidate_activate', recordedAt: 350,
    after: { id: 'legacy-active', slot: 'identity', subject: '甲', value: '旧分支身份' },
}];
const legacyCandidateFork = replayBranchData(legacyCandidateParent, [pair(0), pair(1, '已修改的早期 swipe'), pair(2)], 'Parent Chat');
assert.equal(legacyCandidateFork.fact_ledger.length, 0, 'unverifiable legacy discoveries must not cross a fork');
assert.equal(legacyCandidateFork.fact_decisions.length, 0, 'decisions must not outlive an unverifiable source discovery');
assert.equal(legacyCandidateFork.state_table.entries.some(entry => entry.id === 'legacy-active'), false,
    'an old candidate activation without a source fingerprint must fail closed');

const sourcedCandidateParent = structuredClone(parent);
sourcedCandidateParent.manual_events.push({
    id: 'sourced-activation', anchorFloorKey: 'u1+a1', anchorPairIndex: 1,
    anchorFingerprint: pair(1).contentFingerprint, op: 'upsert', reason: 'candidate_activate', recordedAt: 250,
    sourceCandidateId: 'fc1', sourceFloorKey: 'u1+a1', sourcePairIndex: 1,
    sourceFingerprint: pair(1).contentFingerprint,
    after: { id: 'candidate-active', slot: 'other', subject: '乙', value: '分支内发现' },
});
assert.equal(replayBranchData(sourcedCandidateParent, [pair(0), pair(1)], 'Parent Chat').state_table.entries
    .some(entry => entry.id === 'candidate-active'), true, 'a fully grounded candidate activation should replay');
assert.equal(replayBranchData(sourcedCandidateParent, [pair(0), pair(1, '另一个 swipe')], 'Parent Chat').state_table.entries
    .some(entry => entry.id === 'candidate-active'), false, 'candidate activation must be rejected when its source swipe changed');

const restoredThenSwiped = structuredClone(replayed);
reconcileCurrentHistory(restoredThenSwiped, [pair(0), pair(1, '恢复后换 swipe')]);
assert.equal(restoredThenSwiped.state_table.entries.some(entry => entry.id === 'e_0002'), false,
    'changing a swipe after recovery must also remove facts already materialized in a checkpoint');

const recoveryPromise = beginBranchRecovery();
const barrierPromise = waitForBranchRecovery();
const result = await recoveryPromise;
await barrierPromise;
assert.equal(result.status, 'ready');
assert.equal(activeMetadata.layered_memory.branch_origin.parentChat, 'Parent Chat');
assert.deepEqual(activeMetadata.layered_memory.state_table.entries.map(entry => entry.value), ['原身份', '钥匙']);
assert.equal(saves, 2);

const oldOpenedFork = { main_chat: 'Parent Chat', layered_memory: { state_table: { entries: [{ id: 'unsafe' }] } } };
currentContext = { ...context, chatMetadata: oldOpenedFork };
assert.equal((await beginBranchRecovery()).status, 'ready');
assert.equal(oldOpenedFork.layered_memory.branch_origin.parentChat, 'Parent Chat',
    'an old already-opened fork without verified origin must be recovered');

const groupMetadata = { main_chat: 'Parent Group Chat' };
currentContext = { ...context, groupId: 'group-1', chatMetadata: groupMetadata };
globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/chats/group/get');
    assert.equal(JSON.parse(init.body).id, 'Parent Group Chat');
    return { ok: true, json: async () => [{ chat_metadata: { layered_memory: structuredClone(parent) } }] };
};
assert.equal((await beginBranchRecovery()).status, 'ready');
assert.equal(groupMetadata.layered_memory.branch_origin.method, 'checkpoint_replay');

const noMemoryMetadata = { main_chat: 'Parent Without Plugin' };
currentContext = { ...context, chatMetadata: noMemoryMetadata };
globalThis.fetch = async () => ({ ok: true, json: async () => [{ chat_metadata: {} }] });
assert.equal((await beginBranchRecovery()).status, 'ready');
assert.equal(noMemoryMetadata.layered_memory.branch_origin.method, 'fresh_start');
assert.equal(noMemoryMetadata.layered_memory.branch_origin.status, 'ready');

const failedMetadata = { main_chat: 'Missing Parent' };
currentContext = { ...context, chatMetadata: failedMetadata };
globalThis.fetch = async () => ({ ok: false, status: 404 });
assert.equal((await beginBranchRecovery()).status, 'failed');
assert.equal(failedMetadata.layered_memory.branch_origin.status, 'failed');
assert.equal(failedMetadata.layered_memory.state_table.entries.length, 0);
assert.equal(failedMetadata.layered_memory.review_queue.length, 0);
assert.match(failedMetadata.layered_memory.notices[0].note, /为避免串线/u);
globalThis.fetch = async () => ({ ok: true, json: async () => [{ chat_metadata: { layered_memory: structuredClone(parent) } }] });
assert.equal((await ensureCurrentBranchRecovery()).status, 'ready', 'the next generation should retry a failed branch recovery');

const raceMetadataA = { main_chat: 'Slow Parent' };
const raceMetadataB = { main_chat: 'Fast Parent' };
let resolveSlowFetch;
globalThis.fetch = async (url, init) => {
    const fileName = JSON.parse(init.body).file_name;
    if (fileName === 'Slow Parent') {
        return new Promise(resolve => { resolveSlowFetch = resolve; });
    }
    return { ok: true, json: async () => [{ chat_metadata: { layered_memory: structuredClone(parent) } }] };
};
currentContext = { ...context, chatMetadata: raceMetadataA };
const slowRecovery = beginBranchRecovery();
currentContext = { ...context, chatMetadata: raceMetadataB };
const fastRecovery = beginBranchRecovery();
assert.equal((await fastRecovery).status, 'ready');
resolveSlowFetch({ ok: true, json: async () => [{ chat_metadata: { layered_memory: structuredClone(parent) } }] });
assert.equal((await slowRecovery).status, 'superseded');
await waitForBranchRecovery();
assert.equal(raceMetadataA.layered_memory, undefined, 'a late parent response must not write into an abandoned chat');
assert.equal(raceMetadataB.layered_memory.branch_origin.parentChat, 'Fast Parent');

console.log('fork smoke: fingerprint replay, safe legacy rebuild, group chat, races, and fail-closed recovery passed');
