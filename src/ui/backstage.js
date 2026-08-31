import {
    backstageInputTokenEstimate,
    backstageSessionForMessage,
    beginBackstageSession,
    branchFromBackstage,
    clearBackstageSession,
    continueBackstageToStory,
    getBackstageSnapshot,
    isBackstageDiscussionInFlight,
    listBackstageRecords,
    prepareBackstageCarryover,
    requestBackstageNarratorReply,
    saveBackstageCarryoverRequested,
    saveBackstageCarryoverText,
    saveBackstageComposerDraft,
    stopBackstageCarryover,
    stopBackstageNarratorReply,
    submitBackstageUserMessage,
    subscribeBackstage,
} from '../backstage-runtime.js';
import { isBackstageMarker } from '../backstage.js';
import { getContext } from '../settings.js';

const TRIGGER_ID = 'lm-backstage-trigger';
const DIALOG_ID = 'lm-backstage-dialog';
const COMPOSER_MIN_HEIGHT = 44;
const COMPOSER_MAX_HEIGHT = 112;
let lastTrigger = null;
let archivedView = null;
let linkedView = null;
let historyView = false;
let isComposing = false;
let draftSaveTimer = null;
let triggerRetryTimer = null;
const markerRefreshTimers = new Map();
let uiInjected = false;
let dialogReady = false;
let hydrationGeneration = 0;
let tokenEstimateGeneration = 0;
let lastOpenRequest = null;
let viewportSyncFrame = null;

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

function resizeBackstageComposer(textarea = dialog()?.querySelector('#lm-backstage-input')) {
    if (!textarea || textarea.closest('.lm-backstage-compose')?.hidden) return;
    textarea.style.height = '0px';
    const contentHeight = textarea.scrollHeight;
    const height = Math.max(COMPOSER_MIN_HEIGHT, Math.min(COMPOSER_MAX_HEIGHT, contentHeight));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = contentHeight > COMPOSER_MAX_HEIGHT ? 'auto' : 'hidden';
}

function syncBackstageViewport() {
    viewportSyncFrame = null;
    const root = dialog();
    if (!root?.open) return;
    const viewport = globalThis.visualViewport;
    const width = viewport?.width || globalThis.innerWidth;
    const height = viewport?.height || globalThis.innerHeight;
    const offsetTop = viewport?.offsetTop || 0;
    root.style.setProperty('--lm-backstage-viewport-width', `${width}px`);
    root.style.setProperty('--lm-backstage-viewport-height', `${height}px`);
    root.style.setProperty('--lm-backstage-viewport-top', `${offsetTop}px`);
    root.classList.toggle('is-compact-viewport', height < globalThis.innerHeight - 80);
    const frame = root.querySelector('.lm-backstage-frame');
    if (frame?.scrollTop) frame.scrollTop = 0;
}

function scheduleBackstageViewportSync() {
    if (viewportSyncFrame != null) cancelAnimationFrame(viewportSyncFrame);
    viewportSyncFrame = requestAnimationFrame(syncBackstageViewport);
}

function activeMessages(snapshot) {
    if (archivedView) return archivedView.revision.messages || [];
    return snapshot.session?.working?.messages || [];
}

