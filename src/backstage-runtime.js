import {
    BACKSTAGE_MARKER_EXTRA,
    appendBackstageMessage,
    backstageMarkerMeta,
    backstageOutputMeta,
    closeBackstageSessions,
    createBackstageRevision,
    createBackstageSession,
    ensureBackstageState,
    formatBackstageDiscussionPrompt,
    formatBackstagePlayerInput,
    getBackstageRevision,
    getBackstageSession,
    isBackstageMarker,
    markBackstageMarkerMessage,
    markBackstageOutputMessage,
    markerDisplayText,
    setBackstageComposerDraft,
    setBackstageWorkingCopy,
} from './backstage.js';
import { ensureMessageIds, getActiveMesText, messageStableKey } from './ids.js';
import { getChatData, getContext, saveChatData, saveChatMessages } from './settings.js';
import { estimateTokens } from './tokens.js';

const subscribers = new Set();
let discussionInFlight = false;
let pendingSubmission = null;

function notify() {
    const detail = getBackstageSnapshot();
    for (const subscriber of subscribers) subscriber(detail);
    globalThis.dispatchEvent?.(new CustomEvent('layered-memory:backstage-changed', { detail }));
}

function clone(value) {
    return structuredClone(value);
}

function dispatchInput(element) {
    element?.dispatchEvent?.(new Event('input', { bubbles: true }));
}

function currentChatAnchor() {
    const chat = getContext().chat || [];
    const last = chat.at(-1);
    return last ? messageStableKey(last) : null;
}

function activeSession() {
    const data = getChatData();
    const state = ensureBackstageState(data);
    return getBackstageSession(data, state.activeSessionId);
}

function activeWorkingSession() {
    const session = activeSession();
    return session?.working ? session : null;
}

function findMessageIndexByKey(messageKey) {
    return (getContext().chat || []).findIndex(message => messageStableKey(message) === messageKey);
}

function pendingRevision(data = getChatData()) {
    const pending = ensureBackstageState(data).pendingGeneration;
    if (!pending) return {};
    const session = getBackstageSession(data, pending.sessionId);
    const revision = getBackstageRevision(session, pending.revisionId);
    return { pending, session, revision };
}

function cleanModelReply(value) {
    return String(value ?? '').trim();
}

function hostIsGenerating() {
    return globalThis.document?.body?.dataset?.generating === 'true';
}

async function restoreInterruptedSwipe() {
    const context = getContext();
    const message = context.chat?.at(-1);
    if (!message || message.is_user || !Array.isArray(message.swipes) || !message.swipes.length) return false;
    if (!Number.isInteger(message.swipe_id) || message.swipe_id < message.swipes.length) return false;
    const restoredId = message.swipes.length - 1;
    const info = message.swipe_info?.[restoredId];
    message.swipe_id = restoredId;
    message.mes = message.swipes[restoredId];
    if (info?.send_date) message.send_date = info.send_date;
    if (info?.gen_started) message.gen_started = info.gen_started;
    if (info?.gen_finished) message.gen_finished = info.gen_finished;
    if (info?.extra) message.extra = clone(info.extra);
    await saveChatMessages();
    context.addOneMessage?.(message, { type: 'swipe' });
    return true;
}

export function subscribeBackstage(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
}

export function getBackstageSnapshot() {
    const data = getChatData();
    const state = ensureBackstageState(data);
    const session = getBackstageSession(data, state.activeSessionId);
    return {
        session: session ? clone(session) : null,
        discussionInFlight,
        pendingGeneration: state.pendingGeneration ? clone(state.pendingGeneration) : null,
    };
}

export async function beginBackstageSession({ messageIndex = null } = {}) {
    const data = getChatData();
    const state = ensureBackstageState(data);
    const chat = getContext().chat || [];
    if (Number.isInteger(messageIndex)) {
        const source = chat[messageIndex];
        const output = backstageOutputMeta(source);
        if (!output) throw new Error('这条回复没有关联的幕间讨论');
        const session = getBackstageSession(data, output.sessionId);
        const revision = getBackstageRevision(session, output.revisionId);
        if (!session || !revision) throw new Error('这次幕间讨论已经无法读取');
        if (messageIndex !== chat.length - 1) throw new Error('剧情已经继续，只能查看这次幕间讨论');
        setBackstageWorkingCopy(data, session.id, {
            baseRevisionId: revision.id,
            messages: revision.messages,
            rejectedDraft: getActiveMesText(source),
        });
        state.activeSessionId = session.id;
        await saveChatData(data);
        notify();
        return clone(session);
    }

    const existing = activeWorkingSession();
    const anchor = currentChatAnchor();
    if (existing && (existing.anchorMessageKey === anchor || existing.markerMessageKey === anchor)) {
        notify();
        return clone(existing);
    }
    const session = createBackstageSession(data, { anchorMessageKey: anchor });
    await saveChatData(data);
    notify();
    return clone(session);
}

