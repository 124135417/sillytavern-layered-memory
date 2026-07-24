import { isUsableMemoryEntry, validateMemoryEntryShape } from './quality.js';

function clean(value) {
    return String(value ?? '').trim();
}

function hashText(value) {
    let hash = 0x811c9dc5;
    for (const char of String(value)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function factTopic(entry) {
    return clean(entry?.topic) || clean(entry?.value);
}

/** Distinct promises/identities/etc. may coexist; only the same concrete topic updates. */
export function factIdentityKey(entry) {
    return [clean(entry?.slot), clean(entry?.subject), clean(entry?.object), factTopic(entry)]
        .join('\u0000');
}

export function factValueKey(entry) {
    return [factIdentityKey(entry), clean(entry?.value)].join('\u0000');
}

function candidateId({ floor, floorKey, contentFingerprint, fact }, index = 0) {
    return `fc_${hashText([floorKey || floor, contentFingerprint || 'unverified-source', factValueKey(fact), index].join('\u0000'))}`;
}

export function makeFactCandidate({ fact, floor = null, floorKey = null, contentFingerprint = null, source = 'auto', errors = [], index = 0 }) {
    const snapshot = {
        slot: clean(fact?.slot),
        topic: clean(fact?.topic),
        subject: clean(fact?.subject),
        object: clean(fact?.object),
        value: clean(fact?.value ?? fact?.new_value),
        old_value: clean(fact?.old_value),
        new_value: clean(fact?.new_value),
        cause: clean(fact?.cause),
        evidence: clean(fact?.evidence),
        why_persistent: clean(fact?.why_persistent),
    };
    return {
        id: candidateId({ floor, floorKey, contentFingerprint, fact: snapshot }, index),
        floor,
        floorKey,
        contentFingerprint,
        fact: snapshot,
        source,
        validation_errors: [...new Set((errors || []).map(clean).filter(Boolean))],
        createdAt: Date.now(),
    };
}

export function upsertFactCandidate(ledger, candidate) {
    const list = Array.isArray(ledger) ? ledger : [];
    const existing = list.find(item => item.id === candidate.id);
    if (existing) Object.assign(existing, candidate, { createdAt: existing.createdAt || candidate.createdAt });
    else list.push(candidate);
    return list;
}

/**
 * Soft-migrate legacy data into an immutable discovery ledger. floor_events
 * retains each historical value even when the old state-table merge swallowed it.
 */
export function ensureFactLedger(data) {
    data.fact_ledger = Array.isArray(data.fact_ledger) ? data.fact_ledger : [];
    data.fact_decisions = Array.isArray(data.fact_decisions) ? data.fact_decisions : [];
    if (!data.fact_ledger.length) {
        for (const event of data.floor_events || []) {
            let index = 0;
            for (const change of event.entryChanges || []) {
                if (change?.op !== 'upsert' || !change.after) continue;
                upsertFactCandidate(data.fact_ledger, makeFactCandidate({
                    fact: change.after,
                    floor: event.pairIndex,
                    floorKey: event.floorKey,
                    contentFingerprint: event.contentFingerprint || null,
                    source: change.after.source || 'auto',
                    index: index++,
                }));
            }
        }
    }
    const changelog = data.state_table?.changelog || [];
    const fullSnapshotById = new Map();
    for (const entry of data.state_table?.entries || []) {
        if (entry?.id && entry.slot && entry.subject) fullSnapshotById.set(entry.id, entry);
    }
    for (const change of changelog) {
        for (const snapshot of [change?.before, change?.after]) {
            if (change?.id && snapshot?.slot && snapshot?.subject && !fullSnapshotById.has(change.id)) {
                fullSnapshotById.set(change.id, snapshot);
            }
        }
    }
    for (const change of changelog) {
        const snapshots = change?.op === 'update'
            ? [change.before, change.after]
            : [change.after || change.before];
        let index = 0;
        for (const snapshot of snapshots.filter(Boolean)) {
            const completedSnapshot = { ...(fullSnapshotById.get(change.id) || {}), ...snapshot };
            const floor = Number.isFinite(Number(change.floor)) ? Number(change.floor) : null;
            const represented = data.fact_ledger.some(item => item.floor === floor
                && factValueKey(item.fact) === factValueKey(completedSnapshot));
            if (represented) continue;
            upsertFactCandidate(data.fact_ledger, makeFactCandidate({
                fact: completedSnapshot,
                floor,
                floorKey: change.floorKey || null,
                contentFingerprint: change.contentFingerprint || null,
                source: snapshot.source || 'legacy',
                index: 500 + index++,
            }));
        }
    }
    for (const entry of data.state_table?.entries || []) {
        const represented = data.fact_ledger.some(item => factValueKey(item.fact) === factValueKey(entry));
        if (!represented) {
            upsertFactCandidate(data.fact_ledger, makeFactCandidate({
                fact: entry,
                floor: typeof entry.updated_floor === 'number' ? entry.updated_floor : null,
                floorKey: null,
                source: entry.source || 'legacy',
            }));
        }
    }
    for (const entry of data.quarantined_entries || []) {
        upsertFactCandidate(data.fact_ledger, makeFactCandidate({
            fact: entry,
            floor: typeof entry.updated_floor === 'number' ? entry.updated_floor : null,
            source: entry.source || 'legacy',
            errors: [entry.quarantineReason || '旧结果未通过安全检查'],
        }));
    }
    return data.fact_ledger;
}

export function factCandidateView(data) {
    const ledger = ensureFactLedger(data);
    const entries = (data.state_table?.entries || []).filter(isUsableMemoryEntry);
    return ledger.map(candidate => {
        const decision = [...(data.fact_decisions || [])].reverse().find(item => item.candidateId === candidate.id);
        const exact = entries.find(entry => factValueKey(entry) === factValueKey(candidate.fact));
        const sameTopic = entries.find(entry => factIdentityKey(entry) === factIdentityKey(candidate.fact));
        const sameBroadSlot = entries.find(entry => entry.slot === candidate.fact.slot
            && entry.subject === candidate.fact.subject
            && (entry.object || '') === (candidate.fact.object || ''));
        let status = 'unselected';
        let reason = '这条内容已被发现，但尚未加入当前事实。';
        if (decision?.action === 'dismiss') {
            status = 'dismissed';
            reason = '你已选择不采用这条内容。';
        } else if (exact) {
            status = 'active';
            reason = '与当前记忆一致。';
        } else if (candidate.validation_errors?.length) {
            status = 'unverified';
            reason = `自动检查未通过：${candidate.validation_errors.join('；')}`;
        } else if (sameTopic || (!candidate.fact.topic && sameBroadSlot)) {
            status = 'superseded';
            reason = sameTopic
                ? '同一事项已有不同的当前状态。'
                : '旧版合并规则曾用同类型内容覆盖它；你可以重新加入。';
        }
        return { ...candidate, status, reason, activeEntryId: exact?.id || null };
    }).sort((a, b) => Number(b.floor ?? -1) - Number(a.floor ?? -1));
}

function appendDecision(data, candidate, action, anchor = {}) {
    data.fact_decisions = Array.isArray(data.fact_decisions) ? data.fact_decisions : [];
    data.fact_decisions.push({
        id: crypto.randomUUID(),
        candidateId: candidate.id,
        action,
        candidateSnapshot: structuredClone(candidate.fact),
        anchorFloorKey: anchor.floorKey ?? null,
        anchorPairIndex: Number(anchor.pairIndex ?? -1),
        anchorFingerprint: anchor.contentFingerprint ?? null,
        recordedAt: Date.now(),
    });
}

export function activateFactCandidate(data, candidateIdValue, anchor = {}) {
    const candidate = ensureFactLedger(data).find(item => item.id === candidateIdValue);
    if (!candidate) return null;
    const fact = candidate.fact || {};
    const manualShape = validateMemoryEntryShape({ ...fact, source: 'manual' });
    if (!manualShape.ok) return { error: manualShape.errors.join('；'), candidate };
    const exact = (data.state_table.entries || []).find(entry => factValueKey(entry) === factValueKey(fact));
    if (exact) {
        appendDecision(data, candidate, 'activate', anchor);
        return { entry: exact, candidate, existed: true };
    }
    const replaced = (data.state_table.entries || []).filter(entry => factIdentityKey(entry) === factIdentityKey(fact));
    if (replaced.length) {
        const replacedIds = new Set(replaced.map(entry => entry.id));
        data.state_table.entries = data.state_table.entries.filter(entry => !replacedIds.has(entry.id));
    }
    const seq = Number(data.progress?.next_entry_seq || 1);
    data.progress.next_entry_seq = seq + 1;
    const entry = {
        ...structuredClone(fact),
        id: `e_${String(seq).padStart(4, '0')}`,
        established_floor: candidate.floor ?? 'manual',
        updated_floor: 'manual',
        source: 'manual',
        manual_override: true,
        pinned: true,
    };
    data.state_table.entries.push(entry);
    data.state_table.version = Number(data.state_table.version || 0) + 1;
    appendDecision(data, candidate, 'activate', anchor);
    return { entry, candidate, existed: false, replaced };
}

export function activateEditedFactCandidate(data, candidateIdValue, editedFact, anchor = {}) {
    const original = ensureFactLedger(data).find(item => item.id === candidateIdValue);
    if (!original) return null;
    const editedCandidate = makeFactCandidate({
        fact: { ...editedFact, topic: clean(editedFact?.topic) || clean(editedFact?.value) },
        floor: original.floor,
        floorKey: original.floorKey,
        contentFingerprint: original.contentFingerprint || null,
        source: 'manual',
        index: 997,
    });
    upsertFactCandidate(data.fact_ledger, editedCandidate);
    appendDecision(data, original, 'dismiss', anchor);
    return activateFactCandidate(data, editedCandidate.id, anchor);
}

export function dismissFactCandidate(data, candidateIdValue, anchor = {}) {
    const candidate = ensureFactLedger(data).find(item => item.id === candidateIdValue);
    if (!candidate) return false;
    appendDecision(data, candidate, 'dismiss', anchor);
    return true;
}
