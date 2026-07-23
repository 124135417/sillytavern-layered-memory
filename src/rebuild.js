import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { summarizeChapterNotes, validateChapterArchive } from './archive.js';
import { extractAiBody } from './body.js';
import { buildKeywordIndex } from './chapter.js';
import { QUEUE_PRIORITY, SLOTS } from './constants.js';
import { captureBranchCheckpoint } from './branch.js';
import { getPairTexts, getPairs } from './ids.js';
import { HISTORY_SEGMENT_JSON_SCHEMA, HISTORY_SEGMENT_SYSTEM } from './prompts.js';
import { cancelQueuedJobs, clearFailedJobs, enqueue, getQueueSnapshot } from './queue.js';
import { normalizeGeneratedEntity, validateMemoryEntryShape } from './quality.js';
import { appendLog, assertChatData, getChatData, getContext, getSettings, saveChatData } from './settings.js';
import { evidenceInSource } from './tokens.js';

export const REBUILD_JOB_TYPES = ['history_rebuild_segment', 'history_rebuild_chapter', 'history_rebuild_commit'];
const SEGMENT_SIZE = 13;
let abortRequested = false;

function clone(value) {
    return structuredClone(value);
}

function rebuildState(data = getChatData()) {
    if (!data.history_rebuild || typeof data.history_rebuild !== 'object') return null;
    return data.history_rebuild;
}

function historyPairs(data = getChatData()) {
    const baseline = Number(data.progress?.baseline_pair ?? -1);
    return getPairs().filter(pair => pair.sealed && pair.pairIndex <= baseline);
}

function createStaging(total, baseline) {
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
        chapters: [],
        extracted_keys: [],
    };
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
        history_backfill: clone(data.history_backfill || {}),
        review_queue: clone(data.review_queue || []),
        notices: clone(data.notices || []),
        context_handoff: clone(data.context_handoff || null),
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

function normalizeFact(raw, source, userName) {
    const slot = String(raw?.slot || '').trim();
    const value = slot === 'relationship' ? raw?.new_value : (raw?.value ?? raw?.new_value);
    const fact = {
        slot,
        subject: normalizeGeneratedEntity(raw?.subject, userName),
        object: normalizeGeneratedEntity(raw?.object, userName),
        value: String(value ?? '').trim(),
        old_value: String(raw?.old_value ?? '').trim(),
        new_value: String(raw?.new_value ?? '').trim(),
        evidence: String(raw?.evidence ?? '').trim(),
        why_persistent: String(raw?.why_persistent ?? '').trim(),
        cause: String(raw?.cause ?? '').trim(),
        source: 'auto',
    };
    const errors = [];
    if (!SLOTS.includes(slot)) errors.push('事实类型无法识别');
    if (slot === 'relationship' && (!fact.old_value || !fact.new_value)) errors.push('关系变化缺少旧状态或新状态');
    const shape = validateMemoryEntryShape(fact);
    errors.push(...shape.errors);
    if (!fact.evidence || !evidenceInSource(fact.evidence, source.sourceText)) errors.push('证据不是该轮原文子串');
    if (slot === 'other' && !fact.why_persistent) errors.push('其他事实缺少持续原因');
    return { fact, errors };
}

export function validateHistorySegment(raw, sources, userName = '') {
    const expected = sources.map(item => item.pair.pairIndex);
    const floors = Array.isArray(raw?.floors) ? raw.floors : [];
    const actual = floors.map(item => Number(item?.floor));
    const errors = [];
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        errors.push(`轮数必须完整且顺序一致；需要 ${expected.join('、')}，实际 ${actual.join('、') || '为空'}`);
    }
    const normalized = [];
    for (let index = 0; index < Math.min(floors.length, sources.length); index += 1) {
        const item = floors[index] || {};
        const summary = String(item.summary || '').trim();
        const source = sources[index];
        if ([...summary].length < 10 || [...summary].length > 500) errors.push(`第 ${source.pair.pairIndex} 轮摘要为空或长度异常`);
        if (summary && !summary.includes('<user>')) errors.push(`第 ${source.pair.pairIndex} 轮摘要没有从 <user> 的行为或话语开始`);
        const facts = [];
        for (const rawFact of Array.isArray(item.facts) ? item.facts : []) {
            const checked = normalizeFact(rawFact, source, userName);
            if (checked.errors.length) errors.push(`第 ${source.pair.pairIndex} 轮事实：${checked.errors.join('；')}`);
            else facts.push(checked.fact);
        }
        normalized.push({ floor: source.pair.pairIndex, summary, facts });
    }
    return { ok: errors.length === 0, errors, floors: normalized };
}