export async function appendBackstageUserMessage(text) {
    const data = getChatData();
    const session = activeWorkingSession();
    if (!session) throw new Error('先打开幕间窗口');
    const message = appendBackstageMessage(data, session.id, 'user', text);
    await saveChatData(data);
    notify();
    return clone(message);
}

export async function saveBackstageComposerDraft(text) {
    const data = getChatData();
    const session = activeWorkingSession();
    if (!session || !setBackstageComposerDraft(data, session.id, text)) return false;
    await saveChatData(data);
    return true;
}

export async function requestBackstageNarratorReply() {
    const data = getChatData();
    const session = activeWorkingSession();
    if (!session?.working?.messages?.length) throw new Error('先写下想对叙述者说的话');
    if (session.working.messages.at(-1)?.role !== 'user') throw new Error('叙述者已经回应了这句话');
    const context = getContext();
    if (hostIsGenerating() && !discussionInFlight) {
        throw new Error('酒馆正在生成正文，请等这一轮结束后再询问叙述者');
    }
    if (typeof context.generateQuietPrompt !== 'function') {
        throw new Error('当前 SillyTavern 版本没有提供幕间所需的主模型调用接口');
    }
    discussionInFlight = true;
    notify();
    try {
        const text = cleanModelReply(await context.generateQuietPrompt({
            quietPrompt: formatBackstageDiscussionPrompt(session, { narratorName: context.name2 || '叙述者' }),
            quietToLoud: true,
            skipWIAN: false,
            quietName: context.name2 || '叙述者',
            removeReasoning: true,
        }));
        if (!text) throw new Error('叙述者没有返回可显示的内容');
        const message = appendBackstageMessage(data, session.id, 'narrator', text);
        await saveChatData(data);
        return clone(message);
    } finally {
        discussionInFlight = false;
        notify();
    }
}

export function backstageInputTokenEstimate() {
    const session = activeWorkingSession();
    if (!session?.working?.messages?.length) return 0;
    const preview = {
        messages: session.working.messages,
        rejectedDraft: session.working.rejectedDraft,
    };
    return estimateTokens(formatBackstagePlayerInput(preview));
}

async function restoreTextarea(textarea, originalValue) {
    if (!textarea) return;
    if (!textarea.value || textarea.value === pendingSubmission?.prompt) {
        textarea.value = originalValue;
        dispatchInput(textarea);
    }
}

async function generateFromExistingMarker(session, revision) {
    const context = getContext();
    const markerIndex = findMessageIndexByKey(session.markerMessageKey);
    const marker = context.chat?.[markerIndex];
    if (!marker || !isBackstageMarker(marker)) throw new Error('找不到这次幕间讨论在聊天中的输入');
    marker.mes = formatBackstagePlayerInput(revision);
    markBackstageMarkerMessage(marker, session, revision);
    revision.markerMessageKey = messageStableKey(marker);
    await saveChatMessages();
    await context.eventSource?.emit?.(context.event_types?.MESSAGE_EDITED || context.eventTypes?.MESSAGE_EDITED, markerIndex);

    const last = context.chat.at(-1);
    if (last === marker) {
        return context.generate('normal', { automatic_trigger: true });
    }
    if (!last || last.is_user) throw new Error('只能重写当前最后一条叙述者回复');
    if (!Array.isArray(last.swipes)) {
        last.swipe_id = 0;
        last.swipes = [String(last.mes ?? '')];
        last.swipe_info = [{
            send_date: last.send_date,
            gen_started: last.gen_started,
            gen_finished: last.gen_finished,
            extra: clone(last.extra || {}),
        }];
    }
    const currentSwipe = Number.isInteger(last.swipe_id) ? last.swipe_id : 0;
    if (last.swipes[currentSwipe] == null) last.swipes[currentSwipe] = String(last.mes ?? '');
    if (!Array.isArray(last.swipe_info)) last.swipe_info = [];
    if (!last.swipe_info[currentSwipe]) {
        last.swipe_info[currentSwipe] = {
            send_date: last.send_date,
            gen_started: last.gen_started,
            gen_finished: last.gen_finished,
            extra: clone(last.extra || {}),
        };
    }
    last.swipe_id = last.swipes.length;
    markBackstageOutputMessage(last, session.id, revision.id);
    return context.generate('swipe');
}

