import { recordManualEvent } from './branch.js';
import { deleteFactCandidate, ensureFactLedger, factValueKey } from './facts.js';
import { saveChatData } from './settings.js';

const ARCHIVE_KEYS = new Set(['dormant_facts', 'retired_facts', 'historical_facts']);
const SNAPSHOT_KEYS = [
    'state_table',
    'dormant_facts',
    'retired_facts',
    'historical_facts',
    'manual_events',
    'fact_ledger',
    'fact_decisions',
    'memory_organization',
    'state_lifecycle',
    'review_queue',
    'notices',
    'progress',
];

function clone(value) {
    return structuredClone(value);
}

function uniqueIds(ids) {
    return [...new Set((ids || []).map(String).filter(Boolean))];
}

function nextManualEntryId(data) {
    data.progress = data.progress && typeof data.progress === 'object' ? data.progress : {};
    let sequence = Math.max(1, Number(data.progress.next_entry_seq || 1));
    const existing = new Set((data.state_table?.entries || []).map(entry => entry.id));
    let id = `e_${String(sequence).padStart(4, '0')}`;
    while (existing.has(id)) {
        sequence += 1;
        id = `e_${String(sequence).padStart(4, '0')}`;
    }
    data.progress.next_entry_seq = sequence + 1;
    return id;
}

function incrementStateVersion(data) {
    data.state_table.version = Number(data.state_table.version || 0) + 1;
}

function anchorFromEvent(event) {
    return {
        floorKey: event?.anchorFloorKey ?? null,
        pairIndex: Number.isFinite(Number(event?.anchorPairIndex)) ? Number(event.anchorPairIndex) : -1,
        contentFingerprint: event?.anchorFingerprint ?? null,
    };
}

export function captureFactMutationSnapshot(data) {
    return Object.fromEntries(SNAPSHOT_KEYS.map(key => [key, clone(data[key])]));
}

export function restoreFactMutationSnapshot(data, snapshot) {
    for (const key of SNAPSHOT_KEYS) data[key] = clone(snapshot[key]);
    return data;
}

export function invalidateStagedOrganization(data) {
    const organization = data.memory_organization;
    if (!organization?.staged) return false;
    organization.staged = null;
    organization.status = 'stale';
    data.notices = Array.isArray(data.notices) ? data.notices : [];
    data.notices.push({
        id: crypto.randomUUID(),
        kind: 'notice',
        note: '旧的整理预览已放弃：当前记忆已被手动修改，请按需重新整理。',
        createdAt: Date.now(),
    });
    return true;
}

function archiveManualRetirement(data, entry, event, { now, runId }) {
    data.retired_facts = Array.isArray(data.retired_facts) ? data.retired_facts : [];
    data.retired_facts.push({
        id: crypto.randomUUID(),
        entry: clone(entry),
        entry_id: entry.id,
        destination: 'retired',
        category: 'manual',
        reason: '玩家手动移出当前记忆。',
        evidence: [],
        verification: null,
        automatic: false,
        run_id: runId,
        anchorFloorKey: event?.anchorFloorKey ?? null,
        anchorPairIndex: Number.isFinite(Number(event?.anchorPairIndex)) ? Number(event.anchorPairIndex) : null,
        anchorFingerprint: event?.anchorFingerprint ?? null,
        archivedAt: now,
        retiredAt: now,
    });
}

export function retireCurrentFacts(data, ids, {
    recordEvent = recordManualEvent,
    now = Date.now(),
    runId = crypto.randomUUID(),
} = {}) {
    const requested = new Set(uniqueIds(ids));
    const affected = (data.state_table?.entries || []).filter(entry => requested.has(entry.id));
    if (!affected.length) return { action: 'retire', affected: [], previewInvalidated: false };

    for (const entry of affected) {
        const event = recordEvent(data, {
            op: 'delete',
            before: entry,
            after: null,
            reason: 'manual_retire',
        });
        archiveManualRetirement(data, entry, event, { now, runId });
    }
    data.state_table.entries = data.state_table.entries.filter(entry => !requested.has(entry.id));
    incrementStateVersion(data);
    const previewInvalidated = invalidateStagedOrganization(data);
    return { action: 'retire', affected: clone(affected), previewInvalidated };
}

export function permanentlyDeleteCurrentFacts(data, ids, {
    recordEvent = recordManualEvent,
} = {}) {
    const requested = new Set(uniqueIds(ids));
    const affected = (data.state_table?.entries || []).filter(entry => requested.has(entry.id));
    if (!affected.length) return { action: 'delete', affected: [], tombstones: 0, previewInvalidated: false };

    const candidates = ensureFactLedger(data);
    let tombstones = 0;
    for (const entry of affected) {
        const event = recordEvent(data, {
            op: 'delete',
            before: entry,
            after: null,
            reason: 'manual_delete',
        });
        const anchor = anchorFromEvent(event);
        for (const candidate of candidates.filter(item => factValueKey(item.fact) === factValueKey(entry))) {
            if (deleteFactCandidate(data, candidate.id, anchor)) tombstones += 1;
        }
    }
    data.state_table.entries = data.state_table.entries.filter(entry => !requested.has(entry.id));
    incrementStateVersion(data);
    const previewInvalidated = invalidateStagedOrganization(data);
    return { action: 'delete', affected: clone(affected), tombstones, previewInvalidated };
}

export function restoreArchivedFact(data, archiveKey, archiveId, {
    recordEvent = recordManualEvent,
} = {}) {
    if (!ARCHIVE_KEYS.has(archiveKey)) return { error: 'invalid_archive' };
    const archive = Array.isArray(data[archiveKey]) ? data[archiveKey] : [];
    const record = archive.find(item => item.id === archiveId);
    if (!record?.entry) return { error: 'missing' };

    const currentIds = new Set((data.state_table?.entries || []).map(entry => entry.id));
    const originalId = String(record.entry.id || '');
    const entry = {
        ...clone(record.entry),
        id: originalId && !currentIds.has(originalId) ? originalId : nextManualEntryId(data),
        updated_floor: 'manual',
        source: 'manual',
        manual_override: true,
    };
    data[archiveKey] = archive.filter(item => item.id !== archiveId);
    data.state_table.entries.push(entry);
    incrementStateVersion(data);
    recordEvent(data, {
        op: 'upsert',
        before: null,
        after: entry,
        reason: 'manual_restore_archived',
        archiveKey,
        archiveId,
    });
    const previewInvalidated = invalidateStagedOrganization(data);
    return { error: null, entry: clone(entry), record: clone(record), previewInvalidated };
}

export async function commitFactMutation(data, mutate, {
    persist = saveChatData,
    onOptimistic = null,
    onRollback = null,
} = {}) {
    const snapshot = captureFactMutationSnapshot(data);
    let result;
    try {
        result = mutate(data);
        onOptimistic?.(result);
        await persist(data);
        return result;
    } catch (error) {
        restoreFactMutationSnapshot(data, snapshot);
        onRollback?.(error, result);
        throw error;
    }
}

export function visibleFactIds(cards) {
    return [...new Set((cards || [])
        .filter(card => !card.hidden && card.id)
        .map(card => String(card.id)))];
}
