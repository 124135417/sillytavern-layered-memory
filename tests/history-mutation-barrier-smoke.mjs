import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createHistoryMutationCoordinator } from '../src/history-mutation.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, reject, resolve };
}

const scope = {};
const firstGate = deferred();
const started = deferred();
const runs = [];
const coordinator = createHistoryMutationCoordinator(async (work, activeScope) => {
    assert.equal(activeScope, scope);
    runs.push(work);
    if (work === 'first') {
        started.resolve();
        await firstGate.promise;
    }
});

const first = coordinator.schedule(scope, 'first', 'first-key');
await started.promise;
const barrier = coordinator.wait(scope);
let barrierPassed = false;
void barrier.then(() => { barrierPassed = true; });
await Promise.resolve();
assert.equal(barrierPassed, false, 'generation barrier must wait for an active history mutation');

coordinator.schedule(scope, 'superseded', 'second-key');
coordinator.schedule(scope, 'latest', 'latest-key');
firstGate.resolve();
await first;
await barrier;
assert.deepEqual(runs, ['first', 'latest'], 'rapid mutations must retain only the latest pending projection');
assert.equal(coordinator.snapshot(scope).completedKey, 'latest-key');

await coordinator.schedule(scope, 'duplicate', 'latest-key');
assert.deepEqual(runs, ['first', 'latest'], 'an already reconciled projection must not run twice');

const failedScope = {};
let attempts = 0;
const retrying = createHistoryMutationCoordinator(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('save failed');
});
await assert.rejects(retrying.schedule(failedScope, 'edit', 'same-key'), /save failed/u);
await assert.rejects(retrying.wait(failedScope), /save failed/u,
    'a failed background edit must block generation instead of leaking stale memory');
await retrying.schedule(failedScope, 'edit retry', 'same-key');
await retrying.wait(failedScope);
assert.equal(attempts, 2, 'the same projection must be retryable after a failure');
assert.equal(retrying.snapshot(failedScope).failed, false);

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const queueSource = await readFile(new URL('../src/queue.js', import.meta.url), 'utf8');
assert.match(indexSource, /const historyMutationHandler = \(mesId\) =>[\s\S]*queueHistoryMutation/u,
    'edit and swipe UI events must only schedule background reconciliation');
assert.match(indexSource, /MESSAGE_EDITED\)[\s\S]*MESSAGE_EDITED, historyMutationHandler/u);
assert.match(indexSource, /layeredMemoryIntercept[\s\S]*await waitForGenerationHistory/u,
    'provider prompt assembly must wait for the same mutation barrier');
assert.match(indexSource, /type === 'swipe'[\s\S]*queueHistoryMutation\(null, \{ excludeTrailingAssistant: true \}\)/u,
    'swipe generation must defensively schedule the shared-prefix projection');
assert.match(indexSource, /rebuildAndEnqueuePending\(\{ excludeTrailingAssistant, forcePersist: true \}\)/u,
    'history reconciliation must delegate its one required save to queue rebuilding');
assert.match(queueSource, /if \(forcePersist \|\| pendingChanged\) await saveChatData\(data\)/u,
    'an unchanged ordinary queue rebuild must skip redundant metadata persistence');

console.log('history mutation barrier smoke: nonblocking UI, coalescing, retry, and generation wait passed');
