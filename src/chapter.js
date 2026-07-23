import { QUEUE_PRIORITY } from './constants.js';
import { summarizeChapterNotes } from './archive.js';
import { enqueue } from './queue.js';
import { appendLog, assertChatData, getChatData, saveChatData } from './settings.js';
import { isUsableMemoryEntry } from './quality.js';

function buildKeywordIndex(data) {
    const index = {};
    for (const ch of data.chapters || []) {
        for (const kw of ch.keywords || []) {
            const k = String(kw).trim().toLowerCase();
            if (!k) {
                continue;
            }
            if (!index[k]) {
                index[k] = [];
            }
            if (!index[k].includes(ch.id)) {
                index[k].push(ch.id);
            }
        }
    }
    for (const e of (data.state_table?.entries || []).filter(isUsableMemoryEntry)) {
        for (const name of [e.subject, e.object]) {
            if (!name) {
                continue;
            }
            const k = String(name).trim().toLowerCase();
            if (!k) {
                continue;
            }
            const ch = findChapterForFloorLabel(data, e.updated_floor ?? e.established_floor);
            if (!ch) {
                continue;
            }
            if (!index[k]) {
                index[k] = [];
            }
            if (!index[k].includes(ch.id)) {
                index[k].push(ch.id);
            }
        }
    }
    data.keyword_index = index;
}

function findChapterForFloorLabel(data, floorLabel) {
    if (typeof floorLabel === 'number') {
        return (data.chapters || []).find(c =>
            floorLabel >= c.floor_range[0] && floorLabel <= c.floor_range[1]);
    }
    if (typeof floorLabel === 'string' && floorLabel.startsWith('ch_')) {
        return (data.chapters || []).find(c => c.id === floorLabel.split(' ')[0]);
    }
    return null;
}

function nextChapterId(data) {
    if (!data.progress) {
        data.progress = {};
    }
    const seq = data.progress.next_chapter_seq || 1;
    data.progress.next_chapter_seq = seq + 1;
    return `ch_${String(seq).padStart(3, '0')}`;
}

function advanceChapterEnd(data, endPair) {
    const cur = data.progress.last_chapter_end_pair ?? -1;
    if (endPair > cur) {
        data.progress.last_chapter_end_pair = endPair;
    }
}

export function markChapterStaleForTurnSummaryEdit(data, pairIndex) {
    const affected = [];
    for (const chapter of data?.chapters || []) {
        if (pairIndex < chapter.floor_range?.[0] || pairIndex > chapter.floor_range?.[1]) continue;
        chapter.stale = true;
        chapter.stale_reason = 'turn_summary_edit';
        affected.push(chapter.id);
        if (chapter.volume_id) {
            const volume = (data.volumes || []).find(candidate => candidate.id === chapter.volume_id);
            if (volume) volume.stale = true;
        }
    }
    return affected;
}

export async function handleChapterSummaryJob(payload) {
    if (payload.regenStale) {
        await handleRegenStaleChapters();
        return;
    }
    const { startPair, endPair } = payload;
    const data = getChatData();

    // Fresh non-stale chapter already present → noop
    const fresh = (data.chapters || []).find(c =>
        c.floor_range?.[0] === startPair && c.floor_range?.[1] === endPair && !c.stale);
    if (fresh) {
        return;
    }

    const notes = (data.turn_summaries || [])
        .filter(item => item.pairIndex >= startPair && item.pairIndex <= endPair)
        .sort((a, b) => a.pairIndex - b.pairIndex);
    const result = await summarizeChapterNotes(notes, startPair, endPair, () => assertChatData(data));
    assertChatData(data);

    // Stale (or any) chapter with same range → in-place replace (keep id / volume_id / demoted / pinned)
    const sameRange = (data.chapters || []).find(c =>
        c.floor_range?.[0] === startPair && c.floor_range?.[1] === endPair);
    if (sameRange) {
        sameRange.summary = result.summary;
        sameRange.keywords = result.keywords || [];
        sameRange.key_events = result.key_events || [];
        sameRange.coverage = result.coverage || [];
        sameRange.story_time_range = result.story_time_range || null;
        sameRange.stale = false;
        sameRange.stale_reason = null;
        sameRange.frozen = true;
        if (payload.reason === 'turn_summary_edit') sameRange.manual_override = false;
        advanceChapterEnd(data, endPair);
        buildKeywordIndex(data);
        await saveChatData(data);
        appendLog('info', `章节摘要原地更新 ${sameRange.id} [${startPair}-${endPair}]`);
        if (payload.reason !== 'turn_summary_edit') {
            enqueue('volume_compress', { reason: 'budget_check' }, QUEUE_PRIORITY.volume_compress);
        }
        return;
    }

    const id = nextChapterId(data);
    data.chapters = data.chapters || [];
    data.chapters.push({
        id,
        summary: result.summary,
        keywords: result.keywords || [],
        key_events: result.key_events || [],
        coverage: result.coverage || [],
        story_time_range: result.story_time_range || null,
        floor_range: [startPair, endPair],
        pinned: false,
        demoted: false,
        stale: false,
        frozen: true,
        volume_id: null,
    });
    advanceChapterEnd(data, endPair);
    buildKeywordIndex(data);
    await saveChatData(data);
    appendLog('info', `章节摘要完成 ${id} [${startPair}-${endPair}]`);

    enqueue('volume_compress', { reason: 'budget_check' }, QUEUE_PRIORITY.volume_compress);
}

export async function markChaptersStaleForPair(pairIndex, expectedData = null) {
    const data = getChatData();
    if (expectedData && data !== expectedData) return false;
    let any = false;
    for (const ch of data.chapters || []) {
        const [a, b] = ch.floor_range || [];
        if (pairIndex >= a && pairIndex <= b) {
            ch.stale = true;
            any = true;
            if (ch.volume_id) {
                const vol = (data.volumes || []).find(v => v.id === ch.volume_id);
                if (vol) {
                    vol.stale = true;
                }
            }
        }
    }
    if (any) {
        await saveChatData(data);
        enqueue('chapter_summary', { regenStale: true }, QUEUE_PRIORITY.chapter_summary);
    }
    return any;
}

export async function handleRegenStaleChapters() {
    const data = getChatData();
    const staleChapters = (data.chapters || []).filter(c => c.stale);
    for (const ch of staleChapters) {
        // In-place path via same range match
        await handleChapterSummaryJob({
            startPair: ch.floor_range[0],
            endPair: ch.floor_range[1],
        });
    }
    const staleVols = (getChatData().volumes || []).filter(v => v.stale);
    if (staleVols.length) {
        enqueue('volume_compress', { force: true, staleVolumes: staleVols.map(v => v.id) }, QUEUE_PRIORITY.volume_compress);
    }
}

export { buildKeywordIndex };
