import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { recordManualEvent } from './branch.js';
import { getPairs } from './ids.js';
import { fallbackNarrativeSummary, currentNarrativeSources } from './narrative.js';
import { STATE_REVIEW_JSON_SCHEMA, STATE_REVIEW_SYSTEM } from './prompts.js';
import { usableMemoryEntries } from './quality.js';
import { renderL2Block } from './render.js';
import { appendLog, assertChatData, getChatData, saveChatData } from './settings.js';

const REVIEW_KIND = 'state_cleanup';
const CATEGORIES = new Set(['expired', 'superseded', 'redundant', 'scene_local', 'contradicted']);
const CONFIDENCE = new Set(['high', 'medium']);

function isProtected(entry) {
    return Boolean(entry?.pinned || entry?.source === 'manual' || entry?.manual_override);
}

function cleanText(value, max = 300) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildStateReviewPrompt(data = getChatData()) {
    const sources = currentNarrativeSources().map(source => ({
        ...source,
        fallbackSummary: fallbackNarrativeSummary(source),
    }));
    const narrative = renderL2Block(data, {
        forBudget: true,
        pairs: getPairs(),
        narrativeSources: sources,
    });
    return [
        '## 当前状态表（只能引用这里已有的 ID）',
        (data.state_table?.entries || []).map(entry => {
            const object = entry.object ? `↔${entry.object}` : '';
            const protection = isProtected(entry) ? '｜受玩家保护，不得移出' : '';
            const floor = entry.updated_floor ?? entry.established_floor ?? '未知';
            return `- [${entry.id}] (${entry.slot}｜事项：${entry.topic || entry.value}｜更新：${floor}${protection}) ${entry.subject}${object}: ${entry.value}`;
        }).join('\n') || '（当前状态表为空）',
        '',
        '## 已发生的剧情（用于判断旧状态是否已结束）',
        narrative || '（还没有可供核对的剧情记录）',
    ].join('\n');
}

export function normalizeStateReview(raw, data = getChatData(), {
    now = Date.now(),
    id = crypto.randomUUID(),
    anchor = null,
} = {}) {
    const entries = usableMemoryEntries(data);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const claimed = new Set();
    const proposals = [];
    for (const change of Array.isArray(raw?.changes) ? raw.changes : []) {
        const retireIds = [];
        for (const candidate of Array.isArray(change?.retire_ids) ? change.retire_ids : []) {
            const entryId = String(candidate || '').trim();
            const entry = byId.get(entryId);
            if (!entry || isProtected(entry) || claimed.has(entryId)) continue;
            claimed.add(entryId);
            retireIds.push(entryId);
        }
        if (!retireIds.length) continue;
        const requestedKeepId = String(change?.keep_id || '').trim();
        const keepId = requestedKeepId && byId.has(requestedKeepId) && !retireIds.includes(requestedKeepId)
            ? requestedKeepId
            : '';
        proposals.push({
            retire_ids: retireIds,
            keep_id: keepId,
            category: CATEGORIES.has(change?.category) ? change.category : 'superseded',
            reason: cleanText(change?.reason || '后文已有更新状态，这条旧记忆不再描述现在。'),
            confidence: CONFIDENCE.has(change?.confidence) ? change.confidence : 'medium',
        });
    }
    return {
        id,
        kind: REVIEW_KIND,
        base_version: Number(data.state_table?.version || 0),
        proposals,
        retire_count: proposals.reduce((total, proposal) => total + proposal.retire_ids.length, 0),
        floorKey: anchor?.floorKey || null,
        anchor_pair: Number.isFinite(Number(anchor?.pairIndex)) ? Number(anchor.pairIndex) : null,
        anchor_fingerprint: anchor?.contentFingerprint || null,
        createdAt: now,
    };
}

export function stateReviewEntries(data, batch) {
    const byId = new Map((data.state_table?.entries || []).map(entry => [entry.id, entry]));
    const retired = [];
    const kept = [];
    for (const proposal of batch?.proposals || []) {
        for (const entryId of proposal.retire_ids || []) {
            const entry = byId.get(entryId);
            if (entry) retired.push({ entry, proposal });
        }
        if (proposal.keep_id) {
            const entry = byId.get(proposal.keep_id);
            if (entry) kept.push({ entry, proposal });
        }
    }
    return { retired, kept };
}

export function applyStateReviewBatch(data, batch, { recordEvent = recordManualEvent } = {}) {
    if (!batch || batch.kind !== REVIEW_KIND) return { error: 'invalid_batch', removed: 0 };
    if (Number(batch.base_version) !== Number(data.state_table?.version || 0)) {
        return { error: 'stale', removed: 0 };
    }
    const entries = data.state_table?.entries || [];
    const requested = new Set((batch.proposals || []).flatMap(proposal => proposal.retire_ids || []));
    const removable = entries.filter(entry => requested.has(entry.id) && !isProtected(entry));
    if (!removable.length) return { error: 'nothing_to_remove', removed: 0 };
    const removedIds = new Set(removable.map(entry => entry.id));
    for (const entry of removable) {
        recordEvent(data, { op: 'delete', before: entry, after: null, reason: 'state_review_approval' });
    }
    data.state_table.entries = entries.filter(entry => !removedIds.has(entry.id));
    data.state_table.version = Number(data.state_table.version || 0) + 1;
    data.review_queue = (data.review_queue || []).filter(item => item.id !== batch.id);
    return {
        error: null,
        removed: removable.length,
        removedIds: [...removedIds],
        skipped: Math.max(0, requested.size - removable.length),
    };
}

export async function handleStateReviewJob() {
    const data = getChatData();
    const entries = usableMemoryEntries(data);
    if (entries.length < 2) {
        appendLog('info', '当前记忆重新整理跳过：可整理条目不足');
        return;
    }
    const { text } = await callAuxModel({
        purpose: 'state_review',
        systemPrompt: STATE_REVIEW_SYSTEM,
        userPrompt: buildStateReviewPrompt(data),
        jsonSchema: STATE_REVIEW_JSON_SCHEMA,
        temperature: 0,
    });
    assertChatData(data);
    const raw = parseJsonFromModel(text);
    if (!raw) throw new Error('当前记忆重新整理 JSON 解析失败');
    const head = getPairs().filter(pair => pair.sealed).at(-1);
    const batch = normalizeStateReview(raw, data, { anchor: head });
    data.review_queue = (data.review_queue || []).filter(item => item.kind !== REVIEW_KIND);
    if (batch.proposals.length) {
        data.review_queue.push(batch);
        appendLog('info', `当前记忆重新整理完成：建议移出 ${batch.retire_count} 条，等待确认`);
    } else {
        data.notices = Array.isArray(data.notices) ? data.notices : [];
        data.notices.push({
            id: crypto.randomUUID(),
            kind: 'notice',
            note: '当前记忆重新整理完成，没有找到可以安全移出的旧状态。',
            createdAt: Date.now(),
        });
        appendLog('info', '当前记忆重新整理完成：没有安全修改建议');
    }
    await saveChatData(data);
}

export const STATE_REVIEW_KIND = REVIEW_KIND;
