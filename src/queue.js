import { QUEUE_PRIORITY } from './constants.js';
import {
    appendLog,
    assertChatData,
    getChatData,
    getSettings,
    saveChatData,
} from './settings.js';
import { waitForBranchRecovery } from './branch.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2_000, 8_000];
const MAX_CONCURRENT_JOBS = 3;
const PARALLEL_JOB_TYPES = new Set([
    'extract',
    'narrative_summary',
    'narrative_chapter',
    'chapter_summary',
    'history_rebuild_segment',
    'history_rebuild_chapter',
]);

/** @type {Array<any>} */
let memoryQueue = [];
/** @type {Map<string, any>} */
const inFlightJobs = new Map();
let pumping = false;
let pumpRequested = false;
let wakeTimer = null;
/** @type {Map<string, function>} */
const handlers = new Map();
/** @type {Set<string>} */
const hydratedScopes = new Set();
/** @type {Map<string, any>} */
const chatDataByScope = new Map();

export function registerHandler(type, fn) {
    handlers.set(type, fn);
    // wireHandlers() registers synchronously; the microtask runs after the full
    // set is ready and recovers persisted work on initial extension load.
    queueMicrotask(() => void pump());
}

function ensureQueueState(data = getChatData()) {
    if (!data.job_queue || typeof data.job_queue !== 'object') {
        data.job_queue = {};
    }
    const state = data.job_queue;
    if (!state.scope_id) {
        state.scope_id = crypto.randomUUID();
    }
    if (!Array.isArray(state.queued)) state.queued = [];
    if (!Array.isArray(state.failed)) state.failed = [];
    if (Array.isArray(state.running)) {
        state.running = state.running.filter(job => job?.type);
    } else if (state.running?.type) {
        // <= 0.14.0 persisted a single running job.
        state.running = [state.running];
    } else {
        state.running = [];
    }
    if (!Object.hasOwn(state, 'paused')) state.paused = false;
    return state;
}

function publicJob(job) {
    if (!job) return null;
    const { chatData: _chatData, ...copy } = job;
    return { ...copy, payload: copy.payload ? { ...copy.payload } : {} };
}

function normalizeJob(raw, chatData, scopeId, status = 'queued') {
    return {
        id: raw.id || crypto.randomUUID(),
        type: raw.type,
        priority: Number(raw.priority ?? QUEUE_PRIORITY[raw.type] ?? 50),
        payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
        status,
        createdAt: Number(raw.createdAt) || Date.now(),
        attempt: Math.max(0, Number(raw.attempt) || 0),
        maxAttempts: Math.max(1, Number(raw.maxAttempts) || MAX_ATTEMPTS),
        lastError: raw.lastError ? String(raw.lastError) : null,
        nextRetryAt: Number(raw.nextRetryAt) || null,
        scopeId,
        chatData,
    };
}

function hydrateCurrentScope() {
    const chatData = getChatData();
    const state = ensureQueueState(chatData);
    const scopeId = state.scope_id;
    chatDataByScope.set(scopeId, chatData);
    if (hydratedScopes.has(scopeId)) {
        return { chatData, state, scopeId };
    }
    hydratedScopes.add(scopeId);

    const knownIds = new Set([
        ...memoryQueue.map(j => j.id),
        ...inFlightJobs.keys(),
    ]);
    for (const raw of state.queued) {
        if (raw?.type && !knownIds.has(raw.id)) {
            const job = normalizeJob(raw, chatData, scopeId, 'queued');
            memoryQueue.push(job);
            knownIds.add(job.id);
        }
    }
    // A refresh cannot know whether previously running network requests
    // finished. Requeue all of them; domain handlers are idempotent/deduplicated.
    const stillRunning = [];
    for (const raw of state.running) {
        if (raw?.id && inFlightJobs.has(raw.id)) {
            stillRunning.push(publicJob(inFlightJobs.get(raw.id)));
            continue;
        }
        if (!raw?.type || knownIds.has(raw.id)) continue;
        const recovered = normalizeJob({
            ...raw,
            lastError: raw.lastError || '页面刷新后恢复未完成任务',
            nextRetryAt: Date.now(),
        }, chatData, scopeId, 'queued');
        if (recovered.attempt < recovered.maxAttempts) {
            memoryQueue.push(recovered);
            knownIds.add(recovered.id);
        } else if (!state.failed.some(j => j.id === recovered.id)) {
            state.failed.push(publicJob({ ...recovered, status: 'failed', failedAt: Date.now() }));
        }
    }
    state.running = stillRunning;
    sortQueue();
    return { chatData, state, scopeId };
}

