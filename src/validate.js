import { SLOTS } from './constants.js';
import { evidenceInSource } from './tokens.js';
import { validateMemoryEntryShape } from './quality.js';

/**
 * @param {object} item - one slot entry candidate
 * @param {object} ctx
 * @param {'per_floor'|'chapter'} ctx.pipeline
 * @param {string} ctx.sourceText - floor text or chapter summary
 * @param {object} ctx.stateTable
 * @param {string} slot
 */
export function validateEntry(item, ctx, slot) {
    const errors = [];
    if (!item || typeof item !== 'object') {
        return { ok: false, errors: ['条目不是对象'], conflict: null };
    }

    const shape = validateMemoryEntryShape({
        ...item,
        slot,
        value: item.value ?? item.new_value,
        source: ctx.source || 'auto',
    });
    errors.push(...shape.errors);

    const evidence = item.evidence;
    if (!evidence || typeof evidence !== 'string') {
        errors.push('缺少 evidence');
    } else if (!evidenceInSource(evidence, ctx.sourceText)) {
        errors.push(ctx.pipeline === 'chapter'
            ? 'evidence 不是章摘要子串'
            : 'evidence 不是本楼原文子串');
    }

    const subject = item.subject;
    if (subject) {
        const inSource = evidenceInSource(subject, ctx.sourceText) || evidenceInSource(subject, JSON.stringify(ctx.stateTable));
        const inTable = (ctx.stateTable.entries || []).some(e => e.subject === subject || e.object === subject);
        if (!inSource && !inTable && !String(ctx.sourceText).includes(subject)) {
            // loose: subject string appears in source or table
            const blob = `${ctx.sourceText}\n${(ctx.stateTable.entries || []).map(e => `${e.subject} ${e.object || ''}`).join('\n')}`;
            if (!blob.includes(subject)) {
                errors.push(`subject 未在原文/摘要或状态表中出现: ${subject}`);
            }
        }
    }

    const value = item.value ?? item.new_value;
    if (value && String(value).length > 80) {
        errors.push('value 超过 80 字');
    }

    if (slot === 'other' && item.why_persistent == null && !item.value) {
        // allow; checked loosely
    }

    let conflict = null;
    if (item.old_value != null && item._updateId) {
        const entry = (ctx.stateTable.entries || []).find(e => e.id === item._updateId);
        if (entry && entry.value !== item.old_value) {
            conflict = {
                entry_id: entry.id,
                note: `模型给出的 old_value「${item.old_value}」与表内现值「${entry.value}」不符`,
            };
        }
    }

    return { ok: errors.length === 0, errors, conflict };
}

export function validateUpdateId(id, stateTable) {
    return (stateTable.entries || []).some(e => e.id === id);
}

export function isNoChange(val) {
    return val === '无变化' || val == null || val === '' || (Array.isArray(val) && val.length === 0);
}

/**
 * Normalize model JSON into candidate ops before merge.
 */
export function normalizeExtractOutput(raw, pipeline = 'per_floor') {
    const out = {
        turnSummary: '',
        adds: [],
        updates: [],
        conflicts: [],
        storyTimeRaw: raw?.story_time ?? null,
        pipeline,
    };
    if (!raw || typeof raw !== 'object') {
        return out;
    }

    const turnSummary = String(raw.turn_summary || '').trim();
    if (pipeline === 'per_floor' && turnSummary && [...turnSummary].length <= 500) {
        out.turnSummary = turnSummary;
    }

    for (const slot of SLOTS) {
        const val = raw[slot];
        if (isNoChange(val)) {
            continue;
        }
        const list = Array.isArray(val) ? val : [val];
        for (const item of list) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            if (slot === 'relationship' && (item.new_value || item.old_value)) {
                if (!item.old_value || !item.new_value) continue;
                out.adds.push({
                    slot,
                    topic: item.topic,
                    subject: item.subject,
                    object: item.object ?? '',
                    value: item.new_value ?? item.value,
                    old_value: item.old_value,
                    evidence: item.evidence,
                    cause: item.cause,
                    why_persistent: item.why_persistent,
                });
            } else {
                out.adds.push({
                    slot,
                    topic: item.topic,
                    subject: item.subject,
                    object: item.object ?? '',
                    value: item.value ?? item.new_value,
                    evidence: item.evidence,
                    cause: item.cause,
                    why_persistent: item.why_persistent,
                    old_value: item.old_value,
                });
            }
        }
    }

    if (Array.isArray(raw.conflicts)) {
        for (const c of raw.conflicts) {
            if (c?.entry_id) {
                const action = ['replace', 'retire', 'review'].includes(c.action) ? c.action : 'review';
                out.conflicts.push({ entry_id: c.entry_id, action, note: c.note || '' });
            }
        }
    }
    return out;
}
