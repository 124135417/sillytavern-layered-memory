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

/** @type {Array<any>} */
let memoryQueue = [];
let inFlight = null;
let pumping = false;
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
    if (!Object.hasOwn(state, 'running')) state.running = null;
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

    const knownIds = new Set(memoryQueue.map(j => j.id));
    for (const raw of state.queued) {
        if (raw?.type && !knownIds.has(raw.id)) {
            const job = normalizeJob(raw, chatData, scopeId, 'queued');
            memoryQueue.push(job);
            knownIds.add(job.id);
        }
    }
    // A refresh cannot know whether a previously running network request
    // finished. Requeue it; domain handlers are idempotent/deduplicated.
    if (state.running?.type && !knownIds.has(state.running.id)) {
        const recovered = normalizeJob({
            ...state.running,
            lastError: state.running.lastError || '页面刷新后恢复未完成任务',
            nextRetryAt: Date.now(),
        }, chatData, scopeId, 'queued');
        if (recovered.attempt < recovered.maxAttempts) {
            memoryQueue.push(recovered);
        } else if (!state.failed.some(j => j.id === recovered.id)) {
            state.failed.push(publicJob({ ...recovered, status: 'failed', failedAt: Date.now() }));
        }
        state.running = null;
    }
    return { chatData, state, scopeId };
}

function sameWork(a, type, payload) {
    if (a.type !== type) return false;
    if (type === 'extract') return a.payload?.floorKey && a.payload.floorKey === payload.floorKey;
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
        || Boolean(inFlight && inFlight.scopeId === scopeId && sameWork(inFlight, type, payload))
        || failed.some(j => sameWork(j, type, payload));
}

function writeStateFor(scopeId, chatData) {
    const state = ensureQueueState(chatData);
    state.queued = memoryQueue
        .filter(j => j.scopeId === scopeId)
        .map(publicJob);
    state.running = inFlight?.scopeId === scopeId ? publicJob(inFlight) : null;
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

export function getQueueSnapshot() {
    const { state, scopeId } = hydrateCurrentScope();
    return {
        scopeId,
        paused: Boolean(state.paused),
        inFlight: inFlight?.scopeId === scopeId ? publicJob(inFlight) : null,
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

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        await waitForBranchRecovery();
        if (getChatData().branch_origin?.status === 'failed') return;
        while (true) {
            const { chatData, state, scopeId } = activeScope();
            hydrateCurrentScope();
            if (state.paused) break;

            sortQueue();
            const candidates = memoryQueue.filter(j => j.scopeId === scopeId);
            const job = candidates.find(j => !j.nextRetryAt || j.nextRetryAt <= Date.now());
            if (!job) {
                const next = candidates.map(j => j.nextRetryAt).filter(Boolean).sort((a, b) => a - b)[0];
                if (next) scheduleWake(next);
                break;
            }
            memoryQueue = memoryQueue.filter(j => j.id !== job.id);
            const handler = handlers.get(job.type);
            if (!handler) {
                job.status = 'failed';
                job.lastError = `无处理器: ${job.type}`;
                job.failedAt = Date.now();
                state.failed.push(publicJob(job));
                appendLog('warn', job.lastError);
                await persistScope(scopeId, chatData);
                continue;
            }

            job.attempt += 1;
            job.status = 'running';
            job.startedAt = Date.now();
            job.nextRetryAt = null;
            inFlight = job;
            await persistScope(scopeId, chatData);
            try {
                assertChatData(chatData);
            } catch {
                inFlight = null;
                hydratedScopes.delete(scopeId);
                // The origin metadata already records this job as running; it
                // will be recovered when that chat becomes active again.
                continue;
            }

            let error = null;
            try {
                await handler(job.payload);
                assertChatData(chatData);
            } catch (err) {
                error = err;
            } finally {
                inFlight = null;
            }

            if (job.type.startsWith('migrate_')) {
                const { settleHistoryBackfillStop } = await import('./eval/migrate.js');
                await settleHistoryBackfillStop(chatData);
            }

            if (!error) {
                await persistScope(scopeId, chatData);
                continue;
            }

            const retryable = isRetryableError(error);
            job.lastError = safeJobError(error);
            job.finishedAt = Date.now();
            if (error?.code === 'CHAT_SCOPE_CHANGED') {
                // The persisted state still says "running". On returning to the
                // origin chat (or refreshing), hydration safely recovers it.
                hydratedScopes.delete(scopeId);
                continue;
            }
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
            }
            await persistScope(scopeId, chatData);
        }
    } finally {
        pumping = false;
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

export async function rebuildAndEnqueuePending({ forceLastSealed = false } = {}) {
    hydrateCurrentScope();
    const originData = getChatData();
    const { getFrozenPairs, getPairs, ensureActivationBaseline } = await import('./ids.js');
    assertChatData(originData);
    const baseline = ensureActivationBaseline();
    if (originData.branch_origin?.status === 'failed') return 0;
    await rollbackOrphanExtracts(getPairs, originData);
    assertChatData(originData);
    const data = originData;
    const extracted = new Set(data.extracted_keys || []);
    let candidates = getFrozenPairs().filter(p => p.pairIndex > baseline);

    if (forceLastSealed) {
        const pairs = getPairs();
        const last = [...pairs].reverse().find(p => p.sealed && p.pairIndex > baseline);
        if (last && !candidates.some(c => c.floorKey === last.floorKey)) candidates = [...candidates, last];
    }

    const pending = [];
    for (const p of candidates) {
        if (!extracted.has(p.floorKey)) {
            pending.push({ floorKey: p.floorKey, pairIndex: p.pairIndex, userKey: p.userKey, aiKey: p.aiKey });
        }
    }
    data.pending_floors = pending;
    await saveChatData(data);
    assertChatData(originData);
    for (const item of pending) enqueue('extract', item, QUEUE_PRIORITY.extract);

    const missingCh = enqueueMissingChapters(getPairs, baseline);
    if (missingCh) appendLog('info', `补偿入队缺失章节摘要 ×${missingCh}`);
    void pump();
    return pending.length;
}
