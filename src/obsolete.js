import { factValueKey } from './facts.js';
import { evidenceInSource } from './tokens.js';

const CATEGORIES = new Set(['low_value', 'completed', 'superseded', 'scene_local', 'expired', 'contradicted']);
const protectedEntry = entry => Boolean(entry?.pinned || entry?.source === 'manual' || entry?.manual_override);

/** Freeze exactly what this extraction saw; a later edit must not be retired. */
export function snapshotObsoleteTargets(table) {
    return Object.fromEntries((table?.entries || []).map(entry => [entry.id, structuredClone(entry)]));
}

/** Re-extracting an older discovery must not resurrect a later retired state. */
export function isObsoleteDiscovery(data, candidate) {
    return (data.retired_facts || []).some(record => record.source === 'per_floor_obsolete'
        && factValueKey(record.entry) === factValueKey(candidate.fact)
        && Number.isInteger(candidate.floor)
        && candidate.floor <= record.anchorPairIndex);
}

/** Apply the existing extract call's explicit obsolete decisions, with no model calls. */
export function applyObsoleteFacts(data, decisions, ctx, touched = new Set()) {
    const records = [];
    let discarded = 0;
    const seen = new Set();
    const reviewSource = [ctx.sourceText, ctx.obsoleteHistory, ...Object.values(ctx.obsoleteTargets || {})
        .flatMap(entry => [entry.value, entry.evidence])].filter(Boolean).join('\n');
    for (const decision of Array.isArray(decisions) ? decisions : []) {
        const id = decision?.entry_id;
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = data.state_table.entries.find(item => item.id === id);
        const shown = ctx.obsoleteTargets?.[id];
        const category = CATEGORIES.has(decision?.category) ? decision.category : 'low_value';
        const reason = typeof decision?.reason === 'string' ? decision.reason.trim() : '';
        const evidence = typeof decision?.evidence === 'string' ? decision.evidence.trim() : '';
        const validEvidence = Boolean(evidence && evidence.length <= 50 && evidenceInSource(evidence, reviewSource));
        if (ctx.pipeline !== 'per_floor' || !ctx.floorKey || !ctx.contentFingerprint
            || !Number.isInteger(ctx.pairIndex) || !entry || !shown || protectedEntry(entry)
            || JSON.stringify(entry) !== JSON.stringify(shown) || touched.has(id)
            || !reason || reason.length > 300
            || (evidence && !validEvidence)) {
            discarded += 1;
            continue;
        }
        const archivedAt = Date.now();
        const record = {
            id: crypto.randomUUID(), entry: structuredClone(entry), entry_id: id,
            source: 'per_floor_obsolete', destination: 'retired', category,
            reason, evidence, automatic: true,
            anchorFloorKey: ctx.floorKey, anchorPairIndex: ctx.pairIndex,
            anchorFingerprint: ctx.contentFingerprint, archivedAt, retiredAt: archivedAt,
        };
        data.retired_facts ||= [];
        data.retired_facts.push(record);
        data.state_table.entries = data.state_table.entries.filter(item => item.id !== id);
        data.state_table.version = Number(data.state_table.version || 0) + 1;
        // A previously queued suggestion for this ID is no longer actionable.
        data.review_queue = (data.review_queue || []).filter(item => item.entry_id !== id);
        records.push(record);
    }
    return { records, discarded };
}
