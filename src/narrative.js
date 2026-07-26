import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { summarizeChapterNotes } from './archive.js';
import { extractAiBody } from './body.js';
import { QUEUE_PRIORITY } from './constants.js';
import { getMessageFloors } from './ids.js';
import { NARRATIVE_FLOOR_JSON_SCHEMA, NARRATIVE_FLOOR_SYSTEM } from './prompts.js';
import { enqueue } from './queue.js';
import { appendLog, assertChatData, getChatData, getSettings, saveChatData } from './settings.js';

const MAX_BATCH_MESSAGES = 25;
const MAX_BATCH_CHARS = 45_000;

function narrativeText(source) {
    if (source.role === 'assistant') {
        return extractAiBody(source.text, getSettings().bodyExtractionRegex).text;
    }
    return source.text;
}

function boundedText(value, limit = 320) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if ([...text].length <= limit) return text;
    const chars = [...text];
    const head = Math.ceil(limit * 0.7);
    return `${chars.slice(0, head).join('')}……${chars.slice(-(limit - head)).join('')}`;
}

/** Guaranteed temporary coverage while the auxiliary summary job is pending. */
export function fallbackNarrativeSummary(source) {
    const text = boundedText(narrativeText(source));
    if (source.role === 'user') return `<user>：${text || '该楼没有可读取的正文。'}`;
    return `角色回复：${text || '该楼没有可读取的正文。'}`;
}

export function currentNarrativeSources(options = {}) {
    return getMessageFloors(options).map(source => ({
        ...source,
        narrativeText: narrativeText(source),
    }));
}

function matchesSource(record, source) {
    return record?.messageKey === source?.messageKey
        && record?.contentFingerprint === source?.contentFingerprint;
}

/** Remove only records whose source message vanished or changed. */
export function reconcileNarrativeSummaries(data, sources = currentNarrativeSources()) {
    data.narrative_summaries = Array.isArray(data.narrative_summaries) ? data.narrative_summaries : [];
    data.narrative_chapters = Array.isArray(data.narrative_chapters) ? data.narrative_chapters : [];
    data.narrative_volumes = Array.isArray(data.narrative_volumes) ? data.narrative_volumes : [];
    const sourceByKey = new Map(sources.map(source => [source.messageKey, source]));
    let changed = false;
    const affectedFloors = [];
    const kept = [];
    for (const record of data.narrative_summaries) {
        const source = sourceByKey.get(record.messageKey);
        if (!source || !matchesSource(record, source)) {
            changed = true;
            affectedFloors.push(record.messageIndex, source?.messageIndex);
            continue;
        }
        if (record.messageIndex !== source.messageIndex || record.role !== source.role) {
            kept.push({ ...record, messageIndex: source.messageIndex, role: source.role });
            changed = true;
            affectedFloors.push(record.messageIndex, source.messageIndex);
        } else kept.push(record);
    }
    data.narrative_summaries = kept;

    if (changed) {
        const firstAffected = Math.min(...affectedFloors.filter(Number.isInteger));
        const affectedChapterIds = new Set();
        for (const chapter of data.narrative_chapters) {
            if (Number.isFinite(firstAffected) && chapter.floor_range?.[1] < firstAffected) continue;
            chapter.stale = true;
            chapter.stale_reason = 'source_history_changed';
            affectedChapterIds.add(chapter.id);
        }
        for (const volume of data.narrative_volumes) {
            if ((volume.chapter_ids || []).some(id => affectedChapterIds.has(id))) volume.stale = true;
        }
    }
    return changed;
}

function missingSources(data, sources) {
    const records = new Map((data.narrative_summaries || []).map(item => [item.messageKey, item]));
    return sources.filter(source => {
        const record = records.get(source.messageKey);
        return !record || !matchesSource(record, source) || !String(record.summary || '').trim();
    });
}

