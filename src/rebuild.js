import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { summarizeChapterNotes, validateChapterArchive } from './archive.js';
import { extractAiBody } from './body.js';
import { buildKeywordIndex } from './chapter.js';
import { QUEUE_PRIORITY, SLOTS } from './constants.js';
import { captureBranchCheckpoint } from './branch.js';
import { getPairTexts, getPairs } from './ids.js';
import { HISTORY_SEGMENT_JSON_SCHEMA, HISTORY_SEGMENT_SYSTEM } from './prompts.js';
import { cancelQueuedJobs, clearFailedJobs, enqueue, getQueueSnapshot, retryFailedJob } from './queue.js';
import { normalizeGeneratedEntity, validateMemoryEntryShape } from './quality.js';
import { appendLog, assertChatData, getChatData, getContext, getSettings, saveChatData } from './settings.js';
import { evidenceInSource } from './tokens.js';
import { factIdentityKey, makeFactCandidate, upsertFactCandidate } from './facts.js';
import { normalizeStoryTime, storyTimeRange } from './story-time.js';

export const REBUILD_JOB_TYPES = ['history_rebuild_segment', 'history_rebuild_chapter', 'history_rebuild_commit'];
const SEGMENT_SIZE = 13;
let abortRequested = false;

function clone(value) {
    return structuredClone(value);
}

function rebuildState(data = getChatData()) {
    if (!data.history_rebuild || typeof data.history_rebuild !== 'object') return null;
    const state = data.history_rebuild;
    if (!Array.isArray(state.turn_summaries) && state.status !== 'complete') state.turn_summaries = [];
    if (!Array.isArray(state.entries) && state.status !== 'complete') state.entries = [];
    if (!Array.isArray(state.fact_events) && state.status !== 'complete') state.fact_events = [];
    if (!Array.isArray(state.fact_candidates) && state.status !== 'complete') state.fact_candidates = [];
    if (!Array.isArray(state.chapters) && state.status !== 'complete') state.chapters = [];
    if (!Array.isArray(state.extracted_keys) && state.status !== 'complete') state.extracted_keys = [];
    if (!Array.isArray(state.unresolved_floors)) state.unresolved_floors = [];
    if (!Array.isArray(state.warnings)) state.warnings = [];
    if (!['turns', 'chapters'].includes(state.stage_mode)) state.stage_mode = 'turns';
    return state;
}

function historyPairs(data = getChatData()) {
    return getPairs().filter(pair => pair.sealed);
}

export function matchingTurnSummaries(pairs, summaries) {
    const summariesByFloor = new Map();
    for (const summary of summaries || []) {
        if (Number.isInteger(summary?.pairIndex)) summariesByFloor.set(summary.pairIndex, summary);
    }
    return (pairs || []).flatMap(pair => {
        const summary = summariesByFloor.get(pair.pairIndex);
        return summary?.summary && summary.floorKey === pair.floorKey
            && summary.contentFingerprint === pair.contentFingerprint ? [summary] : [];
    });
}

function createStaging(total, baseline, reuseExisting = false) {
    return {
        status: 'running',
        phase: '正在准备安全重建',
        total,
        completed: 0,
        baseline,
        startedAt: Date.now(),
        finishedAt: null,
        stoppedAt: null,
        error: null,
        turn_summaries: [],
        entries: [],
        fact_events: [],
        fact_candidates: [],
        chapters: [],
        extracted_keys: [],
        unresolved_floors: [],
        warnings: [],
        stage_mode: 'turns',
        reuse_existing: reuseExisting,
    };
}

export function seedStagingFromCurrent(data, staging, pairs) {
    const reusedSummaries = matchingTurnSummaries(pairs, data.turn_summaries);
    const reusedFloors = new Set(reusedSummaries.map(item => item.pairIndex));
    const pairByFloor = new Map(pairs.map(pair => [pair.pairIndex, pair]));
    staging.turn_summaries = clone(reusedSummaries);
    staging.extracted_keys = reusedSummaries.map(summary => `migrated:${summary.floorKey}`);
    staging.fact_events = [];
    for (const event of data.floor_events || []) {
        const pair = pairByFloor.get(event.pairIndex);
        if (!reusedFloors.has(event.pairIndex) || !pair
            || event.floorKey !== pair.floorKey || event.contentFingerprint !== pair.contentFingerprint) continue;
        for (const change of event.entryChanges || []) {
            if (change?.op === 'upsert' && change.after) {
                staging.fact_events.push({ floor: event.pairIndex, fact: clone(change.after) });
            }
        }
    }
    staging.entries = [];
    for (const event of staging.fact_events.slice().sort((a, b) => a.floor - b.floor)) {
        upsertStagedFact(staging, event.fact, event.floor);
    }
    staging.fact_candidates = (data.fact_ledger || []).filter(candidate => {
        const pair = pairByFloor.get(candidate.floor);
        return reusedFloors.has(candidate.floor) && pair
            && candidate.floorKey === pair.floorKey
            && candidate.contentFingerprint === pair.contentFingerprint;
    }).map(clone);
    const size = getSettings().chapterSize || 25;
    staging.chapters = (data.chapters || []).filter(chapter => {
        const [start, end] = chapter.floor_range || [];
        return !chapter.stale && Number.isInteger(start) && Number.isInteger(end)
            && start % size === 0
            && end - start + 1 === size
            && Array.from({ length: size }, (_, offset) => start + offset).every(floor => reusedFloors.has(floor));
    }).map(clone);
    staging.completed = staging.turn_summaries.length;
    return staging;
}

