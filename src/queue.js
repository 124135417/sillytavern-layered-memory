import { QUEUE_PRIORITY } from './constants.js';
import { appendLog, getChatData, getSettings, saveChatData } from './settings.js';

/** @type {{ id: string, type: string, priority: number, payload: any, status: string }[]} */
let memoryQueue = [];
let inFlight = null;
let pumping = false;
/** @type {Map<string, function>} */
const handlers = new Map();

export function registerHandler(type, fn) {
    handlers.set(type, fn);
}

function isDuplicateJob(type, payload) {
    const same = (j) => {
        if (j.type !== type) {
            return false;
        }
        if (type === 'extract') {
            return j.payload?.floorKey && j.payload.floorKey === payload.floorKey;
        }
        if (type === 'chapter_summary') {
            if (payload.regenStale) {
                return Boolean(j.payload?.regenStale);
            }
            return j.payload?.startPair === payload.startPair && j.payload?.endPair === payload.endPair;
        }
        if (type === 'migrate_extract_chapter') {
            return j.payload?.startPair === payload.startPair && j.payload?.endPair === payload.endPair;
        }
        if (type === 'volume_compress' && (payload.reason === 'budget' || payload.reason === 'budget_check')) {
            return j.payload?.reason === 'budget' || j.payload?.reason === 'budget_check';
        }
        return false;
    };
    if (memoryQueue.some(j => j.status === 'queued' && same(j))) {
        return true;
    }
    if (inFlight && same(inFlight)) {
        return true;
    }
    return false;
}

export function enqueue(type, payload = {}, priority = QUEUE_PRIORITY[type] ?? 50) {
    const id = crypto.randomUUID();
    if (isDuplicateJob(type, payload)) {
        return null;
    }
    const job = { id, type, priority, payload, status: 'queued', createdAt: Date.now() };
    memoryQueue.push(job);
    memoryQueue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    void pump();
    return id;
}

export function getQueueSnapshot() {
    return {
        inFlight: inFlight ? { ...inFlight } : null,
        queued: memoryQueue.map(j => ({ ...j })),
    };
}

async function pump() {
    if (pumping) {
        return;
    }
    pumping = true;
    try {
        while (memoryQueue.length > 0) {
            memoryQueue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
            const job = memoryQueue.shift();
            const handler = handlers.get(job.type);
            if (!handler) {
                appendLog('warn', `无处理器: ${job.type}`);
                continue;
            }
            inFlight = { ...job, status: 'running' };
            try {
                await handler(job.payload);
            } catch (err) {
                appendLog('error', `任务失败 ${job.type}: ${err?.message ?? err}`, { job });
            } finally {
                inFlight = null;
            }
        }
    } finally {
        pumping = false;
    }
}

/**
 * Rollback extracted_keys that no longer map to a live sealed pair (e.g. deleted messages).
 */
async function rollbackOrphanExtracts(getPairs) {
    const { rollbackFloor } = await import('./merge.js');
    const data = getChatData();
    const live = new Set(
        getPairs().filter(p => p.sealed).map(p => p.floorKey),
    );
    const orphans = (data.extracted_keys || []).filter(k => !live.has(k));
    for (const key of orphans) {
        await rollbackFloor(key);
        appendLog('info', `孤儿提取键已回滚: ${key}`);
    }
    return orphans.length;
}

/**
 * Enqueue chapter summaries for fully-extracted ranges that lack a non-stale chapter.
 * Compensates for jobs lost on refresh between extract-complete and chapter-summary.
 */
function enqueueMissingChapters(getPairs) {
    const settings = getSettings();
    const size = settings.chapterSize || 25;
    const data = getChatData();
    const pairs = getPairs();
    const extracted = new Set(data.extracted_keys || []);
    const sealedIndexes = pairs.filter(p => p.sealed).map(p => p.pairIndex);
    if (!sealedIndexes.length) {
        return 0;
    }
    const maxPair = Math.max(...sealedIndexes);
    if (maxPair < size - 1) {
        return 0;
    }

    let enqueued = 0;
    for (let start = 0; start + size - 1 <= maxPair; start += size) {
        const end = start + size - 1;
        let complete = true;
        for (let i = start; i <= end; i++) {
            const p = pairs.find(x => x.pairIndex === i);
            if (!p?.sealed || !extracted.has(p.floorKey)) {
                complete = false;
                break;
            }
        }
        if (!complete) {
            continue;
        }
        const covered = (data.chapters || []).some(c =>
            !c.stale
            && c.floor_range?.[0] === start
            && c.floor_range?.[1] === end);
        if (!covered) {
            enqueue('chapter_summary', { startPair: start, endPair: end }, QUEUE_PRIORITY.chapter_summary);
            enqueued += 1;
        }
    }
    return enqueued;
}

/**
 * Rebuild pending extract list from chat vs extracted_keys, then enqueue.
 * Also: orphan rollback + missing chapter compensation.
 */
export async function rebuildAndEnqueuePending({ forceLastSealed = false } = {}) {
    const { getFrozenPairs, getPairs } = await import('./ids.js');

    await rollbackOrphanExtracts(getPairs);

    const data = getChatData();
    // re-read after possible rollbacks
    const extracted = new Set(getChatData().extracted_keys || []);
    let candidates = getFrozenPairs();

    if (forceLastSealed) {
        const pairs = getPairs();
        const last = [...pairs].reverse().find(p => p.sealed);
        if (last && !candidates.some(c => c.floorKey === last.floorKey)) {
            candidates = [...candidates, last];
        }
    }

    const pending = [];
    for (const p of candidates) {
        if (!extracted.has(p.floorKey)) {
            pending.push({
                floorKey: p.floorKey,
                pairIndex: p.pairIndex,
                userKey: p.userKey,
                aiKey: p.aiKey,
            });
        }
    }
    data.pending_floors = pending;
    await saveChatData();

    for (const item of pending) {
        enqueue('extract', item, QUEUE_PRIORITY.extract);
    }

    const missingCh = enqueueMissingChapters(getPairs);
    if (missingCh) {
        appendLog('info', `补偿入队缺失章节摘要 ×${missingCh}`);
    }

    return pending.length;
}
