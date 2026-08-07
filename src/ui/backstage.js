import {
    backstageInputTokenEstimate,
    backstageSessionForMessage,
    beginBackstageSession,
    clearBackstageSession,
    continueBackstageToStory,
    getBackstageSnapshot,
    isBackstageDiscussionInFlight,
    requestBackstageNarratorReply,
    saveBackstageComposerDraft,
    stopBackstageNarratorReply,
    submitBackstageUserMessage,
    subscribeBackstage,
} from '../backstage-runtime.js';
import { isBackstageMarker } from '../backstage.js';
import { getContext } from '../settings.js';

const TRIGGER_ID = 'lm-backstage-trigger';
const DIALOG_ID = 'lm-backstage-dialog';
let lastTrigger = null;
let archivedView = null;
let isComposing = false;
let draftSaveTimer = null;
let triggerRetryTimer = null;
let uiInjected = false;
let dialogReady = false;
let hydrationGeneration = 0;
let tokenEstimateGeneration = 0;
let lastOpenRequest = null;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function dialog() {
    return document.getElementById(DIALOG_ID);
}

function activeMessages(snapshot) {
    if (archivedView) return archivedView.revision.messages || [];
    return snapshot.session?.working?.messages || [];
}

function renderNarratorText(text) {
    const value = String(text ?? '');
    try {
        const context = getContext();
        if (typeof context.messageFormatting === 'function') {
            return String(context.messageFormatting(value, context.name2 || '叙述者', false, false, -1, {}, false));
        }
    } catch (error) {
        console.warn('[Layered Memory] Backstage Markdown formatting failed; using plain text.', error);
    }
    return `<span class="lm-backstage-plain-fallback">${escapeHtml(value)}</span>`;
}

export function renderBackstageMessageBody(message) {
    return message?.role === 'narrator'
        ? renderNarratorText(message.text)
        : escapeHtml(message?.text);
}

function renderMessage(message, index) {
    const narrator = message.role === 'narrator';
    const content = renderBackstageMessageBody(message);
    return `<li class="lm-backstage-turn ${narrator ? 'is-narrator' : 'is-player'}" data-message-id="${escapeHtml(message.id)}" style="--turn-index:${Math.min(index, 8)}">
        <span class="lm-backstage-speaker">${narrator ? '叙述者' : '你'}</span>
        <div class="lm-backstage-content${narrator ? '' : ' is-plain'}">${content}</div>
    </li>`;
}

function syncTranscriptList(list, messages) {
    if (!list) return;
    const existing = Array.from(list.children);
    const sharesPrefix = existing.length <= messages.length
        && existing.every((element, index) => element.dataset.messageId === messages[index]?.id);
    if (!sharesPrefix) list.replaceChildren();
    for (let index = list.children.length; index < messages.length; index += 1) {
        list.insertAdjacentHTML('beforeend', renderMessage(messages[index], index));
    }
}

function scheduleTokenEstimate({ readOnly, messages }) {
    const root = dialog();
    const token = root?.querySelector('.lm-backstage-token-count');
    const generation = ++tokenEstimateGeneration;
    if (!token) return;
    if (readOnly) {
        token.textContent = `${messages.length} 条对话`;
        return;
    }
    token.textContent = '正在估算…';
    requestAnimationFrame(() => {
        setTimeout(() => {
            if (generation !== tokenEstimateGeneration || !dialogReady || !root.open) return;
            try {
                token.textContent = `约 ${backstageInputTokenEstimate().toLocaleString('zh-CN')} token`;
            } catch {
                token.textContent = 'token 暂不可用';
            }
        }, 0);
    });
}

