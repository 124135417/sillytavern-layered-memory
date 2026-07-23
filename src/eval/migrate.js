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
import { enqueue } from '../queue.js';

let migrateAbort = false;

export function requestMigrateAbort() {
    migrateAbort = true;
}

/**
 * Migration only covers history at/before activation baseline.
 * Each chapter summary + extract is its own low-priority job.
 * Trailing partial floors get per-floor extract (ignoreBaseline) at finalize.
 */
export async function startMigration() {
    migrateAbort = false;
    const baseline = ensureActivationBaseline();
    const allPairs = getPairs().filter(p => p.sealed);
    const pairs = allPairs.filter(p => baseline >= 0 && p.pairIndex <= baseline);
    if (!allPairs.length) {
        appendLog('warn', '迁移：基线前无定格楼层');
        return;
    }

    const settings = getSettings();
    settings.migrationReviewMode = true;
    saveSettings();

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
    for (const job of jobs) {
        if (job.full) {
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
}

export async function handleMigrateChapterJob(payload) {
    if (migrateAbort) {
        return;
    }
    await handleChapterSummaryJob(payload);
}

export async function handleMigrateExtractChapterJob(payload) {
    if (migrateAbort) {
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
    await saveChatData(data);
}

export async function handleMigrateFinalizeJob(payload = {}) {
    const originData = getChatData();
    if (migrateAbort) {
        appendLog('info', '迁移已中止');
        return;
    }
    const data = getChatData();
    const extracted = new Set(data.extracted_keys || []);
    const summarized = new Set((data.turn_summaries || []).filter(item => item.summary).map(item => item.floorKey));
    const activeChapters = (data.chapters || []).filter(chapter => !chapter.stale && chapter.summary);
    const pairs = getPairs().filter(pair => {
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
        }, QUEUE_PRIORITY.migrate);
    }

    assertChatData(originData);
    buildKeywordIndex(originData);
    const finalData = originData;
    const already = (finalData.review_queue || []).some(x => x.kind === 'alert' && String(x.note || '').includes('旧聊天'));
    if (!already) {
        finalData.review_queue.push({
            id: crypto.randomUUID(),
            kind: 'alert',
            note: `旧聊天的大段剧情已经补记完成，剩余 ${pairs.length} 轮零散对话正在等待整理。完成后建议检查“当前记忆”。`,
            createdAt: Date.now(),
        });
    }
    captureBranchCheckpoint(finalData, 'history_migration_complete');
    await saveChatData(finalData);
    appendLog('info', `迁移收尾：残楼补提 ×${pairs.length}`);
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