function sameWork(a, type, payload) {
    if (a.type !== type) return false;
    if (type === 'extract') return a.payload?.floorKey && a.payload.floorKey === payload.floorKey;
    if (type === 'narrative_summary') {
        return JSON.stringify(a.payload?.messageKeys || []) === JSON.stringify(payload.messageKeys || [])
            && JSON.stringify(a.payload?.fingerprints || []) === JSON.stringify(payload.fingerprints || [])
            && Number(a.payload?.validatorVersion || 1) === Number(payload.validatorVersion || 1);
    }
    if (type === 'narrative_chapter') {
        return a.payload?.startFloor === payload.startFloor && a.payload?.endFloor === payload.endFloor;
    }
    if (type === 'chapter_summary') {
        if (payload.regenStale) return Boolean(a.payload?.regenStale);
        return a.payload?.startPair === payload.startPair && a.payload?.endPair === payload.endPair;
    }
    if (type === 'migrate_extract_chapter') {
        return a.payload?.startPair === payload.startPair && a.payload?.endPair === payload.endPair;
    }
    if (type === 'migrate_extract_floor') {
        return a.payload?.floorKey && a.payload.floorKey === payload.floorKey;
    }
    if (type === 'history_rebuild_segment' || type === 'history_rebuild_chapter') {
        return a.payload?.startPair === payload.startPair && a.payload?.endPair === payload.endPair;
    }
    if (type === 'history_rebuild_commit') return true;
    if (type === 'volume_compress' && (payload.reason === 'budget' || payload.reason === 'budget_check')) {
        return a.payload?.reason === 'budget' || a.payload?.reason === 'budget_check';
    }
    try {
        return JSON.stringify(a.payload || {}) === JSON.stringify(payload || {});
    } catch {
        return false;
    }
}

function isDuplicateJob(scopeId, type, payload) {
    const failed = ensureQueueState(chatDataByScope.get(scopeId)).failed;
    return memoryQueue.some(j => j.scopeId === scopeId && sameWork(j, type, payload))
        || [...inFlightJobs.values()].some(j => j.scopeId === scopeId && sameWork(j, type, payload))
        || failed.some(j => sameWork(j, type, payload));
}

function writeStateFor(scopeId, chatData) {
    const state = ensureQueueState(chatData);
    state.queued = memoryQueue
        .filter(j => j.scopeId === scopeId)
        .map(publicJob);
    state.running = [...inFlightJobs.values()]
        .filter(job => job.scopeId === scopeId)
        .map(publicJob);
    state.updatedAt = Date.now();
}

function notifyQueueChanged(scopeId) {
    if (typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
        return;
    }
    globalThis.dispatchEvent(new CustomEvent('layered-memory:queue-changed', {
        detail: { scopeId },
    }));
}

async function persistScope(scopeId, chatData) {
    writeStateFor(scopeId, chatData);
    notifyQueueChanged(scopeId);
    if (getChatData() !== chatData) return false;
    try {
        await saveChatData(chatData);
        return true;
    } catch (err) {
        if (err?.code !== 'CHAT_SCOPE_CHANGED') throw err;
        return false;
    }
}

