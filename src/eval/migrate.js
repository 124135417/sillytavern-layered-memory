import { QUEUE_PRIORITY } from '../constants.js';
import { handleChapterSummaryJob, buildKeywordIndex } from '../chapter.js';
import { extractFromChapterSummary } from '../extract.js';
import { addEvalCase } from './cases.js';
import { appendLog, getChatData, getSettings, saveChatData, saveSettings } from '../settings.js';
import { getPairs } from '../ids.js';
import { enqueue } from '../queue.js';

let migrateAbort = false;

export function requestMigrateAbort() {
    migrateAbort = true;
}

/**
 * Long-running migration. Each chapter summary + each chapter extract is its own
 * low-priority job so realtime extract can jump the queue between them.
 */
export async function startMigration() {
    migrateAbort = false;
    const pairs = getPairs().filter(p => p.sealed);
    if (!pairs.length) {
        appendLog('warn', '迁移：无定格楼层');
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
        // Only full chapters for summary; trailing partial still gets extract-from-whatever exists after
        jobs.push({
            startPair: slice[0].pairIndex,
            endPair: slice[slice.length - 1].pairIndex,
            full: slice.length >= size,
        });
    }

    for (const job of jobs) {
        if (job.full) {
            enqueue('migrate_chapter', {
                startPair: job.startPair,
                endPair: job.endPair,
            }, QUEUE_PRIORITY.migrate);
        }
        enqueue('migrate_extract_chapter', {
            startPair: job.startPair,
            endPair: job.endPair,
        }, QUEUE_PRIORITY.migrate);
    }
    enqueue('migrate_finalize', {}, QUEUE_PRIORITY.migrate);
    appendLog('info', `迁移已入队：${jobs.filter(j => j.full).length} 章摘要 + ${jobs.length} 章提取（已开启迁移校对模式）`);
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
        // Partial trailing chapter or summary not ready: synthesize a temp summary from range label
        ch = (data.chapters || []).find(c =>
            c.floor_range?.[0] === startPair && c.floor_range?.[1] === endPair);
    }
    if (!ch?.summary) {
        appendLog('warn', `迁移提取跳过：无章摘要 [${startPair}-${endPair}]`);
        return;
    }
    const before = structuredClone(data.state_table);
    await extractFromChapterSummary({ chapter: ch, stateTableSnapshot: before });
}

export async function handleMigrateFinalizeJob() {
    if (migrateAbort) {
        appendLog('info', '迁移已中止');
        return;
    }
    buildKeywordIndex(getChatData());
    const data = getChatData();
    const already = (data.review_queue || []).some(x => x.kind === 'alert' && String(x.note || '').includes('存量迁移'));
    if (!already) {
        data.review_queue.push({
            id: crypto.randomUUID(),
            kind: 'alert',
            note: '存量迁移回填完成。当前为「迁移校对模式」：改表会自动记入错例库。校对结束后请在设置中关闭该模式。',
            createdAt: Date.now(),
        });
    }
    await saveChatData();
    appendLog('info', '迁移状态表回填完成');
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
