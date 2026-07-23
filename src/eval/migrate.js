import { QUEUE_PRIORITY } from '../constants.js';
import { captureBranchCheckpoint } from '../branch.js';
import { handleChapterSummaryJob, buildKeywordIndex } from '../chapter.js';
import { extractFromChapterSummary } from '../extract.js';
import { addEvalCase } from './cases.js';
import {
    appendLog,
    assertChatData,
    getChatData,
    getSettings,
    saveChatData,
    saveSettings,
} from '../settings.js';
import { ensureActivationBaseline, getPairs } from '../ids.js';
import { cancelQueuedJobs, clearFailedJobs, enqueue, getQueueSnapshot } from '../queue.js';

let migrateAbort = false;

export const MIGRATION_JOB_TYPES = [
    'migrate_chapter',
    'migrate_extract_chapter',
    'migrate_extract_floor',
    'migrate_finalize',
    'migrate_complete',
];

function ensureBackfillState(data = getChatData()) {
    data.history_backfill = data.history_backfill || {};
    return Object.assign(data.history_backfill, {
        status: data.history_backfill.status || 'idle',
        total: Number(data.history_backfill.total) || 0,
        completed: Number(data.history_backfill.completed) || 0,
        startedAt: data.history_backfill.startedAt || null,
        finishedAt: data.history_backfill.finishedAt || null,
        stoppedAt: data.history_backfill.stoppedAt || null,
        error: data.history_backfill.error || null,
    });
}

function historyPairs(data = getChatData()) {
    const baseline = Number(data.progress?.baseline_pair ?? -1);
    return getPairs().filter(pair => pair.sealed && pair.pairIndex <= baseline);
}

function countCompleted(data = getChatData(), pairs = historyPairs(data)) {
    const extracted = new Set(data.extracted_keys || []);
    return pairs.filter(pair => extracted.has(pair.floorKey) || extracted.has(`migrated:${pair.floorKey}`)).length;
}

function migrationStage(job) {
    if (!job) return '等待后台开始';
    const start = Number(job.payload?.startPair);
    const end = Number(job.payload?.endPair);
    if (job.type === 'migrate_chapter' && Number.isFinite(start) && Number.isFinite(end)) return `正在整理第 ${start + 1}–${end + 1} 轮剧情`;
    if (job.type === 'migrate_extract_chapter' && Number.isFinite(start) && Number.isFinite(end)) return `正在提取第 ${start + 1}–${end + 1} 轮的重要内容`;
    if (job.type === 'migrate_extract_floor') return `正在整理第 ${Number(job.payload?.pairIndex) + 1} 轮对话`;
    if (job.type === 'migrate_finalize') return '正在核对尚未补记的对话';
    if (job.type === 'migrate_complete') return '正在保存补记结果';
    return '正在整理旧聊天';
}

export function getHistoryBackfillSnapshot() {
    const data = getChatData();
    const state = ensureBackfillState(data);
    const pairs = historyPairs(data);
    const completed = countCompleted(data, pairs);
    const queue = getQueueSnapshot();
    const queued = queue.queued.filter(job => MIGRATION_JOB_TYPES.includes(job.type));
    const inFlight = MIGRATION_JOB_TYPES.includes(queue.inFlight?.type) ? queue.inFlight : null;
    const failed = queue.failed.filter(job => MIGRATION_JOB_TYPES.includes(job.type));
    const total = Math.max(state.total, pairs.length);
    return {
        ...state,
        total,
        completed: Math.min(total, completed),
        queued: queued.length,
        paused: queue.paused,
        inFlight,
        failed,
        stage: queue.paused ? '后台整理已暂停；恢复后台任务后会继续。' : migrationStage(inFlight || queued[0]),
    };
}

export async function requestMigrateAbort() {
    migrateAbort = true;
    const data = getChatData();
    const state = ensureBackfillState(data);
    const queue = getQueueSnapshot();
    const hasRunning = MIGRATION_JOB_TYPES.includes(queue.inFlight?.type);
    state.status = hasRunning ? 'stopping' : 'stopped';
    state.completed = countCompleted(data);
    state.stoppedAt = hasRunning ? null : Date.now();
    await cancelQueuedJobs(MIGRATION_JOB_TYPES);
    await saveChatData(data);
    appendLog('info', hasRunning ? '补记停止请求已收到，当前任务结束后停止' : '补记已停止');
    return getHistoryBackfillSnapshot();
}

/**
 * Migration only covers history at/before activation baseline.
 * Each chapter summary + extract is its own low-priority job.
 * Trailing partial floors get per-floor extract (ignoreBaseline) at finalize.
 */