function renderTranscript(snapshot, { preserveScroll = false } = {}) {
    const root = dialog();
    if (!root) return;
    const session = archivedView?.session || snapshot.session;
    const revision = archivedView?.revision || null;
    const working = session?.working;
    const messages = activeMessages(snapshot);
    const readOnly = Boolean(archivedView);
    const loading = snapshot.discussionInFlight || isBackstageDiscussionInFlight();
    const scroller = root.querySelector('.lm-backstage-transcript');
    const distanceFromBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : 0;
    const list = root.querySelector('.lm-backstage-turns');
    const empty = root.querySelector('.lm-backstage-empty');
    const hydrating = root.querySelector('.lm-backstage-hydrating');
    if (hydrating) hydrating.hidden = true;
    syncTranscriptList(list, messages);
    if (empty) empty.hidden = messages.length > 0;

    const rejectedDraft = readOnly ? revision?.rejectedDraft : working?.rejectedDraft;
    const draftPanel = root.querySelector('.lm-backstage-rejected');
    if (draftPanel) {
        draftPanel.hidden = !rejectedDraft;
        const content = draftPanel.querySelector('p');
        if (content) content.textContent = rejectedDraft || '';
    }

    const mode = root.querySelector('.lm-backstage-mode');
    if (mode) mode.textContent = readOnly
        ? '这次讨论已经归档'
        : working?.baseRevisionId
            ? '上一版没有对上，继续告诉叙述者哪里需要改'
            : '剧情暂停在这里。直接说说你的想法。';

    const loadingRow = root.querySelector('.lm-backstage-thinking');
    if (loadingRow) loadingRow.hidden = !loading;
    const composer = root.querySelector('.lm-backstage-compose');
    if (composer) composer.hidden = readOnly;
    const textarea = root.querySelector('#lm-backstage-input');
    if (textarea && document.activeElement !== textarea && textarea.value !== (working?.composerDraft || '')) {
        textarea.value = working?.composerDraft || '';
    }
    if (textarea) textarea.disabled = loading;
    const send = root.querySelector('.lm-backstage-send');
    if (send) send.disabled = loading;
    const stop = root.querySelector('.lm-backstage-stop');
    if (stop) stop.hidden = !loading;
    const clear = root.querySelector('.lm-backstage-clear');
    if (clear) {
        const hasClearableContent = Boolean(
            messages.length
            || working?.composerDraft
            || working?.rejectedDraft,
        );
        clear.hidden = readOnly;
        clear.disabled = !hasClearableContent;
    }
    const continueButton = root.querySelector('.lm-backstage-continue');
    if (continueButton) {
        const hasNarratorReply = messages.some(message => message.role === 'narrator');
        continueButton.hidden = readOnly;
        continueButton.disabled = loading || !hasNarratorReply || messages.at(-1)?.role !== 'narrator';
        continueButton.textContent = working?.baseRevisionId ? '好了，重写这段' : '可以了，继续！';
    }
    scheduleTokenEstimate({ readOnly, messages });

    if (scroller) {
        if (preserveScroll && distanceFromBottom > 80) {
            scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - distanceFromBottom);
        } else {
            requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
        }
    }
}

function setError(message = '', { retryMode = 'reply', retryLabel = '重新询问' } = {}) {
    const root = dialog();
    const row = root?.querySelector('.lm-backstage-error');
    if (!row) return;
    row.hidden = !message;
    row.querySelector('span').textContent = message;
    row.dataset.retryMode = retryMode;
    const retry = row.querySelector('.lm-backstage-retry');
    if (retry) retry.textContent = retryLabel;
}

async function flushComposerDraft() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    const textarea = dialog()?.querySelector('#lm-backstage-input');
    if (dialogReady && !archivedView && textarea) await saveBackstageComposerDraft(textarea.value);
}

function scheduleDraftSave() {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
        void flushComposerDraft();
    }, 250);
}

async function sendBackstageMessage() {
    const root = dialog();
    const textarea = root?.querySelector('#lm-backstage-input');
    const text = textarea?.value.trim();
    if (!dialogReady || !text || isBackstageDiscussionInFlight()) return;
    setError('');
    try {
        const reply = submitBackstageUserMessage(text);
        if (textarea) {
            textarea.value = '';
        }
        clearTimeout(draftSaveTimer);
        draftSaveTimer = null;
        renderTranscript(getBackstageSnapshot());
        await reply;
    } catch (error) {
        setError(`叙述者没有回应：${error?.message ?? error}。刚才的话仍然保留，可以再试一次。`);
    } finally {
        renderTranscript(getBackstageSnapshot());
        textarea?.focus();
    }
}

