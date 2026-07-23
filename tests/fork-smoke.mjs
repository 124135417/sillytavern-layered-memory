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
    branch_checkpoints: [{
        id: 'cp0', anchorFloorKey: 'u0+a0', anchorPairIndex: 0, anchorFingerprint: pair(0).contentFingerprint, createdAt: 100, reason: 'seed',
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

const { beginBranchRecovery, buildLegacyRebuildData, ensureCurrentBranchRecovery, reconcileCurrentHistory, replayBranchData, waitForBranchRecovery } = await import('../src/branch.js');
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const queueSource = await readFile(new URL('../src/queue.js', import.meta.url), 'utf8');
assert.match(indexSource, /layeredMemoryIntercept[\s\S]*await waitForBranchRecovery\(\)/u,
    'generation must wait for branch recovery before updating injection');
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
assert.notEqual(replayed.job_queue.scope_id, 'parent-scope');
assert.equal(replayed.branch_origin.method, 'checkpoint_replay');
assert.equal(replayed.branch_checkpoints.every(point => point.stateTable.changelog.length === 0), true,
    'branch checkpoints must not recursively copy the changelog');

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
assert.equal(legacy.review_queue.some(item => item.kind === 'alert'), true);

const alternateSwipe = replayBranchData(parent, [pair(0), pair(1, '另一个 swipe')], 'Parent Chat');
assert.equal(alternateSwipe.state_table.entries.some(entry => entry.id === 'e_0002'), false,
    'same message IDs with different active text must not reuse the old swipe fact');
assert.deepEqual(alternateSwipe.turn_summaries.map(item => item.pairIndex), [0]);
assert.deepEqual(alternateSwipe.extracted_keys, ['u0+a0']);

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

const failedMetadata = { main_chat: 'Missing Parent' };
currentContext = { ...context, chatMetadata: failedMetadata };
globalThis.fetch = async () => ({ ok: false, status: 404 });
assert.equal((await beginBranchRecovery()).status, 'failed');
assert.equal(failedMetadata.layered_memory.branch_origin.status, 'failed');
assert.equal(failedMetadata.layered_memory.state_table.entries.length, 0);
assert.match(failedMetadata.layered_memory.review_queue[0].note, /为避免串线/u);
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
