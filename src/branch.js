import { EMPTY_CHAT_DATA, MODULE_NAME } from './constants.js';
import { getMessageFloors, getPairs } from './ids.js';
import { appendLog, getChatData, getContext, saveChatData } from './settings.js';

let recoveryBarrier = Promise.resolve({ status: 'idle' });
let recoveryTarget = null;

function clone(value) {
    return structuredClone(value);
}

function currentAnchor() {
    const pair = getPairs().filter(item => item.sealed).at(-1);
    return pair
        ? { floorKey: pair.floorKey, pairIndex: pair.pairIndex, contentFingerprint: pair.contentFingerprint }
        : { floorKey: null, pairIndex: -1, contentFingerprint: null };
}

function prefixFingerprints(pairs, throughPair) {
    return (pairs || [])
        .filter(item => item.sealed && Number(item.pairIndex) <= Number(throughPair))
        .map(item => ({
            pairIndex: Number(item.pairIndex),
            floorKey: item.floorKey,
            contentFingerprint: item.contentFingerprint,
        }));
}

function checkpointMatchesPrefix(checkpoint, livePairs) {
    const through = Number(checkpoint?.anchorPairIndex ?? -1);
    if (through < 0) return true;
    const recorded = Array.isArray(checkpoint?.prefixFingerprints) ? checkpoint.prefixFingerprints : null;
    if (!recorded) return false;
    const live = prefixFingerprints(livePairs, through);
    if (recorded.length !== live.length) return false;
    return recorded.every((item, index) => item.pairIndex === live[index]?.pairIndex
        && item.floorKey === live[index]?.floorKey
        && item.contentFingerprint === live[index]?.contentFingerprint);
}

function lightweightStateTable(table) {
    const snapshot = clone(table || EMPTY_CHAT_DATA().state_table);
    snapshot.changelog = [];
    return snapshot;
}

export function recordFloorEvent(data, event) {
    if (!event?.floorKey || !event?.contentFingerprint) return;
    data.floor_events = Array.isArray(data.floor_events) ? data.floor_events : [];
    const normalized = {
        floorKey: event.floorKey,
        pairIndex: Number(event.pairIndex),
        contentFingerprint: String(event.contentFingerprint),
        turnSummary: String(event.turnSummary || ''),
        storyTime: event.storyTime ? clone(event.storyTime) : null,
        entryChanges: clone(event.entryChanges || []),
        recordedAt: Date.now(),
    };
    const index = data.floor_events.findIndex(item => item.floorKey === normalized.floorKey);
    if (index >= 0) {
        if (!normalized.entryChanges.length && data.floor_events[index].entryChanges?.length) {
            normalized.entryChanges = clone(data.floor_events[index].entryChanges);
        }
        data.floor_events[index] = normalized;
    } else data.floor_events.push(normalized);
}

export function recordManualEvent(data, { op, before = null, after = null, reason = 'manual', sourceCandidate = null }) {
    if (op !== 'upsert' && op !== 'delete') return null;
    const anchor = currentAnchor();
    const event = {
        id: crypto.randomUUID(),
        anchorFloorKey: anchor.floorKey,
        anchorPairIndex: anchor.pairIndex,
        anchorFingerprint: anchor.contentFingerprint,
        op,
        before: before ? clone(before) : null,
        after: after ? clone(after) : null,
        reason,
        sourceKind: sourceCandidate ? 'candidate' : null,
        sourceCandidateId: sourceCandidate?.id || null,
        sourceFloorKey: sourceCandidate?.floorKey || null,
        sourcePairIndex: Number.isFinite(Number(sourceCandidate?.floor)) ? Number(sourceCandidate.floor) : null,
        sourceFingerprint: sourceCandidate?.contentFingerprint || null,
        recordedAt: Date.now(),
    };
    data.manual_events = Array.isArray(data.manual_events) ? data.manual_events : [];
    data.manual_events.push(event);
    return event;
}

export function captureBranchCheckpoint(data = getChatData(), reason = 'automatic') {
    const anchor = currentAnchor();
    data.branch_checkpoints = Array.isArray(data.branch_checkpoints) ? data.branch_checkpoints : [];
    const checkpoint = {
        id: crypto.randomUUID(),
        anchorFloorKey: anchor.floorKey,
        anchorPairIndex: anchor.pairIndex,
        anchorFingerprint: anchor.contentFingerprint,
        prefixFingerprints: prefixFingerprints(getPairs(), anchor.pairIndex),
        stateTable: lightweightStateTable(data.state_table),
        createdAt: Date.now(),
        reason,
    };
    const sameAnchor = data.branch_checkpoints.findIndex(item =>
        item.anchorFloorKey === anchor.floorKey && item.anchorFingerprint === anchor.contentFingerprint);
    if (sameAnchor >= 0) data.branch_checkpoints[sameAnchor] = checkpoint;
    else data.branch_checkpoints.push(checkpoint);
    return checkpoint;
}

