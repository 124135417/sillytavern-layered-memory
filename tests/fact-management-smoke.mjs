import assert from 'node:assert/strict';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const { EMPTY_CHAT_DATA } = await import('../src/constants.js');
const { factCandidateView, makeFactCandidate } = await import('../src/facts.js');
const {
    commitFactMutation,
    permanentlyDeleteCurrentFacts,
    restoreArchivedFact,
    retireCurrentFacts,
    visibleFactIds,
} = await import('../src/fact-management.js');

function fact(id, subject, value, slot = 'other') {
    return {
        id,
        slot,
        topic: `${subject}事项`,
        subject,
        object: '',
        value,
        evidence: `${subject}明确说${value}`,
        source: 'auto',
        established_floor: 1,
        updated_floor: 1,
        pinned: false,
    };
}

function dataWithFacts() {
    const data = EMPTY_CHAT_DATA();
    data.state_table.entries = [
        fact('e_0001', '阿尔德瑞思', '保管旧书', 'possession'),
        fact('e_0002', '伯滔', '答应保密', 'promise'),
        fact('e_0003', '雷蒙德', '守在门外', 'relationship'),
    ];
    data.state_table.version = 7;
    data.progress.next_entry_seq = 4;
    data.memory_organization.staged = { base_state_version: 7, decisions: [] };
    data.memory_organization.status = 'ready';
    return data;
}

let eventSequence = 0;
function recordEvent(data, event) {
    const recorded = {
        id: `manual-${++eventSequence}`,
        ...structuredClone(event),
        anchorFloorKey: 'floor-9',
        anchorPairIndex: 9,
        anchorFingerprint: 'fingerprint-9',
        recordedAt: 900 + eventSequence,
    };
    data.manual_events.push(recorded);
    return recorded;
}

const optimistic = dataWithFacts();
let resolveSave;
let persistenceCalls = 0;
let optimisticRendered = false;
const delayedSave = new Promise(resolve => { resolveSave = resolve; });
const pending = commitFactMutation(
    optimistic,
    data => retireCurrentFacts(data, ['e_0001', 'e_0002'], { recordEvent, now: 1000, runId: 'bulk-1' }),
    {
        persist: async () => {
            persistenceCalls += 1;
            await delayedSave;
        },
        onOptimistic: () => { optimisticRendered = true; },
    },
);
assert.equal(optimisticRendered, true, 'the UI callback must run before persistence settles');
assert.deepEqual(optimistic.state_table.entries.map(entry => entry.id), ['e_0003'], 'selected facts must disappear optimistically');
assert.equal(persistenceCalls, 1, 'one UI batch must issue exactly one persistence request');
assert.equal(optimistic.retired_facts.length, 2);
assert.equal(optimistic.manual_events.length, 2, 'each fact must retain its own replayable manual event');
assert.deepEqual(new Set(optimistic.manual_events.map(event => event.anchorFloorKey)), new Set(['floor-9']));
assert.equal(optimistic.state_table.version, 8, 'the whole batch advances the state version once');
assert.equal(optimistic.memory_organization.staged, null, 'manual mutation must immediately discard a staged organization preview');
assert.equal(optimistic.memory_organization.status, 'stale');
resolveSave();
await pending;

const rejected = dataWithFacts();
const beforeRejected = structuredClone(rejected);
let rollbackCalled = false;
await assert.rejects(
    commitFactMutation(
        rejected,
        data => permanentlyDeleteCurrentFacts(data, ['e_0001', 'e_0002'], { recordEvent }),
        {
            persist: async () => { throw new Error('metadata unavailable'); },
            onRollback: () => { rollbackCalled = true; },
        },
    ),
    /metadata unavailable/u,
);
assert.equal(rollbackCalled, true);
assert.deepEqual(rejected, beforeRejected, 'a failed save must restore every mutated memory structure exactly');

const deleted = dataWithFacts();
const oldCandidate = makeFactCandidate({
    fact: deleted.state_table.entries[0],
    floor: 1,
    floorKey: 'floor-1',
    contentFingerprint: 'old-swipe',
});
deleted.fact_ledger.push(oldCandidate);
const deletion = permanentlyDeleteCurrentFacts(deleted, ['e_0001'], { recordEvent });
assert.equal(deletion.tombstones, 1);
assert.equal(factCandidateView(deleted).find(item => item.id === oldCandidate.id).status, 'dismissed',
    'permanent deletion must tombstone the old discovery');
const newEvidence = makeFactCandidate({
    fact: oldCandidate.fact,
    floor: 12,
    floorKey: 'floor-12',
    contentFingerprint: 'new-swipe',
});
deleted.fact_ledger.push(newEvidence);
assert.equal(factCandidateView(deleted).find(item => item.id === newEvidence.id).status, 'unselected',
    'genuinely new evidence must remain available after an old discovery was deleted');

const restored = EMPTY_CHAT_DATA();
restored.state_table.version = 4;
restored.retired_facts.push({
    id: 'archive-1',
    entry: fact('e_0007', '顾南', '已离开城堡'),
    anchorFloorKey: 'floor-8',
    anchorPairIndex: 8,
    anchorFingerprint: 'fingerprint-8',
});
const restoration = restoreArchivedFact(restored, 'retired_facts', 'archive-1', { recordEvent });
assert.equal(restoration.error, null);
assert.equal(restored.retired_facts.length, 0);
assert.equal(restored.state_table.entries[0].id, 'e_0007');
assert.equal(restored.state_table.entries[0].source, 'manual');
assert.equal(restored.manual_events.at(-1).reason, 'manual_restore_archived');
assert.equal(restored.manual_events.at(-1).archiveId, 'archive-1');

assert.deepEqual(
    visibleFactIds([
        { id: 'e_1', hidden: false },
        { id: 'e_2', hidden: true },
        { id: 'e_3', hidden: false },
        { id: 'e_1', hidden: false },
    ]),
    ['e_1', 'e_3'],
    'select-all must include only the visible filtered facts',
);

console.log('fact management smoke: optimistic batch, rollback, tombstones, restore, and filtered selection are safe');