function makeBatches(sources) {
    const batches = [];
    let batch = [];
    let chars = 0;
    for (const source of sources) {
        const length = [...source.narrativeText].length;
        if (batch.length && (batch.length >= MAX_BATCH_MESSAGES || chars + length > MAX_BATCH_CHARS)) {
            batches.push(batch);
            batch = [];
            chars = 0;
        }
        batch.push(source);
        chars += length;
    }
    if (batch.length) batches.push(batch);
    return batches;
}

export async function scheduleNarrativeMaintenance() {
    const data = getChatData();
    const sources = currentNarrativeSources();
    const changed = reconcileNarrativeSummaries(data, sources);
    if (changed) await saveChatData(data);

    const missing = missingSources(data, sources);
    for (const batch of makeBatches(missing)) {
        enqueue('narrative_summary', {
            messageKeys: batch.map(item => item.messageKey),
            fingerprints: batch.map(item => item.contentFingerprint),
        }, QUEUE_PRIORITY.narrative_summary);
    }
    enqueueMissingNarrativeChapters(data, sources);
    return { total: sources.length, missing: missing.length };
}

function batchPrompt(sources, retryNote = '') {
    return [
        retryNote ? `上次输出没有通过校验：${retryNote}\n请完整修正。\n\n` : '',
        ...sources.map(source => `【第 ${source.messageIndex} 楼｜${source.role === 'user' ? '用户消息' : '角色消息'}】\n${source.narrativeText}`),
    ].join('\n\n');
}

export function validateNarrativeBatch(raw, sources) {
    const floors = Array.isArray(raw?.floors) ? raw.floors : [];
    const expected = sources.map(source => source.messageIndex);
    const results = [];
    const errors = [];
    for (const source of sources) {
        const matches = floors.filter(item => Number(item?.floor) === source.messageIndex);
        if (matches.length !== 1) {
            errors.push(`第 ${source.messageIndex} 楼${matches.length ? '返回重复结果' : '缺少结果'}`);
            continue;
        }
        let summary = String(matches[0]?.summary || '').replace(/\s+/g, ' ').trim();
        const length = [...summary].length;
        if (length < 4 || length > 240) {
            errors.push(`第 ${source.messageIndex} 楼摘要长度异常`);
            continue;
        }
        if (source.role === 'user' && !summary.includes('<user>')) {
            summary = `<user>${summary.replace(/^(?:用户|你)/u, '')}`;
        }
        results.push({ source, summary });
    }
    const returned = floors.map(item => Number(item?.floor)).filter(Number.isInteger);
    if (returned.some(floor => !expected.includes(floor))) errors.push('返回了未请求的楼号');
    return { ok: errors.length === 0 && results.length === sources.length, errors, results };
}

export async function handleNarrativeSummaryJob(payload) {
    const data = getChatData();
    const wanted = new Map((payload.messageKeys || []).map((key, index) => [key, payload.fingerprints?.[index]]));
    const sources = currentNarrativeSources().filter(source => wanted.get(source.messageKey) === source.contentFingerprint);
    if (!sources.length) return;
    const missing = missingSources(data, sources);
    if (!missing.length) return;

    let retryNote = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const { text } = await callAuxModel({
            purpose: 'narrative_summary',
            systemPrompt: NARRATIVE_FLOOR_SYSTEM,
            userPrompt: batchPrompt(missing, retryNote),
            jsonSchema: NARRATIVE_FLOOR_JSON_SCHEMA,
            temperature: 0,
        });
        assertChatData(data);
        const checked = validateNarrativeBatch(parseJsonFromModel(text), missing);
        if (!checked.ok) {
            retryNote = checked.errors.join('；');
            continue;
        }
        data.narrative_summaries = data.narrative_summaries || [];
        for (const { source, summary } of checked.results) {
            const next = {
                messageKey: source.messageKey,
                messageIndex: source.messageIndex,
                role: source.role,
                contentFingerprint: source.contentFingerprint,
                summary,
                updatedAt: Date.now(),
            };
            const index = data.narrative_summaries.findIndex(item => item.messageKey === source.messageKey);
            if (index >= 0) data.narrative_summaries[index] = next;
            else data.narrative_summaries.push(next);
        }
        data.narrative_summaries.sort((a, b) => a.messageIndex - b.messageIndex);
        await saveChatData(data);
        appendLog('info', `逐楼剧情记录完成：第 ${missing[0].messageIndex}–${missing.at(-1).messageIndex} 楼`);
        enqueueMissingNarrativeChapters(data, currentNarrativeSources());
        return;
    }
    const error = new Error(`逐楼剧情记录连续两次未通过校验：${retryNote}`);
    error.status = 422;
    throw error;
}

