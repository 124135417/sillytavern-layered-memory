import { QUEUE_PRIORITY } from '../constants.js';
import { handleChapterSummaryJob, buildKeywordIndex } from '../chapter.js';
import { extractFromChapterSummary } from '../extract.js';
import { addEvalCase } from './cases.js';
import { appendLog, getChatData, saveChatData } from '../settings.js';
import { getPairs } from '../ids.js';
import { enqueue } from '../queue.js';

let migrateAbort = false;

export function requestMigrateAbort() {
    migrateAbort = true;
}

/**
 * Long-running migration. Enqueued as low priority jobs per chapter.
 */
export async function startMigration() {
    migrateAbort = false;
    const pairs = getPairs().filter(p => p.sealed);
    if (!pairs.length) {
        appendLog('warn', '迁移：无定格楼层');
        return;
    }

    const { getSettings } = await import('../settings.js');
    const size = getSettings().chapterSize || 25;
    const jobs = [];
    for (let start = 0; start < pairs.length; start += size) {
        const end = Math.min(start + size - 1, pairs[pairs.length - 1].pairIndex);
        const endPair = Math.min(start + size - 1, pairs.length - 1);
        // Use actual pairIndex from filtered list
        const slice = pairs.slice(start, start + size);
        if (!slice.length) {
            continue;
        }
        jobs.push({
            startPair: slice[0].pairIndex,
            endPair: slice[slice.length - 1].pairIndex,
        });
        void end;
        void endPair;
    }

    for (const job of jobs) {
        enqueue('migrate_chapter', job, QUEUE_PRIORITY.migrate);
    }
    enqueue('migrate_extract_all', {}, QUEUE_PRIORITY.migrate);
    appendLog('info', `迁移已入队：${jobs.length} 章摘要 + 状态表回填`);
}

export async function handleMigrateChapterJob(payload) {
    if (migrateAbort) {
        return;
    }
    await handleChapterSummaryJob(payload);
}

export async function handleMigrateExtractAllJob() {
    if (migrateAbort) {
        return;
    }
    const data = getChatData();
    const chapters = [...(data.chapters || [])].sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    for (const ch of chapters) {
        if (migrateAbort) {
            break;
        }
        // Snapshot before merge for potential eval
        const before = structuredClone(data.state_table);
        await extractFromChapterSummary({ chapter: ch, stateTableSnapshot: before });
        // Floor labels already chapter-precision via extractFromChapterSummary
    }
    buildKeywordIndex(getChatData());
    await saveChatData();
    getChatData().review_queue.push({
        id: crypto.randomUUID(),
        kind: 'alert',
        note: '存量迁移回填完成，请人工校对状态表。修改将自动记入错例库。',
        createdAt: Date.now(),
    });
    await saveChatData();
    appendLog('info', '迁移状态表回填完成');
}

/**
 * Hook: user edited state table during/after migration → auto eval case.
 */
export function recordMigrationEdit({ beforeEntry, afterEntry, op }) {
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
