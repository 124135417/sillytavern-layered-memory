import { QUEUE_PRIORITY } from './constants.js';
import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { getPairTexts, getPairs } from './ids.js';
import { CHAPTER_SYSTEM } from './prompts.js';
import { enqueue } from './queue.js';
import { appendLog, getChatData, getSettings, saveChatData } from './settings.js';
import { estimateTokens } from './tokens.js';

function buildKeywordIndex(data) {
    const index = {};
    for (const ch of data.chapters || []) {
        if (ch.demoted) {
            // still indexable for L4
        }
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
    // State table entities → chapter of established/updated floor if numeric pair in range
    for (const e of data.state_table?.entries || []) {
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

export async function handleChapterSummaryJob(payload) {
    if (payload.regenStale) {
        await handleRegenStaleChapters();
        return;
    }
    const { startPair, endPair } = payload;
    const settings = getSettings();
    const data = getChatData();
    const existing = (data.chapters || []).find(c =>
        c.floor_range?.[0] === startPair && c.floor_range?.[1] === endPair && !c.stale);
    if (existing) {
        return;
    }

    const pairs = getPairs().filter(p => p.pairIndex >= startPair && p.pairIndex <= endPair && p.sealed);
    const texts = pairs.map(p => {
        const { userText, aiText } = getPairTexts(p);
        return `【第${p.pairIndex}对】\n用户：${userText}\nAI：${aiText}`;
    });
    let body = texts.join('\n\n');
    const cap = settings.chapterInputTokenCap || 20000;
    if (estimateTokens(body) > cap) {
        // Split halves, summarize each, then merge
        const mid = Math.floor(texts.length / 2);
        const left = await summarizeChunk(texts.slice(0, mid).join('\n\n'), data);
        const right = await summarizeChunk(texts.slice(mid).join('\n\n'), data);
        body = `上半摘要：${left.summary}\n下半摘要：${right.summary}`;
    }

    const prev = (data.chapters || []).filter(c => !c.stale && c.floor_range?.[1] < startPair).at(-1);
    const bridge = prev?.summary ? prev.summary.slice(-80) : '';
    const userPrompt = [
        bridge ? `上一章末尾（仅衔接）：…${bridge}\n\n` : '',
        body,
    ].join('');

    const result = await summarizeChunk(userPrompt, data);
    const id = `ch_${String((data.chapters?.length || 0) + 1).padStart(3, '0')}`;
    // Remove stale chapter with same range
    data.chapters = (data.chapters || []).filter(c =>
        !(c.floor_range?.[0] === startPair && c.floor_range?.[1] === endPair));

    data.chapters.push({
        id,
        summary: result.summary,
        keywords: result.keywords || [],
        floor_range: [startPair, endPair],
        pinned: false,
        demoted: false,
        stale: false,
        frozen: true,
        volume_id: null,
    });
    data.progress.last_chapter_end_pair = endPair;
    buildKeywordIndex(data);
    await saveChatData();
    appendLog('info', `章节摘要完成 ${id} [${startPair}-${endPair}]`);

    // Check L2 budget
    enqueue('volume_compress', { reason: 'budget_check' }, QUEUE_PRIORITY.volume_compress);
}

async function summarizeChunk(text, data) {
    const { text: out } = await callAuxModel({
        purpose: 'chapter_summary',
        systemPrompt: CHAPTER_SYSTEM,
        userPrompt: text,
        temperature: 0.2,
    });
    const raw = parseJsonFromModel(out) || { summary: out, keywords: [] };
    return {
        summary: String(raw.summary || out || '').slice(0, 2000),
        keywords: Array.isArray(raw.keywords) ? raw.keywords.slice(0, 10) : [],
    };
}

export async function markChaptersStaleForPair(pairIndex) {
    const data = getChatData();
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
        await saveChatData();
        enqueue('chapter_summary', { regenStale: true }, QUEUE_PRIORITY.chapter_summary);
    }
}

export async function handleRegenStaleChapters() {
    const data = getChatData();
    const staleChapters = (data.chapters || []).filter(c => c.stale);
    for (const ch of staleChapters) {
        await handleChapterSummaryJob({
            startPair: ch.floor_range[0],
            endPair: ch.floor_range[1],
        });
    }
    const staleVols = (data.volumes || []).filter(v => v.stale);
    if (staleVols.length) {
        enqueue('volume_compress', { force: true, staleVolumes: staleVols.map(v => v.id) }, QUEUE_PRIORITY.volume_compress);
    }
}

export { buildKeywordIndex };
