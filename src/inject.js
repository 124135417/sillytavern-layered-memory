import { PROMPT_KEYS, QUEUE_PRIORITY } from './constants.js';
import { getPairs } from './ids.js';
import { inspectPresetAnchor, MEMORY_ANCHOR_MACRO } from './preset-anchor.js';
import { retrieveHits } from './retrieve.js';
import { renderL1Block, renderL2Block, renderL4Block } from './render.js';
import { enqueue } from './queue.js';
import { getChatData, getSettings } from './settings.js';
import { estimateTokens } from './tokens.js';
import { currentNarrativeSources, fallbackNarrativeSummary } from './narrative.js';
import { selectRecentRawWindow } from './recent-raw.js';

let presetMacroRegistered = false;

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

export function getPresetAnchorStatus(context = SillyTavern.getContext()) {
    const anchor = inspectPresetAnchor(context);
    const supported = typeof context?.registerMacro === 'function';
    const registered = supported && presetMacroRegistered;
    return {
        ...anchor,
        supported,
        registered,
        mode: registered && anchor.state === 'active' ? 'anchor' : 'fallback',
    };
}

export function buildCoreMemoryParts({
    data = getChatData(),
    settings = getSettings(),
    context = SillyTavern.getContext(),
    pairs = getPairs(),
    narrativeSources = currentNarrativeSources().map(source => ({
        ...source,
        fallbackSummary: fallbackNarrativeSummary(source),
    })),
} = {}) {
    const l1 = renderL1Block(data, settings.budgetL1, context);
    const rawWindow = selectRecentRawWindow(narrativeSources, settings.recentRawTokens);
    const maxFloor = Number.isInteger(rawWindow.startFloor) ? rawWindow.startFloor - 1 : null;
    const l2 = renderL2Block(data, {
        forInjection: true,
        pairs,
        narrativeSources,
        maxFloor,
    });
    return { l1, l2, raw: rawWindow.text, rawWindow, narrativeSources };
}

export function renderCoreMemoryPayload(options = {}) {
    const { l1, l2, raw } = buildCoreMemoryParts(options);
    return [l1, l2, raw].filter(Boolean).join('\n\n');
}

export function renderPresetMemoryMacro() {
    const settings = getSettings();
    if (!settings.enabled) {
        return '';
    }
    const status = getPresetAnchorStatus();
    if (status.mode !== 'anchor') {
        return '';
    }
    return renderCoreMemoryPayload({ settings });
}

export function registerPresetMemoryMacro() {
    const context = SillyTavern.getContext();
    if (typeof context?.registerMacro !== 'function') {
        presetMacroRegistered = false;
        console.warn('[layered-memory] 当前 SillyTavern 未提供 registerMacro，使用兼容注入');
        return false;
    }
    context.registerMacro(
        MEMORY_ANCHOR_MACRO,
        () => renderPresetMemoryMacro(),
        '在预设指定位置插入分层长程记忆的剧情回顾与当前承接状态',
    );
    presetMacroRegistered = true;
    return true;
}

export function updateInjection() {
    const settings = getSettings();
    const context = SillyTavern.getContext();
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
    const narrativeSources = currentNarrativeSources().map(source => ({
        ...source,
        fallbackSummary: fallbackNarrativeSummary(source),
    }));
    const { l1, l2, raw } = buildCoreMemoryParts({
        data,
        settings,
        context,
        pairs: getPairs(),
        narrativeSources,
    });
    const core = [l1, l2, raw].filter(Boolean).join('\n\n');

    if (estimateTokens(renderL2Block(data, { forBudget: true, narrativeSources })) > (settings.budgetL2 || 5000)) {
        enqueue('volume_compress', { reason: 'budget', narrative: true }, QUEUE_PRIORITY.volume_compress);
    }
    if (estimateTokens(l1) > (settings.budgetL1 || 2000) * 0.95) {
        enqueue('state_gc', {}, QUEUE_PRIORITY.state_gc);
    }

    let l4 = '';
    if (settings.l4Enabled) {
        const hits = retrieveHits(data, settings.budgetL4);
        l4 = renderL4Block(hits, settings.budgetL4);
    }

    const IN_PROMPT = extension_prompt_types.IN_PROMPT;
    const IN_CHAT = extension_prompt_types.IN_CHAT;
    const SYSTEM = extension_prompt_roles.SYSTEM;
    const anchor = getPresetAnchorStatus(context);
    const usePresetAnchor = anchor.mode === 'anchor';

    // A preset anchor expands inside its host prompt, preserving that prompt's
    // exact text position and role. Otherwise keep the mandatory IN_PROMPT
    // fallback so presets without an anchor continue to receive core memory.
    // Keep the compatibility fallback in one prompt so facts, older summaries,
    // and recent raw floors cannot be reordered by prompt-manager keys.
    setExtensionPrompt(PROMPT_KEYS.L1, usePresetAnchor ? '' : core, IN_PROMPT, 0, false, SYSTEM);
    setExtensionPrompt(PROMPT_KEYS.L2, '', IN_PROMPT, 0, false, SYSTEM);
    setExtensionPrompt(PROMPT_KEYS.L4, l4, IN_CHAT, settings.depthL4 ?? 4, false, SYSTEM);
    return anchor;
}
