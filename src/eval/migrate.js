import { QUEUE_PRIORITY } from '../constants.js';
import { handleChapterSummaryJob, buildKeywordIndex } from '../chapter.js';
import { extractFromChapterSummary } from '../extract.js';
import { addEvalCase } from './cases.js';
import { appendLog, getChatData, getSettings, saveChatData, saveSettings } from '../settings.js';
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
    if (baseline < 0) {
        appendLog('warn', '迁移：无基线历史（新聊天），无需迁移');
        return;
    }

    const pairs = getPairs().filter(p => p.sealed && p.pairIndex <= baseline);
    if (!pairs.length) {
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
    appendLog('info', `迁移已入队：${jobs.filter(j => j.full).length} 完整章（基线≤${baseline}）；尾部残楼将在收尾时 per-floor 补提`);
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

    // Mark covered pair keys so live path never double-touches if baseline is reset
    const pairs = getPairs().filter(p => p.sealed && p.pairIndex >= startPair && p.pairIndex <= endPair);
    const d = getChatData();
    d.extracted_keys = d.extracted_keys || [];
    for (const p of pairs) {
        const marker = `migrated:${p.floorKey}`;
        if (!d.extracted_keys.includes(marker)) {
            d.extracted_keys.push(marker);
        }
    }
    await saveChatData();
}

export async function handleMigrateFinalizeJob(payload = {}) {
    if (migrateAbort) {
        appendLog('info', '迁移已中止');
        return;
    }
    const baseline = payload.baseline ?? ensureActivationBaseline();

    // Trailing residual = sealed pairs after the last full chapter's real endPair, still ≤ baseline.
    // lastFullEnd comes from the actual enqueued chapters (uses real pairIndex, not an arithmetic
    // grid), so unpaired/deleted floors in history never mis-align residual vs chapter coverage.
    // lastFullEnd = -1 (no full chapter) → every sealed pair ≤ baseline is residual.
    const lastFullEnd = payload.lastFullEnd ?? -1;
    const residualStart = lastFullEnd + 1;
    const pairs = getPairs().filter(p =>
        p.sealed && p.pairIndex >= residualStart && p.pairIndex <= baseline);

    for (const p of pairs) {
        enqueue('migrate_extract_floor', {
            floorKey: p.floorKey,
            pairIndex: p.pairIndex,
            ignoreBaseline: true,
        }, QUEUE_PRIORITY.migrate);
    }

    buildKeywordIndex(getChatData());
    const data = getChatData();
    const already = (data.review_queue || []).some(x => x.kind === 'alert' && String(x.note || '').includes('存量迁移'));
    if (!already) {
        data.review_queue.push({
            id: crypto.randomUUID(),
            kind: 'alert',
            note: `存量迁移收尾：完整章已回填；尾部残楼 ${pairs.length} 对已入队 per-floor 补提。当前为「迁移校对模式」。`,
            createdAt: Date.now(),
        });
    }
    await saveChatData();
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