export async function continueBackstageToStory() {
    const data = getChatData();
    const session = activeWorkingSession();
    if (!session) throw new Error('没有正在进行的幕间讨论');
    if (!session.working.messages.some(message => message.role === 'narrator')) {
        throw new Error('先让叙述者回应，再继续剧情');
    }
    if (hostIsGenerating()) throw new Error('酒馆正在生成，请等这一轮结束后再继续');
    const context = getContext();
    if (typeof context.generate !== 'function') throw new Error('当前 SillyTavern 版本没有提供正文生成接口');
    const textarea = session.markerMessageKey ? null : document.querySelector('#send_textarea');
    if (!session.markerMessageKey && !textarea) throw new Error('找不到 SillyTavern 玩家输入框');

    const revision = createBackstageRevision(data, session.id);
    const state = ensureBackstageState(data);
    state.pendingGeneration = {
        sessionId: session.id,
        revisionId: revision.id,
        startedAt: Date.now(),
    };
    await saveChatData(data);
    notify();

    if (session.markerMessageKey) {
        try {
            return await generateFromExistingMarker(session, revision);
        } catch (error) {
            await restoreInterruptedSwipe();
            revision.status = 'interrupted';
            state.pendingGeneration = null;
            await saveChatData(data);
            notify();
            throw error;
        }
    }

    const originalValue = textarea.value;
    const prompt = formatBackstagePlayerInput(revision);
    pendingSubmission = { sessionId: session.id, revisionId: revision.id, prompt };
    textarea.value = prompt;
    dispatchInput(textarea);
    try {
        return await context.generate('normal');
    } catch (error) {
        revision.status = 'interrupted';
        state.pendingGeneration = null;
        await saveChatData(data);
        notify();
        throw error;
    } finally {
        await restoreTextarea(textarea, originalValue);
        pendingSubmission = null;
    }
}

export async function handleBackstageMessageSent(messageIndex) {
    const data = getChatData();
    const state = ensureBackstageState(data);
    const message = getContext().chat?.[messageIndex];
    if (!message) return false;
    const pending = pendingSubmission || state.pendingGeneration;
    if (pending && pendingSubmission) {
        const session = getBackstageSession(data, pending.sessionId);
        const revision = getBackstageRevision(session, pending.revisionId);
        if (!session || !revision) return false;
        markBackstageMarkerMessage(message, session, revision);
        ensureMessageIds();
        session.markerMessageKey = messageStableKey(message);
        revision.markerMessageKey = session.markerMessageKey;
        session.updatedAt = Date.now();
        await saveChatData(data);
        notify();
        return true;
    }
    if (!isBackstageMarker(message)) {
        closeBackstageSessions(data);
        state.pendingGeneration = null;
        await saveChatData(data);
        notify();
    }
    return false;
}

export async function handleBackstageGenerationStarted(type, isDryRun = false) {
    if (isDryRun || type !== 'swipe') return;
    const data = getChatData();
    const state = ensureBackstageState(data);
    if (state.pendingGeneration) return;
    const last = getContext().chat?.at(-1);
    const output = backstageOutputMeta(last);
    if (!output) return;
    const session = getBackstageSession(data, output.sessionId);
    const revision = getBackstageRevision(session, output.revisionId);
    if (!session || !revision) return;
    state.pendingGeneration = {
        sessionId: session.id,
        revisionId: revision.id,
        startedAt: Date.now(),
        nativeSwipe: true,
    };
    await saveChatData(data);
    notify();
}

export async function handleBackstageMessageReceived(messageIndex, type) {
    if (!['normal', 'swipe', undefined, null].includes(type)) return false;
    const data = getChatData();
    const state = ensureBackstageState(data);
    const { pending, session, revision } = pendingRevision(data);
    const message = getContext().chat?.[messageIndex];
    if (!pending || !session || !revision || !message || message.is_user) return false;
    const text = getActiveMesText(message).trim();
    if (!text || text === '...') return false;
    markBackstageOutputMessage(message, session.id, revision.id);
    ensureMessageIds();
    revision.targetMessageKey = messageStableKey(message);
    revision.status = 'generated';
    session.status = 'generated';
    session.working = null;
    session.updatedAt = Date.now();
    state.activeSessionId = null;
    state.pendingGeneration = null;
    await saveChatData(data);
    notify();
    return true;
}

export async function handleBackstageGenerationStopped({ includeDiscussion = true } = {}) {
    const data = getChatData();
    const state = ensureBackstageState(data);
    if (!state.pendingGeneration && (!includeDiscussion || !discussionInFlight)) return false;
    const { revision } = pendingRevision(data);
    if (revision?.status === 'pending') revision.status = 'interrupted';
    state.pendingGeneration = null;
    if (includeDiscussion) discussionInFlight = false;
    await saveChatData(data);
    notify();
    return true;
}

export function backstageSessionForMessage(messageIndex) {
    const data = getChatData();
    const message = getContext().chat?.[messageIndex];
    const marker = backstageMarkerMeta(message);
    const output = backstageOutputMeta(message);
    const meta = output || marker;
    if (!meta) return null;
    const session = getBackstageSession(data, meta.sessionId);
    const revision = getBackstageRevision(session, meta.revisionId);
    return session && revision ? { session: clone(session), revision: clone(revision), output: Boolean(output) } : null;
}

export function isBackstageDiscussionInFlight() {
    return discussionInFlight;
}

export { BACKSTAGE_MARKER_EXTRA, markerDisplayText };