export function enqueueMissingNarrativeChapters(data = getChatData(), sources = currentNarrativeSources()) {
    const size = getSettings().chapterSize || 25;
    const recordByFloor = new Map((data.narrative_summaries || [])
        .filter(item => String(item.summary || '').trim())
        .map(item => [item.messageIndex, item]));
    const sourceByFloor = new Map(sources.map(item => [item.messageIndex, item]));
    const maxFloor = sources.at(-1)?.messageIndex ?? -1;
    let count = 0;
    for (let startFloor = 0; startFloor + size - 1 <= maxFloor; startFloor += size) {
        const endFloor = startFloor + size - 1;
        const complete = Array.from({ length: size }, (_, offset) => startFloor + offset).every(floor => {
            const source = sourceByFloor.get(floor);
            const record = recordByFloor.get(floor);
            return source && record && matchesSource(record, source);
        });
        if (!complete) continue;
        const fresh = (data.narrative_chapters || []).some(chapter =>
            chapter.floor_range?.[0] === startFloor && chapter.floor_range?.[1] === endFloor && !chapter.stale);
        if (!fresh) {
            enqueue('narrative_chapter', { startFloor, endFloor }, QUEUE_PRIORITY.narrative_chapter);
            count += 1;
        }
    }
    return count;
}

function nextNarrativeChapterId(data) {
    const max = Math.max(0, ...(data.narrative_chapters || [])
        .map(chapter => Number(String(chapter.id || '').replace(/^nch_/, '')))
        .filter(Number.isFinite));
    return `nch_${String(max + 1).padStart(3, '0')}`;
}

export async function handleNarrativeChapterJob(payload) {
    const data = getChatData();
    const { startFloor, endFloor } = payload;
    const sources = currentNarrativeSources();
    const sourceByFloor = new Map(sources.map(item => [item.messageIndex, item]));
    const notes = (data.narrative_summaries || [])
        .filter(item => item.messageIndex >= startFloor && item.messageIndex <= endFloor)
        .filter(item => matchesSource(item, sourceByFloor.get(item.messageIndex)))
        .sort((a, b) => a.messageIndex - b.messageIndex)
        .map(item => ({ pairIndex: item.messageIndex, summary: item.summary }));
    const result = await summarizeChapterNotes(notes, startFloor, endFloor, () => assertChatData(data), { unit: 'floor' });
    assertChatData(data);
    data.narrative_chapters = data.narrative_chapters || [];
    const existing = data.narrative_chapters.find(chapter =>
        chapter.floor_range?.[0] === startFloor && chapter.floor_range?.[1] === endFloor);
    const next = {
        ...(existing || {}),
        id: existing?.id || nextNarrativeChapterId(data),
        summary: result.summary,
        keywords: result.keywords || [],
        key_events: result.key_events || [],
        coverage: result.coverage || [],
        story_time_range: result.story_time_range || null,
        floor_range: [startFloor, endFloor],
        stale: false,
        stale_reason: null,
        frozen: true,
        demoted: Boolean(existing?.demoted),
        volume_id: existing?.volume_id || null,
    };
    if (existing) Object.assign(existing, next);
    else data.narrative_chapters.push(next);
    data.narrative_chapters.sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    await saveChatData(data);
    appendLog('info', `可见楼层章节完成 ${next.id} [${startFloor}-${endFloor}]`);
    enqueue('volume_compress', { reason: 'budget_check', narrative: true }, QUEUE_PRIORITY.volume_compress);
}