function clearCurrentBackstage() {
    if (!dialogReady) return;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    setError('');
    const root = dialog();
    const textarea = root?.querySelector('#lm-backstage-input');
    if (textarea) textarea.value = '';
    clearBackstageSession();
    renderTranscript(getBackstageSnapshot());
    textarea?.focus();
}

async function retryBackstageReply() {
    if (isBackstageDiscussionInFlight()) return;
    setError('');
    try {
        await requestBackstageNarratorReply();
    } catch (error) {
        setError(`叙述者还是没有回应：${error?.message ?? error}。这句话仍然保留。`);
    } finally {
        renderTranscript(getBackstageSnapshot());
        dialog()?.querySelector('#lm-backstage-input')?.focus();
    }
}

function retryBackstageError() {
    const row = dialog()?.querySelector('.lm-backstage-error');
    if (row?.dataset.retryMode === 'hydrate') {
        void openBackstageDialog(lastOpenRequest || {});
        return;
    }
    void retryBackstageReply();
}

function closeBackstageDialog({ restoreFocus = true } = {}) {
    const root = dialog();
    if (!root?.open || root.classList.contains('is-closing')) return Promise.resolve();
    const shouldSaveDraft = dialogReady;
    if (shouldSaveDraft) void flushComposerDraft();
    dialogReady = false;
    hydrationGeneration += 1;
    tokenEstimateGeneration += 1;
    root.classList.add('is-closing');
    return new Promise(resolve => {
        const finish = () => {
            root.classList.remove('is-closing', 'is-open', 'is-hydrating');
            root.removeAttribute('aria-busy');
            root.close();
            if (restoreFocus) lastTrigger?.focus?.({ preventScroll: true });
            resolve();
        };
        if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) finish();
        else setTimeout(finish, 190);
    });
}

async function continueStory() {
    const root = dialog();
    const button = root?.querySelector('.lm-backstage-continue');
    if (!button || button.disabled) return;
    setError('');
    button.disabled = true;
    button.textContent = '正在回到剧情…';
    const closePromise = closeBackstageDialog({ restoreFocus: false });
    try {
        const generation = continueBackstageToStory();
        await Promise.all([closePromise, generation]);
    } catch (error) {
        await closePromise;
        globalThis.toastr?.error?.(`没有继续成功：${error?.message ?? error}`);
        await openBackstageDialog({ trigger: lastTrigger });
        if (dialogReady) {
            setError(`没有继续成功：${error?.message ?? error}。幕间讨论仍然保留。`);
        }
    }
}

function showDialogShell() {
    const root = dialog();
    if (!root) return;
    if (!root.open) root.showModal();
    root.classList.remove('is-closing');
    root.classList.add('is-open', 'is-hydrating');
    root.setAttribute('aria-busy', 'true');
    dialogReady = false;
    tokenEstimateGeneration += 1;
    setError('');
    const rejected = root.querySelector('.lm-backstage-rejected');
    if (rejected) rejected.hidden = true;
    const empty = root.querySelector('.lm-backstage-empty');
    if (empty) empty.hidden = true;
    const hydrating = root.querySelector('.lm-backstage-hydrating');
    if (hydrating) hydrating.hidden = false;
    const thinking = root.querySelector('.lm-backstage-thinking');
    if (thinking) thinking.hidden = true;
    const mode = root.querySelector('.lm-backstage-mode');
    if (mode) mode.textContent = '正在接上这段剧情…';
    const composer = root.querySelector('.lm-backstage-compose');
    if (composer) composer.hidden = false;
    const textarea = root.querySelector('#lm-backstage-input');
    if (textarea) {
        textarea.value = '';
        textarea.disabled = true;
    }
    const send = root.querySelector('.lm-backstage-send');
    if (send) send.disabled = true;
    const stop = root.querySelector('.lm-backstage-stop');
    if (stop) stop.hidden = true;
    const clear = root.querySelector('.lm-backstage-clear');
    if (clear) {
        clear.hidden = false;
        clear.disabled = true;
    }
    const continueButton = root.querySelector('.lm-backstage-continue');
    if (continueButton) {
        continueButton.hidden = false;
        continueButton.disabled = true;
        continueButton.textContent = '可以了，继续！';
    }
    const token = root.querySelector('.lm-backstage-token-count');
    if (token) token.textContent = '正在准备…';
}

function waitForFirstPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
    });
}

async function hydrateDialog({ messageIndex }, generation) {
    await waitForFirstPaint();
    const root = dialog();
    if (generation !== hydrationGeneration || !root?.open) return false;
    try {
        archivedView = null;
        if (Number.isInteger(messageIndex)) {
            const linked = backstageSessionForMessage(messageIndex);
            const isLast = messageIndex === (getContext().chat?.length || 0) - 1;
            if (!linked) throw new Error('找不到这条消息关联的幕间讨论');
            if (linked.output && isLast) beginBackstageSession({ messageIndex });
            else archivedView = linked;
        } else {
            beginBackstageSession();
        }
        if (generation !== hydrationGeneration || !root.open) return false;
        dialogReady = true;
        root.classList.remove('is-hydrating');
        root.removeAttribute('aria-busy');
        renderTranscript(getBackstageSnapshot());
        requestAnimationFrame(() => {
            if (generation !== hydrationGeneration || !root.open) return;
            const focusTarget = archivedView
                ? root.querySelector('.lm-backstage-close')
                : root.querySelector('#lm-backstage-input');
            focusTarget?.focus();
        });
        return true;
    } catch (error) {
        if (generation !== hydrationGeneration || !root.open) return false;
        root.querySelector('.lm-backstage-turns')?.replaceChildren();
        root.classList.remove('is-hydrating');
        root.removeAttribute('aria-busy');
        const hydrating = root.querySelector('.lm-backstage-hydrating');
        if (hydrating) hydrating.hidden = true;
        const mode = root.querySelector('.lm-backstage-mode');
        if (mode) mode.textContent = '这段剧情暂时没有接上';
        const token = root.querySelector('.lm-backstage-token-count');
        if (token) token.textContent = '尚未就绪';
        setError(`幕间没有准备好：${error?.message ?? error}`, {
            retryMode: 'hydrate',
            retryLabel: '重新连接',
        });
        root.querySelector('.lm-backstage-close')?.focus();
        return false;
    }
}

export async function openBackstageDialog({ messageIndex = null, trigger = null } = {}) {
    lastTrigger = trigger || document.activeElement;
    lastOpenRequest = { messageIndex, trigger: lastTrigger };
    archivedView = null;
    const generation = ++hydrationGeneration;
    showDialogShell();
    return hydrateDialog({ messageIndex }, generation);
}

function toggleExpanded(button) {
    const root = dialog();
    const expanded = root?.classList.toggle('is-expanded');
    button.setAttribute('aria-pressed', String(Boolean(expanded)));
    button.setAttribute('aria-label', expanded ? '缩小幕间窗口' : '展开幕间窗口');
    button.title = expanded ? '缩小窗口' : '展开窗口';
}