export function mergeStagingFromCurrent(data, staging, pairs) {
    const seeded = createStaging(pairs.length, staging.baseline, true);
    seedStagingFromCurrent(data, seeded, pairs);
    const draftedFloors = new Set((staging.turn_summaries || []).map(item => item.pairIndex));
    const draftedRanges = new Set((staging.chapters || []).map(chapter => JSON.stringify(chapter.floor_range)));

    staging.turn_summaries = [
        ...(staging.turn_summaries || []),
        ...seeded.turn_summaries.filter(item => !draftedFloors.has(item.pairIndex)),
    ].sort((a, b) => a.pairIndex - b.pairIndex);
    staging.fact_events = [
        ...(staging.fact_events || []),
        ...seeded.fact_events.filter(item => !draftedFloors.has(item.floor)),
    ];
    staging.fact_candidates = [
        ...(staging.fact_candidates || []),
        ...seeded.fact_candidates.filter(item => !draftedFloors.has(item.floor)),
    ];
    staging.chapters = [
        ...(staging.chapters || []),
        ...seeded.chapters.filter(chapter => !draftedRanges.has(JSON.stringify(chapter.floor_range))),
    ].sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    staging.extracted_keys = [...new Set([
        ...(staging.extracted_keys || []),
        ...seeded.extracted_keys,
    ])];
    staging.entries = [];
    for (const event of staging.fact_events.slice().sort((a, b) => a.floor - b.floor)) {
        upsertStagedFact(staging, event.fact, event.floor);
    }
    staging.completed = staging.turn_summaries.length;
    staging.reuse_existing = true;
    return staging;
}

export function currentMatchingTurnSummaries(data = getChatData()) {
    return matchingTurnSummaries(historyPairs(data), data.turn_summaries);
}

function pairsForActiveRebuild(data, state) {
    const pairs = historyPairs(data);
    if (!state || !['running', 'stopping'].includes(state.status)) return pairs;
    return pairs.slice(0, Math.max(0, Number(state.total) || 0));
}

function backupCurrent(data) {
    return {
        createdAt: Date.now(),
        state_table: clone(data.state_table),
        turn_summaries: clone(data.turn_summaries || []),
        floor_events: clone(data.floor_events || []),
        branch_checkpoints: clone(data.branch_checkpoints || []),
        chapters: clone(data.chapters || []),
        volumes: clone(data.volumes || []),
        keyword_index: clone(data.keyword_index || {}),
        extracted_keys: clone(data.extracted_keys || []),
        quarantined_entries: clone(data.quarantined_entries || []),
        fact_ledger: clone(data.fact_ledger || []),
        fact_decisions: clone(data.fact_decisions || []),
        manual_events: clone(data.manual_events || []),
        history_backfill: clone(data.history_backfill || {}),
        review_queue: clone(data.review_queue || []),
        notices: clone(data.notices || []),
        progress: clone(data.progress || {}),
    };
}

function pairSource(pair) {
    const { userText, aiText } = getPairTexts(pair);
    const body = extractAiBody(aiText, getSettings().bodyExtractionRegex);
    return {
        pair,
        userText,
        aiText: body.text,
        bodyMode: body.mode,
        sourceText: `${userText}\n${body.text}`,
    };
}

function segmentPrompt(sources, retryNote = '') {
    return [
        retryNote ? `上次输出没有通过校验：${retryNote}\n请完整修正，不要省略任何轮次。\n\n` : '',
        ...sources.map(item => `【第 ${item.pair.pairIndex} 轮】\n用户：${item.userText}\nAI 正文：${item.aiText}`),
    ].join('\n\n');
}

function stripWrappingQuotes(value) {
    let text = String(value ?? '').trim();
    const pairs = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"]];
    for (const [left, right] of pairs) {
        if (text.startsWith(left) && text.endsWith(right) && text.length > left.length + right.length) {
            text = text.slice(left.length, -right.length).trim();
            break;
        }
    }
    return text;
}

function canonicalEvidenceChars(value) {
    const punctuation = new Map([
        ['（', '('], ['）', ')'],
    ]);
    const separators = /[\s，。,:：;；!！?？—–…]/u;
    const chars = [];
    const sourceIndexes = [];
    const original = [...String(value ?? '')];
    for (let index = 0; index < original.length; index += 1) {
        let char = original[index];
        if (separators.test(char)) char = ' ';
        else char = punctuation.get(char) || char;
        if (char === ' ' && chars.at(-1) === ' ') continue;
        chars.push(char);
        sourceIndexes.push(index);
    }
    return { chars, sourceIndexes, original };
}

export function recoverEvidence(rawEvidence, sourceText) {
    const candidate = stripWrappingQuotes(rawEvidence);
    const source = String(sourceText ?? '');
    if (!candidate || !source) return '';
    let recovered = '';
    if (source.includes(candidate)) {
        recovered = candidate;
    } else {
        const haystack = canonicalEvidenceChars(source);
        const needle = canonicalEvidenceChars(candidate).chars;
        outer: for (let start = 0; start + needle.length <= haystack.chars.length; start += 1) {
            for (let offset = 0; offset < needle.length; offset += 1) {
                if (haystack.chars[start + offset] !== needle[offset]) continue outer;
            }
            const originalStart = haystack.sourceIndexes[start];
            const originalEnd = haystack.sourceIndexes[start + needle.length - 1] + 1;
            recovered = haystack.original.slice(originalStart, originalEnd).join('');
            break;
        }
    }
    return [...recovered].slice(0, 50).join('').trimEnd();
}