export function enqueue(type, payload = {}, priority = QUEUE_PRIORITY[type] ?? 50) {
    const { chatData, scopeId } = hydrateCurrentScope();
    if (isDuplicateJob(scopeId, type, payload)) return null;

    const job = normalizeJob({ type, priority, payload }, chatData, scopeId);
    memoryQueue.push(job);
    sortQueue();
    void persistScope(scopeId, chatData).then(() => pump());
    return job.id;
}

function narrativeSourceIndex(job, messageKey, fingerprint) {
    if (job?.type !== 'narrative_summary') return -1;
    const keys = Array.isArray(job.payload?.messageKeys) ? job.payload.messageKeys : [];
    const fingerprints = Array.isArray(job.payload?.fingerprints) ? job.payload.fingerprints : [];
    return keys.findIndex((key, index) => key === messageKey && fingerprints[index] === fingerprint);
}

function removeNarrativeSourceFromJob(job, index) {
    const keys = Array.isArray(job.payload?.messageKeys) ? [...job.payload.messageKeys] : [];
    const fingerprints = Array.isArray(job.payload?.fingerprints) ? [...job.payload.fingerprints] : [];
    keys.splice(index, 1);
    fingerprints.splice(index, 1);
    job.payload = { ...job.payload, messageKeys: keys, fingerprints };
    return keys.length;
}

/**
 * Move one exact narrative floor ahead of ordinary background work. A queued
 * multi-floor batch is split so generation waits only for the required floor;
 * an already running request is joined instead of duplicated.
 */
export function prioritizeNarrativeSummary(messageKey, fingerprint, priority = QUEUE_PRIORITY.style_reset_narrative) {
    const { chatData, state, scopeId } = hydrateCurrentScope();
    const running = [...inFlightJobs.values()].find(job =>
        job.scopeId === scopeId && narrativeSourceIndex(job, messageKey, fingerprint) >= 0);
    if (running) {
        return { jobId: running.id, scopeId, status: 'running' };
    }

    const queued = memoryQueue.find(job =>
        job.scopeId === scopeId && narrativeSourceIndex(job, messageKey, fingerprint) >= 0);
    if (queued) {
        const index = narrativeSourceIndex(queued, messageKey, fingerprint);
        const keys = Array.isArray(queued.payload?.messageKeys) ? queued.payload.messageKeys : [];
        if (keys.length === 1) {
            queued.priority = Math.max(Number(queued.priority) || 0, Number(priority) || 0);
            queued.nextRetryAt = null;
            sortQueue();
            void persistScope(scopeId, chatData).then(() => pump());
            return { jobId: queued.id, scopeId, status: 'queued' };
        }
        removeNarrativeSourceFromJob(queued, index);
        const promoted = normalizeJob({
            type: 'narrative_summary',
            priority,
            payload: {
                ...queued.payload,
                messageKeys: [messageKey],
                fingerprints: [fingerprint],
            },
        }, chatData, scopeId);
        memoryQueue.push(promoted);
        sortQueue();
        void persistScope(scopeId, chatData).then(() => pump());
        return { jobId: promoted.id, scopeId, status: 'queued' };
    }

    const failedIndex = state.failed.findIndex(job => narrativeSourceIndex(job, messageKey, fingerprint) >= 0);
    let validatorVersion = 1;
    if (failedIndex >= 0) {
        const failed = state.failed[failedIndex];
        validatorVersion = Number(failed.payload?.validatorVersion || 1);
        const sourceIndex = narrativeSourceIndex(failed, messageKey, fingerprint);
        if (removeNarrativeSourceFromJob(failed, sourceIndex)) {
            state.failed[failedIndex] = failed;
        } else {
            state.failed.splice(failedIndex, 1);
        }
    }

    const promoted = normalizeJob({
        type: 'narrative_summary',
        priority,
        payload: {
            messageKeys: [messageKey],
            fingerprints: [fingerprint],
            validatorVersion,
        },
    }, chatData, scopeId);
    memoryQueue.push(promoted);
    sortQueue();
    void persistScope(scopeId, chatData).then(() => pump());
    return { jobId: promoted.id, scopeId, status: 'queued' };
}