export async function ensureBranchCheckpoint() {
    const data = getChatData();
    if ((data.branch_checkpoints || []).length) return false;
    captureBranchCheckpoint(data, 'upgrade_seed');
    await saveChatData(data);
    return true;
}

function applyEntryChanges(table, changes, event) {
    table.entries = Array.isArray(table.entries) ? table.entries : [];
    table.changelog = Array.isArray(table.changelog) ? table.changelog : [];
    for (const change of changes || []) {
        if (change.op === 'delete') {
            const before = table.entries.find(entry => entry.id === change.id);
            table.entries = table.entries.filter(entry => entry.id !== change.id);
            if (before) table.changelog.push({ op: 'delete', id: change.id, floorKey: event.floorKey, floor: event.pairIndex, before: clone(before), at: event.recordedAt });
            continue;
        }
        if (!change.after?.id) continue;
        const index = table.entries.findIndex(entry => entry.id === change.after.id);
        if (index >= 0) {
            const before = clone(table.entries[index]);
            table.entries[index] = clone(change.after);
            table.changelog.push({ op: 'update', id: change.after.id, floorKey: event.floorKey, floor: event.pairIndex, before, after: clone(change.after), at: event.recordedAt });
        } else {
            table.entries.push(clone(change.after));
            table.changelog.push({ op: 'add', id: change.after.id, floorKey: event.floorKey, floor: event.pairIndex, after: clone(change.after), at: event.recordedAt });
        }
    }
    table.version = Number(table.version || 0) + 1;
}

function applyManualEvent(table, event) {
    table.entries = Array.isArray(table.entries) ? table.entries : [];
    if (event.op === 'delete') {
        const id = event.before?.id || event.after?.id;
        if (id) table.entries = table.entries.filter(entry => entry.id !== id);
    } else if (event.after?.id) {
        const index = table.entries.findIndex(entry => entry.id === event.after.id);
        if (index >= 0) table.entries[index] = clone(event.after);
        else table.entries.push(clone(event.after));
    }
    table.version = Number(table.version || 0) + 1;
}

function underlyingFloorKey(key) {
    return String(key || '').replace(/^migrated:/, '');
}

function pairMap(livePairs) {
    return new Map(livePairs.filter(pair => pair.sealed).map(pair => [pair.floorKey, pair]));
}

function matchesFloor(record, liveByKey, keyField = 'floorKey', fingerprintField = 'contentFingerprint') {
    const key = record?.[keyField];
    if (key == null) return true;
    const pair = liveByKey.get(key);
    const fingerprint = record?.[fingerprintField];
    return Boolean(pair && fingerprint && fingerprint === pair.contentFingerprint);
}

function isCandidateDerivedManualEvent(event) {
    return event?.sourceKind === 'candidate' || String(event?.reason || '').includes('candidate');
}

function manualEventMatchesSource(event, liveByKey) {
    if (!isCandidateDerivedManualEvent(event)) return true;
    return Boolean(event.sourceFloorKey && event.sourceFingerprint
        && matchesFloor(event, liveByKey, 'sourceFloorKey', 'sourceFingerprint'));
}

function reconcileArchives(data, maxPair) {
    data.chapters = (data.chapters || []).filter(chapter => {
        const [start, end] = chapter.floor_range || [];
        return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= maxPair;
    });
    const chapterIds = new Set(data.chapters.map(chapter => chapter.id));
    data.volumes = (data.volumes || []).filter(volume =>
        Array.isArray(volume.chapter_ids) && volume.chapter_ids.length > 0
        && volume.chapter_ids.every(id => chapterIds.has(id)));
    const volumeIds = new Set(data.volumes.map(volume => volume.id));
    for (const chapter of data.chapters) {
        if (!chapter.volume_id || !volumeIds.has(chapter.volume_id)) {
            chapter.volume_id = null;
            chapter.demoted = false;
        }
    }
    data.keyword_index = {};
    for (const chapter of data.chapters) {
        for (const keyword of chapter.keywords || []) {
            const key = String(keyword).toLowerCase();
            if (!key) continue;
            data.keyword_index[key] = data.keyword_index[key] || [];
            if (!data.keyword_index[key].includes(chapter.id)) data.keyword_index[key].push(chapter.id);
        }
    }
}

