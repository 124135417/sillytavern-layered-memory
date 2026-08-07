import {
    BACKSTAGE_MARKER_EXTRA,
    appendBackstageMessage,
    backstageMarkerMeta,
    backstageOutputMeta,
    buildBackstageDiscussionRequest,
    clearBackstageWorkingCopy,
    closeBackstageSessions,
    createBackstageRevision,
    createBackstageSession,
    ensureBackstageState,
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
import { buildCoreMemoryParts } from './inject.js';
import { getChatData, getContext, saveChatData, saveChatMessages } from './settings.js';
import { estimateTokens } from './tokens.js';

const subscribers = new Set();
let activeDiscussion = null;
let discussionEpoch = 0;
let pendingSubmission = null;
let lastPersistenceErrorAt = 0;

function queueBackstageSave(data) {
    const pending = saveChatData(data).catch(error => {
        if (error?.code === 'CHAT_SCOPE_CHANGED') return false;
        console.error('[layered-memory] 幕间状态后台保存失败', error);
        const now = Date.now();
        if (now - lastPersistenceErrorAt > 5_000) {
            lastPersistenceErrorAt = now;
            globalThis.toastr?.error?.(`幕间状态保存失败：${error?.message ?? error}`);
        }
        return false;
    });
    return pending;
}

function discussionIsCurrent(request) {
    return Boolean(
        request
        && activeDiscussion === request
        && request.epoch === discussionEpoch
        && request.data === getChatData(),
    );
}

function invalidateDiscussion({ stop = false, notifyChange = true } = {}) {
    const request = activeDiscussion;
    discussionEpoch += 1;
    activeDiscussion = null;
    if (notifyChange) notify();
    if (stop && request) {
        try {
            getContext().stopGeneration?.();
        } catch (error) {
            console.warn('[layered-memory] 无法停止已经失效的幕间请求', error);
        }
    }
    return Boolean(request);
}

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
    if (activeDiscussion && activeDiscussion.data !== data) {
        discussionEpoch += 1;
        activeDiscussion = null;
    }
    const state = ensureBackstageState(data);
    const session = getBackstageSession(data, state.activeSessionId);
    return {
        session: session ? clone(session) : null,
        discussionInFlight: Boolean(activeDiscussion),
        pendingGeneration: state.pendingGeneration ? clone(state.pendingGeneration) : null,
    };
}

export function beginBackstageSession({ messageIndex = null } = {}) {
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
        notify();
        void queueBackstageSave(data);
        return clone(session);
    }

    const existing = activeWorkingSession();
    const anchor = currentChatAnchor();
    if (existing && (existing.anchorMessageKey === anchor || existing.markerMessageKey === anchor)) {
        notify();
        return clone(existing);
    }
    const session = createBackstageSession(data, { anchorMessageKey: anchor });
    notify();
    void queueBackstageSave(data);
    return clone(session);
}

export function appendBackstageUserMessage(text) {
    const data = getChatData();
    const session = activeWorkingSession();
    if (!session) throw new Error('先打开幕间窗口');
    const message = appendBackstageMessage(data, session.id, 'user', text);
    notify();
    void queueBackstageSave(data);
    return clone(message);
}

export function saveBackstageComposerDraft(text) {
    const data = getChatData();
    const session = activeWorkingSession();
    if (!session || !setBackstageComposerDraft(data, session.id, text)) return false;
    void queueBackstageSave(data);
    return true;
}

async function runBackstageNarratorReply(request) {
    const { data, sessionId, userMessageId, context } = request;
    try {
        const session = getBackstageSession(data, sessionId);
        const { l2, raw } = buildCoreMemoryParts({ data, context });
        const generation = buildBackstageDiscussionRequest(session, {
            narratorName: context.name2 || '叙述者',
            l2,
            raw,
        });
        const text = cleanModelReply(await context.generateRaw(generation));
        if (!discussionIsCurrent(request)) return null;
        if (!text) throw new Error('叙述者没有返回可显示的内容');
        const currentSession = getBackstageSession(data, sessionId);
        if (!currentSession?.working || currentSession.working.messages.at(-1)?.id !== userMessageId) {
            return null;
        }
        const message = appendBackstageMessage(data, sessionId, 'narrator', text);
        void queueBackstageSave(data);
        return clone(message);
    } catch (error) {
        if (!discussionIsCurrent(request)) return null;
        throw error;
    } finally {
        if (activeDiscussion === request) {
            activeDiscussion = null;
            notify();
        }
    }
}

