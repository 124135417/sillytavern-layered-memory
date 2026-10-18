import { buildTimeline, renderTimelinePrompt, annotateTimelineHistory } from './timeline.js';
import { PROMPT_KEYS, QUEUE_PRIORITY } from './constants.js';
import { getActiveMesText, getPairs, messageStableKey, messageContentFingerprint } from './ids.js';
import { inspectPresetAnchor, MEMORY_ANCHOR_MACRO, NPC_DRIVES_MACRO, NPC_DRIVES_TOKEN } from './preset-anchor.js';
import { retrieveHits } from './retrieve.js';
import { selectL1Entries, renderL2Block, renderL4Block } from './render.js';
import { enqueue } from './queue.js';
import { getChatData, getSettings } from './settings.js';
import { estimateTokens } from './tokens.js';
import { currentNarrativeSources, fallbackNarrativeSummary } from './narrative.js';
import { selectRecentRawWindow } from './recent-raw.js';
import { resolveStyleReset } from './style-reset.js';
import { renderContextContributions } from './context-contributions.js';
import { composeInjectedMemory, filterInjectedMemory, readInjectionFilter } from './injection-filter.js';

let presetMacroRegistered = false;
let activeGenerationType = null;
let activeGenerationExcludeTrailingAssistant = false;

function inferTrailingAssistantProjection(type, context = SillyTavern.getContext()) {
    if (type === 'swipe') return true;
    if (!type) return false;
    const last = context?.chat?.at?.(-1);
    return Boolean(last && !last.is_user);
}

export function setActiveGenerationType(type, { excludeTrailingAssistant } = {}) {
    activeGenerationType = typeof type === 'string' ? type : null;
    activeGenerationExcludeTrailingAssistant = typeof excludeTrailingAssistant === 'boolean'
        ? excludeTrailingAssistant
        : inferTrailingAssistantProjection(activeGenerationType);
}

export function clearActiveGenerationType() {
    activeGenerationType = null;
    activeGenerationExcludeTrailingAssistant = false;
}

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

function anchorStatus(context, token) {
    const anchor = inspectPresetAnchor(context, token);
    const supported = typeof context?.registerMacro === 'function';
    const registered = supported && presetMacroRegistered;
    return {
        ...anchor,
        supported,
        registered,
        mode: registered && anchor.state === 'active' ? 'anchor' : 'fallback',
    };
}

export function getPresetAnchorStatus(context = SillyTavern.getContext()) { return anchorStatus(context); }
export function getNpcDriveAnchorStatus(context = SillyTavern.getContext()) { return anchorStatus(context, NPC_DRIVES_TOKEN); }