function reconcileNarrativeArchives(data, liveMessages, maxFloor) {
    const liveFloors = new Set((liveMessages || [])
        .filter(message => message.messageIndex <= maxFloor)
        .map(message => message.messageIndex));
    const summarizedFloors = new Set((data.narrative_summaries || []).map(item => item.messageIndex));
    data.narrative_chapters = (data.narrative_chapters || []).filter(chapter => {
        const [start, end] = chapter.floor_range || [];
        return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= maxFloor
            && Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
                .every(floor => liveFloors.has(floor) && summarizedFloors.has(floor));
    });
    const chapterIds = new Set(data.narrative_chapters.map(chapter => chapter.id));
    data.narrative_volumes = (data.narrative_volumes || []).filter(volume =>
        Array.isArray(volume.chapter_ids) && volume.chapter_ids.length > 0
        && volume.chapter_ids.every(id => chapterIds.has(id)));
    const volumeIds = new Set(data.narrative_volumes.map(volume => volume.id));
    for (const chapter of data.narrative_chapters) {
        if (!chapter.volume_id || !volumeIds.has(chapter.volume_id)) {
            chapter.volume_id = null;
            chapter.demoted = false;
        }
    }
}

function reconcileBackstageSessions(data, parentData, liveMessageByKey) {
    const source = clone(parentData.backstage || EMPTY_CHAT_DATA().backstage);
    source.pendingGeneration = null;
    source.sessions = (source.sessions || []).flatMap(session => {
        if (!session.markerMessageKey || !liveMessageByKey.has(session.markerMessageKey)) return [];
        const revisions = (session.revisions || []).filter(revision =>
            (!revision.markerMessageKey || liveMessageByKey.has(revision.markerMessageKey))
            && (!revision.targetMessageKey || liveMessageByKey.has(revision.targetMessageKey)));
        if (!revisions.length && !session.working) return [];
        return [{ ...session, revisions }];
    });
    const sessionIds = new Set(source.sessions.map(session => session.id));
    if (!sessionIds.has(source.activeSessionId)) source.activeSessionId = null;
    data.backstage = source;
}