function startBackstageNarratorReply({ userText = null } = {}) {
    if (isBackstageDiscussionInFlight()) return activeDiscussion.promise;
    const data = getChatData();
    const session = activeWorkingSession();
    const context = getContext();
    if (!session?.working) throw new Error('先打开幕间窗口');
    if (hostIsGenerating()) {
        throw new Error('酒馆正在生成正文，请等这一轮结束后再询问叙述者');
    }
    if (typeof context.generateRaw !== 'function') {
        throw new Error('当前 SillyTavern 版本没有提供幕间所需的主模型调用接口');
    }
    const request = {
        id: globalThis.crypto?.randomUUID?.() || `backstage-request-${Date.now()}-${discussionEpoch + 1}`,
        epoch: discussionEpoch + 1,
        data,
        sessionId: session.id,
        userMessageId: null,
        context,
        promise: null,
    };
    discussionEpoch = request.epoch;
    activeDiscussion = request;
    try {
        if (userText != null) appendBackstageMessage(data, session.id, 'user', userText);
        const latest = session.working.messages.at(-1);
        if (!latest) throw new Error('先写下想对叙述者说的话');
        if (latest.role !== 'user') throw new Error('叙述者已经回应了这句话');
        request.userMessageId = latest.id;
        request.promise = Promise.resolve().then(() => runBackstageNarratorReply(request));
        notify();
        void queueBackstageSave(data);
        return request.promise;
    } catch (error) {
        if (activeDiscussion === request) activeDiscussion = null;
        notify();
        throw error;
    }
}

export function submitBackstageUserMessage(text) {
    const value = String(text ?? '').trim();
    if (!value) throw new Error('先写下想对叙述者说的话');
    return startBackstageNarratorReply({ userText: value });
}

export function requestBackstageNarratorReply() {
    return startBackstageNarratorReply();
}

export function stopBackstageNarratorReply() {
    return invalidateDiscussion({ stop: true });
}

export function clearBackstageSession() {
    const data = getChatData();
    const session = activeWorkingSession();
    if (!session) return false;
    const stopped = activeDiscussion?.sessionId === session.id
        ? invalidateDiscussion({ stop: false, notifyChange: false })
        : false;
    const changed = clearBackstageWorkingCopy(data, session.id);
    notify();
    void queueBackstageSave(data);
    if (stopped) {
        try {
            getContext().stopGeneration?.();
        } catch (error) {
            console.warn('[layered-memory] 清空后无法停止旧幕间请求', error);
        }
    }
    return changed || stopped;
}

export function handleBackstageChatChanged() {
    pendingSubmission = null;
    return invalidateDiscussion({ stop: true });
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

function restoreTextarea(textarea, originalValue) {
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
    if (isBackstageDiscussionInFlight()) throw new Error('叙述者还在回应，请稍等片刻');
    if (!session.working.messages.some(message => message.role === 'narrator')) {
        throw new Error('先让叙述者回应，再继续剧情');
    }
    if (hostIsGenerating()) throw new Error('酒馆正在生成，请等这一轮结束后再继续');
    const context = getContext();
    if (typeof context.generate !== 'function') throw new Error('当前 SillyTavern 版本没有提供正文生成接口');
    const textarea = session.markerMessageKey ? null : document.querySelector('#send_textarea');
    if (!session.markerMessageKey && !textarea) throw new Error('找不到 SillyTavern 玩家输入框');

    const state = ensureBackstageState(data);
    if (state.pendingGeneration) throw new Error('这一版剧情已经在生成');
    const revision = createBackstageRevision(data, session.id);
    state.pendingGeneration = {
        sessionId: session.id,
        revisionId: revision.id,
        startedAt: Date.now(),
    };
    notify();
    void queueBackstageSave(data);

    if (session.markerMessageKey) {
        try {
            return await generateFromExistingMarker(session, revision);
        } catch (error) {
            await restoreInterruptedSwipe();
            revision.status = 'interrupted';
            state.pendingGeneration = null;
            notify();
            void queueBackstageSave(data);
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
        notify();
        void queueBackstageSave(data);
        throw error;
    } finally {
        restoreTextarea(textarea, originalValue);
        pendingSubmission = null;
    }
}

export function handleBackstageMessageSent(messageIndex) {
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
        notify();
        void queueBackstageSave(data);
        return true;
    }
    if (!isBackstageMarker(message)) {
        closeBackstageSessions(data);
        state.pendingGeneration = null;
        notify();
        void queueBackstageSave(data);
    }
    return false;
}

export function handleBackstageGenerationStarted(type, isDryRun = false) {
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
    notify();
    void queueBackstageSave(data);
}

export function handleBackstageMessageReceived(messageIndex, type) {
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
    notify();
    void queueBackstageSave(data);
    return true;
}

export function handleBackstageGenerationStopped({ includeDiscussion = true } = {}) {
    const data = getChatData();
    const state = ensureBackstageState(data);
    const stoppedDiscussion = includeDiscussion && isBackstageDiscussionInFlight();
    if (!state.pendingGeneration && !stoppedDiscussion) return false;
    const { revision } = pendingRevision(data);
    if (revision?.status === 'pending') revision.status = 'interrupted';
    state.pendingGeneration = null;
    if (stoppedDiscussion) invalidateDiscussion({ notifyChange: false });
    notify();
    void queueBackstageSave(data);
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
    if (!activeDiscussion) return false;
    if (activeDiscussion.data !== getChatData()) {
        discussionEpoch += 1;
        activeDiscussion = null;
        return false;
    }
    return true;
}

export { BACKSTAGE_MARKER_EXTRA, markerDisplayText };