export function normalizeHistoryUserSummary(value, userName = '') {
    const summary = String(value ?? '').trim();
    if (summary.startsWith('<user>')) return summary;
    const aliases = [String(userName || '').trim(), '用户', '你'].filter(Boolean);
    for (const alias of aliases) {
        if (summary.startsWith(alias)) return `<user>${summary.slice(alias.length)}`;
    }
    return summary;
}

function normalizeFact(raw, source, userName) {
    const slot = String(raw?.slot || '').trim();
    const value = slot === 'relationship' ? raw?.new_value : (raw?.value ?? raw?.new_value);
    const fact = {
        slot,
        topic: String(raw?.topic ?? '').trim() || String(value ?? '').trim(),
        subject: normalizeGeneratedEntity(raw?.subject, userName),
        object: normalizeGeneratedEntity(raw?.object, userName),
        value: String(value ?? '').trim(),
        old_value: String(raw?.old_value ?? '').trim(),
        new_value: String(raw?.new_value ?? '').trim(),
        evidence: recoverEvidence(raw?.evidence, source.sourceText),
        why_persistent: String(raw?.why_persistent ?? '').trim(),
        cause: String(raw?.cause ?? '').trim(),
        source: 'auto',
    };
    const errors = [];
    if (!SLOTS.includes(slot)) errors.push('事实类型无法识别');
    if (slot === 'relationship' && (!fact.old_value || !fact.new_value)) errors.push('关系变化缺少旧状态或新状态');
    const shape = validateMemoryEntryShape(fact);
    errors.push(...shape.errors);
    if (!fact.evidence || !evidenceInSource(fact.evidence, source.sourceText)) errors.push('证据无法恢复为该轮原文');
    if (slot === 'other' && !fact.why_persistent) errors.push('其他事实缺少持续原因');
    return { fact, errors };
}

export function validateHistorySegment(raw, sources, userName = '') {
    const expected = sources.map(item => item.pair.pairIndex);
    const floors = Array.isArray(raw?.floors) ? raw.floors : [];
    const errors = [];
    const warnings = [];
    const failedFloors = [];
    const normalized = [];
    const candidates = [];
    const expectedSet = new Set(expected);
    for (const item of floors) {
        const floor = Number(item?.floor);
        if (!expectedSet.has(floor)) warnings.push(`忽略了未请求的第 ${Number.isFinite(floor) ? floor : '?'} 轮结果`);
    }
    for (const source of sources) {
        const floor = source.pair.pairIndex;
        const floorResults = floors.filter(item => Number(item?.floor) === floor);
        if (!floorResults.length) {
            const message = `第 ${floor} 轮缺少结果`;
            errors.push(message);
            failedFloors.push({ floor, errors: [message] });
            continue;
        }
        if (floorResults.length > 1) {
            const message = `第 ${floor} 轮返回了重复结果`;
            errors.push(message);
            failedFloors.push({ floor, errors: [message] });
            continue;
        }
        const item = floorResults[0] || {};
        const summary = normalizeHistoryUserSummary(item.summary, userName);
        const floorErrors = [];
        if ([...summary].length < 10 || [...summary].length > 500) floorErrors.push(`第 ${floor} 轮摘要为空或长度异常`);
        if (summary && !summary.startsWith('<user>')) floorErrors.push(`第 ${floor} 轮摘要遗漏了用户本轮的行为或话语`);
        const facts = [];
        let factIndex = 0;
        for (const rawFact of Array.isArray(item.facts) ? item.facts : []) {
            const checked = normalizeFact(rawFact, source, userName);
            candidates.push(makeFactCandidate({
                fact: checked.fact,
                floor,
                floorKey: source.pair.floorKey,
                contentFingerprint: source.pair.contentFingerprint || null,
                source: 'auto',
                errors: checked.errors,
                index: factIndex++,
            }));
            if (checked.errors.length) warnings.push(`第 ${floor} 轮已忽略一条不可靠事实：${checked.errors.join('；')}`);
            else facts.push(checked.fact);
        }
        if (floorErrors.length) {
            errors.push(...floorErrors);
            failedFloors.push({ floor, errors: floorErrors });
            continue;
        }
        normalized.push({ floor, summary, facts, story_time: normalizeStoryTime(item.story_time, source.sourceText) });
    }
    return { ok: failedFloors.length === 0, errors, warnings, failedFloors, floors: normalized, candidates };
}

function upsertStagedFact(staging, fact, floor) {
    const duplicate = staging.entries.find(entry => factIdentityKey(entry) === factIdentityKey(fact));
    if (duplicate) {
        duplicate.value = fact.value;
        duplicate.evidence = fact.evidence;
        duplicate.why_persistent = fact.why_persistent;
        duplicate.cause = fact.cause || fact.old_value;
        duplicate.updated_floor = floor;
        return;
    }
    staging.entries.push({
        ...fact,
        id: `staged_${staging.entries.length + 1}`,
        established_floor: floor,
        updated_floor: floor,
        pinned: false,
    });
}

function memoryKey(entry) {
    return `${entry.slot}\u0000${entry.subject}\u0000${entry.object || ''}`;
}