export function getQueueSnapshot() {
    const { state, scopeId } = hydrateCurrentScope();
    const running = [...inFlightJobs.values()]
        .filter(job => job.scopeId === scopeId)
        .map(publicJob);
    return {
        scopeId,
        paused: Boolean(state.paused),
        running,
        // Compatibility for callers that only need one representative task.
        inFlight: running[0] || null,
        queued: memoryQueue.filter(j => j.scopeId === scopeId).map(publicJob),
        failed: state.failed.map(j => ({ ...j, payload: { ...(j.payload || {}) } })),
    };
}

export function setQueuePaused(paused) {
    const { chatData, state, scopeId } = hydrateCurrentScope();
    state.paused = Boolean(paused);
    void persistScope(scopeId, chatData).then(() => {
        if (!state.paused) void pump();
    });
}

export function retryFailedJob(jobId) {
    const { chatData, state, scopeId } = hydrateCurrentScope();
    const index = state.failed.findIndex(j => j.id === jobId);
    if (index < 0) return false;
    const [failed] = state.failed.splice(index, 1);
    if (!isDuplicateJob(scopeId, failed.type, failed.payload || {})) {
        memoryQueue.push(normalizeJob({
            ...failed,
            attempt: 0,
            lastError: null,
            nextRetryAt: null,
            createdAt: Date.now(),
        }, chatData, scopeId));
        sortQueue();
    }
    void persistScope(scopeId, chatData).then(() => pump());
    return true;
}

export function dismissFailedJob(jobId) {
    const { chatData, state, scopeId } = hydrateCurrentScope();
    const before = state.failed.length;
    state.failed = state.failed.filter(j => j.id !== jobId);
    if (state.failed.length === before) return false;
    void persistScope(scopeId, chatData);
    return true;
}

export async function cancelQueuedJobs(types = []) {
    const wanted = new Set(types);
    if (!wanted.size) return 0;
    const { chatData, state, scopeId } = hydrateCurrentScope();
    const before = memoryQueue.length;
    memoryQueue = memoryQueue.filter(job => job.scopeId !== scopeId || !wanted.has(job.type));
    state.queued = (state.queued || []).filter(job => !wanted.has(job.type));
    const removed = before - memoryQueue.length;
    await persistScope(scopeId, chatData);
    return removed;
}

export async function clearFailedJobs(types = []) {
    const wanted = new Set(types);
    if (!wanted.size) return 0;
    const { chatData, state, scopeId } = hydrateCurrentScope();
    const before = state.failed.length;
    state.failed = state.failed.filter(job => !wanted.has(job.type));
    await persistScope(scopeId, chatData);
    return before - state.failed.length;
}

function sortQueue() {
    memoryQueue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
}

function activeScope() {
    const chatData = getChatData();
    const state = ensureQueueState(chatData);
    return { chatData, state, scopeId: state.scope_id };
}

function scheduleWake(timestamp) {
    if (wakeTimer) clearTimeout(wakeTimer);
    const delay = Math.max(0, timestamp - Date.now());
    wakeTimer = setTimeout(() => {
        wakeTimer = null;
        void pump();
    }, delay);
}

export function isRetryableError(error) {
    const message = String(error?.message ?? error ?? '');
    const status = Number(error?.status);
    if (message.startsWith('副模型不可用：')) return false;
    if ([400, 401, 403, 404, 422].includes(status)) return false;
    if (/(?:模型服务|fallback) HTTP (400|401|403|404|422)\b/i.test(message)) return false;
    return true;
}

function safeJobError(error) {
    return String(error?.message ?? error ?? '未知错误')
        .replace(/fallback HTTP (\d+):[\s\S]*/i, 'Fallback API 返回 HTTP $1')
        .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
        .replace(/(api[_-]?key\s*[=:]\s*)[^\s,;]+/gi, '$1[已隐藏]')
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, 'sk-[已隐藏]')
        .slice(0, 500);
}

