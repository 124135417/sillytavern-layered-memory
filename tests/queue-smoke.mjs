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
let metadataSaves = 0;
const context = {
    chat: [],
    extensionSettings: { layered_memory: { enabled: true, chapterSize: 25 } },
    get chatMetadata() { return chats[active]; },
    saveMetadata: async () => { metadataSaves += 1; },
    saveSettingsDebounced: () => {},
};
globalThis.SillyTavern = { getContext: () => context, libs: {} };

const {
    dismissFailedJob,
    enqueue,
    getQueueSnapshot,
    isRetryableError,
    prioritizeNarrativeSummary,
    releaseInactiveQueueScopes,
    rebuildAndEnqueuePending,
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
const releasedIdleScopes = releaseInactiveQueueScopes();
assert.equal(releasedIdleScopes.released, 1, '切聊后应释放没有后台工作的旧聊天运行时引用');
assert.equal(releasedIdleScopes.retained, 1, '有等待任务的聊天必须继续保留运行时引用');
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

chats.a.layered_memory.job_queue.failed.push({
    id: 'failed-old-validator', type: 'narrative_summary',
    payload: { messageKeys: ['m44'], fingerprints: ['fp44'] },
    priority: 95, status: 'failed', attempt: 1, maxAttempts: 3,
    lastError: '旧版 evidence 校验失败',
});
const upgradedNarrative = enqueue('narrative_summary', {
    messageKeys: ['m44'], fingerprints: ['fp44'], validatorVersion: 2,
}, 95);
assert.ok(upgradedNarrative, '新版 validator 必须能绕过旧版失败任务自动补档');
assert.equal(enqueue('narrative_summary', {
    messageKeys: ['m44'], fingerprints: ['fp44'], validatorVersion: 2,
}, 95), null, '同一新版 validator 任务仍必须去重');

enqueue('narrative_summary', {
    messageKeys: ['m50', 'm51'], fingerprints: ['fp50', 'fp51'], validatorVersion: 2,
}, 95);
const promoted = prioritizeNarrativeSummary('m51', 'fp51', 1000);
assert.equal(promoted.status, 'queued');
const narrativeJobs = getQueueSnapshot().queued.filter(job => job.type === 'narrative_summary');
assert.ok(narrativeJobs.some(job => job.priority === 1000
    && JSON.stringify(job.payload.messageKeys) === JSON.stringify(['m51'])),
    '文风重置必须把紧邻上一层拆成独立最高优先任务');
assert.ok(narrativeJobs.some(job => JSON.stringify(job.payload.messageKeys) === JSON.stringify(['m50'])),
    '拆分优先楼层时不得丢掉同批其它后台工作');

chats.a.layered_memory.job_queue.failed.push({
    id: 'failed-reset-batch', type: 'narrative_summary',
    payload: { messageKeys: ['m60', 'm61'], fingerprints: ['fp60', 'fp61'], validatorVersion: 2 },
    priority: 95, status: 'failed', attempt: 3, maxAttempts: 3, lastError: '旧批次失败',
});
prioritizeNarrativeSummary('m61', 'fp61', 1000);
assert.ok(getQueueSnapshot().queued.some(job => job.priority === 1000
    && JSON.stringify(job.payload.messageKeys) === JSON.stringify(['m61'])),
    '重置所需楼层此前失败时必须拆出并重新尝试');
assert.deepEqual(getQueueSnapshot().failed.find(job => job.id === 'failed-reset-batch')?.payload.messageKeys, ['m60'],
    '重试目标楼层时不得清除同批其它失败记录');

assert.equal(isRetryableError(Object.assign(new Error('模型服务 HTTP 400'), { status: 400 })), false);
assert.equal(isRetryableError(new Error('模型服务 HTTP 422: invalid schema')), false);
assert.equal(isRetryableError(Object.assign(new Error('模型服务 HTTP 429'), { status: 429 })), true);
assert.equal(isRetryableError(Object.assign(new Error('模型服务 HTTP 503'), { status: 503 })), true);

active = 'b';
metadataSaves = 0;
await rebuildAndEnqueuePending();
assert.equal(metadataSaves, 0, 'unchanged pending floors must not trigger a redundant metadata save');
await rebuildAndEnqueuePending({ forcePersist: true });
assert.equal(metadataSaves, 1, 'history reconciliation must still be able to require one metadata save');

console.log('queue smoke: retry, validator upgrade, scope isolation, and error classes passed');