function makeDialog() {
    const root = document.createElement('dialog');
    root.id = DIALOG_ID;
    root.className = 'lm-backstage-dialog';
    root.setAttribute('aria-labelledby', 'lm-backstage-title');
    root.innerHTML = `
        <section class="lm-backstage-frame">
            <header class="lm-backstage-header">
                <div class="lm-backstage-mark" aria-hidden="true"><span></span><i class="fa-solid fa-masks-theater"></i></div>
                <div class="lm-backstage-heading">
                    <span class="lm-backstage-kicker">BACKSTAGE · 幕间</span>
                    <h2 id="lm-backstage-title">和叙述者说说</h2>
                    <p class="lm-backstage-mode">剧情暂停在这里。直接说说你的想法。</p>
                </div>
                <div class="lm-backstage-window-actions">
                    <button type="button" class="lm-backstage-clear" disabled>清空本次幕间</button>
                    <button type="button" class="lm-backstage-icon lm-backstage-expand fa-solid fa-expand" aria-label="展开幕间窗口" aria-pressed="false" title="展开窗口"></button>
                    <button type="button" class="lm-backstage-icon lm-backstage-close fa-solid fa-xmark" aria-label="关闭幕间窗口" title="关闭窗口"></button>
                </div>
            </header>
            <main class="lm-backstage-transcript">
                <div class="lm-backstage-hydrating" role="status" aria-live="polite" hidden>
                    <span class="lm-backstage-hydrating-mark" aria-hidden="true"><i class="fa-solid fa-masks-theater"></i></span>
                    <span>正在接上这段剧情…</span>
                </div>
                <details class="lm-backstage-rejected" hidden>
                    <summary>上一版正文</summary>
                    <p></p>
                </details>
                <div class="lm-backstage-empty">
                    <span>剧情已经暂停</span>
                    <p>问清刚才发生了什么，或者直接告诉叙述者下一段想要怎样的感觉。</p>
                </div>
                <ol class="lm-backstage-turns" aria-live="polite" aria-relevant="additions"></ol>
                <div class="lm-backstage-thinking" role="status" aria-live="polite" hidden>
                    <span class="lm-backstage-thinking-label">叙述者正在回应</span>
                    <span class="lm-backstage-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                </div>
            </main>
            <footer class="lm-backstage-footer">
                <div class="lm-backstage-compose">
                    <label class="sr-only" for="lm-backstage-input">对叙述者说</label>
                    <textarea id="lm-backstage-input" rows="2" placeholder="直接和叙述者说……"></textarea>
                    <button type="button" class="lm-backstage-send fa-solid fa-arrow-up" aria-label="发送给叙述者" title="发送"></button>
                    <button type="button" class="lm-backstage-stop fa-solid fa-stop" aria-label="停止叙述者回应" title="停止回应" hidden></button>
                </div>
                <div class="lm-backstage-error" role="alert" hidden>
                    <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
                    <span></span>
                    <button type="button" class="lm-backstage-retry">重新询问</button>
                </div>
                <div class="lm-backstage-actions">
                    <span class="lm-backstage-token-count">约 0 token</span>
                    <button type="button" class="lm-backstage-continue" disabled>可以了，继续！</button>
                </div>
            </footer>
        </section>`;
    document.body.appendChild(root);

    root.addEventListener('cancel', event => {
        event.preventDefault();
        void closeBackstageDialog();
    });
    root.querySelector('.lm-backstage-close')?.addEventListener('click', () => closeBackstageDialog());
    root.querySelector('.lm-backstage-expand')?.addEventListener('click', event => toggleExpanded(event.currentTarget));
    root.querySelector('.lm-backstage-clear')?.addEventListener('click', clearCurrentBackstage);
    root.querySelector('.lm-backstage-send')?.addEventListener('click', sendBackstageMessage);
    root.querySelector('.lm-backstage-retry')?.addEventListener('click', retryBackstageError);
    root.querySelector('.lm-backstage-stop')?.addEventListener('click', stopBackstageNarratorReply);
    root.querySelector('.lm-backstage-continue')?.addEventListener('click', continueStory);
    const textarea = root.querySelector('#lm-backstage-input');
    textarea?.addEventListener('compositionstart', () => { isComposing = true; });
    textarea?.addEventListener('compositionend', () => { isComposing = false; });
    textarea?.addEventListener('input', scheduleDraftSave);
    textarea?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !isComposing) {
            event.preventDefault();
            void sendBackstageMessage();
        }
    });
}

function updateTriggerState() {
    const trigger = document.getElementById(TRIGGER_ID);
    if (!trigger) return;
    const context = getContext();
    const generating = document.body?.dataset?.generating === 'true'
        || isBackstageDiscussionInFlight();
    trigger.disabled = !(context.chat?.length) || generating;
    trigger.setAttribute('aria-disabled', String(trigger.disabled));
    trigger.title = trigger.disabled
        ? generating ? '生成结束后再进入幕间' : '开始聊天后可以进入幕间'
        : '暂停剧情，和叙述者说说';
}