export async function startMigration() {
    migrateAbort = false;
    const existingQueue = getQueueSnapshot();
    if (existingQueue.inFlight?.type && MIGRATION_JOB_TYPES.includes(existingQueue.inFlight.type)
        || existingQueue.queued.some(job => MIGRATION_JOB_TYPES.includes(job.type))) {
        return getHistoryBackfillSnapshot();
    }
    const baseline = ensureActivationBaseline();
    const allPairs = getPairs().filter(p => p.sealed);
    const pairs = allPairs.filter(p => baseline >= 0 && p.pairIndex <= baseline);
    const data = getChatData();
    const state = ensureBackfillState(data);
    if (!pairs.length) {
        state.status = 'complete';
        state.total = 0;
        state.completed = 0;
        state.finishedAt = Date.now();
        await saveChatData(data);
        appendLog('info', '没有需要补记的旧聊天');
        return getHistoryBackfillSnapshot();
    }

    const settings = getSettings();
    settings.migrationReviewMode = true;
    saveSettings();

    state.status = 'running';
    state.total = pairs.length;
    state.completed = countCompleted(data, pairs);
    state.startedAt = Date.now();
    state.finishedAt = null;
    state.stoppedAt = null;
    state.error = null;
    await clearFailedJobs(MIGRATION_JOB_TYPES);
    await saveChatData(data);

    const size = settings.chapterSize || 25;
    const jobs = [];
    for (let start = 0; start < pairs.length; start += size) {
        const slice = pairs.slice(start, start + size);
        if (!slice.length) {
            continue;
        }
        jobs.push({
            startPair: slice[0].pairIndex,
            endPair: slice[slice.length - 1].pairIndex,
            full: slice.length >= size,
        });
    }

    let lastFullEnd = -1;
    const extracted = new Set(data.extracted_keys || []);
    for (const job of jobs) {
        if (job.full) {
            const complete = pairs.filter(pair => pair.pairIndex >= job.startPair && pair.pairIndex <= job.endPair)
                .every(pair => extracted.has(pair.floorKey) || extracted.has(`migrated:${pair.floorKey}`));
            if (complete) {
                lastFullEnd = Math.max(lastFullEnd, job.endPair);
                continue;
            }
            enqueue('migrate_chapter', {
                startPair: job.startPair,
                endPair: job.endPair,
            }, QUEUE_PRIORITY.migrate);
            enqueue('migrate_extract_chapter', {
                startPair: job.startPair,
                endPair: job.endPair,
            }, QUEUE_PRIORITY.migrate);
            lastFullEnd = Math.max(lastFullEnd, job.endPair);
        }
    }
    // Residual = sealed pairs after the last full chapter's real endPair (no arithmetic grid).
    enqueue('migrate_finalize', { baseline, lastFullEnd }, QUEUE_PRIORITY.migrate);
    appendLog('info', `迁移已入队：${jobs.filter(j => j.full).length} 完整章；缺少的逐轮剧情记录将在收尾时补齐`);
    return getHistoryBackfillSnapshot();
}

export async function handleMigrateChapterJob(payload) {
    if (migrateAbort || ['stopping', 'stopped'].includes(ensureBackfillState().status)) {
        return;
    }
    await handleChapterSummaryJob(payload);
}

export async function handleMigrateExtractChapterJob(payload) {
    if (migrateAbort || ['stopping', 'stopped'].includes(ensureBackfillState().status)) {
        return;
    }
    const { startPair, endPair } = payload;
    const data = getChatData();
    let ch = (data.chapters || []).find(c =>
        c.floor_range?.[0] === startPair && c.floor_range?.[1] === endPair && !c.stale);
    if (!ch) {
        ch = (data.chapters || []).find(c =>
            c.floor_range?.[0] === startPair && c.floor_range?.[1] === endPair);
    }
    if (!ch?.summary) {
        appendLog('warn', `迁移提取跳过：无章摘要 [${startPair}-${endPair}]`);
        return;
    }
    const before = structuredClone(data.state_table);
    await extractFromChapterSummary({ chapter: ch, stateTableSnapshot: before });
    assertChatData(data);

    // Mark covered pair keys so live path never double-touches if baseline is reset
    const pairs = getPairs().filter(p => p.sealed && p.pairIndex >= startPair && p.pairIndex <= endPair);
    const d = data;
    d.extracted_keys = d.extracted_keys || [];
    for (const p of pairs) {
        const marker = `migrated:${p.floorKey}`;
        if (!d.extracted_keys.includes(marker)) {
            d.extracted_keys.push(marker);
        }
    }
    ensureBackfillState(data).completed = countCompleted(data);
    await saveChatData(data);
}