function finishBranchData(data, parentData, livePairs, parentChat, method, trustedMaxPair) {
    const liveByKey = pairMap(livePairs);
    const maxPair = livePairs.filter(pair => pair.sealed).at(-1)?.pairIndex ?? -1;
    const maxFloor = livePairs.filter(pair => pair.sealed && pair.pairIndex <= trustedMaxPair).at(-1)?.aiFloor ?? -1;
    const liveMessages = getMessageFloors({ includeTrailingUser: true });
    const liveMessageByKey = new Map(liveMessages.map(message => [message.messageKey, message]));
    reconcileBackstageSessions(data, parentData, liveMessageByKey);
    const withinTrustedPrefix = item => Number(item.floor ?? item.pairIndex ?? item.anchorPairIndex) <= trustedMaxPair;
    data.turn_summaries = (parentData.turn_summaries || [])
        .filter(item => withinTrustedPrefix(item) && matchesFloor(item, liveByKey)).map(clone);
    data.narrative_summaries = (parentData.narrative_summaries || []).filter(item => {
        const message = liveMessageByKey.get(item.messageKey);
        return message && message.messageIndex <= maxFloor
            && item.contentFingerprint === message.contentFingerprint;
    }).map(item => {
        const message = liveMessageByKey.get(item.messageKey);
        return { ...clone(item), messageIndex: message.messageIndex, role: message.role };
    });
    data.floor_events = (parentData.floor_events || [])
        .filter(item => withinTrustedPrefix(item) && matchesFloor(item, liveByKey)).map(clone);
    data.manual_events = (parentData.manual_events || [])
        .filter(item => withinTrustedPrefix(item)
            && matchesFloor(item, liveByKey, 'anchorFloorKey', 'anchorFingerprint')
            && manualEventMatchesSource(item, liveByKey)).map(clone);
    data.fact_ledger = (parentData.fact_ledger || [])
        .filter(item => withinTrustedPrefix(item)
            && item.floorKey && item.contentFingerprint && matchesFloor(item, liveByKey)).map(clone);
    const trustedCandidateIds = new Set(data.fact_ledger.map(item => item.id));
    data.fact_decisions = (parentData.fact_decisions || [])
        .filter(item => trustedCandidateIds.has(item.candidateId)
            && withinTrustedPrefix(item)
            && matchesFloor(item, liveByKey, 'anchorFloorKey', 'anchorFingerprint')).map(clone);
    const trustedKeys = new Set([
        ...data.floor_events.map(item => item.floorKey),
        ...data.turn_summaries.map(item => item.floorKey),
    ]);
    data.extracted_keys = (parentData.extracted_keys || []).filter(key => trustedKeys.has(underlyingFloorKey(key)));
    data.pending_floors = [];
    data.history_rebuild = null;
    data.rebuild_backup = null;
    data.review_queue = (parentData.review_queue || [])
        .filter(item => !item.floorKey || trustedKeys.has(item.floorKey)).map(clone);
    data.notices = [];
    data.job_queue = EMPTY_CHAT_DATA().job_queue;
    data.job_queue.scope_id = crypto.randomUUID();
    data.progress = { ...EMPTY_CHAT_DATA().progress, ...(data.progress || {}) };
    const parentBaseline = parentData.progress?.baseline_pair == null ? -1 : Number(parentData.progress.baseline_pair);
    const parentChapterEnd = parentData.progress?.last_chapter_end_pair == null ? -1 : Number(parentData.progress.last_chapter_end_pair);
    data.progress.baseline_pair = Math.min(Number.isFinite(parentBaseline) ? parentBaseline : -1, trustedMaxPair, maxPair);
    data.progress.last_chapter_end_pair = Math.min(Number.isFinite(parentChapterEnd) ? parentChapterEnd : -1, trustedMaxPair, maxPair);
    reconcileArchives(data, trustedMaxPair);
    data.narrative_chapters = clone(parentData.narrative_chapters || []);
    data.narrative_volumes = clone(parentData.narrative_volumes || []);
    reconcileNarrativeArchives(data, liveMessages, maxFloor);
    data.progress.next_entry_seq = Math.max(1, ...data.state_table.entries.map(entry => Number(String(entry.id || '').replace(/^e_/, '')) + 1).filter(Number.isFinite));
    data.progress.next_chapter_seq = Math.max(1, ...data.chapters.map(chapter => Number(String(chapter.id || '').replace(/^ch_/, '')) + 1).filter(Number.isFinite));
    data.branch_origin = {
        parentChat,
        forkFloorKey: livePairs.filter(pair => pair.sealed).at(-1)?.floorKey || null,
        forkPairIndex: maxPair,
        method,
        status: 'ready',
        recoveredAt: Date.now(),
    };
    data.logs = [];
    return data;
}

export function buildLegacyRebuildData(livePairs, parentChat = '') {
    const data = EMPTY_CHAT_DATA();
    const maxPair = livePairs.filter(pair => pair.sealed).at(-1)?.pairIndex ?? -1;
    data.progress.baseline_pair = -1;
    data.job_queue.scope_id = crypto.randomUUID();
    data.branch_origin = {
        parentChat,
        forkFloorKey: livePairs.filter(pair => pair.sealed).at(-1)?.floorKey || null,
        forkPairIndex: maxPair,
        method: 'safe_rebuild',
        status: 'ready',
        recoveredAt: Date.now(),
    };
    data.notices.push({
        id: crypto.randomUUID(),
        kind: 'notice',
        note: '这个分支来自旧版记录，无法证明旧记忆没有混入另一条剧情线。插件已停止继承旧表，并会从这个分支自己的聊天内容重新整理。',
        createdAt: Date.now(),
    });
    data.branch_checkpoints.push({
        id: crypto.randomUUID(),
        anchorFloorKey: null,
        anchorPairIndex: -1,
        anchorFingerprint: null,
        prefixFingerprints: [],
        stateTable: lightweightStateTable(data.state_table),
        createdAt: Date.now(),
        reason: 'safe_rebuild_seed',
    });
    return data;
}