function applySegment(staging, validated, sources) {
    const sourceByFloor = new Map(sources.map(item => [item.pair.pairIndex, item]));
    const replacedFloors = new Set(validated.floors.map(item => item.floor));
    staging.fact_events = (staging.fact_events || []).filter(event => !replacedFloors.has(event.floor));
    for (const item of validated.floors) {
        const source = sourceByFloor.get(item.floor);
        const existing = staging.turn_summaries.find(summary => summary.pairIndex === item.floor);
        const next = {
            floorKey: source.pair.floorKey,
            pairIndex: item.floor,
            contentFingerprint: source.pair.contentFingerprint,
            summary: item.summary,
            story_time: item.story_time,
            sourceMode: source.bodyMode,
            updatedAt: Date.now(),
        };
        if (existing) Object.assign(existing, next);
        else staging.turn_summaries.push(next);
        const marker = `migrated:${source.pair.floorKey}`;
        if (!staging.extracted_keys.includes(marker)) staging.extracted_keys.push(marker);
        for (const fact of item.facts) {
            staging.fact_events.push({ floor: item.floor, fact: clone(fact) });
        }
    }
    staging.entries = [];
    for (const event of staging.fact_events.slice().sort((a, b) => a.floor - b.floor)) {
        upsertStagedFact(staging, event.fact, event.floor);
    }
    staging.completed = staging.turn_summaries.length;
    staging.fact_candidates = (staging.fact_candidates || []).filter(candidate => !replacedFloors.has(candidate.floor));
    for (const candidate of validated.candidates || []) {
        if (replacedFloors.has(candidate.floor)) upsertFactCandidate(staging.fact_candidates, candidate);
    }
}

export async function handleHistoryRebuildSegment(payload) {
    const data = getChatData();
    const staging = rebuildState(data);
    if (!staging || abortRequested || staging.status !== 'running') return;
    const requestedFloors = Array.isArray(payload.pairIndexes) ? new Set(payload.pairIndexes.map(Number)) : null;
    const sources = getPairs()
        .filter(pair => pair.sealed && (requestedFloors
            ? requestedFloors.has(pair.pairIndex)
            : pair.pairIndex >= payload.startPair && pair.pairIndex <= payload.endPair))
        .map(pairSource);
    const expectedCount = requestedFloors?.size ?? (payload.endPair - payload.startPair + 1);
    if (sources.length !== expectedCount) throw nonRetryableError(`找不到完整对话：需要 ${expectedCount} 轮，实际 ${sources.length} 轮`);
    let retryNote = '';
    let pendingSources = sources;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        staging.phase = `正在逐轮核对第 ${formatRebuildFloorList(pendingSources.map(source => source.pair.pairIndex))} 轮`;
        await saveChatData(data);
        notifyRebuildProgress();
        const { text } = await callAuxModel({
            purpose: 'history_rebuild_segment',
            systemPrompt: HISTORY_SEGMENT_SYSTEM,
            userPrompt: segmentPrompt(pendingSources, retryNote),
            jsonSchema: HISTORY_SEGMENT_JSON_SCHEMA,
            temperature: 0,
        });
        assertChatData(data);
        const raw = parseJsonFromModel(text);
        const checked = validateHistorySegment(raw, pendingSources, getContext().name1 || '');
        if (checked.floors.length) applySegment(staging, checked, pendingSources);
        for (const warning of checked.warnings) {
            if (!staging.warnings.includes(warning)) staging.warnings.push(warning);
        }
        const accepted = new Set(checked.floors.map(item => item.floor));
        staging.unresolved_floors = (staging.unresolved_floors || []).filter(item => !accepted.has(item.floor));
        pendingSources = pendingSources.filter(source => !accepted.has(source.pair.pairIndex));
        await saveChatData(data);
        notifyRebuildProgress();
        if (!pendingSources.length) return;
        retryNote = `${checked.errors.join('；')}。本次只返回下方列出的失败轮次，不要返回其他轮次。`;
    }
    const failedFloorSet = new Set(pendingSources.map(source => source.pair.pairIndex));
    staging.unresolved_floors = (staging.unresolved_floors || []).filter(item => !failedFloorSet.has(item.floor));
    for (const source of pendingSources) {
        staging.unresolved_floors.push({ floor: source.pair.pairIndex, error: retryNote, attempts: 2 });
    }
    staging.phase = `第 ${[...failedFloorSet].join('、')} 轮需要单独重试`;
    await saveChatData(data);
    notifyRebuildProgress();
}

export async function handleHistoryRebuildChapter(payload) {
    const data = getChatData();
    const staging = rebuildState(data);
    if (!staging || abortRequested || staging.status !== 'running' || staging.stage_mode !== 'chapters') return;
    const notes = staging.turn_summaries
        .filter(item => item.pairIndex >= payload.startPair && item.pairIndex <= payload.endPair)
        .sort((a, b) => a.pairIndex - b.pairIndex);
    if (notes.length !== payload.endPair - payload.startPair + 1) {
        staging.phase = `第 ${payload.startPair}–${payload.endPair} 轮尚未齐全，暂不合并章节`;
        await saveChatData(data);
        return;
    }
    staging.phase = `正在合并第 ${payload.startPair}–${payload.endPair} 轮剧情`;
    await saveChatData(data);
    notifyRebuildProgress();
    const result = await summarizeChapterNotes(notes, payload.startPair, payload.endPair, () => assertChatData(data));
    const existing = staging.chapters.find(chapter => chapter.floor_range?.[0] === payload.startPair);
    const chapter = {
                id: existing?.id || `staged_ch_${String(staging.chapters.length + 1).padStart(3, '0')}`,
                ...result,
                story_time_range: storyTimeRange(notes),
                floor_range: [payload.startPair, payload.endPair],
                pinned: false,
                demoted: false,
                stale: false,
                frozen: true,
                manual_override: false,
                volume_id: null,
            };
    if (existing) Object.assign(existing, chapter);
    else staging.chapters.push(chapter);
    await saveChatData(data);
}

export { validateChapterArchive } from './archive.js';

