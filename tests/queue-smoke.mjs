import assert from 'node:assert/strict';

function emptyData(scope) {
    return {
        version: 1,
        state_table: { version: 1, entries: [], changelog: [] },
        chapters: [], volumes: [], keyword_index: {}, review_queue: [],
        pending_floors: [], extracted_keys: [], logs: [],
        job_queue: { scope_id: scope, paused: false, queued: [], running: null, failed: [], updatedAt: null },
        progress: { last_chapter_end_pair: -1, pairs_since_proofread: 0, next_entry_seq: 1, next_chapter_seq: 1, baseline_pair: -1 },
    };
}

const chats = {
    a: { layered_memory: emptyData('scope-a') },
    b: { layered_memory: emptyData('scope-b') },
};
let active = 'a';
const context = {
    chat: [],
    extensionSettings: { layered_memory: { enabled: true, chapterSize: 25 } },
    get chatMetadata() { return chats[active]; },
    saveMetadata: async () => {},
    saveSettingsDebounced: () => {},
};
globalThis.SillyTavern = { getContext: () => context, libs: {} };

const {
    dismissFailedJob,
    enqueue,
    getQueueSnapshot,
    isRetryableError,
    retryFailedJob,
    setQueuePaused,
} = await import('../src/queue.js');

setQueuePaused(true);
await new Promise(resolve => setTimeout(resolve, 0));
const first = enqueue('extract', { floorKey: 'a-floor', pairIndex: 1 }, 100);
const duplicate = enqueue('extract', { floorKey: 'a-floor', pairIndex: 1 }, 100);
assert.ok(first);
assert.equal(duplicate, null, '同聊天同楼任务必须去重');
assert.equal(getQueueSnapshot().paused, true);
assert.equal(getQueueSnapshot().queued.length, 1);

active = 'b';
assert.equal(getQueueSnapshot().scopeId, 'scope-b');
assert.equal(getQueueSnapshot().queued.length, 0, '切聊后不得看到旧聊天队列');

active = 'a';
assert.equal(getQueueSnapshot().queued.length, 1, '切回后应恢复原聊天队列');
chats.a.layered_memory.job_queue.failed.push({
    id: 'failed-1', type: 'proofread', payload: {}, priority: 50,
    status: 'failed', attempt: 3, maxAttempts: 3, lastError: '超时',
});
assert.equal(dismissFailedJob('failed-1'), true);
assert.equal(getQueueSnapshot().failed.length, 0, '失败任务应可忽略');

chats.a.layered_memory.job_queue.failed.push({
    id: 'failed-2', type: 'proofread', payload: {}, priority: 50,
    status: 'failed', attempt: 3, maxAttempts: 3, lastError: '超时',
});
assert.equal(retryFailedJob('failed-2'), true);
assert.ok(getQueueSnapshot().queued.some(job => job.id === 'failed-2'), '手动重试应重新入队');

assert.equal(isRetryableError(Object.assign(new Error('模型服务 HTTP 400'), { status: 400 })), false);
assert.equal(isRetryableError(new Error('模型服务 HTTP 422: invalid schema')), false);
assert.equal(isRetryableError(Object.assign(new Error('模型服务 HTTP 429'), { status: 429 })), true);
assert.equal(isRetryableError(Object.assign(new Error('模型服务 HTTP 503'), { status: 503 })), true);

console.log('queue smoke: 12/12 passed');