export function buildCoreMemoryParts({
    data = getChatData(),
    settings = getSettings(),
    context = SillyTavern.getContext(),
    generationType = activeGenerationType,
    excludeTrailingAssistant = null,
    pairs = null,
    narrativeSources = null,
} = {}) {
    const resolvedExcludeTrailingAssistant = typeof excludeTrailingAssistant === 'boolean'
        ? excludeTrailingAssistant
        : generationType === activeGenerationType
            ? activeGenerationExcludeTrailingAssistant
            : inferTrailingAssistantProjection(generationType, context);
    const resolvedPairs = Array.isArray(pairs)
        ? pairs
        : getPairs({ excludeTrailingAssistant: resolvedExcludeTrailingAssistant });
    const resolvedNarrativeSources = Array.isArray(narrativeSources)
        ? narrativeSources
        : currentNarrativeSources({ excludeTrailingAssistant: resolvedExcludeTrailingAssistant }).map(source => ({
            ...source,
            fallbackSummary: fallbackNarrativeSummary(source),
        }));
    const trailingMessage = resolvedExcludeTrailingAssistant && !context?.chat?.at?.(-1)?.is_user ? context?.chat?.at?.(-2) : context?.chat?.at?.(-1);
    const selection = selectL1Entries(data, Number(settings.budgetL1 || 2000), context, settings, { generationType });
    const l1 = selection.factsText;
    const drives = selection.driveText;
    const styleReset = resolveStyleReset({ context, excludeTrailingAssistant: resolvedExcludeTrailingAssistant });
    const rawWindow = selectRecentRawWindow(resolvedNarrativeSources, settings.recentRawTokens, {
        minimumFloor: styleReset?.messageIndex ?? null,
    });
    const latestNarrativeFloor = resolvedNarrativeSources.at(-1)?.messageIndex;
    const maxFloor = Number.isInteger(rawWindow.startFloor)
        ? rawWindow.startFloor - 1
        : Number.isInteger(styleReset?.messageIndex)
            && (!Number.isInteger(latestNarrativeFloor) || latestNarrativeFloor < styleReset.messageIndex)
            ? styleReset.messageIndex - 1
            : null;
    const timeline = buildChatTimeline({ data, context, sources: resolvedNarrativeSources, trailingUser: !Array.isArray(narrativeSources) && trailingMessage?.is_user ? trailingMessage : null, excludeTrailingAssistant: resolvedExcludeTrailingAssistant });
    const rawL2 = renderL2Block(data, {
        forInjection: true,
        pairs: resolvedPairs,
        narrativeSources: resolvedNarrativeSources,
        maxFloor,
    });
    const l2 = settings.timelineEnabled !== false ? annotateTimelineHistory(rawL2, timeline) : rawL2;
    const authorNotes = renderContextContributions();
    return filterInjectedMemory({
        l1,
        drives,
        l2,
        authorNotes,
        raw: rawWindow.text,
        rawWindow,
        narrativeSources: resolvedNarrativeSources,
        styleReset,
        timeline,
        temporal: settings.timelineEnabled !== false ? renderTimelinePrompt(timeline, { rawFloors: rawWindow.sources.map(source => source.messageIndex) }) : '',
    }, readInjectionFilter(context));
}

export function renderCoreMemoryPayload(options = {}) {
    const { includeDrives = true, ...buildOptions } = options;
    return composeInjectedMemory(buildCoreMemoryParts(buildOptions), { includeDrives });
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
    return renderCoreMemoryPayload({ settings, generationType: activeGenerationType, includeDrives: false });
}

/** A separate author direction, outside compressed history. */
export function renderNpcDriveMacro() {
    if (!getSettings().enabled || getNpcDriveAnchorStatus().mode !== 'anchor') return '';
    return buildCoreMemoryParts({ generationType: activeGenerationType }).drives;
}

/** Optional short clock anchor for a preset's final instructions. No history duplication. */
export function renderCurrentStoryClockMacro() {
    const settings = getSettings();
    if (!settings.enabled || settings.timelineEnabled === false) return '';
    const now = buildChatTimeline().current;
    if (!now?.date) return '';
    const minute = Number.isInteger(now.minute)
        ? ` ${String(Math.floor(now.minute / 60)).padStart(2, '0')}:${String(now.minute % 60).padStart(2, '0')}` : '';
    const hour = Number.isInteger(now.minute) ? Math.floor(now.minute / 60) : null;
    const period = hour === null ? '' : hour < 6 ? '凌晨' : hour < 9 ? '早晨'
        : hour < 12 ? '上午' : hour < 13 ? '中午' : hour < 18 ? '下午' : hour < 19 ? '傍晚' : '晚上';
    const chinese = value => value < 10 ? '零一二三四五六七八九'[value]
        : `${value >= 20 ? '零一二三四五六七八九'[Math.floor(value / 10)] : ''}十${value % 10 ? '零一二三四五六七八九'[value % 10] : ''}`;
    const spokenHour = hour === null ? '' : hour === 0 ? '零' : hour % 12 === 2 ? '两' : chinese(hour % 12 || 12);
    const spoken = period ? `${period}${spokenHour}点${now.minute % 60 ? `${chinese(now.minute % 60)}分` : '整'}` : '';
    return `本轮承接时钟：${now.date}${minute}${spoken ? `（${spoken}，24小时制）` : ''}。未明确跳时不倒退；时段称呼、正文当前报时和摘要起止使用同一条时间线。正文无须报时就不额外编精确钟点。`;
}

