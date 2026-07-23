import { SLOTS } from './constants.js';

const EMPTY_SENTINELS = new Set(['undefined', 'null', '未填写事实', '未命名主体']);

function cleanText(value) {
    return String(value ?? '').trim();
}

function isMeaningful(value) {
    const text = cleanText(value);
    return Boolean(text) && !EMPTY_SENTINELS.has(text.toLowerCase()) && !EMPTY_SENTINELS.has(text);
}

/** One authoritative safety gate shared by storage, UI, retrieval and injection. */
export function validateMemoryEntryShape(entry) {
    const errors = [];
    if (!entry || typeof entry !== 'object') return { ok: false, errors: ['记忆不是对象'] };
    if (!SLOTS.includes(entry.slot)) errors.push('记忆类型无法识别');
    if (!isMeaningful(entry.subject)) errors.push('缺少明确主体');
    if (!isMeaningful(entry.value)) errors.push('缺少事实内容');
    if (cleanText(entry.subject).length > 80) errors.push('主体名称超过 80 字');
    if (cleanText(entry.object).length > 80) errors.push('关联对象超过 80 字');
    if (cleanText(entry.value).length > 80) errors.push('事实内容超过 80 字');
    if (cleanText(entry.evidence).length > 50) errors.push('原文证据超过 50 字');
    if (entry.slot === 'relationship' && !isMeaningful(entry.object)) errors.push('关系记忆缺少另一方');
    if (entry.source === 'auto' && !isMeaningful(entry.evidence)) errors.push('自动记忆缺少原文证据');
    return { ok: errors.length === 0, errors };
}

export function isUsableMemoryEntry(entry) {
    return validateMemoryEntryShape(entry).ok;
}

export function usableMemoryEntries(data) {
    return (data?.state_table?.entries || []).filter(isUsableMemoryEntry);
}

/** Move unsafe legacy entries aside without deleting them. Idempotent. */
export function quarantineInvalidEntries(data) {
    if (!data?.state_table) return 0;
    data.state_table.entries = Array.isArray(data.state_table.entries) ? data.state_table.entries : [];
    data.quarantined_entries = Array.isArray(data.quarantined_entries) ? data.quarantined_entries : [];
    const known = new Set(data.quarantined_entries.map(entry => entry.id).filter(Boolean));
    const kept = [];
    let moved = 0;
    for (const entry of data.state_table.entries) {
        const check = validateMemoryEntryShape(entry);
        if (check.ok) {
            kept.push(entry);
            continue;
        }
        if (!entry?.id || !known.has(entry.id)) {
            data.quarantined_entries.push({
                ...structuredClone(entry),
                quarantinedAt: Date.now(),
                quarantineReason: check.errors.join('；'),
            });
            if (entry?.id) known.add(entry.id);
        }
        moved += 1;
    }
    if (moved) {
        data.state_table.entries = kept;
        data.state_table.version = Number(data.state_table.version || 0) + 1;
    }
    return moved;
}

export function displayEntityName(value, context = null) {
    const text = cleanText(value);
    if (text !== '<user>') return text;
    const ctx = context || globalThis.SillyTavern?.getContext?.();
    return cleanText(ctx?.name1) || '你';
}

export function displayNarrativeText(value, context = null) {
    const text = cleanText(value);
    if (!text.includes('<user>')) return text;
    const ctx = context || globalThis.SillyTavern?.getContext?.();
    const userName = cleanText(ctx?.name1) || '你';
    return text.replaceAll('<user>', userName);
}

export function normalizeGeneratedEntity(value, userName = '') {
    const text = cleanText(value);
    if (!text) return '';
    if (text === '<user>' || (userName && text === cleanText(userName))) return '<user>';
    return text;
}