function injectTrigger() {
    if (document.getElementById(TRIGGER_ID)) return true;
    const host = document.getElementById('leftSendForm');
    if (!host) return false;
    const trigger = document.createElement('button');
    trigger.id = TRIGGER_ID;
    trigger.type = 'button';
    trigger.className = 'lm-backstage-trigger interactable fa-solid fa-masks-theater';
    trigger.setAttribute('aria-label', '进入幕间，与叙述者说话');
    trigger.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        try {
            await openBackstageDialog({ trigger });
        } catch (error) {
            globalThis.toastr?.error?.(error?.message ?? error);
        }
    });
    host.appendChild(trigger);
    updateTriggerState();
    return true;
}

function scheduleTriggerInjection(attempt = 0) {
    clearTimeout(triggerRetryTimer);
    triggerRetryTimer = null;
    if (injectTrigger() || attempt >= 30) return;
    triggerRetryTimer = setTimeout(() => scheduleTriggerInjection(attempt + 1), 100);
}

function setMarkerAccessibility(element, marker) {
    const markerText = element?.querySelector('.mes_text');
    element?.querySelector('.lm-backstage-reopen')?.remove();
    element?.classList.toggle('lm-backstage-marker-message', marker);
    if (!markerText) return;
    if (marker) {
        markerText.setAttribute('role', 'button');
        markerText.setAttribute('tabindex', '0');
        markerText.setAttribute('aria-label', '查看这次幕间讨论');
    } else {
        markerText.removeAttribute('role');
        markerText.removeAttribute('tabindex');
        markerText.removeAttribute('aria-label');
    }
}

/**
 * Restore marker affordances once after a chat render, or update one message
 * after an explicit SillyTavern event. DOM changes never drive this function.
 */
export function refreshBackstageMarkers(messageIndex = null) {
    const context = getContext();
    const elements = Number.isInteger(messageIndex)
        ? [document.querySelector(`#chat .mes[mesid="${messageIndex}"]`)].filter(Boolean)
        : Array.from(document.querySelectorAll('#chat .mes[mesid]'));
    elements.forEach(element => {
        const index = Number(element.getAttribute('mesid'));
        setMarkerAccessibility(element, isBackstageMarker(context.chat?.[index]));
    });
}

export function refreshBackstageTriggerState() {
    updateTriggerState();
}

function messageIndexFromTarget(target) {
    const message = target.closest?.('.mes[mesid]');
    const index = Number(message?.getAttribute('mesid'));
    return Number.isInteger(index) ? index : null;
}

function activateLinkedMessage(target) {
    const index = messageIndexFromTarget(target);
    if (!Number.isInteger(index)) return;
    void openBackstageDialog({ messageIndex: index, trigger: target }).catch(error => {
        globalThis.toastr?.error?.(error?.message ?? error);
    });
}

export function injectBackstageUi() {
    if (uiInjected) {
        scheduleTriggerInjection();
        updateTriggerState();
        return;
    }
    uiInjected = true;
    if (!document.getElementById(DIALOG_ID)) makeDialog();
    scheduleTriggerInjection();
    document.body.addEventListener('click', event => {
        const marker = event.target.closest?.('.lm-backstage-marker-message .mes_text');
        if (!marker) return;
        event.preventDefault();
        event.stopPropagation();
        activateLinkedMessage(marker);
    });
    document.body.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const target = event.target.closest?.('.lm-backstage-marker-message .mes_text');
        if (!target) return;
        event.preventDefault();
        activateLinkedMessage(target);
    });
    subscribeBackstage(snapshot => {
        updateTriggerState();
        if (dialog()?.open && dialogReady && !archivedView) renderTranscript(snapshot, { preserveScroll: true });
    });
}

export { closeBackstageDialog };