function upsertStagedFact(staging, fact, floor) {
    const duplicate = staging.entries.find(entry => entry.slot === fact.slot
        && entry.subject === fact.subject && (entry.object || '') === (fact.object || ''));
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
}

export async function handleHistoryRebuildSegment(payload) {
    const data = getChatData();
    const staging = rebuildState(data);
    if (!staging || abortRequested || staging.status !== 'running') return;
    const sources = getPairs()
        .filter(pair => pair.sealed && pair.pairIndex >= payload.startPair && pair.pairIndex <= payload.endPair)
        .map(pairSource);
    const expectedCount = payload.endPair - payload.startPair + 1;
    if (sources.length !== expectedCount) throw nonRetryableError(`找不到完整对话：需要 ${expectedCount} 轮，实际 ${sources.length} 轮`);
    let retryNote = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
        staging.phase = `正在逐轮核对第 ${payload.startPair}–${payload.endPair} 轮`;
        await saveChatData(data);
        const { text } = await callAuxModel({
            purpose: 'history_rebuild_segment',
            systemPrompt: HISTORY_SEGMENT_SYSTEM,
            userPrompt: segmentPrompt(sources, retryNote),
            jsonSchema: HISTORY_SEGMENT_JSON_SCHEMA,
            temperature: 0,
        });
        assertChatData(data);
        const raw = parseJsonFromModel(text);
        const checked = validateHistorySegment(raw, sources, getContext().name1 || '');
        if (checked.ok) {
            applySegment(staging, checked, sources);
            await saveChatData(data);
            return;
        }
        retryNote = checked.errors.slice(0, 8).join('；');
    }
    throw nonRetryableError(`分段结果连续两次未通过校验：${retryNote}`);
}