function runningForScope(scopeId) {
    return [...inFlightJobs.values()].filter(job => job.scopeId === scopeId);
}

function parallelGroup(job) {
    if (!PARALLEL_JOB_TYPES.has(job?.type)) return null;
    if (job.type === 'chapter_summary' && (job.payload?.regenStale
        || !Number.isInteger(job.payload?.startPair)
        || !Number.isInteger(job.payload?.endPair))) return null;
    return job.type;
}

function readyJobsForScope(scopeId) {
    const now = Date.now();
    return memoryQueue.filter(job => job.scopeId === scopeId
        && (!job.nextRetryAt || job.nextRetryAt <= now));
}

function selectJobsToStart(scopeId) {
    sortQueue();
    const ready = readyJobsForScope(scopeId);
    if (!ready.length) return [];
    const running = runningForScope(scopeId);
    if (running.length) {
        const group = parallelGroup(running[0]);
        if (!group || running.some(job => parallelGroup(job) !== group)) return [];
        // Do not fill a low-priority batch after newer high-priority work
        // arrives. Existing requests finish, then the queue re-evaluates.
        if (parallelGroup(ready[0]) !== group) return [];
        return ready
            .filter(job => parallelGroup(job) === group)
            .slice(0, Math.max(0, MAX_CONCURRENT_JOBS - running.length));
    }
    const first = ready[0];
    const group = parallelGroup(first);
    return group
        ? ready.filter(job => parallelGroup(job) === group).slice(0, MAX_CONCURRENT_JOBS)
        : [first];
}

async function settleStoppedWorkflow(job, chatData) {
    if (job.type.startsWith('migrate_')) {
        if (runningForScope(job.scopeId).some(candidate => candidate.type.startsWith('migrate_'))) return;
        const { settleHistoryBackfillStop } = await import('./eval/migrate.js');
        await settleHistoryBackfillStop(chatData);
    }
    if (job.type.startsWith('history_rebuild_')) {
        if (runningForScope(job.scopeId).some(candidate => candidate.type.startsWith('history_rebuild_'))) return;
        const { settleHistoryRebuildStop } = await import('./rebuild.js');
        await settleHistoryRebuildStop(chatData);
    }
}

async function finishJob(job, handler, scopeId, chatData, state) {
    let error = null;
    try {
        assertChatData(chatData);
        await handler(job.payload);
        assertChatData(chatData);
    } catch (err) {
        error = err;
    } finally {
        inFlightJobs.delete(job.id);
    }

    try {
        await settleStoppedWorkflow(job, chatData);
    } catch (err) {
        error = error || err;
    }

    if (!error) {
        try {
            const persisted = await persistScope(scopeId, chatData);
            if (!persisted) {
                error = new Error('聊天已切换，已保留原聊天任务等待恢复');
                error.code = 'CHAT_SCOPE_CHANGED';
            }
        } catch (err) {
            error = err;
        }
    }

    if (error?.code === 'CHAT_SCOPE_CHANGED') {
        // A final persist may already have projected this job out of `running`
        // before noticing the chat switch. Put it back in the origin object so
        // returning to that chat safely replays the idempotent handler.
        const running = ensureQueueState(chatData).running;
        if (!running.some(candidate => candidate.id === job.id)) running.push(publicJob(job));
        hydratedScopes.delete(scopeId);
        void pump();
        return;
    }
    if (!error) {
        void pump();
        return;
    }

    const retryable = isRetryableError(error);
    job.lastError = safeJobError(error);
    job.finishedAt = Date.now();
    if (job.attempt < job.maxAttempts && retryable) {
        job.status = 'queued';
        job.nextRetryAt = Date.now() + (RETRY_DELAYS_MS[job.attempt - 1] ?? RETRY_DELAYS_MS.at(-1));
        memoryQueue.push(job);
        appendLog('warn', `任务失败，等待重试 ${job.type} (${job.attempt}/${job.maxAttempts}): ${job.lastError}`);
    } else {
        job.status = 'failed';
        job.failedAt = Date.now();
        state.failed.push(publicJob(job));
        appendLog('error', `任务失败 ${job.type} (${job.attempt}/${job.maxAttempts}): ${job.lastError}`);
        if (job.type.startsWith('migrate_')) {
            const { markHistoryBackfillError } = await import('./eval/migrate.js');
            await markHistoryBackfillError(job.lastError, chatData);
        }
        if (job.type.startsWith('history_rebuild_')) {
            const { markHistoryRebuildError } = await import('./rebuild.js');
            await markHistoryRebuildError(job.lastError, chatData);
        }
    }
    sortQueue();
    await persistScope(scopeId, chatData);
    void pump();
}

