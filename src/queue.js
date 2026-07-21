import { QUEUE_PRIORITY } from './constants.js';
import { appendLog, getChatData, saveChatData } from './settings.js';

/** @type {{ id: string, type: string, priority: number, payload: any, status: string }[]} */
let memoryQueue = [];
let inFlight = null;
let pumping = false;
/** @type {Map<string, function>} */
const handlers = new Map();

export function registerHandler(type, fn) {
    handlers.set(type, fn);
}

export function enqueue(type, payload = {}, priority = QUEUE_PRIORITY[type] ?? 50) {
    const id = crypto.randomUUID();
    // Deduplicate extract jobs for same floorKey
    if (type === 'extract' && payload.floorKey) {
        const dup = memoryQueue.find(j => j.type === 'extract' && j.payload?.floorKey === payload.floorKey && j.status === 'queued');
        if (dup) {
            return dup.id;
        }
        if (inFlight?.type === 'extract' && inFlight.payload?.floorKey === payload.floorKey) {
            return inFlight.id;
        }
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
 * Rebuild pending extract list from chat vs extracted_keys, then enqueue.
 */
export async function rebuildAndEnqueuePending({ forceLastSealed = false } = {}) {
    const { getFrozenPairs, getPairs } = await import('./ids.js');
    const data = getChatData();
    const extracted = new Set(data.extracted_keys || []);
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
    return pending.length;
}