function idFactory(entries, prefix, width) {
    let next = Math.max(0, ...entries
        .map(entry => Number(String(entry.id || '').replace(new RegExp(`^${prefix}_`), '')))
        .filter(Number.isFinite)) + 1;
    return {
        take: () => `${prefix}_${String(next++).padStart(width, '0')}`,
        peek: () => next,
    };
}

export async function handleHistoryRebuildCommit() {
    const data = getChatData();
    const staging = rebuildState(data);
    if (!staging || abortRequested || staging.status !== 'running') return;
    const pairs = pairsForActiveRebuild(data, staging);
    if (staging.turn_summaries.length !== pairs.length) {
        const done = new Set(staging.turn_summaries.map(item => item.pairIndex));
        const missing = pairs.filter(pair => !done.has(pair.pairIndex)).map(pair => pair.pairIndex);
        staging.status = 'error';
        staging.error = `仍有 ${missing.length} 轮需要重试：第 ${missing.join('、')} 轮`;
        staging.phase = '已保留合格结果，等待继续重建';
        await saveChatData(data);
        appendLog('warn', staging.error);
        return;
    }
    if (staging.stage_mode !== 'chapters') {
        staging.status = 'review';
        staging.completed = pairs.length;
        staging.error = null;
        staging.phase = '对话记录已经生成，等待检查和修改';
        await saveChatData(data);
        appendLog('info', `对话记录草稿已完成：${pairs.length}/${pairs.length}`);
        return;
    }
    const fullChapterCount = Math.floor(pairs.length / (getSettings().chapterSize || 25));
    if (staging.chapters.length !== fullChapterCount) {
        staging.status = 'error';
        staging.error = `对话记录已经齐全，仍有 ${fullChapterCount - staging.chapters.length} 章需要重新合并`;
        staging.phase = '已保留合格结果，等待继续重建';
        await saveChatData(data);
        appendLog('warn', staging.error);
        return;
    }

    staging.phase = '正在安全替换旧结果';
    await saveChatData(data);
    const preservedEntries = (data.state_table?.entries || []).filter(entry => entry.source === 'manual'
        || entry.source === 'proofread' || entry.pinned || entry.manual_override);
    const entryIds = idFactory(preservedEntries, 'e', 4);
    const preservedKeys = new Set(preservedEntries.map(factIdentityKey));
    const rebuiltEntries = staging.entries
        .filter(entry => !preservedKeys.has(factIdentityKey(entry)))
        .map(entry => ({ ...entry, id: entryIds.take() }));
    const pinnedChapters = (data.chapters || []).filter(chapter => chapter.pinned || chapter.manual_override);
    const pinnedRanges = new Set(pinnedChapters.map(chapter => JSON.stringify(chapter.floor_range)));
    const chapterIds = idFactory(pinnedChapters, 'ch', 3);
    const rebuiltChapters = staging.chapters
        .filter(chapter => !pinnedRanges.has(JSON.stringify(chapter.floor_range)))
        .sort((a, b) => a.floor_range[0] - b.floor_range[0])
        .map(chapter => ({ ...chapter, id: chapterIds.take() }));

    data.state_table = {
        version: Number(data.state_table?.version || 0) + 1,
        entries: [...preservedEntries, ...rebuiltEntries],
        changelog: [],
    };
    const preservedTurnSummaries = new Map((data.turn_summaries || [])
        .filter(summary => summary.manual_override)
        .map(summary => [summary.pairIndex, summary]));
    data.turn_summaries = clone(staging.turn_summaries).map(summary => {
        const manual = preservedTurnSummaries.get(summary.pairIndex);
        const sameSource = manual && manual.floorKey === summary.floorKey
            && manual.contentFingerprint === summary.contentFingerprint;
        return sameSource ? { ...summary, summary: manual.summary, manual_override: true, updatedAt: manual.updatedAt } : summary;
    });
    const rebuiltByKey = new Map(rebuiltEntries.map(entry => [factIdentityKey(entry), entry]));
    const firstFloorByKey = new Map();
    for (const event of (staging.fact_events || []).slice().sort((a, b) => a.floor - b.floor)) {
        const key = factIdentityKey(event.fact);
        if (!firstFloorByKey.has(key)) firstFloorByKey.set(key, event.floor);
    }
    const factEventsByFloor = new Map();
    for (const event of staging.fact_events || []) {
        const finalEntry = rebuiltByKey.get(factIdentityKey(event.fact));
        if (!finalEntry) continue;
        const after = {
            ...clone(event.fact),
            id: finalEntry.id,
            established_floor: firstFloorByKey.get(factIdentityKey(event.fact)),
            updated_floor: event.floor,
            pinned: false,
            source: 'auto',
        };
        const changes = factEventsByFloor.get(event.floor) || [];
        changes.push({ op: 'upsert', id: finalEntry.id, after });
        factEventsByFloor.set(event.floor, changes);
    }
    data.floor_events = data.turn_summaries.map(summary => ({
        floorKey: summary.floorKey,
        pairIndex: summary.pairIndex,
        contentFingerprint: summary.contentFingerprint,
        turnSummary: summary.summary,
        storyTime: summary.story_time || null,
        entryChanges: factEventsByFloor.get(summary.pairIndex) || [],
        recordedAt: Math.max(1, summary.pairIndex + 1),
    }));
    const preservedCandidateIds = new Set((data.fact_decisions || []).map(item => item.candidateId));
    const preservedCandidates = (data.fact_ledger || []).filter(candidate => preservedCandidateIds.has(candidate.id)
        || candidate.source === 'manual');
    data.fact_ledger = [...preservedCandidates];
    for (const candidate of staging.fact_candidates || []) upsertFactCandidate(data.fact_ledger, clone(candidate));
    data.chapters = [...pinnedChapters, ...rebuiltChapters].sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    data.volumes = [];
    data.extracted_keys = clone(staging.extracted_keys);
    data.quarantined_entries = (data.quarantined_entries || []).filter(entry => entry.source === 'manual'
        || entry.pinned || entry.manual_override);
    data.review_queue = [];
    data.progress.last_chapter_end_pair = Math.max(-1, ...data.chapters.map(chapter => Number(chapter.floor_range?.[1])).filter(Number.isFinite));
    data.progress.next_entry_seq = entryIds.peek();
    data.progress.next_chapter_seq = chapterIds.peek();
    buildKeywordIndex(data);
    data.history_backfill = {
        status: 'complete', total: pairs.length, completed: pairs.length,
        startedAt: staging.startedAt, finishedAt: Date.now(), stoppedAt: null, error: null,
    };
    staging.status = 'complete';
    staging.completed = pairs.length;
    staging.finishedAt = Date.now();
    staging.phase = '安全重建完成';
    delete staging.turn_summaries;
    delete staging.entries;
    delete staging.fact_events;
    delete staging.fact_candidates;
    delete staging.chapters;
    delete staging.extracted_keys;
    data.notices = (data.notices || []).filter(item => !/补记|重建|父聊天还没有可继承|开始自动记录/.test(String(item.note || '')));
    data.notices.push({ id: crypto.randomUUID(), kind: 'notice', note: `旧聊天安全重建完成：已核对 ${pairs.length} / ${pairs.length} 轮。`, createdAt: Date.now() });
    data.branch_checkpoints = [{
        id: crypto.randomUUID(),
        anchorFloorKey: null,
        anchorPairIndex: -1,
        anchorFingerprint: null,
        prefixFingerprints: [],
        stateTable: { version: 1, entries: [], changelog: [] },
        createdAt: 0,
        reason: 'history_rebuild_seed',
    }];
    captureBranchCheckpoint(data, 'history_rebuild_complete');
    await saveChatData(data);
    appendLog('info', `旧聊天安全重建完成：${pairs.length}/${pairs.length}`);
}

