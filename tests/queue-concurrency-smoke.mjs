import assert from 'node:assert/strict';

function emptyData(scope, { paused = false, running = [] } = {}) {
    return {
        version: 6,
        state_table: { version: 1, entries: [], changelog: [] },
        chapters: [], volumes: [], keyword_index: {}, review_queue: [],
        pending_floors: [], extracted_keys: [], logs: [],
        job_queue: { scope_id: scope, paused, queued: [], running, failed: [], updatedAt: null },
        progress: { last_chapter_end_pair: -1, pairs_since_proofread: 0, next_entry_seq: 1, next_chapter_seq: 1, baseline_pair: -1 },
    };
}

const chats = {
    parallel: { layered_memory: emptyData('parallel') },
    priority: { layered_memory: emptyData('priority') },
    stages: { layered_memory: emptyData('stages') },
    exclusive: { layered_memory: emptyData('exclusive') },
    scope_switch: { layered_memory: emptyData('scope-switch') },
    switch_target: { layered_memory: emptyData('switch-target', { paused: true }) },
    legacy: {
        layered_memory: emptyData('legacy', {
            paused: true,
            running: {
                id: 'legacy-running', type: 'proofread', payload: {}, priority: 50,
                status: 'running', attempt: 1, maxAttempts: 3,
            },
        }),
    },
};
let active = 'parallel';
let activeSaves = 0;
let maxActiveSaves = 0;
const context = {
    chat: [],
    extensionSettings: { layered_memory: { enabled: true, chapterSize: 25 } },
    get chatMetadata() { return chats[active]; },
    saveMetadata: async () => {
        activeSaves += 1;
        maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
        await new Promise(resolve => setTimeout(resolve, 2));
        activeSaves -= 1;
    },
    saveSettingsDebounced: () => {},
};
globalThis.SillyTavern = { getContext: () => context, libs: {} };

const {
    enqueue,
    getQueueSnapshot,
    registerHandler,
    setQueuePaused,
} = await import('../src/queue.js');

async function waitUntil(predicate, message, timeout = 2_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(message);
}

function gatedHandler(started, releases, counters) {
    return async payload => {
        const key = payload.key ?? payload.startPair ?? payload.startFloor ?? payload.floorKey ?? payload.messageKeys?.[0];
        started.push(key);
        counters.active += 1;
        counters.max = Math.max(counters.max, counters.active);
        try {
            await new Promise(resolve => releases.set(key, resolve));
        } finally {
            counters.active -= 1;
        }
    };
}

const parallelStarted = [];
const parallelReleases = new Map();
const parallelCounters = { active: 0, max: 0 };
registerHandler('history_rebuild_segment', gatedHandler(parallelStarted, parallelReleases, parallelCounters));
for (let index = 0; index < 4; index += 1) {
    enqueue('history_rebuild_segment', { startPair: index * 10, endPair: index * 10 + 9 }, 10);
}
await waitUntil(() => parallelStarted.length === 3, 'three safe jobs should start together');
assert.equal(parallelCounters.max, 3, 'safe jobs must use the bounded three-worker pool');
assert.equal(getQueueSnapshot().running.length, 3);
assert.equal(getQueueSnapshot().queued.length, 1);
assert.equal(chats.parallel.layered_memory.job_queue.running.length, 3, 'all running jobs must be persisted');

setQueuePaused(true);
for (const key of parallelStarted) parallelReleases.get(key)();
await waitUntil(() => getQueueSnapshot().running.length === 0, 'in-flight jobs should finish after pause');
assert.equal(parallelStarted.length, 3, 'pause must prevent the fourth job from starting');
assert.equal(getQueueSnapshot().queued.length, 1);
setQueuePaused(false);
await waitUntil(() => parallelStarted.length === 4, 'resume should start the remaining job');
parallelReleases.get(parallelStarted[3])();
await waitUntil(() => getQueueSnapshot().running.length === 0 && getQueueSnapshot().queued.length === 0,
    'parallel queue should drain');

active = 'priority';
const prioritySegmentStarted = [];
const prioritySegmentReleases = new Map();
const prioritySegmentCounters = { active: 0, max: 0 };
let priorityProofreadStarted = false;
let releasePriorityProofread;
registerHandler('history_rebuild_segment', gatedHandler(
    prioritySegmentStarted, prioritySegmentReleases, prioritySegmentCounters));
