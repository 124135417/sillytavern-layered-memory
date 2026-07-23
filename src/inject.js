import { TRIM_TYPES, PROMPT_KEYS, QUEUE_PRIORITY } from './constants.js';
import { getPairs } from './ids.js';
import { retrieveHits } from './retrieve.js';
import { renderL1Block, renderL2Block, renderL4Block } from './render.js';
import { enqueue } from './queue.js';
import { getChatData, getSettings } from './settings.js';
import { estimateTokens } from './tokens.js';

function extensionPromptApi() {
    const ctx = SillyTavern.getContext();
    return {
        setExtensionPrompt: ctx.setExtensionPrompt,
        extension_prompt_types: ctx.extension_prompt_types || { IN_PROMPT: 0, IN_CHAT: 1, NONE: -1 },
        extension_prompt_roles: ctx.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    };
}

export function clearInjection() {
    const { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } = extensionPromptApi();
    if (!setExtensionPrompt) {
        return;
    }
    for (const key of Object.values(PROMPT_KEYS)) {
        setExtensionPrompt(key, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    }
}

export function updateInjection({ archiveEndPair } = {}) {
    const settings = getSettings();
    const { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } = extensionPromptApi();
    if (!setExtensionPrompt) {
        console.warn('[layered-memory] setExtensionPrompt 不可用');
        return;
    }
    if (!settings.enabled) {
        clearInjection();
        return;
    }

    const data = getChatData();
    const throughPair = Number.isInteger(archiveEndPair)
        ? archiveEndPair
        : (Number.isInteger(data.context_handoff?.removedThrough) ? data.context_handoff.removedThrough : -1);
    const l1 = renderL1Block(data, settings.budgetL1);
    const l2 = renderL2Block(data, { budget: settings.budgetL2, throughPair });

    if (estimateTokens(renderL2Block(data, { forBudget: true })) > (settings.budgetL2 || 5000)) {
        enqueue('volume_compress', { reason: 'budget' }, QUEUE_PRIORITY.volume_compress);
    }
    if (estimateTokens(l1) > (settings.budgetL1 || 2000) * 0.95) {
        enqueue('state_gc', {}, QUEUE_PRIORITY.state_gc);
    }

    let l4 = '';
    if (settings.l4Enabled) {
        const hits = retrieveHits(data, settings.budgetL4);
        l4 = renderL4Block(hits, settings.budgetL4);
    }

    const IN_CHAT = extension_prompt_types.IN_CHAT;
    const SYSTEM = extension_prompt_roles.SYSTEM;

    setExtensionPrompt(PROMPT_KEYS.L1, l1, IN_CHAT, settings.depthL1 ?? 100, false, SYSTEM);
    setExtensionPrompt(PROMPT_KEYS.L2, l2, IN_CHAT, settings.depthL2 ?? 100, false, SYSTEM);
    setExtensionPrompt(PROMPT_KEYS.L4, l4, IN_CHAT, settings.depthL4 ?? 4, false, SYSTEM);
}

const HISTORY_PERCENT = Object.freeze({ compact: 0.25, balanced: 0.4, detailed: 0.6 });

async function countChatTokens(chat) {
    const context = SillyTavern.getContext();
    const countExact = context?.getTokenCountAsync;
    let exact = typeof countExact === 'function';
    const counts = await Promise.all((chat || []).map(async message => {
        const text = String(message?.mes || '');
        if (exact) {
            try {
                const value = await countExact.call(context, text, 0);
                if (Number.isFinite(value)) return Number(value);
            } catch {
                exact = false;
            }
        }
        return estimateTokens(text);
    }));
    return {
        total: counts.reduce((sum, value) => sum + value, 0),
        byMessage: new Map((chat || []).map((message, index) => [message, counts[index]])),
        tokenizer: exact ? 'sillytavern' : 'estimate',
    };
}

function resolveHistoryBudget(settings, contextSize) {
    if (settings.historyBudgetMode === 'custom') {
        const custom = Number(settings.historyTokenBudget);
        return Number.isFinite(custom) && custom >= 500 ? Math.floor(custom) : null;
    }
    const percent = HISTORY_PERCENT[settings.historyBudgetMode] ?? HISTORY_PERCENT.balanced;
    const total = Number(contextSize);
    return Number.isFinite(total) && total > 0 ? Math.max(500, Math.floor(total * percent)) : null;
}

function getSafeArchiveBoundaries(data, maxPair) {
    const intervals = [];
    for (const chapter of data.chapters || []) {
        const [start, end] = chapter.floor_range || [];
        if (!chapter.stale && chapter.summary && Number.isInteger(start) && Number.isInteger(end) && end >= start) {
            intervals.push([start, end]);
        }
    }
    for (const item of data.turn_summaries || []) {
        if (item.summary && Number.isInteger(item.pairIndex)) {
            intervals.push([item.pairIndex, item.pairIndex]);
        }
    }

    const endpoints = [...new Set(intervals.map(([, end]) => end))]
        .filter(end => end <= maxPair)
        .sort((a, b) => a - b);
    return endpoints.filter(boundary => {
        const usable = intervals
            .filter(([, end]) => end <= boundary)
            .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
        let coveredThrough = -1;
        for (const [start, end] of usable) {
            if (start > coveredThrough + 1) break;
            if (end > coveredThrough) coveredThrough = end;
            if (coveredThrough >= boundary) return true;
        }
        return false;
    });
}

function baseHandoff(type, contextSize, before, budget, minRecentPairs) {
    return {
        at: Date.now(),
        type: type == null ? '' : String(type),
        contextSize: Number.isFinite(Number(contextSize)) ? Number(contextSize) : null,
        historyTokensBefore: before,
        historyTokensAfter: before,
        historyBudget: budget,
        minRecentPairs,
        removedThrough: -1,
        removedPairs: 0,
        keptFrom: 0,
        archiveTokens: 0,
        status: 'kept',
        reason: '',
    };
}

/**
 * Trim the post-regex request copy by a chat-only token budget. Only a
 * continuously summarized prefix may be removed; all uncertainty fails closed.
 */
export async function trimChatForGenerate(chat, type, contextSize) {
    const settings = getSettings();
    const data = getChatData();
    const counted = await countChatTokens(chat);
    const before = counted.total;
    const minRecentPairs = Math.max(1, Number(settings.minRecentPairs) || Number(settings.recentPairs) || 6);
    const budget = resolveHistoryBudget(settings, contextSize);
    const result = baseHandoff(type, contextSize, before, budget, minRecentPairs);
    result.tokenizer = counted.tokenizer;

    if (!settings.enabled) {
        result.status = 'skipped';
        result.reason = 'plugin_disabled';
        return result;
    }
    const t = type == null ? '' : String(type);
    if (!TRIM_TYPES.has(t)) {
        result.status = 'skipped';
        result.reason = 'generation_type';
        data.context_handoff = result;
        return result;
    }
    const pairs = getPairs();
    if (!pairs.length || before <= 0) {
        result.reason = 'no_chat';
        data.context_handoff = result;
        return result;
    }
    const pairIndexByFloorKey = new Map(pairs.map(pair => [pair.floorKey, pair.pairIndex]));
    data.turn_summaries = (data.turn_summaries || [])
        .filter(item => item.floorKey && pairIndexByFloorKey.has(item.floorKey))
        .map(item => ({ ...item, pairIndex: pairIndexByFloorKey.get(item.floorKey) }));
    if (!Number.isFinite(budget)) {
        result.status = 'blocked';
        result.reason = 'invalid_budget';
        data.context_handoff = result;
        return result;
    }
    if (before <= budget) {
        result.reason = 'within_budget';
        data.context_handoff = result;
        return result;
    }

    const maxRemovablePair = pairs.length - minRecentPairs - 1;
    if (maxRemovablePair < 0) {
        result.status = 'blocked';
        result.reason = 'recent_floor';
        data.context_handoff = result;
        return result;
    }

    const keyToMessage = new Map();
    for (const message of chat) {
        const id = message?.extra?.layered_memory_id;
        if (id) {
            keyToMessage.set(id, message);
        }
    }

    const boundaries = getSafeArchiveBoundaries(data, maxRemovablePair);
    if (!boundaries.length) {
        result.status = 'blocked';
        result.reason = 'summary_gap';
        data.context_handoff = result;
        return result;
    }

    const pairTokens = new Map();
    for (const pair of pairs) {
        if (pair.pairIndex > boundaries.at(-1)) {
            break;
        }
        const keys = [pair.userKey, pair.aiKey].filter(Boolean);
        if (!keys.length || keys.some(key => !keyToMessage.has(key))) {
            result.status = 'blocked';
            result.reason = 'message_mapping';
            result.blockedAt = pair.pairIndex;
            data.context_handoff = result;
            return result;
        }
        pairTokens.set(pair.pairIndex, keys.reduce((sum, key) => sum + (counted.byMessage.get(keyToMessage.get(key)) || 0), 0));
    }

    let cumulativeRemovedTokens = 0;
    let nextPair = 0;
    let chosen = null;
    for (const boundary of boundaries) {
        while (nextPair <= boundary) {
            cumulativeRemovedTokens += pairTokens.get(nextPair) || 0;
            nextPair += 1;
        }
        const archiveText = renderL2Block(data, { forBudget: true, throughPair: boundary });
        const archiveTokens = estimateTokens(archiveText);
        if (!archiveText || archiveTokens > (settings.budgetL2 || 5000)) {
            continue;
        }
        chosen = { boundary, removedTokens: cumulativeRemovedTokens, archiveTokens };
        if (before - cumulativeRemovedTokens <= budget) {
            break;
        }
    }

    if (!chosen) {
        result.status = 'blocked';
        result.reason = 'archive_budget';
        data.context_handoff = result;
        return result;
    }

    const removeKeys = new Set();
    for (const pair of pairs) {
        if (pair.pairIndex > chosen.boundary) break;
        removeKeys.add(pair.userKey);
        if (pair.aiKey) removeKeys.add(pair.aiKey);
    }
    for (let i = chat.length - 1; i >= 0; i--) {
        const id = chat[i]?.extra?.layered_memory_id;
        if (id && removeKeys.has(id)) {
            chat.splice(i, 1);
        }
    }

    result.status = 'trimmed';
    result.reason = before - chosen.removedTokens <= budget ? 'budget_met' : 'coverage_limit';
    result.removedThrough = chosen.boundary;
    result.removedPairs = chosen.boundary + 1;
    result.keptFrom = chosen.boundary + 1;
    result.archiveTokens = chosen.archiveTokens;
    result.historyTokensAfter = before - chosen.removedTokens;
    data.context_handoff = result;
    return result;
}