export async function handleHistoryRebuildChapter(payload) {
    const data = getChatData();
    const staging = rebuildState(data);
    if (!staging || abortRequested || staging.status !== 'running') return;
    const notes = staging.turn_summaries
        .filter(item => item.pairIndex >= payload.startPair && item.pairIndex <= payload.endPair)
        .sort((a, b) => a.pairIndex - b.pairIndex);
    if (notes.length !== payload.endPair - payload.startPair + 1) throw new Error('章节依赖的逐轮记录尚未齐全');
    staging.phase = `正在合并第 ${payload.startPair}–${payload.endPair} 轮剧情`;
    await saveChatData(data);
    const result = await summarizeChapterNotes(notes, payload.startPair, payload.endPair, () => assertChatData(data));
    const existing = staging.chapters.find(chapter => chapter.floor_range?.[0] === payload.startPair);
    const chapter = {
                id: existing?.id || `staged_ch_${String(staging.chapters.length + 1).padStart(3, '0')}`,
                ...result,
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
    const pairs = historyPairs(data);
    if (staging.turn_summaries.length !== pairs.length) throw nonRetryableError(`重建结果不完整：${staging.turn_summaries.length}/${pairs.length} 轮`);
    const fullChapterCount = Math.floor(pairs.length / (getSettings().chapterSize || 25));
    if (staging.chapters.length !== fullChapterCount) throw nonRetryableError(`章节结果不完整：${staging.chapters.length}/${fullChapterCount} 章`);

    staging.phase = '正在安全替换旧结果';
    await saveChatData(data);
    const preservedEntries = (data.state_table?.entries || []).filter(entry => entry.source === 'manual'
        || entry.source === 'proofread' || entry.pinned || entry.manual_override);
    const entryIds = idFactory(preservedEntries, 'e', 4);
    const preservedKeys = new Set(preservedEntries.map(entry => `${entry.slot}\u0000${entry.subject}\u0000${entry.object || ''}`));
    const rebuiltEntries = staging.entries
        .filter(entry => !preservedKeys.has(`${entry.slot}\u0000${entry.subject}\u0000${entry.object || ''}`))
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
    data.turn_summaries = clone(staging.turn_summaries);
    const rebuiltByKey = new Map(rebuiltEntries.map(entry => [memoryKey(entry), entry]));
    const firstFloorByKey = new Map();
    for (const event of (staging.fact_events || []).slice().sort((a, b) => a.floor - b.floor)) {
        const key = memoryKey(event.fact);
        if (!firstFloorByKey.has(key)) firstFloorByKey.set(key, event.floor);
    }
    const factEventsByFloor = new Map();
    for (const event of staging.fact_events || []) {
        const finalEntry = rebuiltByKey.get(memoryKey(event.fact));
        if (!finalEntry) continue;
        const after = {
            ...clone(event.fact),
            id: finalEntry.id,
            established_floor: firstFloorByKey.get(memoryKey(event.fact)),
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
        entryChanges: factEventsByFloor.get(summary.pairIndex) || [],
        recordedAt: Math.max(1, summary.pairIndex + 1),
    }));
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
    delete staging.chapters;
    delete staging.extracted_keys;
    data.notices = (data.notices || []).filter(item => !/补记|重建|父聊天还没有可继承|开始自动记录/.test(String(item.note || '')));
    data.notices.push({ id: crypto.randomUUID(), kind: 'notice', note: `旧聊天安全重建完成：已核对 ${pairs.length} / ${pairs.length} 轮。`, createdAt: Date.now() });
    data.branch_checkpoints = [{
        id: crypto.randomUUID(),
        anchorFloorKey: null,
        anchorPairIndex: -1,
        anchorFingerprint: null,
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

function rebuildStage(job, state) {
    if (state?.phase) return state.phase;
    if (job?.type === 'history_rebuild_segment') return `正在逐轮核对第 ${job.payload.startPair}–${job.payload.endPair} 轮`;
    if (job?.type === 'history_rebuild_chapter') return `正在合并第 ${job.payload.startPair}–${job.payload.endPair} 轮剧情`;
    if (job?.type === 'history_rebuild_commit') return '正在安全替换旧结果';
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

export function getHistoryRebuildSnapshot() {
    const data = getChatData();
    const state = rebuildState(data);
    if (!state) {
        const total = historyPairs(data).length;
        return {
            status: 'idle', phase: '尚未开始', stage: '尚未开始', total, completed: 0,
            turnSummaryCount: (data.turn_summaries || []).length,
            queued: 0, inFlight: null, failed: [], paused: false,
        };
    }
    const queue = getQueueSnapshot();
    const queued = queue.queued.filter(job => REBUILD_JOB_TYPES.includes(job.type));
    const inFlight = REBUILD_JOB_TYPES.includes(queue.inFlight?.type) ? queue.inFlight : null;
    const failed = queue.failed.filter(job => REBUILD_JOB_TYPES.includes(job.type));
    return {
        ...state,
        turnSummaryCount: state.status === 'complete'
            ? (data.turn_summaries || []).length
            : (state.turn_summaries || []).length,
        queued: queued.length,
        inFlight,
        failed,
        paused: queue.paused,
        stage: rebuildStage(inFlight || queued[0], state),
    };
}

function enqueueMissingRebuildJobs(data, pairs) {
    const state = rebuildState(data);
    const doneFloors = new Set((state.turn_summaries || []).map(item => item.pairIndex));
    const size = getSettings().chapterSize || 25;
    for (const [startPair, endPair] of buildRebuildSegmentRanges(pairs, size)) {
        if (pairs.some(pair => pair.pairIndex >= startPair && pair.pairIndex <= endPair && !doneFloors.has(pair.pairIndex))) {
            enqueue('history_rebuild_segment', { startPair, endPair }, QUEUE_PRIORITY.migrate);
        }
    }
    const existingRanges = new Set((state.chapters || []).map(chapter => JSON.stringify(chapter.floor_range)));
    for (let offset = 0; offset + size <= pairs.length; offset += size) {
        const slice = pairs.slice(offset, offset + size);
        const range = [slice[0].pairIndex, slice.at(-1).pairIndex];
        if (!existingRanges.has(JSON.stringify(range))) {
            enqueue('history_rebuild_chapter', { startPair: range[0], endPair: range[1] }, QUEUE_PRIORITY.migrate - 1);
        }
    }
    enqueue('history_rebuild_commit', {}, QUEUE_PRIORITY.migrate - 2);
}

export async function startHistoryRebuild() {
    abortRequested = false;
    const data = getChatData();
    const pairs = historyPairs(data);
    if (!pairs.length) {
        data.history_rebuild = createStaging(0, data.progress?.baseline_pair ?? -1);
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
    const resumable = data.history_rebuild && ['stopped', 'error'].includes(data.history_rebuild.status)
        && data.history_rebuild.total === pairs.length;
    if (!resumable) {
        data.rebuild_backup = backupCurrent(data);
        data.history_rebuild = createStaging(pairs.length, data.progress?.baseline_pair ?? -1);
    } else {
        data.history_rebuild.status = 'running';
        data.history_rebuild.error = null;
        data.history_rebuild.stoppedAt = null;
    }
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
    const running = REBUILD_JOB_TYPES.includes(queue.inFlight?.type);
    state.status = running ? 'stopping' : 'stopped';
    state.stoppedAt = running ? null : Date.now();
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
        'context_handoff', 'progress']) {
        data[key] = clone(backup[key]);
    }
    data.history_rebuild = null;
    data.rebuild_backup = null;
    await saveChatData(data);
    return true;
}