async function pump() {
    if (pumping) {
        pumpRequested = true;
        return;
    }
    pumping = true;
    try {
        await waitForBranchRecovery();
        if (getChatData().branch_origin?.status === 'failed') return;
        const { chatData, state, scopeId } = activeScope();
        hydrateCurrentScope();
        if (state.paused) return;

        const jobs = selectJobsToStart(scopeId);
        if (!jobs.length) {
            const next = memoryQueue
                .filter(job => job.scopeId === scopeId)
                .map(job => job.nextRetryAt)
                .filter(timestamp => timestamp && timestamp > Date.now())
                .sort((a, b) => a - b)[0];
            if (next) scheduleWake(next);
            return;
        }

        const runnable = [];
        for (const job of jobs) {
            memoryQueue = memoryQueue.filter(candidate => candidate.id !== job.id);
            const handler = handlers.get(job.type);
            if (!handler) {
                job.status = 'failed';
                job.lastError = `无处理器: ${job.type}`;
                job.failedAt = Date.now();
                state.failed.push(publicJob(job));
                appendLog('warn', job.lastError);
                continue;
            }
            job.attempt += 1;
            job.status = 'running';
            job.startedAt = Date.now();
            job.nextRetryAt = null;
            inFlightJobs.set(job.id, job);
            runnable.push([job, handler]);
        }
        let persisted = false;
        try {
            persisted = await persistScope(scopeId, chatData);
        } catch (error) {
            for (const [job] of runnable) {
                inFlightJobs.delete(job.id);
                job.attempt = Math.max(0, job.attempt - 1);
                job.status = 'queued';
                job.nextRetryAt = Date.now() + RETRY_DELAYS_MS[0];
                memoryQueue.push(job);
            }
            sortQueue();
            appendLog('warn', `任务队列保存失败，稍后重试：${safeJobError(error)}`);
            scheduleWake(Date.now() + RETRY_DELAYS_MS[0]);
            return;
        }
        if (!persisted) {
            for (const [job] of runnable) inFlightJobs.delete(job.id);
            hydratedScopes.delete(scopeId);
            return;
        }
        for (const [job, handler] of runnable) {
            void finishJob(job, handler, scopeId, chatData, state).catch(error => {
                console.error('[layered-memory] 后台任务收尾失败', error);
                void pump();
            });
        }
        if (!runnable.length) pumpRequested = true;
    } finally {
        pumping = false;
        if (pumpRequested) {
            pumpRequested = false;
            queueMicrotask(() => void pump());
        }
    }
}

function isPairFloorKey(key) {
    return typeof key === 'string'
        && key.includes('+')
        && !key.startsWith('chapter:')
        && !key.startsWith('migrated:');
}

async function rollbackOrphanExtracts(getPairs, expectedData) {
    const { rollbackFloor } = await import('./merge.js');
    const data = getChatData();
    assertChatData(expectedData);
    const live = new Set(getPairs().filter(p => p.sealed).map(p => p.floorKey));
    const orphans = (data.extracted_keys || []).filter(k => isPairFloorKey(k) && !live.has(k));
    let rolled = 0;
    for (const key of orphans) {
        const n = await rollbackFloor(key, expectedData);
        assertChatData(expectedData);
        if (n > 0) {
            rolled += 1;
            appendLog('info', `孤儿提取键已回滚: ${key}`);
        }
    }
    return rolled;
}