export async function handleMigrateFinalizeJob(payload = {}) {
    const originData = getChatData();
    if (migrateAbort || ['stopping', 'stopped'].includes(ensureBackfillState(originData).status)) {
        appendLog('info', '迁移已中止');
        return;
    }
    const data = getChatData();
    const extracted = new Set(data.extracted_keys || []);
    const summarized = new Set((data.turn_summaries || []).filter(item => item.summary).map(item => item.floorKey));
    const activeChapters = (data.chapters || []).filter(chapter => !chapter.stale && chapter.summary);
    const baseline = Number(payload.baseline ?? data.progress?.baseline_pair ?? -1);
    const pairs = getPairs().filter(pair => {
        if (pair.pairIndex > baseline) return false;
        if (!pair.sealed || summarized.has(pair.floorKey)) return false;
        return !activeChapters.some(chapter =>
            pair.pairIndex >= chapter.floor_range?.[0] && pair.pairIndex <= chapter.floor_range?.[1]);
    });

    for (const p of pairs) {
        const alreadyExtracted = extracted.has(p.floorKey) || extracted.has(`migrated:${p.floorKey}`);
        enqueue('migrate_extract_floor', {
            floorKey: p.floorKey,
            pairIndex: p.pairIndex,
            ignoreBaseline: true,
            summaryOnly: alreadyExtracted,
            historyBackfill: true,
        }, QUEUE_PRIORITY.migrate);
    }
    enqueue('migrate_complete', { baseline }, QUEUE_PRIORITY.migrate_complete);
    appendLog('info', `迁移收尾：残楼补提 ×${pairs.length}`);
}

export async function handleMigrateCompleteJob() {
    const data = getChatData();
    const state = ensureBackfillState(data);
    if (migrateAbort || ['stopping', 'stopped'].includes(state.status)) return;
    buildKeywordIndex(data);
    state.total = historyPairs(data).length;
    state.completed = countCompleted(data);
    state.status = state.completed >= state.total ? 'complete' : 'error';
    state.finishedAt = Date.now();
    state.error = state.status === 'error' ? '仍有旧对话未能完成整理，请重试失败任务或继续补记。' : null;
    data.notices = data.notices || [];
    const already = data.notices.some(item => String(item.note || '').includes('旧聊天补记完成'));
    if (!already && state.status === 'complete') {
        data.notices.push({
            id: crypto.randomUUID(),
            kind: 'notice',
            note: `旧聊天补记完成：已整理 ${state.completed} / ${state.total} 轮。建议检查“当前记忆”。`,
            createdAt: Date.now(),
        });
    }
    captureBranchCheckpoint(data, 'history_migration_complete');
    await saveChatData(data);
    appendLog('info', state.status === 'complete' ? `旧聊天补记完成：${state.completed}/${state.total}` : state.error);
}

export async function settleHistoryBackfillStop(expectedData = getChatData()) {
    if (getChatData() !== expectedData) return false;
    const state = ensureBackfillState(expectedData);
    if (state.status !== 'stopping') return false;
    state.status = 'stopped';
    state.completed = countCompleted(expectedData);
    state.stoppedAt = Date.now();
    await saveChatData(expectedData);
    appendLog('info', `补记已停止：${state.completed}/${state.total}`);
    return true;
}

export async function markHistoryBackfillError(message, expectedData = getChatData()) {
    if (getChatData() !== expectedData) return false;
    const state = ensureBackfillState(expectedData);
    if (state.status === 'stopping' || state.status === 'stopped') return false;
    state.status = 'error';
    state.completed = countCompleted(expectedData);
    state.error = String(message || '补记任务失败');
    await saveChatData(expectedData);
    return true;
}

/**
 * Hook: user edited state table during migration review mode → auto eval case.
 */
export function recordMigrationEdit({ beforeEntry, afterEntry, op }) {
    if (!getSettings().migrationReviewMode) {
        return;
    }
    const data = getChatData();
    const chapters = data.chapters || [];
    const ch = chapters.find(c => {
        const floor = afterEntry?.established_floor || beforeEntry?.established_floor;
        if (typeof floor === 'number') {
            return floor >= c.floor_range[0] && floor <= c.floor_range[1];
        }
        if (typeof floor === 'string' && String(floor).includes(c.id)) {
            return true;
        }
        return false;
    }) || chapters.at(-1);

    addEvalCase({
        pipeline: 'chapter',
        type: op === 'delete' ? 'spurious' : (op === 'add' ? 'miss' : 'wrong'),
        source: 'migration_edit',
        floor_key: ch ? `chapter:${ch.id}` : '',
        chapter_summary: ch?.summary || '',
        user_mes: '',
        ai_mes: ch?.summary || '',
        state_table_snapshot: structuredClone(data.state_table),
        expected: afterEntry
            ? { slot: afterEntry.slot, subject: afterEntry.subject, contains_value: afterEntry.value }
            : { should_be_empty: op === 'delete' },
        note: `迁移校对自动记录：${op}`,
    });
}