registerHandler('proofread', async () => {
    priorityProofreadStarted = true;
    await new Promise(resolve => { releasePriorityProofread = resolve; });
});
enqueue('history_rebuild_segment', { startPair: 0, endPair: 9 }, 10);
enqueue('history_rebuild_segment', { startPair: 10, endPair: 19 }, 10);
await waitUntil(() => prioritySegmentStarted.length === 2, 'initial low-priority batch should start');
enqueue('history_rebuild_segment', { startPair: 20, endPair: 29 }, 10);
enqueue('proofread', { key: 'priority-proofread' }, 100);
prioritySegmentReleases.get(prioritySegmentStarted[0])();
await waitUntil(() => getQueueSnapshot().running.length === 1, 'one low-priority request should remain active');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(prioritySegmentStarted.length, 2, 'a low-priority batch must not refill ahead of higher-priority work');
assert.equal(priorityProofreadStarted, false, 'exclusive high-priority work waits for the active batch to drain');
prioritySegmentReleases.get(prioritySegmentStarted[1])();
await waitUntil(() => priorityProofreadStarted, 'high-priority exclusive work should run next');
assert.equal(prioritySegmentStarted.length, 2);
releasePriorityProofread();
await waitUntil(() => prioritySegmentStarted.length === 3, 'remaining low-priority work should resume afterward');
prioritySegmentReleases.get(prioritySegmentStarted[2])();
await waitUntil(() => getQueueSnapshot().running.length === 0 && getQueueSnapshot().queued.length === 0,
    'priority queue should drain');

active = 'stages';
const summaryStarted = [];
const summaryReleases = new Map();
const summaryCounters = { active: 0, max: 0 };
let chapterStarted = false;
let releaseChapter;
registerHandler('narrative_summary', gatedHandler(summaryStarted, summaryReleases, summaryCounters));
registerHandler('narrative_chapter', async () => {
    chapterStarted = true;
    await new Promise(resolve => { releaseChapter = resolve; });
});
enqueue('narrative_summary', { messageKeys: ['a'], fingerprints: ['a'], validatorVersion: 2 }, 95);
enqueue('narrative_summary', { messageKeys: ['b'], fingerprints: ['b'], validatorVersion: 2 }, 95);
enqueue('narrative_chapter', { startFloor: 0, endFloor: 24 }, 85);
await waitUntil(() => summaryStarted.length === 2, 'same-stage summaries should start together');
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(chapterStarted, false, 'a lower stage must not overlap the active summary stage');
for (const key of summaryStarted) summaryReleases.get(key)();
await waitUntil(() => chapterStarted, 'chapter should start after all summaries finish');
releaseChapter();
await waitUntil(() => getQueueSnapshot().running.length === 0 && getQueueSnapshot().queued.length === 0,
    'stage queue should drain');

active = 'exclusive';
const exclusiveStarted = [];
const exclusiveReleases = new Map();
const exclusiveCounters = { active: 0, max: 0 };
registerHandler('proofread', gatedHandler(exclusiveStarted, exclusiveReleases, exclusiveCounters));
enqueue('proofread', { key: 'proofread-a' }, 50);
enqueue('proofread', { key: 'proofread-b' }, 50);
await waitUntil(() => exclusiveStarted.length === 1, 'first exclusive job should start');
assert.equal(getQueueSnapshot().running.length, 1);
assert.equal(getQueueSnapshot().queued.length, 1);
exclusiveReleases.get(exclusiveStarted[0])();
await waitUntil(() => exclusiveStarted.length === 2, 'second exclusive job should start after the first');
assert.equal(exclusiveCounters.max, 1, 'shared-state maintenance jobs must remain serial');
exclusiveReleases.get(exclusiveStarted[1])();
await waitUntil(() => getQueueSnapshot().running.length === 0 && getQueueSnapshot().queued.length === 0,
    'exclusive queue should drain');

active = 'scope_switch';
let releaseScopeSwitch;
let scopeSwitchHandlerFinished = false;
registerHandler('narrative_summary', async () => {
    await new Promise(resolve => { releaseScopeSwitch = resolve; });
    scopeSwitchHandlerFinished = true;
});
enqueue('narrative_summary', { messageKeys: ['switch'], fingerprints: ['switch'], validatorVersion: 2 }, 95);
await waitUntil(() => typeof releaseScopeSwitch === 'function', 'scope-switch handler should start');
assert.equal(getQueueSnapshot().running.length, 1);
chats.scope_switch.layered_memory.job_queue.paused = true;
active = 'switch_target';
releaseScopeSwitch();
await waitUntil(() => scopeSwitchHandlerFinished, 'origin handler should return after the chat switch');
await new Promise(resolve => setTimeout(resolve, 20));
active = 'scope_switch';
const recoveredScope = getQueueSnapshot();
assert.equal(recoveredScope.running.length, 0);
assert.equal(recoveredScope.queued.length, 1,
    'a job finishing across a chat switch must remain recoverable in its origin scope');

active = 'legacy';
const legacy = getQueueSnapshot();
assert.equal(legacy.running.length, 0);
assert.equal(legacy.queued.length, 1, 'legacy single running job should recover into the queue');
assert.deepEqual(chats.legacy.layered_memory.job_queue.running, [], 'legacy running state should migrate to an array');
assert.equal(maxActiveSaves, 1, 'chat metadata writes must remain serialized');

console.log('queue concurrency smoke: bounded workers, stage barriers, pause, exclusive jobs, persistence, and legacy recovery passed');