function nonRetryableError(message) {
    const error = new Error(message);
    error.status = 422;
    return error;
}

export function formatRebuildFloorList(values) {
    const floors = [...new Set((values || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    if (!floors.length) return '';
    const parts = [];
    let start = floors[0];
    let end = start;
    for (const floor of floors.slice(1)) {
        if (floor === end + 1) {
            end = floor;
            continue;
        }
        parts.push(start === end ? String(start) : `${start}–${end}`);
        start = floor;
        end = floor;
    }
    parts.push(start === end ? String(start) : `${start}–${end}`);
    return parts.join('、');
}

function notifyRebuildProgress() {
    if (typeof globalThis.dispatchEvent !== 'function' || typeof globalThis.CustomEvent !== 'function') return;
    globalThis.dispatchEvent(new globalThis.CustomEvent('layered-memory:queue-changed'));
}

export function rebuildStage(job, state) {
    if (job?.type === 'history_rebuild_segment') {
        const floors = job.payload.pairIndexes?.length
            ? formatRebuildFloorList(job.payload.pairIndexes)
            : `${job.payload.startPair}–${job.payload.endPair}`;
        return `正在逐轮核对第 ${floors} 轮`;
    }
    if (job?.type === 'history_rebuild_chapter') return `正在合并第 ${job.payload.startPair}–${job.payload.endPair} 轮剧情`;
    if (job?.type === 'history_rebuild_commit') return job.payload?.reviewOnly ? '正在完成对话记录草稿' : '正在安全替换旧结果';
    if (state?.phase) return state.phase;
    return '等待后台开始';
}

export function buildRebuildSegmentRanges(pairs, size = 25) {
    const ranges = [];
    const fullLength = Math.floor(pairs.length / size) * size;
    for (let chapterOffset = 0; chapterOffset < fullLength; chapterOffset += size) {
        const chapterPairs = pairs.slice(chapterOffset, chapterOffset + size);
        const split = Math.ceil(chapterPairs.length / 2);
        for (const slice of [chapterPairs.slice(0, split), chapterPairs.slice(split)]) {
            if (slice.length) ranges.push([slice[0].pairIndex, slice.at(-1).pairIndex]);
        }
    }
    const tail = pairs.slice(fullLength);
    for (let offset = 0; offset < tail.length; offset += SEGMENT_SIZE) {
        const slice = tail.slice(offset, offset + SEGMENT_SIZE);
        if (slice.length) ranges.push([slice[0].pairIndex, slice.at(-1).pairIndex]);
    }
    return ranges;
}

export function buildMissingRebuildSegmentPayloads(pairs, doneFloors, size = 25) {
    const done = doneFloors instanceof Set ? doneFloors : new Set(doneFloors || []);
    return buildRebuildSegmentRanges(pairs, size).flatMap(([startPair, endPair]) => {
        const pairIndexes = pairs
            .filter(pair => pair.pairIndex >= startPair && pair.pairIndex <= endPair && !done.has(pair.pairIndex))
            .map(pair => pair.pairIndex);
        return pairIndexes.length ? [{ startPair, endPair, pairIndexes }] : [];
    });
}

export function getHistoryRebuildSnapshot() {
    const data = getChatData();
    const state = rebuildState(data);
    const currentPairs = historyPairs(data);
    if (!state) {
        const total = currentPairs.length;
        const completed = matchingTurnSummaries(currentPairs, data.turn_summaries).length;
        const size = getSettings().chapterSize || 25;
        const fullChapterTotal = Math.floor(total / size);
        const tailStart = fullChapterTotal * size;
        return {
            status: 'idle', phase: '尚未开始', stage: '尚未开始', total, completed: 0,
            turnSummaryCount: completed,
            warningCount: 0,
            queued: 0, inFlight: null, failed: [], paused: false,
            turnProgress: { status: completed === total && total > 0 ? 'complete' : completed ? 'partial' : 'idle', completed, total },
            chapterProgress: {
                status: 'locked',
                completed: 0,
                total: fullChapterTotal,
                currentRange: null,
                remaining: fullChapterTotal,
                tailRange: total > tailStart ? [tailStart, total - 1] : null,
            },
        };
    }
    const queue = getQueueSnapshot();
    const queued = queue.queued.filter(job => REBUILD_JOB_TYPES.includes(job.type));
    const running = (queue.running || []).filter(job => REBUILD_JOB_TYPES.includes(job.type));
    const inFlight = running[0] || null;
    const failed = queue.failed.filter(job => REBUILD_JOB_TYPES.includes(job.type));
    const stalePausedState = ['stopped', 'error', 'review'].includes(state.status)
        && Number(state.total) !== currentPairs.length;
    const activeState = state.status !== 'complete' && !stalePausedState;
    const scopedPairs = activeState ? currentPairs.slice(0, Math.max(0, Number(state.total) || 0)) : currentPairs;
    const total = scopedPairs.length;
    const size = getSettings().chapterSize || 25;
    const fullChapterTotal = Math.floor(total / size);
    const expectedRanges = Array.from({ length: fullChapterTotal }, (_, index) => [index * size, index * size + size - 1]);
    const chapterSource = state.status === 'complete' || stalePausedState ? (data.chapters || []) : (state.chapters || []);
    const completeRanges = new Set(chapterSource.map(chapter => JSON.stringify(chapter.floor_range)));
    const chapterCompleted = expectedRanges.filter(range => completeRanges.has(JSON.stringify(range))).length;
    const activeChapterJob = [...running, ...queued, ...failed].find(job => job?.type === 'history_rebuild_chapter');
    const tailStart = fullChapterTotal * size;
    const turnSource = state.status === 'complete' || stalePausedState ? (data.turn_summaries || []) : (state.turn_summaries || []);
    const completedTurns = matchingTurnSummaries(scopedPairs, turnSource).length;
    const turnsComplete = completedTurns === total;
    const turnStatus = turnsComplete ? 'complete'
        : stalePausedState ? (completedTurns ? 'partial' : 'idle')
        : state.status === 'complete' ? (completedTurns ? 'partial' : 'idle')
            : state.stage_mode === 'turns' ? state.status
                : completedTurns ? 'partial' : 'stopped';
    const chapterStatus = state.status === 'complete' && turnsComplete && chapterCompleted === fullChapterTotal ? 'complete'
        : !turnsComplete ? 'locked'
            : state.stage_mode === 'chapters' ? state.status
                : 'ready';
    return {
        ...state,
        staleScope: stalePausedState,
        total,
        completed: completedTurns,
        turnSummaryCount: completedTurns,
        warningCount: (state.warnings || []).length,
        queued: queued.length,
        inFlight,
        running,
        failed,
        paused: queue.paused,
        stage: rebuildStage(inFlight || queued[0], state),
        turnProgress: {
            status: turnStatus,
            completed: completedTurns,
            total,
        },
        chapterProgress: {
            status: chapterStatus,
            completed: chapterCompleted,
            total: fullChapterTotal,
            currentRange: activeChapterJob ? [activeChapterJob.payload.startPair, activeChapterJob.payload.endPair] : null,
            remaining: Math.max(0, fullChapterTotal - chapterCompleted),
            tailRange: total > tailStart ? [tailStart, total - 1] : null,
        },
    };
}

function enqueueMissingRebuildJobs(data, pairs) {
    const state = rebuildState(data);
    const doneFloors = new Set((state.turn_summaries || []).map(item => item.pairIndex));
    const size = getSettings().chapterSize || 25;
    for (const payload of buildMissingRebuildSegmentPayloads(pairs, doneFloors, size)) {
        enqueue('history_rebuild_segment', payload, QUEUE_PRIORITY.migrate);
    }
    if (state.stage_mode === 'chapters') {
        const existingRanges = new Set((state.chapters || []).map(chapter => JSON.stringify(chapter.floor_range)));
        for (let offset = 0; offset + size <= pairs.length; offset += size) {
            const slice = pairs.slice(offset, offset + size);
            const range = [slice[0].pairIndex, slice.at(-1).pairIndex];
            if (!existingRanges.has(JSON.stringify(range))) {
                enqueue('history_rebuild_chapter', { startPair: range[0], endPair: range[1] }, QUEUE_PRIORITY.migrate - 1);
            }
        }
    }
    enqueue('history_rebuild_commit', { reviewOnly: state.stage_mode !== 'chapters' }, QUEUE_PRIORITY.migrate - 2);
}

export async function startHistoryRebuild({ reuseExisting = false } = {}) {
    abortRequested = false;
    const data = getChatData();
    const pairs = historyPairs(data);
    if (!pairs.length) {
        data.history_rebuild = createStaging(0, data.progress?.baseline_pair ?? -1, reuseExisting);
        data.history_rebuild.status = 'complete';
        data.history_rebuild.finishedAt = Date.now();
        await saveChatData(data);
        return getHistoryRebuildSnapshot();
    }
    const running = getHistoryRebuildSnapshot();
    if (running && ['running', 'stopping'].includes(running.status)
        && (running.inFlight || running.queued)) return running;
    await clearFailedJobs([...REBUILD_JOB_TYPES, 'migrate_chapter', 'migrate_extract_chapter', 'migrate_extract_floor', 'migrate_finalize', 'migrate_complete']);
    await cancelQueuedJobs(['migrate_chapter', 'migrate_extract_chapter', 'migrate_extract_floor', 'migrate_finalize', 'migrate_complete']);
    const resumable = data.history_rebuild && data.history_rebuild.stage_mode === 'turns'
        && ['stopped', 'error'].includes(data.history_rebuild.status)
        && data.history_rebuild.total === pairs.length;
    if (!resumable) {
        data.rebuild_backup = backupCurrent(data);
        data.history_rebuild = createStaging(pairs.length, data.progress?.baseline_pair ?? -1, reuseExisting);
        if (reuseExisting) seedStagingFromCurrent(data, data.history_rebuild, pairs);
    } else {
        if (reuseExisting) mergeStagingFromCurrent(data, data.history_rebuild, pairs);
        data.history_rebuild.status = 'running';
        data.history_rebuild.error = null;
        data.history_rebuild.stoppedAt = null;
    }
    await saveChatData(data);
    enqueueMissingRebuildJobs(data, pairs);
    return getHistoryRebuildSnapshot();
}

export async function retryHistoryRebuildJob(jobId) {
    const data = getChatData();
    const state = rebuildState(data);
    const job = getQueueSnapshot().failed.find(item => item.id === jobId);
    if (!state || !job || !REBUILD_JOB_TYPES.includes(job.type)) return false;
    if (job.type === 'history_rebuild_segment' && state.stage_mode !== 'turns') {
        throw new Error('这条逐轮任务不属于当前重建阶段，请从“对话记录”继续。');
    }
    if (job.type === 'history_rebuild_chapter' && state.stage_mode !== 'chapters') {
        throw new Error('这条章节任务不属于当前重建阶段，请从“章节摘要”继续。');
    }
    abortRequested = false;
    state.status = 'running';
    state.error = null;
    state.stoppedAt = null;
    state.phase = rebuildStage(job, state);
    await saveChatData(data);
    const retried = retryFailedJob(jobId);
    if (!retried) {
        state.status = 'error';
        state.error = '没有找到需要重新处理的任务';
        await saveChatData(data);
    } else {
        enqueueMissingRebuildJobs(data, pairsForActiveRebuild(data, state));
    }
    return retried;
}

export async function startHistoryRebuildChapters() {
    abortRequested = false;
    const data = getChatData();
    const state = rebuildState(data);
    const pairs = pairsForActiveRebuild(data, state);
    const resumableChapterStage = state?.stage_mode === 'chapters' && ['stopped', 'error'].includes(state.status);
    if (!state || (!resumableChapterStage && state.status !== 'review') || state.turn_summaries.length !== pairs.length) {
        throw new Error('对话记录尚未完整生成，暂时不能整理章节');
    }
    state.stage_mode = 'chapters';
    state.status = 'running';
    state.error = null;
    state.phase = '正在准备生成章节摘要';
    await clearFailedJobs(REBUILD_JOB_TYPES);
    await cancelQueuedJobs(REBUILD_JOB_TYPES);
    await saveChatData(data);
    enqueueMissingRebuildJobs(data, pairs);
    return getHistoryRebuildSnapshot();
}

export async function requestHistoryRebuildAbort() {
    abortRequested = true;
    const data = getChatData();
    const state = rebuildState(data);
    if (!state) return null;
    const queue = getQueueSnapshot();
    const hasRunning = (queue.running || []).some(job => REBUILD_JOB_TYPES.includes(job.type));
    state.status = hasRunning ? 'stopping' : 'stopped';
    state.stoppedAt = hasRunning ? null : Date.now();
    await cancelQueuedJobs(REBUILD_JOB_TYPES);
    await saveChatData(data);
    return getHistoryRebuildSnapshot();
}

export async function settleHistoryRebuildStop(expectedData = getChatData()) {
    if (getChatData() !== expectedData) return false;
    const state = rebuildState(expectedData);
    if (!state || state.status !== 'stopping') return false;
    state.status = 'stopped';
    state.stoppedAt = Date.now();
    await saveChatData(expectedData);
    return true;
}

export async function markHistoryRebuildError(message, expectedData = getChatData()) {
    if (getChatData() !== expectedData) return false;
    const state = rebuildState(expectedData);
    if (!state || ['stopping', 'stopped'].includes(state.status)) return false;
    state.status = 'error';
    state.error = String(message || '安全重建失败');
    await cancelQueuedJobs(REBUILD_JOB_TYPES);
    await saveChatData(expectedData);
    return true;
}

export async function restoreRebuildBackup() {
    const data = getChatData();
    const backup = data.rebuild_backup;
    if (!backup || ['running', 'stopping'].includes(data.history_rebuild?.status)) return false;
    for (const key of ['state_table', 'turn_summaries', 'floor_events', 'branch_checkpoints', 'chapters', 'volumes',
        'keyword_index', 'extracted_keys', 'quarantined_entries', 'history_backfill', 'review_queue', 'notices',
        'progress', 'fact_ledger', 'fact_decisions', 'manual_events']) {
        data[key] = clone(backup[key]);
    }
    data.history_rebuild = null;
    data.rebuild_backup = null;
    await saveChatData(data);
    return true;
}
