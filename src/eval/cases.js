import { getSettings, saveSettings } from '../settings.js';
import { getPairTexts, getPairs } from '../ids.js';
import { getChatData } from '../settings.js';
import { callAuxModel, parseJsonFromModel } from '../aux-model.js';
import { EXTRACT_SYSTEM, EXTRACT_JSON_SCHEMA } from '../prompts.js';
import { normalizeExtractOutput } from '../validate.js';
import { renderStateTableCompact } from '../merge.js';

export function listEvalCases() {
    return getSettings().eval_cases || [];
}

export function addEvalCase( partial ) {
    const settings = getSettings();
    const item = {
        id: crypto.randomUUID(),
        pipeline: partial.pipeline || 'per_floor',
        type: partial.type || 'miss',
        source: partial.source || 'panel_report',
        floor_key: partial.floor_key || '',
        user_mes: partial.user_mes || '',
        ai_mes: partial.ai_mes || '',
        chapter_summary: partial.chapter_summary || '',
        state_table_snapshot: partial.state_table_snapshot || { version: 0, entries: [] },
        expected: partial.expected || {},
        created_at: new Date().toISOString(),
        note: partial.note || '',
    };
    settings.eval_cases.push(item);
    saveSettings();
    return item;
}

export function removeEvalCase(id) {
    const settings = getSettings();
    settings.eval_cases = (settings.eval_cases || []).filter(c => c.id !== id);
    saveSettings();
}

export function exportEvalCasesJson() {
    return JSON.stringify(listEvalCases(), null, 2);
}

/**
 * Snapshot state table + pair texts for a pairIndex / floorKey.
 */
export function snapshotForPair(pairIndex) {
    const pairs = getPairs();
    const pair = pairs.find(p => p.pairIndex === pairIndex);
    if (!pair) {
        return null;
    }
    const { userText, aiText } = getPairTexts(pair);
    return {
        floor_key: pair.floorKey,
        user_mes: userText,
        ai_mes: aiText,
        state_table_snapshot: structuredClone(getChatData().state_table),
        pairIndex,
    };
}

/**
 * Rerun one case through the matching pipeline; compare loosely to expected.
 */
export async function rerunEvalCase(caseId) {
    const c = listEvalCases().find(x => x.id === caseId);
    if (!c) {
        throw new Error('错例不存在');
    }

    let raw;
    if (c.pipeline === 'chapter') {
        const userPrompt = [
            '## 当前状态表\n',
            renderStateTableCompact(c.state_table_snapshot),
            '\n\n## 章节摘要\n',
            c.chapter_summary || c.ai_mes,
        ].join('');
        const { text } = await callAuxModel({
            purpose: 'extract',
            systemPrompt: EXTRACT_SYSTEM + '\n\n注意：evidence 须引自章节摘要。',
            userPrompt,
            jsonSchema: EXTRACT_JSON_SCHEMA,
            temperature: 0,
        });
        raw = parseJsonFromModel(text);
    } else {
        const userPrompt = [
            '## 当前状态表\n',
            renderStateTableCompact(c.state_table_snapshot),
            '\n\n## 本楼用户输入\n',
            c.user_mes,
            '\n\n## 本楼 AI 回复\n',
            c.ai_mes,
        ].join('');
        const { text } = await callAuxModel({
            purpose: 'extract',
            systemPrompt: EXTRACT_SYSTEM,
            userPrompt,
            jsonSchema: EXTRACT_JSON_SCHEMA,
            temperature: 0,
        });
        raw = parseJsonFromModel(text);
    }

    const normalized = normalizeExtractOutput(raw || {}, c.pipeline);
    const pass = matchExpected(normalized, c.expected, c.type);
    return { pass, normalized, raw, caseId };
}

function matchExpected(normalized, expected, type) {
    if (!expected || Object.keys(expected).length === 0) {
        // If user only left a note, treat as manual review — fail if type=miss and no adds
        if (type === 'miss') {
            return (normalized.adds || []).length > 0;
        }
        if (type === 'spurious') {
            return (normalized.adds || []).length === 0;
        }
        return false;
    }
    // expected may be { should_be_empty: true } or { contains_value: "..." }
    if (expected.should_be_empty) {
        return (normalized.adds || []).length === 0;
    }
    if (expected.contains_value) {
        return (normalized.adds || []).some(a => String(a.value || '').includes(expected.contains_value));
    }
    if (expected.slot && expected.subject) {
        return (normalized.adds || []).some(a =>
            a.slot === expected.slot && a.subject === expected.subject);
    }
    return JSON.stringify(normalized).includes(JSON.stringify(expected));
}

export async function rerunAllEvalCases() {
    const results = [];
    for (const c of listEvalCases()) {
        try {
            results.push(await rerunEvalCase(c.id));
        } catch (err) {
            results.push({ pass: false, caseId: c.id, error: err?.message ?? String(err) });
        }
    }
    return results;
}
