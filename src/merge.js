import { appendLog, getChatData, saveChatData } from './settings.js';
import { validateEntry, validateUpdateId } from './validate.js';

function nextEntryId(data) {
    const seq = data.progress.next_entry_seq || 1;
    data.progress.next_entry_seq = seq + 1;
    return `e_${String(seq).padStart(4, '0')}`;
}

function findDuplicate(entries, slot, subject, object) {
    return entries.find(e =>
        e.slot === slot
        && e.subject === subject
        && (e.object || '') === (object || ''));
}

function pushChangelog(data, record) {
    data.state_table.changelog = data.state_table.changelog || [];
    data.state_table.changelog.push({
        ...record,
        at: Date.now(),
    });
    if (data.state_table.changelog.length > 500) {
        // Keep recent; prefer not folding segments referenced by eval (eval stores snapshots)
        data.state_table.changelog = data.state_table.changelog.slice(-500);
    }
}

/**
 * Apply normalized extract result into state table.
 * @returns {{ applied: number, discarded: number, conflicts: number }}
 */
export async function mergeExtractResult(normalized, ctx) {
    const data = getChatData();
    const table = data.state_table;
    table.entries = table.entries || [];
    let applied = 0;
    let discarded = 0;
    let conflicts = 0;

    const floorLabel = ctx.floorLabel ?? ctx.pairIndex ?? '?';
    const floorKey = ctx.floorKey ?? null;

    if (ctx.pipeline === 'per_floor' && normalized.turnSummary && floorKey) {
        data.turn_summaries = data.turn_summaries || [];
        const existing = data.turn_summaries.find(item => item.floorKey === floorKey);
        const next = {
            floorKey,
            pairIndex: Number(ctx.pairIndex ?? ctx.floorLabel),
            summary: normalized.turnSummary,
            sourceMode: ctx.bodyMode || 'full',
            updatedAt: Date.now(),
        };
        if (existing) {
            Object.assign(existing, next);
        } else {
            data.turn_summaries.push(next);
        }
    }

    for (const item of normalized.adds) {
        const dup = findDuplicate(table.entries, item.slot, item.subject, item.object || '');
        if (dup) {
            // treat as update
            if (dup.pinned) {
                discarded += 1;
                continue;
            }
            const v = validateEntry({ ...item, _updateId: dup.id }, ctx, item.slot);
            if (v.conflict) {
                data.review_queue.push({
                    id: crypto.randomUUID(),
                    kind: 'flag_conflict',
                    entry_id: v.conflict.entry_id,
                    note: v.conflict.note,
                    floorKey,
                    createdAt: Date.now(),
                });
                conflicts += 1;
            }
            if (!v.ok) {
                discarded += 1;
                appendLog('warn', `丢弃 update: ${v.errors.join('; ')}`, item);
                continue;
            }
            const oldValue = dup.value;
            pushChangelog(data, {
                op: 'update',
                id: dup.id,
                floorKey,
                floor: floorLabel,
                before: { value: oldValue, cause: dup.cause },
                after: { value: item.value, cause: item.cause || item.old_value },
            });
            dup.value = item.value;
            if (item.cause) {
                dup.cause = item.cause;
            }
            dup.updated_floor = floorLabel;
            dup.evidence = item.evidence || dup.evidence;
            table.version += 1;
            applied += 1;
            continue;
        }

        const v = validateEntry(item, ctx, item.slot);
        if (!v.ok) {
            discarded += 1;
            appendLog('warn', `丢弃 add: ${v.errors.join('; ')}`, item);
            continue;
        }
        if (v.conflict) {
            data.review_queue.push({
                id: crypto.randomUUID(),
                kind: 'flag_conflict',
                entry_id: v.conflict.entry_id,
                note: v.conflict.note,
                floorKey,
                createdAt: Date.now(),
            });
            conflicts += 1;
        }

        const entry = {
            id: nextEntryId(data),
            slot: item.slot,
            subject: item.subject || '',
            object: item.object || '',
            value: item.value || '',
            cause: item.cause || '',
            established_floor: floorLabel,
            updated_floor: floorLabel,
            evidence: item.evidence || '',
            pinned: false,
            source: ctx.source || 'auto',
            why_persistent: item.why_persistent || '',
        };
        table.entries.push(entry);
        pushChangelog(data, {
            op: 'add',
            id: entry.id,
            floorKey,
            floor: floorLabel,
            after: { ...entry },
        });
        table.version += 1;
        applied += 1;
    }

    for (const c of normalized.conflicts || []) {
        if (!validateUpdateId(c.entry_id, table)) {
            discarded += 1;
            continue;
        }
        data.review_queue.push({
            id: crypto.randomUUID(),
            kind: 'flag_conflict',
            entry_id: c.entry_id,
            note: c.note || '',
            floorKey,
            createdAt: Date.now(),
        });
        conflicts += 1;
    }

    await saveChatData();
    return { applied, discarded, conflicts };
}

/**
 * Roll back all changelog ops for a given floorKey.
 */
export async function rollbackFloor(floorKey) {
    if (!floorKey) {
        return 0;
    }
    const data = getChatData();
    const table = data.state_table;
    const logs = (table.changelog || []).filter(c => c.floorKey === floorKey);
    const beforeSummaryCount = (data.turn_summaries || []).length;
    data.turn_summaries = (data.turn_summaries || []).filter(item => item.floorKey !== floorKey);
    const removedSummary = beforeSummaryCount !== data.turn_summaries.length;
    if (!logs.length && !removedSummary) {
        return 0;
    }
    // Apply reverse in reverse order
    for (const rec of [...logs].reverse()) {
        if (rec.op === 'add') {
            table.entries = table.entries.filter(e => e.id !== rec.id);
        } else if (rec.op === 'update') {
            const e = table.entries.find(x => x.id === rec.id);
            if (e && rec.before) {
                e.value = rec.before.value;
                e.cause = rec.before.cause ?? e.cause;
            }
        }
    }
    table.changelog = (table.changelog || []).filter(c => c.floorKey !== floorKey);
    data.extracted_keys = (data.extracted_keys || []).filter(k => k !== floorKey);
    if (logs.length) table.version += 1;
    await saveChatData();
    return Math.max(logs.length, removedSummary ? 1 : 0);
}

export function renderStateTableCompact(table) {
    const entries = table?.entries || [];
    if (!entries.length) {
        return '（当前状态表为空）';
    }
    return entries.map(e => {
        const obj = e.object ? `↔${e.object}` : '';
        return `- [${e.id}] (${e.slot}) ${e.subject}${obj}: ${e.value}${e.cause ? `（因：${e.cause}）` : ''}`;
    }).join('\n');
}