export function buildFreshBranchData(livePairs, parentChat = '') {
    const data = EMPTY_CHAT_DATA();
    const head = livePairs.filter(pair => pair.sealed).at(-1);
    data.progress.baseline_pair = head?.pairIndex ?? -1;
    data.job_queue.scope_id = crypto.randomUUID();
    data.branch_origin = {
        parentChat,
        forkFloorKey: head?.floorKey || null,
        forkPairIndex: head?.pairIndex ?? -1,
        method: 'fresh_start',
        status: 'ready',
        recoveredAt: Date.now(),
    };
    data.notices.push({
        id: crypto.randomUUID(),
        kind: 'notice',
        note: '父聊天还没有可继承的插件记忆。这个分支会从下一轮开始正常记录；如果需要整理此前剧情，请在设置中点击“安全重建旧结果”。',
        createdAt: Date.now(),
    });
    data.branch_checkpoints.push({
        id: crypto.randomUUID(),
        anchorFloorKey: head?.floorKey || null,
        anchorPairIndex: head?.pairIndex ?? -1,
        anchorFingerprint: head?.contentFingerprint || null,
        prefixFingerprints: prefixFingerprints(livePairs, head?.pairIndex ?? -1),
        stateTable: lightweightStateTable(data.state_table),
        createdAt: Date.now(),
        reason: 'fresh_branch_seed',
    });
    return data;
}

export function replayBranchData(parentData, livePairs, parentChat = '') {
    const liveByKey = pairMap(livePairs);
    const checkpoints = (parentData.branch_checkpoints || [])
        .filter(point => point?.stateTable
            && matchesFloor(point, liveByKey, 'anchorFloorKey', 'anchorFingerprint')
            && checkpointMatchesPrefix(point, livePairs))
        .sort((a, b) => Number(a.anchorPairIndex) - Number(b.anchorPairIndex) || Number(a.createdAt) - Number(b.createdAt));
    const checkpoint = checkpoints.at(-1);
    if (!checkpoint) return buildLegacyRebuildData(livePairs, parentChat);

    const mismatchCandidates = [
        ...(parentData.floor_events || []).map(item => ({ ...item, index: item.pairIndex, keyField: 'floorKey', fpField: 'contentFingerprint' })),
        ...(parentData.turn_summaries || []).map(item => ({ ...item, index: item.pairIndex, keyField: 'floorKey', fpField: 'contentFingerprint' })),
        ...(parentData.manual_events || []).map(item => ({ ...item, index: item.anchorPairIndex, keyField: 'anchorFloorKey', fpField: 'anchorFingerprint' })),
        ...(parentData.manual_events || []).filter(isCandidateDerivedManualEvent).map(item => ({
            ...item, index: item.sourcePairIndex, keyField: 'sourceFloorKey', fpField: 'sourceFingerprint',
        })),
    ].filter(item => Number(item.index) > Number(checkpoint.anchorPairIndex)
        && liveByKey.has(item[item.keyField])
        && !matchesFloor(item, liveByKey, item.keyField, item.fpField));
    const firstMismatch = Math.min(Infinity, ...mismatchCandidates.map(item => Number(item.index)));
    const branchHead = livePairs.filter(pair => pair.sealed).at(-1)?.pairIndex ?? -1;
    const trustedMaxPair = Math.min(branchHead, Number.isFinite(firstMismatch) ? firstMismatch - 1 : branchHead);

    const data = EMPTY_CHAT_DATA();
    data.state_table = lightweightStateTable(checkpoint.stateTable);
    data.progress = clone(parentData.progress || data.progress);
    data.chapters = clone(parentData.chapters || []);
    data.volumes = clone(parentData.volumes || []);

    const replayItems = [
        ...(parentData.floor_events || [])
            .filter(event => Number(event.recordedAt) > Number(checkpoint.createdAt)
                && Number(event.pairIndex) <= trustedMaxPair && matchesFloor(event, liveByKey))
            .map(event => ({ kind: 'floor', at: Number(event.recordedAt), event })),
        ...(parentData.manual_events || [])
            .filter(event => Number(event.recordedAt) > Number(checkpoint.createdAt)
                && Number(event.anchorPairIndex) <= trustedMaxPair
                && matchesFloor(event, liveByKey, 'anchorFloorKey', 'anchorFingerprint')
                && manualEventMatchesSource(event, liveByKey))
            .map(event => ({ kind: 'manual', at: Number(event.recordedAt), event })),
    ].sort((a, b) => a.at - b.at);
    for (const item of replayItems) {
        if (item.kind === 'floor') applyEntryChanges(data.state_table, item.event.entryChanges, item.event);
        else applyManualEvent(data.state_table, item.event);
    }

    finishBranchData(data, parentData, livePairs, parentChat, 'checkpoint_replay', trustedMaxPair);
    const earliest = checkpoints[0];
    data.branch_checkpoints = earliest ? [{ ...clone(earliest), stateTable: lightweightStateTable(earliest.stateTable) }] : [];
    const recoveredCheckpoint = {
        id: crypto.randomUUID(),
        anchorFloorKey: data.branch_origin.forkFloorKey,
        anchorPairIndex: branchHead,
        anchorFingerprint: livePairs.filter(pair => pair.sealed).at(-1)?.contentFingerprint || null,
        prefixFingerprints: prefixFingerprints(livePairs, branchHead),
        stateTable: lightweightStateTable(data.state_table),
        createdAt: Date.now(),
        reason: 'fork_recovery',
    };
    if (!data.branch_checkpoints.some(point => point.anchorFloorKey === recoveredCheckpoint.anchorFloorKey
        && point.anchorFingerprint === recoveredCheckpoint.anchorFingerprint)) {
        data.branch_checkpoints.push(recoveredCheckpoint);
    }
    return data;
}