export function registerPresetMemoryMacro() {
    const context = SillyTavern.getContext();
    if (typeof context?.registerMacro !== 'function') {
        presetMacroRegistered = false;
        console.warn('[layered-memory] 当前 SillyTavern 未提供 registerMacro，使用兼容注入');
        return false;
    }
    context.registerMacro('layered_memory_clock', () => renderCurrentStoryClockMacro(), '只插入当前分支的简短剧情时钟，适合预设末尾核对时间');
    context.registerMacro(NPC_DRIVES_MACRO, () => renderNpcDriveMacro(), '在末尾创作任务附近插入当前角色驱动力，独立于历史记忆且不重复发送');
    context.registerMacro(
        MEMORY_ANCHOR_MACRO,
        () => renderPresetMemoryMacro(),
        '在预设指定位置插入分层长程记忆的剧情回顾与当前承接状态',
    );
    presetMacroRegistered = true;
    return true;
}

export function updateInjection({
    generationType = activeGenerationType,
    excludeTrailingAssistant = null,
} = {}) {
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
    const resolvedExcludeTrailingAssistant = typeof excludeTrailingAssistant === 'boolean'
        ? excludeTrailingAssistant
        : generationType === activeGenerationType
            ? activeGenerationExcludeTrailingAssistant
            : inferTrailingAssistantProjection(generationType, context);
    const narrativeSources = currentNarrativeSources({
        excludeTrailingAssistant: resolvedExcludeTrailingAssistant,
    }).map(source => ({
        ...source,
        fallbackSummary: fallbackNarrativeSummary(source),
    }));
    const parts = buildCoreMemoryParts({
        data,
        settings,
        context,
        generationType,
        excludeTrailingAssistant: resolvedExcludeTrailingAssistant,
        pairs: getPairs({ excludeTrailingAssistant: resolvedExcludeTrailingAssistant }),
        narrativeSources,
    });
    const core = composeInjectedMemory(parts, { includeDrives: false });

    if (estimateTokens(renderL2Block(data, { forBudget: true, narrativeSources })) > (settings.budgetL2 || 5000)) {
        enqueue('volume_compress', { reason: 'budget', narrative: true }, QUEUE_PRIORITY.volume_compress);
    }
    let l4 = '';
    if (settings.l4Enabled) {
        const hits = retrieveHits(data, settings.budgetL4, {
            excludeTrailingAssistant: resolvedExcludeTrailingAssistant,
        });
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
    // Explicit preset placement wins; otherwise use the nearest native history depth.
    setExtensionPrompt(PROMPT_KEYS.DRIVES, getNpcDriveAnchorStatus(context).mode === 'anchor' ? '' : parts.drives, IN_CHAT, 0, false, SYSTEM);
    return anchor;
}

export function buildChatTimeline({ data = getChatData(), context = SillyTavern.getContext(), sources = null, trailingUser = null, excludeTrailingAssistant = null } = {}) {
    const last = context?.chat?.at?.(-1);
    const skip = excludeTrailingAssistant ?? Boolean(activeGenerationType && last && !last.is_user);
    let visible = sources || currentNarrativeSources({ includeTrailingUser: true, excludeTrailingAssistant: skip });
    if (trailingUser && !visible.some(source => source.messageKey === messageStableKey(trailingUser))) {
        visible = [...visible, { message: trailingUser, messageKey: messageStableKey(trailingUser), contentFingerprint: messageContentFingerprint(trailingUser), messageIndex: context.chat.indexOf(trailingUser), role: 'user', text: getActiveMesText(trailingUser), narrativeText: getActiveMesText(trailingUser) }];
    }
    return buildTimeline({ sources: visible, records: data.narrative_summaries || [], corrections: data.timeline_corrections || [], incomplete: data.timeline_incomplete || [] });
}

export function isTimelineBusy() { return activeGenerationType !== null; }