function enqueueMissingChapters(getPairs, baseline) {
    const settings = getSettings();
    const size = settings.chapterSize || 25;
    const data = getChatData();
    const pairs = getPairs();
    const extracted = new Set(data.extracted_keys || []);
    const sealedIndexes = pairs.filter(p => p.sealed && p.pairIndex > baseline).map(p => p.pairIndex);
    if (!sealedIndexes.length) return 0;
    const maxPair = Math.max(...sealedIndexes);
    let enqueued = 0;
    for (let start = baseline + 1; start + size - 1 <= maxPair; start += size) {
        const end = start + size - 1;
        let complete = true;
        for (let i = start; i <= end; i++) {
            const p = pairs.find(x => x.pairIndex === i);
            if (!p?.sealed || !extracted.has(p.floorKey)) {
                complete = false;
                break;
            }
        }
        if (!complete) continue;
        const covered = (data.chapters || []).some(c =>
            !c.stale && c.floor_range?.[0] === start && c.floor_range?.[1] === end);
        if (!covered) {
            enqueue('chapter_summary', { startPair: start, endPair: end }, QUEUE_PRIORITY.chapter_summary);
            enqueued += 1;
        }
    }
    return enqueued;
}

function samePendingFloors(current, next) {
    const left = Array.isArray(current) ? current : [];
    const right = Array.isArray(next) ? next : [];
    return left.length === right.length && left.every((item, index) => {
        const candidate = right[index];
        return item?.floorKey === candidate?.floorKey
            && item?.pairIndex === candidate?.pairIndex
            && item?.userKey === candidate?.userKey
            && item?.aiKey === candidate?.aiKey;
    });
}

export async function rebuildAndEnqueuePending({
    forceLastSealed = false,
    excludeTrailingAssistant = false,
    forcePersist = false,
} = {}) {
    hydrateCurrentScope();
    const originData = getChatData();
    const { getFrozenPairs, getPairs, ensureActivationBaseline } = await import('./ids.js');
    assertChatData(originData);
    const pairs = getPairs({ excludeTrailingAssistant });
    const currentPairs = () => getPairs({ excludeTrailingAssistant });
    const baseline = ensureActivationBaseline({ pairs });
    if (originData.branch_origin?.status === 'failed') return 0;
    await rollbackOrphanExtracts(currentPairs, originData);
    assertChatData(originData);
    const data = originData;
    const extracted = new Set(data.extracted_keys || []);
    let candidates = getFrozenPairs({ excludeTrailingAssistant }).filter(p => p.pairIndex > baseline);

    if (forceLastSealed) {
        const last = [...pairs].reverse().find(p => p.sealed && p.pairIndex > baseline);
        if (last && !candidates.some(c => c.floorKey === last.floorKey)) candidates = [...candidates, last];
    }

    const pending = [];
    for (const p of candidates) {
        if (!extracted.has(p.floorKey)) {
            pending.push({ floorKey: p.floorKey, pairIndex: p.pairIndex, userKey: p.userKey, aiKey: p.aiKey });
        }
    }
    const pendingChanged = !samePendingFloors(data.pending_floors, pending);
    data.pending_floors = pending;
    if (forcePersist || pendingChanged) await saveChatData(data);
    assertChatData(originData);
    for (const item of pending) enqueue('extract', item, QUEUE_PRIORITY.extract);

    const missingCh = enqueueMissingChapters(currentPairs, baseline);
    if (missingCh) appendLog('info', `补偿入队缺失章节摘要 ×${missingCh}`);
    const { scheduleNarrativeMaintenance } = await import('./narrative.js');
    await scheduleNarrativeMaintenance({ excludeTrailingAssistant });
    void pump();
    return pending.length;
}