/** Re-materialize the active chat after edit/swipe/delete, including facts inside old checkpoints. */
export function reconcileCurrentHistory(data = getChatData(), livePairs = getPairs()) {
    const previousOrigin = data.branch_origin ? clone(data.branch_origin) : null;
    const rebuilt = replayBranchData(data, livePairs, previousOrigin?.parentChat || '');
    if (!previousOrigin) rebuilt.branch_origin = null;
    const metadata = getContext().chatMetadata;
    if (metadata?.[MODULE_NAME] === data) {
        // Replace the active object instead of mutating it. Any background job
        // that captured the old swipe now fails the existing chat-scope guard
        // before it can persist stale facts or summaries into this branch.
        metadata[MODULE_NAME] = rebuilt;
        return rebuilt;
    }
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, rebuilt);
    return data;
}

async function fetchParentChat(parentChat) {
    const context = getContext();
    const isGroup = context.groupId !== null && context.groupId !== undefined;
    const endpoint = isGroup ? '/api/chats/group/get' : '/api/chats/get';
    const character = context.characters?.[context.characterId];
    const body = isGroup
        ? { id: parentChat }
        : { ch_name: character?.name || context.name2, file_name: parentChat, avatar_url: character?.avatar };
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`无法读取父聊天（HTTP ${response.status}）`);
    const rows = await response.json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('父聊天文件为空或格式不正确');
    return rows[0]?.chat_metadata?.[MODULE_NAME] || null;
}

async function recoverCurrentBranch() {
    const context = getContext();
    const metadata = context.chatMetadata;
    const parentChat = String(metadata?.main_chat || '');
    const existing = metadata?.[MODULE_NAME];
    const verified = existing?.branch_origin?.status === 'ready'
        && existing.branch_origin.parentChat === parentChat;
    if (!parentChat || verified) return { status: 'not_needed' };
    const livePairs = getPairs();
    try {
        const parentData = await fetchParentChat(parentChat);
        if (getContext().chatMetadata !== metadata) return { status: 'superseded' };
        const restored = parentData
            ? replayBranchData(parentData, livePairs, parentChat)
            : buildFreshBranchData(livePairs, parentChat);
        metadata[MODULE_NAME] = restored;
        await saveChatData(restored);
        appendLog('info', `分支记忆恢复完成：${restored.branch_origin.method}`);
        return { status: 'ready', method: restored.branch_origin.method };
    } catch (error) {
        if (getContext().chatMetadata !== metadata) return { status: 'superseded' };
        const blank = EMPTY_CHAT_DATA();
        blank.job_queue.scope_id = crypto.randomUUID();
        blank.branch_origin = { parentChat, status: 'failed', error: String(error?.message || error), recoveredAt: Date.now() };
        blank.notices.push({ id: crypto.randomUUID(), kind: 'notice', note: `分支记忆恢复失败：${error?.message || error}。为避免串线，本分支暂不注入旧记忆。`, createdAt: Date.now() });
        metadata[MODULE_NAME] = blank;
        await saveChatData(blank);
        return { status: 'failed', error };
    }
}

export function beginBranchRecovery() {
    const target = getContext().chatMetadata;
    if (recoveryTarget === target) return recoveryBarrier;
    recoveryTarget = target;
    const pending = recoverCurrentBranch();
    recoveryBarrier = pending.finally(() => {
        if (recoveryTarget === target) recoveryTarget = null;
    });
    return recoveryBarrier;
}

export async function waitForBranchRecovery() {
    let observed;
    do {
        observed = recoveryBarrier;
        await observed;
    } while (observed !== recoveryBarrier);
}

export async function ensureCurrentBranchRecovery() {
    const data = getContext().chatMetadata?.[MODULE_NAME];
    if (data?.branch_origin?.status === 'failed') return beginBranchRecovery();
    return waitForBranchRecovery();
}