function formatRecordTime(value) {
    const date = new Date(Number(value) || Date.now());
    return new Intl.DateTimeFormat('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function renderBackstageHistory() {
    const root = dialog();
    const history = root?.querySelector('.lm-backstage-history');
    const list = history?.querySelector('.lm-backstage-history-list');
    const empty = history?.querySelector('.lm-backstage-history-empty');
    if (!history || !list || !empty) return;
    const records = listBackstageRecords();
    empty.hidden = records.length > 0;
    list.hidden = records.length === 0;
    list.innerHTML = records.map(record => `
        <li>
            <button type="button" class="lm-backstage-history-item" data-message-index="${record.markerIndex}">
                <span class="lm-backstage-history-meta">
                    <strong>幕间讨论 · ${record.messageCount} 条</strong>
                    <time>${escapeHtml(formatRecordTime(record.createdAt))}</time>
                </span>
                <span class="lm-backstage-history-preview">${escapeHtml(record.preview || '打开查看这次完整讨论')}</span>
                <span class="lm-backstage-history-state">${record.editable ? '仍可继续修改' : '只读记录'} <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></span>
            </button>
        </li>`).join('');
}

function renderCarryover(snapshot) {
    const root = dialog();
    const panel = root?.querySelector('.lm-backstage-carryover');
    const note = snapshot.activeCarryover;
    if (!panel) return;
    panel.hidden = !note;
    if (!note) return;
    const textarea = panel.querySelector('.lm-backstage-carryover-text');
    if (textarea && document.activeElement !== textarea && textarea.value !== note.text) {
        textarea.value = note.text;
    }
    const saving = snapshot.carryoverInFlight;
    if (textarea) textarea.disabled = saving;
    panel.querySelector('.lm-backstage-carryover-save')?.toggleAttribute('disabled', saving);
    panel.querySelector('.lm-backstage-carryover-stop')?.toggleAttribute('disabled', saving);
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
    renderCarryover(snapshot);
    const history = root.querySelector('.lm-backstage-history');
    const story = root.querySelector('.lm-backstage-story-view');
    const footer = root.querySelector('.lm-backstage-footer');
    const historyButton = root.querySelector('.lm-backstage-history-open');
    if (history) history.hidden = !historyView;
    if (story) story.hidden = historyView;
    if (footer) footer.hidden = historyView;
    if (historyButton) historyButton.textContent = historyView ? '回到当前幕间' : '幕间记录';
    if (historyView) {
        const mode = root.querySelector('.lm-backstage-mode');
        if (mode) mode.textContent = '以前商量过的内容都在这里';
        renderBackstageHistory();
        return;
    }
    const session = archivedView?.session || snapshot.session;
    const revision = archivedView?.revision || null;
    const working = session?.working;
    const messages = activeMessages(snapshot);
    const readOnly = Boolean(archivedView);
    const loading = snapshot.discussionInFlight || snapshot.carryoverInFlight || isBackstageDiscussionInFlight();
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
    if (textarea) {
        textarea.disabled = loading;
        if (!readOnly) resizeBackstageComposer(textarea);
    }
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
    const carryoverChoice = root.querySelector('.lm-backstage-carryover-choice');
    if (carryoverChoice) {
        carryoverChoice.hidden = readOnly;
        const checkbox = carryoverChoice.querySelector('input');
        if (checkbox) {
            checkbox.checked = Boolean(working?.carryoverRequested);
            checkbox.disabled = loading;
        }
    }
    const branchButton = root.querySelector('.lm-backstage-branch');
    if (branchButton) {
        branchButton.hidden = !linkedView || linkedView.markerIndex < 0;
        branchButton.disabled = loading;
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
            resizeBackstageComposer(textarea);
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
    if (textarea) {
        textarea.value = '';
        resizeBackstageComposer(textarea);
    }
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
            root.classList.remove('is-closing', 'is-open', 'is-hydrating', 'is-compact-viewport');
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
    try {
        const snapshot = getBackstageSnapshot();
        if (snapshot.session?.working?.carryoverRequested) {
            button.textContent = '正在整理后续约定…';
            await prepareBackstageCarryover();
            if (!dialog()?.open || !dialogReady) return;
            button.textContent = '正在回到剧情…';
        }
        const closePromise = closeBackstageDialog({ restoreFocus: false });
        const generation = continueBackstageToStory();
        await Promise.all([closePromise, generation]);
    } catch (error) {
        globalThis.toastr?.error?.(`没有继续成功：${error?.message ?? error}`);
        if (!dialog()?.open) await openBackstageDialog({ trigger: lastTrigger });
        if (dialogReady) setError(`没有继续成功：${error?.message ?? error}。幕间讨论仍然保留。`);
        renderTranscript(getBackstageSnapshot());
    }
}

function toggleHistoryView() {
    if (!dialogReady) return;
    setError('');
    if (!historyView) {
        historyView = true;
        archivedView = null;
        linkedView = null;
        renderTranscript(getBackstageSnapshot());
        return;
    }
    historyView = false;
    archivedView = null;
    linkedView = null;
    beginBackstageSession();
    renderTranscript(getBackstageSnapshot());
    dialog()?.querySelector('#lm-backstage-input')?.focus();
}

function saveCarryoverText() {
    const textarea = dialog()?.querySelector('.lm-backstage-carryover-text');
    try {
        saveBackstageCarryoverText(textarea?.value || '');
        globalThis.toastr?.success?.('后续约定已更新');
    } catch (error) {
        setError(`没有保存后续约定：${error?.message ?? error}`);
    }
}

function stopCarryover() {
    if (!stopBackstageCarryover()) return;
    globalThis.toastr?.info?.('后续约定已停止生效');
    renderTranscript(getBackstageSnapshot());
}

async function branchLinkedBackstage() {
    const markerIndex = linkedView?.markerIndex;
    if (!Number.isInteger(markerIndex) || markerIndex < 0) return;
    const button = dialog()?.querySelector('.lm-backstage-branch');
    if (button) {
        button.disabled = true;
        button.textContent = '正在创建分支…';
    }
    try {
        await closeBackstageDialog({ restoreFocus: false });
        const fileName = await branchFromBackstage(markerIndex);
        globalThis.toastr?.success?.(`已从这次幕间创建分支：${fileName}`);
    } catch (error) {
        globalThis.toastr?.error?.(`没有创建成功：${error?.message ?? error}`);
        await openBackstageDialog({ messageIndex: markerIndex, trigger: lastTrigger });
    }
}

function showDialogShell() {
    const root = dialog();
    if (!root) return;
    if (!root.open) root.showModal();
    syncBackstageViewport();
    root.classList.remove('is-closing');
    root.classList.add('is-open', 'is-hydrating');
    root.setAttribute('aria-busy', 'true');
    dialogReady = false;
    tokenEstimateGeneration += 1;
    setError('');
    const rejected = root.querySelector('.lm-backstage-rejected');
    if (rejected) rejected.hidden = true;
    const carryover = root.querySelector('.lm-backstage-carryover');
    if (carryover) carryover.hidden = true;
    const history = root.querySelector('.lm-backstage-history');
    if (history) history.hidden = true;
    const story = root.querySelector('.lm-backstage-story-view');
    if (story) story.hidden = false;
    const footer = root.querySelector('.lm-backstage-footer');
    if (footer) footer.hidden = false;
    const historyButton = root.querySelector('.lm-backstage-history-open');
    if (historyButton) historyButton.textContent = '幕间记录';
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
        resizeBackstageComposer(textarea);
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
    const branchButton = root.querySelector('.lm-backstage-branch');
    if (branchButton) {
        branchButton.hidden = true;
        branchButton.disabled = false;
        branchButton.textContent = '从这次幕间分支';
    }
    const carryoverChoice = root.querySelector('.lm-backstage-carryover-choice');
    if (carryoverChoice) carryoverChoice.hidden = false;
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
        linkedView = null;
        historyView = false;
        if (Number.isInteger(messageIndex)) {
            const linked = backstageSessionForMessage(messageIndex);
            if (!linked) throw new Error('找不到这条消息关联的幕间讨论');
            linkedView = linked;
            if (linked.editable) beginBackstageSession({ messageIndex });
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
            scheduleBackstageViewportSync();
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
    linkedView = null;
    historyView = false;
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
                    <button type="button" class="lm-backstage-history-open">幕间记录</button>
                    <button type="button" class="lm-backstage-clear" disabled>清空本次幕间</button>
                    <button type="button" class="lm-backstage-icon lm-backstage-expand fa-solid fa-expand" aria-label="展开幕间窗口" aria-pressed="false" title="展开窗口"></button>
                    <button type="button" class="lm-backstage-icon lm-backstage-close fa-solid fa-xmark" aria-label="关闭幕间窗口" title="关闭窗口"></button>
                </div>
            </header>
            <details class="lm-backstage-carryover" hidden>
                <summary>
                    <span><i class="fa-solid fa-thumbtack" aria-hidden="true"></i> 后续约定 · 正在生效</span>
                    <span class="lm-backstage-carryover-hint">展开查看或修改</span>
                </summary>
                <div class="lm-backstage-carryover-editor">
                    <label for="lm-backstage-carryover-text">这些方向会持续影响后续正文，但不属于剧情事实</label>
                    <textarea id="lm-backstage-carryover-text" class="lm-backstage-carryover-text" rows="5"></textarea>
                    <div class="lm-backstage-carryover-actions">
                        <button type="button" class="lm-backstage-carryover-stop">停止生效</button>
                        <button type="button" class="lm-backstage-carryover-save">保存修改</button>
                    </div>
                </div>
            </details>
            <main class="lm-backstage-transcript">
                <section class="lm-backstage-history" hidden>
                    <div class="lm-backstage-history-intro">
                        <span class="lm-backstage-history-mark" aria-hidden="true"><i class="fa-solid fa-box-archive"></i></span>
                        <div><strong>以前的幕间没有消失</strong><p>打开任意一次记录，可以查看完整讨论或从那里另开一条剧情线。</p></div>
                    </div>
                    <p class="lm-backstage-history-empty" hidden>这个聊天里还没有已完成的幕间讨论。</p>
                    <ol class="lm-backstage-history-list"></ol>
                </section>
                <div class="lm-backstage-story-view">
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
                </div>
            </main>
            <footer class="lm-backstage-footer">
                <div class="lm-backstage-compose">
                    <label class="sr-only" for="lm-backstage-input">对叙述者说</label>
                    <textarea id="lm-backstage-input" rows="1" placeholder="直接和叙述者说……"></textarea>
                    <button type="button" class="lm-backstage-send fa-solid fa-arrow-up" aria-label="发送给叙述者" title="发送"></button>
                    <button type="button" class="lm-backstage-stop fa-solid fa-stop" aria-label="停止叙述者回应" title="停止回应" hidden></button>
                </div>
                <div class="lm-backstage-error" role="alert" hidden>
                    <i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i>
                    <span></span>
                    <button type="button" class="lm-backstage-retry">重新询问</button>
                </div>
                <div class="lm-backstage-actions">
                    <label class="lm-backstage-carryover-choice" title="把已经商量好的长期方向整理成短便签，继续影响后面的正文">
                        <input type="checkbox">
                        <span>后续仍需记住</span>
                    </label>
                    <button type="button" class="lm-backstage-branch" hidden>从这次幕间分支</button>
                    <span class="lm-backstage-token-count">约 0 token</span>
                    <button type="button" class="lm-backstage-continue" disabled>可以了，继续！</button>
                </div>
            </footer>
        </section>`;
    document.body.appendChild(root);

    globalThis.visualViewport?.addEventListener('resize', scheduleBackstageViewportSync);
    globalThis.visualViewport?.addEventListener('scroll', scheduleBackstageViewportSync);
    globalThis.addEventListener('resize', scheduleBackstageViewportSync);

    root.addEventListener('cancel', event => {
        event.preventDefault();
        void closeBackstageDialog();
    });
    root.querySelector('.lm-backstage-close')?.addEventListener('click', () => closeBackstageDialog());
    root.querySelector('.lm-backstage-expand')?.addEventListener('click', event => toggleExpanded(event.currentTarget));
    root.querySelector('.lm-backstage-history-open')?.addEventListener('click', toggleHistoryView);
    root.querySelector('.lm-backstage-clear')?.addEventListener('click', clearCurrentBackstage);
    root.querySelector('.lm-backstage-carryover-save')?.addEventListener('click', saveCarryoverText);
    root.querySelector('.lm-backstage-carryover-stop')?.addEventListener('click', stopCarryover);
    root.querySelector('.lm-backstage-send')?.addEventListener('click', sendBackstageMessage);
    root.querySelector('.lm-backstage-retry')?.addEventListener('click', retryBackstageError);
    root.querySelector('.lm-backstage-stop')?.addEventListener('click', stopBackstageNarratorReply);
    root.querySelector('.lm-backstage-branch')?.addEventListener('click', () => { void branchLinkedBackstage(); });
    root.querySelector('.lm-backstage-continue')?.addEventListener('click', continueStory);
    root.querySelector('.lm-backstage-carryover-choice input')?.addEventListener('change', event => {
        saveBackstageCarryoverRequested(event.currentTarget.checked);
    });
    root.querySelector('.lm-backstage-history-list')?.addEventListener('click', event => {
        const item = event.target.closest?.('.lm-backstage-history-item[data-message-index]');
        if (!item) return;
        const messageIndex = Number(item.dataset.messageIndex);
        if (!Number.isInteger(messageIndex)) return;
        void openBackstageDialog({ messageIndex, trigger: item });
    });
    const textarea = root.querySelector('#lm-backstage-input');
    textarea?.addEventListener('compositionstart', () => { isComposing = true; });
    textarea?.addEventListener('compositionend', () => { isComposing = false; });
    textarea?.addEventListener('input', () => {
        resizeBackstageComposer(textarea);
        scheduleDraftSave();
    });
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
    const snapshot = getBackstageSnapshot();
    const generating = document.body?.dataset?.generating === 'true'
        || isBackstageDiscussionInFlight()
        || snapshot.carryoverInFlight;
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

export function scheduleBackstageMarkerRefresh(messageIndex, attempt = 0) {
    if (!Number.isInteger(messageIndex) || messageIndex < 0) return;
    clearTimeout(markerRefreshTimers.get(messageIndex));
    markerRefreshTimers.delete(messageIndex);
    const message = getContext().chat?.[messageIndex];
    if (!isBackstageMarker(message)) return;
    const element = document.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (element) {
        setMarkerAccessibility(element, true);
        return;
    }
    if (attempt >= 12) return;
    const timer = setTimeout(() => {
        markerRefreshTimers.delete(messageIndex);
        scheduleBackstageMarkerRefresh(messageIndex, attempt + 1);
    }, Math.min(240, 24 * (attempt + 1)));
    markerRefreshTimers.set(messageIndex, timer);
}

export function scheduleBackstageMarkerRefreshes() {
    const chat = getContext().chat || [];
    chat.forEach((message, messageIndex) => {
        if (isBackstageMarker(message)) scheduleBackstageMarkerRefresh(messageIndex);
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

function linkedMarkerFromTarget(target) {
    const markerText = target.closest?.('.mes_text');
    const message = markerText?.closest?.('.mes[mesid]');
    const index = Number(message?.getAttribute('mesid'));
    if (!Number.isInteger(index) || !isBackstageMarker(getContext().chat?.[index])) return null;
    setMarkerAccessibility(message, true);
    return markerText;
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
        scheduleBackstageMarkerRefreshes();
        updateTriggerState();
        return;
    }
    uiInjected = true;
    if (!document.getElementById(DIALOG_ID)) makeDialog();
    scheduleTriggerInjection();
    scheduleBackstageMarkerRefreshes();
    document.body.addEventListener('click', event => {
        const marker = linkedMarkerFromTarget(event.target);
        if (!marker) return;
        event.preventDefault();
        event.stopPropagation();
        activateLinkedMessage(marker);
    });
    document.body.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        const target = linkedMarkerFromTarget(event.target);
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
