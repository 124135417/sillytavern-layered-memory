import { TRIM_TYPES, PROMPT_KEYS, QUEUE_PRIORITY } from './constants.js';
import { getPairs, messageStableKey } from './ids.js';
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

export function updateInjection() {
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
    const l1 = renderL1Block(data, settings.budgetL1);
    const l2 = renderL2Block(data, { budget: settings.budgetL2 });

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

/**
 * Trim only for known-safe generate types (whitelist).
 * Keep unpaired messages from minKeepIdx through end (trailing multi-AI).
 */
export function trimChatForGenerate(chat, type) {
    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }
    const t = type == null ? '' : String(type);
    if (!TRIM_TYPES.has(t)) {
        return;
    }

    const data = getChatData();
    const pairs = getPairs();
    if (!pairs.length) {
        return;
    }

    const N = settings.recentPairs || 3;
    const lastChapterEnd = data.progress?.last_chapter_end_pair ?? -1;
    const total = pairs.length;
    const recentStart = Math.max(0, total - N);
    const gapStart = Math.max(0, lastChapterEnd + 1);
    const startPair = Math.min(recentStart, gapStart);

    if (startPair <= 0) {
        return;
    }

    // Pre-baseline history that no chapter represents must NOT be trimmed — otherwise those
    // floors vanish with no summary standing in for them (silent amnesia when the plugin is
    // enabled on an old chat without migration, or over residual floors after migration).
    // Leave them to ST's native token truncation, i.e. behave as before install.
    const baseline = data.progress?.baseline_pair ?? -1;
    const chapterRanges = (data.chapters || [])
        .filter(c => Array.isArray(c.floor_range))
        .map(c => c.floor_range);
    const isRepresented = (pairIndex) =>
        chapterRanges.some(([a, b]) => pairIndex >= a && pairIndex <= b);
    const keepUnrepresented = (pairIndex) =>
        pairIndex <= baseline && !isRepresented(pairIndex);

    const pairedMes = new Set();
    const keepKeys = new Set();
    let minKeepIdx = Infinity;

    for (const p of pairs) {
        pairedMes.add(p.user);
        if (p.ai) {
            pairedMes.add(p.ai);
        }
        if (p.pairIndex >= startPair) {
            keepKeys.add(p.userKey);
            if (p.aiKey) {
                keepKeys.add(p.aiKey);
            }
        }
    }

    for (let i = 0; i < chat.length; i++) {
        const mes = chat[i];
        const paired = pairs.find(p => p.user === mes || p.ai === mes);
        if (paired && paired.pairIndex >= startPair) {
            minKeepIdx = Math.min(minKeepIdx, i);
        }
    }

    let firstUserIdx = chat.findIndex(m => m.is_user);
    if (firstUserIdx < 0) {
        firstUserIdx = 0;
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const mes = chat[i];
        const key = mes.extra?.layered_memory_id || messageStableKey(mes);
        const paired = pairs.find(p => p.user === mes || p.ai === mes);
        const stable = paired ? (mes.is_user ? paired.userKey : paired.aiKey) : key;

        if (keepKeys.has(stable) || keepKeys.has(key)) {
            continue;
        }

        if (i < firstUserIdx) {
            continue;
        }

        // No upper bound: keep trailing unpaired AI after the last paired message
        if (!pairedMes.has(mes) && minKeepIdx !== Infinity && i >= minKeepIdx) {
            continue;
        }

        // Pre-baseline floors with no chapter representation: leave to ST native truncation
        if (paired && keepUnrepresented(paired.pairIndex)) {
            continue;
        }

        chat.splice(i, 1);
    }
}
