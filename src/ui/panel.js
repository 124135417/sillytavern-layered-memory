import { SLOT_LABELS, SLOTS } from '../constants.js';
import { listConnectionProfiles, listDirectModels, testAuxModelConnection } from '../aux-model.js';
import {
    addEvalCase,
    exportEvalCasesJson,
    listEvalCases,
    removeEvalCase,
    rerunAllEvalCases,
    rerunEvalCase,
    snapshotForPair,
} from '../eval/cases.js';
import { recordMigrationEdit } from '../eval/migrate.js';
import {
    getHistoryRebuildSnapshot,
    currentMatchingTurnSummaries,
    normalizeHistoryUserSummary,
    requestHistoryRebuildAbort,
    restoreRebuildBackup,
    retryHistoryRebuildJob,
    startHistoryRebuild,
    startHistoryRebuildChapters,
} from '../rebuild.js';
import { getPairs, getPairTexts } from '../ids.js';
import {
    dismissFailedJob,
    enqueue,
    getQueueSnapshot,
    retryFailedJob,
    setQueuePaused,
} from '../queue.js';
import { QUEUE_PRIORITY } from '../constants.js';
import { getChatData, getSettings, saveChatData, saveSettings } from '../settings.js';
import { buildCoreMemoryParts, getPresetAnchorStatus, updateInjection } from '../inject.js';
import { renderL4Block } from '../render.js';
import { retrieveHits } from '../retrieve.js';
import { estimateTokens } from '../tokens.js';
import { extractAiBody } from '../body.js';
import { recordManualEvent } from '../branch.js';
import { displayEntityName, displayNarrativeText, usableMemoryEntries } from '../quality.js';
import { markChapterStaleForTurnSummaryEdit } from '../chapter.js';
import { activateEditedFactCandidate, activateFactCandidate, dismissFactCandidate, factCandidateView } from '../facts.js';
import { openConfirmDialog, openFormDialog, openMessageDialog, openTextEditorDialog } from './dialogs.js';
import {
    FACT_STATUS_LABELS,
    FACT_VIEW_LABELS,
    factViewMeta,
    injectionPresentation,
    presetAnchorPresentation,
    taskRailPresentation,
    workflowPresentation,
} from './presentation.js';

const ROOT_ID = 'layered-memory-panel';
const DRAWER_ID = 'layered-memory-drawer';
const BACKDROP_ID = 'layered-memory-backdrop';
const SETTINGS_CARD_ID = 'layered-memory-settings-entry';
const MENU_ENTRY_ID = 'layered-memory-menu-entry';
const GEOMETRY_STYLE_ID = 'layered-memory-viewport-geometry';
let lastDrawerTrigger = null;
let lastConnectionTest = null;
let settingsDirty = false;
let currentFactView = 'active';
let hostInertSnapshot = [];

function setHostInert(inert) {
    if (inert) {
        if (hostInertSnapshot.length) return;
        const panel = document.getElementById(ROOT_ID);
        const backdrop = document.getElementById(BACKDROP_ID);
        hostInertSnapshot = [...document.body.children]
            .filter(element => element !== panel && element !== backdrop)
            .map(element => ({ element, hadInert: element.hasAttribute('inert') }));
        hostInertSnapshot.forEach(({ element }) => element.setAttribute('inert', ''));
        return;
    }
    hostInertSnapshot.forEach(({ element, hadInert }) => {
        if (!element.isConnected || hadInert) return;
        element.removeAttribute('inert');
    });
    hostInertSnapshot = [];
}

function trapPanelFocus(event, panel) {
    if (event.key !== 'Tab' || document.querySelector('dialog.lm-dialog[open]')) return;
    const focusable = [...panel.querySelectorAll([
        'a[href]', 'button:not([disabled])', 'input:not([disabled])',
        'select:not([disabled])', 'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
    ].join(','))].filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

export function injectPanel() {
    injectViewportGeometryStyle();
    if (document.getElementById(DRAWER_ID)) {
        return;
    }
    const drawer = document.createElement('div');
    drawer.id = DRAWER_ID;
    drawer.className = 'lm-drawer-shell';
    drawer.innerHTML = `
        <button type="button" class="lm-drawer-trigger drawer-icon fa-solid fa-brain fa-fw interactable"
            aria-label="打开分层长程记忆" aria-controls="${ROOT_ID}" aria-expanded="false"
            title="分层长程记忆"></button>
        <div id="${BACKDROP_ID}" class="lm-memory-backdrop" aria-hidden="true" hidden></div>
        <section id="${ROOT_ID}" class="layered-memory-root" role="dialog" aria-modal="false"
            aria-labelledby="lm-center-title" hidden>
            <header class="lm-center-header">
                <div class="lm-center-heading">
                    <span class="lm-eyebrow">当前聊天的记忆</span>
                    <div class="lm-title-line">
                        <h2 id="lm-center-title" tabindex="-1">分层长程记忆</h2>
                        <span class="lm-status-pill" data-status="idle"><span aria-hidden="true">●</span> 正常</span>
                    </div>
                    <p class="lm-chat-name">当前聊天</p>
                </div>
                <div class="lm-header-metrics" aria-label="记忆状态摘要"></div>
                <button type="button" class="lm-icon-button lm-close" aria-label="关闭记忆中心" title="关闭">×</button>
            </header>
            <nav class="lm-tabs" role="tablist" aria-label="记忆中心页面">
                <button id="lm-tab-state" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="true" data-tab="state" class="lm-tab active">当前记忆</button>
                <button id="lm-tab-turns" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="false" tabindex="-1" data-tab="turns" class="lm-tab">对话记录</button>
                <button id="lm-tab-chapters" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="false" tabindex="-1" data-tab="chapters" class="lm-tab">章节</button>
                <button id="lm-tab-review" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="false" tabindex="-1" data-tab="review" class="lm-tab">待处理 <span class="lm-tab-count" hidden></span></button>
                <button id="lm-tab-settings" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="false" tabindex="-1" data-tab="settings" class="lm-tab">设置</button>
            </nav>
            <div id="lm-tab-panel" class="lm-body" role="tabpanel" aria-labelledby="lm-tab-state" tabindex="0"></div>
        </section>
    `;

    const anchor = document.getElementById('extensions-settings-button');
    if (anchor?.parentNode) {
        anchor.insertAdjacentElement('afterend', drawer);
    } else {
        document.body.appendChild(drawer);
        drawer.classList.add('lm-floating-trigger');
    }

    // SillyTavern hides and constrains the top settings host at several
    // responsive breakpoints. Portal the fixed panel to <body>, and move the
    // launcher there too while the host is hidden on phone-sized viewports.
    const backdrop = drawer.querySelector(`#${BACKDROP_ID}`);
    const panel = drawer.querySelector(`#${ROOT_ID}`);
    if (backdrop) {
        document.body.appendChild(backdrop);
    }
    if (panel) {
        document.body.appendChild(panel);
    }
    const phoneLauncherQuery = globalThis.matchMedia?.('(max-width: 599px)');
    const placeLauncher = () => {
        if (phoneLauncherQuery?.matches || !anchor?.parentNode) {
            document.body.appendChild(drawer);
            drawer.classList.add('lm-floating-trigger');
            return;
        }
        anchor.insertAdjacentElement('afterend', drawer);
        drawer.classList.remove('lm-floating-trigger');
    };
    placeLauncher();
    phoneLauncherQuery?.addEventListener?.('change', placeLauncher);

    injectSettingsEntry();
    injectExtensionsMenuEntry();
    if (!document.getElementById(SETTINGS_CARD_ID) || !document.getElementById(MENU_ENTRY_ID)) {
        const observer = new MutationObserver(() => {
            injectSettingsEntry();
            injectExtensionsMenuEntry();
            if (document.getElementById(SETTINGS_CARD_ID) && document.getElementById(MENU_ENTRY_ID)) {
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => observer.disconnect(), 10_000);
    }

    drawer.querySelector('.lm-drawer-trigger')?.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const memoryPanel = document.getElementById(ROOT_ID);
        openMemoryCenter(memoryPanel?.hasAttribute('hidden'));
    });
    panel?.querySelector('.lm-close')?.addEventListener('click', () => openMemoryCenter(false));
    backdrop?.addEventListener('click', () => openMemoryCenter(false));
    panel?.addEventListener('keydown', event => trapPanelFocus(event, panel));

    panel?.querySelectorAll('.lm-tab').forEach(btn => {
        btn.addEventListener('click', () => selectTab(btn.dataset.tab));
        btn.addEventListener('keydown', onTabKeydown);
    });

    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape'
            && !document.querySelector('dialog.lm-dialog[open]')
            && !document.getElementById(ROOT_ID)?.hasAttribute('hidden')) {
            openMemoryCenter(false);
        }
    });
    globalThis.addEventListener?.('layered-memory:queue-changed', refreshQueueUi);

    renderShellStatus();
}

function injectViewportGeometryStyle() {
    if (document.getElementById(GEOMETRY_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = GEOMETRY_STYLE_ID;
    // Keep critical viewport geometry with the JavaScript bundle as well as the
    // external stylesheet. Some CDN/browser combinations retain an older CSS
    // asset after an extension update; stale layout CSS must never re-anchor
    // the modal to SillyTavern's right-side settings host.
    style.textContent = `
        #${ROOT_ID} {
            position: fixed !important;
            top: clamp(44px, 6vh, 72px) !important;
            right: 0 !important;
            bottom: auto !important;
            left: 0 !important;
            width: min(1120px, calc(100% - clamp(24px, 4vw, 64px))) !important;
            height: calc(100dvh - clamp(60px, 9vh, 104px)) !important;
            margin-inline: auto !important;
            transform-origin: top center !important;
        }
        @media (max-width: 899px) {
            #${ROOT_ID} {
                inset: 50px 8px auto !important;
                width: auto !important;
                height: calc(100dvh - 58px) !important;
                margin-inline: 0 !important;
            }
        }
        @media (max-width: 599px) {
            #${ROOT_ID} {
                inset: 0 !important;
                width: auto !important;
                height: 100dvh !important;
            }
        }
        @media (max-height: 520px) and (max-width: 899px) {
            #${ROOT_ID} {
                inset: 6px !important;
                width: auto !important;
                height: calc(100dvh - 12px) !important;
            }
        }
    `;
    document.head.appendChild(style);
}

function refreshQueueUi() {
    const panel = document.getElementById(ROOT_ID);
    if (!panel || panel.hasAttribute('hidden')) {
        return;
    }
    renderShellStatus();
    if (activeTab() === 'settings') {
        refreshHistoryBackfillUi(panel.querySelector('.lm-body'));
        return;
    }
    if (['turns', 'chapters'].includes(activeTab())) {
        renderActiveTab();
        return;
    }
    if (activeTab() !== 'state') {
        return;
    }
    const current = panel.querySelector('.lm-task-rail');
    if (!current) {
        return;
    }
    const template = document.createElement('template');
    template.innerHTML = renderTaskRail().trim();
    const next = template.content.firstElementChild;
    current.replaceWith(next);
    bindQueueControls(panel.querySelector('.lm-body'));
}

function renderHistoryBackfillStatus(snapshot = getHistoryRebuildSnapshot()) {
    return `<div class="lm-rebuild-workflows" aria-live="polite">
        ${renderTurnProgressCard(snapshot, { controls: true })}
        ${renderChapterProgressCard(snapshot, { controls: true })}
    </div>`;
}

function workflowPercent(completed, total) {
    return total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
}

export function pairFloorBounds(pair) {
    if (!pair) return null;
    const start = Number(pair.userFloor);
    const end = Number(pair.aiFloor ?? pair.userFloor);
    return Number.isInteger(start) && Number.isInteger(end) ? [start, end] : null;
}

function pairAt(pairIndex, pairs = getPairs()) {
    return pairs.find(pair => pair.pairIndex === Number(pairIndex));
}

function pairFloorRangeLabel(startPair, endPair = startPair, pairs = getPairs()) {
    const start = pairFloorBounds(pairAt(startPair, pairs));
    const end = pairFloorBounds(pairAt(endPair, pairs));
    if (!start || !end) return '对应楼层未知';
    return start[0] === end[1] ? `第 ${start[0]} 楼` : `第 ${start[0]}–${end[1]} 楼`;
}

function latestChatFloor(pairs = getPairs().filter(pair => pair.sealed)) {
    return pairFloorBounds(pairs.at(-1))?.[1] ?? null;
}

function summarizedThroughFloor(completed, pairs = getPairs().filter(pair => pair.sealed)) {
    if (!completed) return null;
    return pairFloorBounds(pairs[Math.min(completed, pairs.length) - 1])?.[1] ?? null;
}

function floorProgressText(completed, total, summaryItems = null) {
    const pairs = getPairs().filter(pair => pair.sealed);
    const latest = latestChatFloor(pairs);
    const summaries = normalizedTurnSummaries({
        turn_summaries: summaryItems ?? turnSummaryDisplaySource(getChatData()).items,
    });
    const summarizedPairs = new Set(summaries.map(item => item.pairIndex));
    let contiguousPair = null;
    for (const pair of pairs) {
        if (!summarizedPairs.has(pair.pairIndex)) break;
        contiguousPair = pair;
    }
    const through = pairFloorBounds(contiguousPair)?.[1]
        ?? (summaries.length ? null : summarizedThroughFloor(completed, pairs));
    const remaining = Math.max(0, total - completed);
    const throughText = through == null ? '尚未开始总结' : `已总结到第 ${through} 楼`;
    const latestText = latest == null ? '当前没有完整对话' : `最新第 ${latest} 楼`;
    return `${throughText} · ${latestText} · 剩余 ${remaining} 条对话`;
}

function renderTurnProgressCard(snapshot, { controls = false, showOpen = true, preservedCount = 0 } = {}) {
    const progress = snapshot.turnProgress || { status: 'idle', completed: 0, total: snapshot.total || 0 };
    const percent = workflowPercent(progress.completed, progress.total);
    const remaining = Math.max(0, progress.total - progress.completed);
    const active = snapshot.stage_mode === 'turns' && ['running', 'stopping'].includes(snapshot.status);
    const failed = snapshot.stage_mode === 'turns' && snapshot.status === 'error';
    const view = workflowPresentation({
        status: active ? snapshot.status : failed ? 'error' : progress.status,
        completed: progress.completed,
        total: progress.total,
        remaining,
        failedCount: failed ? 1 : 0,
    });
    const preservingFormal = preservedCount > 0 && snapshot.status !== 'complete' && progress.completed === 0;
    const title = view.complete ? '对话记录已经齐全'
        : view.error ? '对话记录生成遇到问题'
            : active ? `正在整理，还剩 ${remaining} 条对话`
                : view.paused ? `整理已暂停，还有 ${remaining} 条对话`
                    : progress.completed ? '对话记录还有遗漏'
                        : preservingFormal ? `本次重建还有 ${remaining} 条对话待整理` : '还没有生成对话记录';
    const detail = view.error ? snapshot.error
        : active ? snapshot.stage
            : view.complete ? '可以随时查看和修改；完成章节后这些记录也不会消失。'
                : progress.completed ? `当前聊天需要 ${progress.total} 轮记录，已有 ${progress.completed} 轮仍与原文一致；可以只补缺少部分。`
                : preservingFormal ? `原来的 ${preservedCount} 条正式记录仍然保留并显示，不需要重新付费才能查看。`
                    : '先逐轮整理用户输入和角色回应，再决定是否生成章节摘要。';
    const label = view.canRetry ? '重试失败任务'
        : progress.completed ? '补齐缺少的记录'
            : '生成对话记录';
    const rebuild = getChatData().history_rebuild;
    const progressItems = snapshot.stage_mode === 'turns' && snapshot.status !== 'complete' && !snapshot.staleScope
        ? rebuild?.turn_summaries || []
        : null;
    const progressValueLabel = floorProgressText(progress.completed, progress.total, progressItems);
    return `<section class="lm-backfill-card" data-workflow="turns" data-state="${escapeHtml(progress.status)}">
        <div class="lm-backfill-heading"><div><span class="lm-kicker">第一步 · 可独立使用</span><b>${escapeHtml(title)}</b><p>${escapeHtml(detail || '')}</p></div><strong>${escapeHtml(progressValueLabel)}</strong></div>
        <progress max="100" value="${percent}" aria-label="对话记录进度：${percent}%">${percent}%</progress>
        <div class="lm-backfill-meta"><span>${percent}%</span><span>${Number(snapshot.warningCount) ? `已忽略 ${snapshot.warningCount} 条证据不可靠的事实` : '没有未解决的逐轮错误'}</span></div>
        ${controls ? `<div class="lm-settings-actions">${view.canContinue || view.canRetry ? `<button type="button" class="lm-button" data-rebuild-action="turns" data-rebuild-mode="${progress.completed ? 'reuse' : 'full'}" ${snapshot.stage_mode === 'chapters' && snapshot.status === 'running' ? 'disabled' : ''}>${escapeHtml(label)}</button>` : ''}${showOpen ? '<button type="button" class="lm-text-button" data-open-workflow="turns">查看对话记录</button>' : ''}${active ? '<button type="button" class="lm-text-button" data-rebuild-action="stop">停止</button>' : ''}</div>${!active && progress.completed ? '<details class="lm-maintenance-tools"><summary>重建工具</summary><p>放弃现有自动记录并重新调用模型处理全部对话。当前正式记忆会保留到新记录和章节全部完成。</p><button type="button" class="lm-text-button lm-danger" data-rebuild-action="turns" data-rebuild-mode="full">重新生成全部记录</button></details>' : ''}` : ''}
    </section>`;
}

function renderChapterProgressCard(snapshot, { controls = false, showOpen = true } = {}) {
    const progress = snapshot.chapterProgress || { status: 'locked', completed: 0, total: 0, remaining: 0, currentRange: null, tailRange: null };
    const percent = workflowPercent(progress.completed, progress.total);
    const view = workflowPresentation({
        status: progress.status,
        completed: progress.completed,
        total: progress.total,
        remaining: progress.remaining,
        failedCount: progress.status === 'error' ? 1 : 0,
    });
    const current = progress.currentRange
        ? `${progress.status === 'error' ? '上次失败于' : progress.status === 'stopped' ? '已停在' : '正在生成'}${pairFloorRangeLabel(progress.currentRange[0], progress.currentRange[1])}`
        : '';
    const title = view.complete ? '章节摘要已经完成'
        : progress.status === 'locked' ? '章节摘要等待对话记录'
            : view.error ? '章节摘要生成遇到问题'
                : progress.status === 'running' || progress.status === 'stopping' ? '正在生成章节摘要'
                    : progress.completed ? '章节摘要可以继续生成' : '可以生成章节摘要';
    const detail = view.error ? snapshot.error
        : current || (progress.status === 'locked' ? '对话记录完整后才能合并章节。'
            : view.complete ? '对话记录仍然保留，可随时单独查看和修改。'
                : `剩余 ${progress.remaining} 章；已经完成的章节不会重复生成。`);
    const actionLabel = view.canRetry ? '重试失败任务'
        : progress.completed > 0 ? '继续生成章节摘要' : '生成章节摘要';
    const tail = progress.tailRange
        ? `<p class="lm-tail-note">${pairFloorRangeLabel(progress.tailRange[0], progress.tailRange[1])}共 ${progress.tailRange[1] - progress.tailRange[0] + 1} 轮记录，不足一章，仅保留对话记录。</p>` : '';
    const active = ['running', 'stopping'].includes(progress.status);
    return `<section class="lm-backfill-card" data-workflow="chapters" data-state="${escapeHtml(progress.status)}">
        <div class="lm-backfill-heading"><div><span class="lm-kicker">第二步 · 单独启动</span><b>${escapeHtml(title)}</b><p>${escapeHtml(detail || '')}</p></div><strong>${progress.completed} / ${progress.total} 章</strong></div>
        <progress max="100" value="${percent}" aria-label="章节摘要进度：${percent}%">${percent}%</progress>
        <div class="lm-backfill-meta"><span>${percent}%</span><span>剩余 ${progress.remaining} 章</span>${current ? `<span>${escapeHtml(current)}</span>` : ''}</div>
        ${tail}
        ${controls ? `<div class="lm-settings-actions">${(view.canContinue && progress.status !== 'locked') || view.canRetry ? `<button type="button" class="lm-button ${progress.status === 'ready' ? 'lm-button-primary' : ''}" data-rebuild-action="chapters">${escapeHtml(actionLabel)}</button>` : ''}${showOpen ? '<button type="button" class="lm-text-button" data-open-workflow="chapters">查看章节</button>' : ''}${active ? '<button type="button" class="lm-text-button" data-rebuild-action="stop">停止</button>' : ''}</div>${view.complete ? '<details class="lm-maintenance-tools"><summary>重建工具</summary><p>重新处理全部完整章节。现有章节会保留到新结果完整生成。</p><button type="button" class="lm-text-button lm-danger" data-rebuild-action="chapters" data-rebuild-mode="full">重新生成全部章节</button></details>' : ''}` : ''}
    </section>`;
}

function refreshHistoryBackfillUi(body) {
    const host = body?.querySelector('#lm-backfill-status');
    if (!host) return;
    host.innerHTML = renderHistoryBackfillStatus();
    bindHistoryBackfillControls(host, body);
}

function bindHistoryBackfillControls(host, body) {
    if (!host) return;
    host.querySelectorAll('[data-rebuild-action="turns"]').forEach(button => button.addEventListener('click', async () => {
        const reuseExisting = button.dataset.rebuildMode === 'reuse';
        const confirmed = await openConfirmDialog({
            kicker: reuseExisting ? '补齐缺口' : '重建工具',
            title: reuseExisting ? '生成缺少的对话记录？' : '重新生成全部对话记录？',
            description: reuseExisting
                ? '已经存在且仍对应当前原文的记录会直接复用，不会重复调用模型。'
                : '这会重新调用模型处理当前聊天的全部对话。现有正式记忆会保留到新记录和章节全部完成。',
            confirmLabel: reuseExisting ? '补齐缺少的记录' : '重新生成全部记录',
            cancelLabel: reuseExisting ? '暂不生成' : '保留现有记录',
            tone: reuseExisting ? 'default' : 'danger',
        });
        if (!confirmed) return;
        host.querySelectorAll('[data-rebuild-action="turns"]').forEach(candidate => { candidate.disabled = true; });
        await startHistoryRebuild({ reuseExisting });
        refreshHistoryBackfillUi(body);
        toastr?.info?.(reuseExisting ? '已经开始补齐缺少的记录。' : '已经开始重新生成全部对话记录。');
    }));
    host.querySelectorAll('[data-rebuild-action="stop"]').forEach(button => button.addEventListener('click', async () => {
        if (button) button.disabled = true;
        await requestHistoryRebuildAbort();
        refreshHistoryBackfillUi(body);
        toastr?.info?.('停止请求已收到，已经完成的内容会保留。');
    }));
    host.querySelectorAll('[data-open-workflow]').forEach(button => button.addEventListener('click', () => selectTab(button.dataset.openWorkflow)));
    host.querySelector('[data-rebuild-action="chapters"]')?.addEventListener('click', async () => {
        const rebuildAll = host.querySelector('[data-rebuild-action="chapters"]')?.dataset.rebuildMode === 'full';
        const confirmed = await openConfirmDialog({
            kicker: rebuildAll ? '重建工具' : '生成章节',
            title: rebuildAll ? '重新生成全部章节？' : '根据当前对话记录生成章节？',
            description: rebuildAll
                ? '这会重新调用模型处理全部完整章节；现有章节会保留到新结果生成完成。'
                : '人工修改后的对话记录会作为生成依据，只处理已经凑满一章的记录。',
            confirmLabel: rebuildAll ? '重新生成全部章节' : '开始生成章节',
            cancelLabel: rebuildAll ? '保留现有章节' : '暂不生成',
            tone: rebuildAll ? 'danger' : 'default',
        });
        if (!confirmed) return;
        const button = host.querySelector('[data-rebuild-action="chapters"]');
        if (button) button.disabled = true;
        await startHistoryRebuildChapters();
        refreshHistoryBackfillUi(body);
        toastr?.info?.('已经开始根据对话记录生成章节摘要。');
    });
}

function injectSettingsEntry() {
    if (document.getElementById(SETTINGS_CARD_ID)) {
        return;
    }
    const host = document.getElementById('extensions_settings')
        || document.getElementById('rm_extensions_block');
    if (!host) {
        return;
    }
    const entry = document.createElement('div');
    entry.id = SETTINGS_CARD_ID;
    entry.className = 'lm-settings-entry';
    entry.innerHTML = `
        <div>
            <strong>分层长程记忆</strong>
            <p>记忆内容、整理进度和设置都在独立的记忆中心里。</p>
        </div>
        <button type="button" class="menu_button">打开记忆中心</button>
    `;
    entry.querySelector('button')?.addEventListener('click', () => openMemoryCenter(true));
    host.appendChild(entry);
}

function injectExtensionsMenuEntry() {
    if (document.getElementById(MENU_ENTRY_ID)) {
        return;
    }
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        return;
    }
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.id = MENU_ENTRY_ID;
    entry.className = 'list-group-item flex-container flexGap5 interactable lm-menu-entry';
    entry.innerHTML = '<span class="fa-solid fa-brain extensionsMenuExtensionButton" aria-hidden="true"></span><span>分层长程记忆</span>';
    entry.addEventListener('click', () => openMemoryCenter(true));
    menu.appendChild(entry);
}

export async function openMemoryCenter(open = true, targetTab = null) {
    const panel = document.getElementById(ROOT_ID);
    const backdrop = document.getElementById(BACKDROP_ID);
    const trigger = document.querySelector(`#${DRAWER_ID} .lm-drawer-trigger`);
    if (!panel || !backdrop || !trigger) {
        return;
    }
    if (open) {
        lastDrawerTrigger = document.activeElement;
        backdrop.removeAttribute('hidden');
        panel.removeAttribute('hidden');
        panel.setAttribute('aria-modal', 'true');
        setHostInert(true);
        document.body.classList.add('lm-memory-center-open');
        document.getElementById(DRAWER_ID)?.classList.add('lm-open');
        trigger.setAttribute('aria-expanded', 'true');
        if (targetTab) {
            await selectTab(targetTab);
        } else {
            renderActiveTab();
        }
        panel.querySelector('#lm-center-title')?.focus();
    } else {
        if (settingsDirty) {
            const confirmed = await openConfirmDialog({
                kicker: '未保存的设置',
                title: '不保存并关闭记忆中心？',
                description: '这次修改的设置还没有保存，关闭后会恢复为上一次保存的内容。',
                confirmLabel: '不保存并关闭',
                cancelLabel: '继续编辑',
            });
            if (!confirmed) {
                return;
            }
            settingsDirty = false;
        }
        backdrop.setAttribute('hidden', '');
        panel.setAttribute('hidden', '');
        panel.setAttribute('aria-modal', 'false');
        document.body.classList.remove('lm-memory-center-open');
        document.getElementById(DRAWER_ID)?.classList.remove('lm-open');
        trigger.setAttribute('aria-expanded', 'false');
        setHostInert(false);
        if (lastDrawerTrigger instanceof HTMLElement
            && lastDrawerTrigger !== document.body
            && lastDrawerTrigger !== document.documentElement
            && document.contains(lastDrawerTrigger)) {
            lastDrawerTrigger.focus();
        } else {
            trigger.focus();
        }
    }
}

async function selectTab(tab) {
    if (activeTab() === 'settings' && tab !== 'settings' && settingsDirty) {
        const confirmed = await openConfirmDialog({
            kicker: '未保存的设置',
            title: '不保存并离开设置？',
            description: '这次修改的设置还没有保存，离开后会恢复为上一次保存的内容。',
            confirmLabel: '不保存并离开',
            cancelLabel: '继续编辑',
        });
        if (!confirmed) {
            return;
        }
        settingsDirty = false;
    }
    const tabs = [...document.querySelectorAll(`#${ROOT_ID} .lm-tab`)];
    for (const btn of tabs) {
        const selected = btn.dataset.tab === tab;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', String(selected));
        btn.tabIndex = selected ? 0 : -1;
    }
    document.getElementById('lm-tab-panel')?.setAttribute('aria-labelledby', `lm-tab-${tab}`);
    renderActiveTab();
}

function onTabKeydown(ev) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) {
        return;
    }
    ev.preventDefault();
    const tabs = [...document.querySelectorAll(`#${ROOT_ID} .lm-tab`)];
    const current = tabs.indexOf(ev.currentTarget);
    const next = ev.key === 'Home' ? 0
        : ev.key === 'End' ? tabs.length - 1
            : (current + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    selectTab(tabs[next]?.dataset.tab);
}

function activeTab() {
    return document.querySelector(`#${ROOT_ID} .lm-tab.active`)?.dataset.tab || 'state';
}

export function renderActiveTab() {
    const body = document.querySelector(`#${ROOT_ID} .lm-body`);
    if (!body) {
        return;
    }
    renderShellStatus();
    const tab = activeTab();
    body.classList.toggle('lm-state-body', tab === 'state');
    if (tab === 'state') {
        body.innerHTML = renderStateTab();
        bindStateTab(body);
    } else if (tab === 'turns') {
        body.innerHTML = renderTurnsTab();
        bindTurnsTab(body);
    } else if (tab === 'chapters') {
        body.innerHTML = renderChaptersTab();
        bindChaptersTab(body);
    } else if (tab === 'review') {
        body.innerHTML = renderReviewTab();
        bindReviewTab(body);
    } else {
        if (settingsDirty && body.querySelector('.lm-settings-layout')) {
            return;
        }
        body.innerHTML = renderSettingsTab();
        bindSettingsTab(body);
    }
}

function renderShellStatus() {
    const panel = document.getElementById(ROOT_ID);
    if (!panel) {
        return;
    }
    const data = getChatData();
    const settings = getSettings();
    const queue = getQueueSnapshot();
    const entries = usableMemoryEntries(data);
    const reviews = (data.review_queue || []).filter(item => item.kind !== 'alert');
    const failed = queue.failed || [];
    const pendingCount = queue.queued?.length || 0;
    const status = data.branch_origin?.status === 'failed' ? { key: 'error', text: '分支记忆恢复失败' }
        : failed.length ? { key: 'error', text: `${failed.length} 项整理工作需要处理` }
        : !settings.enabled ? { key: 'paused', text: '已停用' }
            : queue.paused ? { key: 'paused', text: '已暂停' }
            : queue.inFlight || pendingCount ? { key: 'working', text: queue.inFlight ? '正在处理' : '等待处理' }
                : !lastConnectionTest ? { key: 'warning', text: '模型连接待检查' }
                    : lastConnectionTest.ok ? { key: 'idle', text: '运行正常' }
                        : { key: 'error', text: '模型连接不可用' };
    const pill = panel.querySelector('.lm-status-pill');
    if (pill) {
        pill.dataset.status = status.key;
        pill.innerHTML = `<span aria-hidden="true">●</span> ${escapeHtml(status.text)}`;
    }

    const pairs = getPairs().filter(p => p.sealed);
    const extracted = new Set(data.extracted_keys || []);
    const baseline = data.progress?.baseline_pair ?? -1;
    const liveStart = Math.max(0, baseline + 1);
    let syncedThrough = liveStart - 1;
    for (const pair of pairs.sort((a, b) => a.pairIndex - b.pairIndex).filter(p => p.pairIndex >= liveStart)) {
        if (extracted.has(pair.floorKey) || extracted.has(`migrated:${pair.floorKey}`)) {
            if (pair.pairIndex === syncedThrough + 1) {
                syncedThrough = pair.pairIndex;
                continue;
            }
        }
        break;
    }
    const maxSealed = pairs.at(-1)?.pairIndex ?? -1;
    const rebuild = getHistoryRebuildSnapshot();
    const formalTurnCount = normalizedTurnSummaries(data).length;
    let syncLabel;
    if (rebuild?.turnProgress?.status === 'complete') {
        syncLabel = floorProgressText(rebuild.turnProgress.completed, rebuild.turnProgress.total);
    } else if (rebuild?.status === 'complete' && rebuild?.turnProgress?.completed < rebuild?.turnProgress?.total) {
        syncLabel = `${floorProgressText(rebuild.turnProgress.completed, rebuild.turnProgress.total)} · 还有遗漏`;
    } else if (rebuild?.status === 'review') {
        syncLabel = `${floorProgressText(rebuild.completed, rebuild.total, data.history_rebuild?.turn_summaries || [])} · 待检查`;
    } else if (rebuild?.stage_mode === 'chapters' && ['running', 'stopping', 'stopped', 'error'].includes(rebuild.status)) {
        const needsAttention = ['stopped', 'error'].includes(rebuild.status) ? ' · 需要继续' : '';
        syncLabel = `章节摘要 ${rebuild.chapterProgress?.completed || 0} / ${rebuild.chapterProgress?.total || 0} 章${needsAttention}`;
    } else if (rebuild?.stage_mode === 'turns' && ['running', 'stopping', 'stopped', 'error'].includes(rebuild.status)) {
        const needsAttention = ['stopped', 'error'].includes(rebuild.status) ? ' · 需要继续' : '';
        const remaining = Math.max(0, (rebuild.turnProgress?.total || 0) - (rebuild.turnProgress?.completed || 0));
        syncLabel = formalTurnCount
            ? `${floorProgressText(rebuild.turnProgress?.completed || 0, rebuild.turnProgress?.total || 0, data.history_rebuild?.turn_summaries || [])} · 原记录 ${formalTurnCount} 条仍可查看${needsAttention}`
            : `${floorProgressText(rebuild.turnProgress?.completed || 0, rebuild.turnProgress?.total || 0, data.history_rebuild?.turn_summaries || [])}${needsAttention}`;
    } else if (syncedThrough >= liveStart) {
        const throughFloor = pairFloorBounds(pairAt(syncedThrough, pairs))?.[1];
        const latestFloor = latestChatFloor(pairs);
        const remaining = Math.max(0, maxSealed - syncedThrough);
        syncLabel = `已总结到第 ${throughFloor} 楼 · 最新第 ${latestFloor} 楼 · 剩余 ${remaining} 条对话${syncedThrough === maxSealed ? '' : ' · 后面有遗漏'}`;
    } else {
        const firstFloor = pairFloorBounds(pairAt(liveStart, pairs))?.[0];
        const latestFloor = latestChatFloor(pairs);
        syncLabel = maxSealed >= liveStart ? `尚未总结 · 最新第 ${latestFloor} 楼 · 从第 ${firstFloor} 楼开始待整理` : baseline >= 0 ? `将从第 ${firstFloor ?? '下一'} 楼开始记录` : '新聊天';
    }
    const configuredConnection = settings.memoryModelSource === 'direct'
        ? `自填 API · ${settings.directModel || '未选模型'}`
        : settings.memoryModelSource === 'profile'
            ? `酒馆连接 · ${settings.profileModelOverride || '配置内模型'}`
            : '跟随当前聊天模型';
    const connectionLabel = lastConnectionTest
        ? `${lastConnectionTest.ok ? '可用' : '不可用'} · ${lastConnectionTest.model || lastConnectionTest.message}`
        : `${configuredConnection} · 尚未检查`;
    const metrics = panel.querySelector('.lm-header-metrics');
    if (metrics) {
        metrics.innerHTML = `
            <span class="lm-metric"><b>${escapeHtml(syncLabel)}</b><small>记忆进度</small></span>
            <span class="lm-metric"><b>${entries.length}</b><small>当前记忆</small></span>
            <span class="lm-metric"><b>${reviews.length}</b><small>待处理</small></span>
            <span class="lm-metric lm-connection"><b>${escapeHtml(connectionLabel)}</b><small>记忆模型</small></span>
        `;
    }
    const ctx = SillyTavern.getContext();
    const chatName = ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '当前聊天';
    const chatLabel = panel.querySelector('.lm-chat-name');
    if (chatLabel) {
        chatLabel.textContent = chatName;
    }
    const badge = panel.querySelector('[data-tab="review"] .lm-tab-count');
    if (badge) {
        badge.textContent = String(reviews.length);
        badge.hidden = reviews.length === 0;
    }
}

function renderStateTab() {
    const data = getChatData();
    const rebuildSnapshot = getHistoryRebuildSnapshot();
    const entries = usableMemoryEntries(data);
    const candidates = factCandidateView(data);
    const inactiveCandidates = candidates.filter(item => !['active', 'dismissed'].includes(item.status));
    const quarantined = data.quarantined_entries || [];
    const notices = (data.notices || []).filter(item => {
        if (rebuildSnapshot.turnProgress?.status !== 'partial') return true;
        return !/安全重建完成|已核对\s*\d+\s*\/\s*\d+/.test(item.note || '');
    });
    const rebuild = data.history_rebuild;
    const rebuilding = rebuild && !['complete', 'idle'].includes(rebuild.status);
    const stagedFactCount = Array.isArray(rebuild?.entries) ? rebuild.entries.length : 0;
    const ignoredFactCount = Array.isArray(rebuild?.warnings) ? rebuild.warnings.length : 0;
    const statusBannerItems = [
        rebuilding ? `<aside class="lm-quality-alert"><div><strong>当前显示旧正式事实 ${entries.length} 条；新暂存事实 ${stagedFactCount} 条</strong><p>暂存结果尚未加入当前记忆；完成章节后才会一次性采用。${ignoredFactCount ? `另有 ${ignoredFactCount} 条因原文证据不可靠而被忽略。` : ''}</p></div></aside>` : '',
        quarantined.length ? `<aside class="lm-quality-alert"><div><strong>已隔离 ${quarantined.length} 条异常结果</strong><p>它们缺少主体、事实或原文证据，不会加入当前记忆。完成安全重建后会由新结果替换。</p></div></aside>` : '',
        notices.length ? `<section class="lm-notice-strip" aria-label="状态通知">${notices.slice(-3).map(item => `<article data-notice-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.note || '')}</span><button type="button" class="lm-text-button" data-dismiss-notice>知道了</button></article>`).join('')}</section>` : '',
    ].filter(Boolean);
    const statusBanners = statusBannerItems.length
        ? `<div class="lm-status-stack">${statusBannerItems.join('')}</div>`
        : '';
    let groups = '';
    for (const slot of SLOTS) {
        const group = entries.filter(e => e.slot === slot);
        if (!group.length) {
            continue;
        }
        groups += `
            <section class="lm-memory-group" data-slot="${slot}">
                <header><h3>${escapeHtml(SLOT_LABELS[slot])}</h3><span>${group.length} 条</span></header>
                <div class="lm-memory-list">${group.map(renderMemoryCard).join('')}</div>
            </section>`;
    }
    if (!entries.length) {
        groups = `
            <div class="lm-empty-state">
                <span class="fa-solid fa-feather-pointed" aria-hidden="true"></span>
                <h3>故事刚刚翻开</h3>
                <p>完成一轮对话后，仍会影响后续剧情的重要内容会出现在这里。你也可以先手动添加一条。</p>
                <button type="button" class="lm-button lm-button-primary" data-empty-add>添加第一条记忆</button>
            </div>`;
    }
    const candidateItems = currentFactView === 'all'
        ? candidates
        : currentFactView === 'inactive' ? inactiveCandidates : [];
    const viewMeta = factViewMeta(currentFactView, {
        active: entries.length,
        all: candidates.length,
        inactive: inactiveCandidates.length,
    });
    const candidateList = candidateItems.length
        ? `<div class="lm-discovery-list">${candidateItems.map(renderFactCandidateCard).join('')}</div>`
        : `<div class="lm-empty-state lm-compact-empty"><h3>${currentFactView === 'inactive' ? '没有等待采用的事实' : '还没有发现事实'}</h3><p>${currentFactView === 'inactive' ? '当前没有被覆盖、未验证或尚未选择的内容。' : '完成逐轮整理后，模型发现的内容会完整保留在这里。'}</p></div>`;
    return `
        <div class="lm-dashboard">
            <main class="lm-memory-main" id="lm-memory-main">
                ${statusBanners}
                <section class="lm-fact-shell">
                    <div class="lm-fact-overview" aria-label="事实记录概览">
                        <button type="button" data-fact-view="active" class="${currentFactView === 'active' ? 'active' : ''}"><strong>${entries.length}</strong><span>${FACT_VIEW_LABELS.active}</span></button>
                        <button type="button" data-fact-view="all" class="${currentFactView === 'all' ? 'active' : ''}"><strong>${candidates.length}</strong><span>${FACT_VIEW_LABELS.all}</span></button>
                        <button type="button" data-fact-view="inactive" class="${currentFactView === 'inactive' ? 'active' : ''}"><strong>${inactiveCandidates.length}</strong><span>${FACT_VIEW_LABELS.inactive}</span></button>
                    </div>
                    <p class="lm-fact-explainer">当前记忆会随你之后发出的聊天请求一起提供给模型；发现历史只用于查看和追溯。</p>
                </section>
                <div class="lm-memory-toolbar">
                    <label class="lm-search">
                        <span class="fa-solid fa-magnifying-glass" aria-hidden="true"></span>
                        <span class="sr-only">搜索记忆</span>
                        <input type="search" id="lm-memory-search" placeholder="搜索人物、约定、物品或证据" autocomplete="off"/>
                    </label>
                    <select id="lm-slot-filter" aria-label="按记忆类型筛选">
                        <option value="">全部类型</option>
                        ${SLOTS.map(slot => `<option value="${slot}">${escapeHtml(SLOT_LABELS[slot])}</option>`).join('')}
                    </select>
                    <button type="button" class="lm-button lm-button-secondary" id="lm-proof-now"><span class="fa-solid fa-spell-check" aria-hidden="true"></span><span>检查记忆</span></button>
                    <button type="button" class="lm-button lm-button-primary" id="lm-add-entry"><span aria-hidden="true">＋</span> 添加记忆</button>
                </div>
                <div class="lm-memory-meta">
                    <span>${escapeHtml(viewMeta.description)}</span>
                    <small>${viewMeta.count} 条</small>
                </div>
                <div id="lm-memory-groups">${currentFactView === 'active' ? groups : candidateList}</div>
                <p class="lm-no-results" hidden>没有找到匹配的记忆。可以试试人物名、物品名或聊天楼层。</p>
            </main>
            ${renderTaskRail()}
        </div>
        ${renderInjectionFooter()}
    `;
}

function renderFactCandidateCard(candidate) {
    const fact = candidate.fact || {};
    const subject = fact.object
        ? `${displayEntityName(fact.subject)} → ${displayEntityName(fact.object)}`
        : displayEntityName(fact.subject);
    const searchable = [fact.subject, fact.object, fact.topic, fact.value, fact.evidence, candidate.reason].filter(Boolean).join(' ').toLowerCase();
    const canActivate = ['unselected', 'superseded', 'dismissed'].includes(candidate.status);
    const canEdit = candidate.status !== 'active';
    return `<article class="lm-discovery-card" data-candidate-id="${escapeHtml(candidate.id)}" data-slot="${escapeHtml(fact.slot)}" data-search="${escapeHtml(searchable)}" data-status="${escapeHtml(candidate.status)}">
        <div class="lm-discovery-head"><span class="lm-discovery-status">${escapeHtml(FACT_STATUS_LABELS[candidate.status] || candidate.status)}</span><span>${escapeHtml(formatFloorLabel(candidate.floor))}</span></div>
        <h3>${escapeHtml(readableCandidateText(subject, '主体需要补充'))}</h3>
        ${fact.topic ? `<small class="lm-fact-topic">具体事项：${escapeHtml(fact.topic)}</small>` : ''}
        <p>${escapeHtml(readableCandidateText(fact.value, '事实内容需要补充'))}</p>
        <p class="lm-discovery-reason">${escapeHtml(candidate.reason)}</p>
        ${fact.evidence ? `<details class="lm-evidence"><summary>查看原文依据</summary><blockquote>${escapeHtml(fact.evidence)}</blockquote></details>` : ''}
        <div class="lm-discovery-actions">
            ${canActivate ? '<button type="button" class="lm-button lm-button-primary" data-candidate-action="activate">加入当前记忆</button>' : ''}
            ${canEdit ? `<button type="button" class="lm-text-button" data-candidate-action="edit">${candidate.status === 'unverified' ? '核对并加入' : '编辑并加入'}</button>` : ''}
            ${candidate.status !== 'active' && candidate.status !== 'dismissed' ? '<button type="button" class="lm-text-button" data-candidate-action="dismiss">忽略</button>' : ''}
        </div>
    </article>`;
}

function readableCandidateText(value, fallback) {
    const text = String(value ?? '').trim();
    return !text || ['undefined', 'null', '未填写事实', '未命名主体'].includes(text.toLowerCase()) ? fallback : text;
}

function editableCandidateFact(fact = {}) {
    return {
        ...fact,
        subject: readableCandidateText(fact.subject, ''),
        object: readableCandidateText(fact.object, ''),
        value: readableCandidateText(fact.value, ''),
    };
}

function renderMemoryCard(entry) {
    const subjectName = displayEntityName(entry.subject);
    const objectName = displayEntityName(entry.object);
    const subject = entry.object
        ? `${escapeHtml(subjectName)} <span aria-hidden="true">→</span> ${escapeHtml(objectName)}`
        : escapeHtml(subjectName);
    const floor = formatFloorLabel(entry.updated_floor ?? entry.established_floor);
    const searchable = [entry.subject, entry.object, entry.value, entry.evidence, floor].filter(Boolean).join(' ').toLowerCase();
    return `
        <article class="lm-memory-card ${entry.pinned ? 'lm-pinned' : ''}" data-id="${escapeHtml(entry.id)}" data-search="${escapeHtml(searchable)}">
            <div class="lm-card-leading">
                <div class="lm-card-title"><strong>${subject}</strong><span>${escapeHtml(floor)}</span></div>
                <p>${escapeHtml(entry.value || '未填写事实')}</p>
                ${entry.cause ? `<div class="lm-impact"><span>持续影响</span>${escapeHtml(entry.cause)}</div>` : ''}
                ${entry.evidence ? `<details class="lm-evidence"><summary>查看这条记忆来自哪段对话</summary><blockquote>${escapeHtml(entry.evidence)}</blockquote></details>` : ''}
            </div>
            <div class="lm-card-actions" aria-label="记忆操作">
                <button type="button" data-act="pin" class="lm-icon-button" title="${entry.pinned ? '恢复自动整理' : '始终保留这条记忆'}" aria-label="${entry.pinned ? '恢复自动整理' : '始终保留这条记忆'}"><span class="fa-solid fa-thumbtack" aria-hidden="true"></span></button>
                <button type="button" data-act="edit" class="lm-icon-button" title="编辑" aria-label="编辑"><span class="fa-solid fa-pen" aria-hidden="true"></span></button>
                <button type="button" data-act="report" class="lm-icon-button" title="这条记忆有问题" aria-label="报告这条记忆的问题"><span class="fa-solid fa-flag" aria-hidden="true"></span></button>
                <button type="button" data-act="del" class="lm-icon-button lm-danger" title="删除" aria-label="删除"><span class="fa-solid fa-trash" aria-hidden="true"></span></button>
            </div>
        </article>`;
}

function renderTaskRail() {
    const q = getQueueSnapshot();
    const failed = q.failed || [];
    const queued = q.queued || [];
    const data = getChatData();
    const rebuild = getHistoryRebuildSnapshot();
    const missingTurns = rebuild.turnProgress?.status === 'partial'
        ? Math.max(0, rebuild.turnProgress.total - rebuild.turnProgress.completed)
        : 0;
    const recent = [...(data.logs || [])].reverse().filter(x => /完成|更新|回滚/.test(x.message || '')).slice(0, 4);
    const inFlight = q.inFlight;
    const taskView = taskRailPresentation({ paused: q.paused, queued, running: inFlight, failed });
    const activeCount = Number(Boolean(inFlight)) + queued.length + failed.length;
    const summary = failed.length
        ? `${activeCount} 项工作 · ${failed.length} 项需要处理`
        : activeCount
            ? `正在处理 ${activeCount} 项工作`
            : missingTurns ? `还有 ${missingTurns} 条对话尚未整理` : '已全部处理完成';
    const summaryState = missingTurns && taskView.state === 'idle' ? 'attention' : taskView.state;
    const expanded = summaryState !== 'idle';
    const idleTask = missingTurns
        ? `<div class="lm-task lm-task-idle"><span class="fa-solid fa-circle-exclamation" aria-hidden="true"></span><div><b>对话记录还不完整</b><small>${floorProgressText(rebuild.turnProgress.completed, rebuild.turnProgress.total, data.history_rebuild?.turn_summaries || null)}；前往“对话记录”补齐缺少部分。</small></div></div>`
        : '<div class="lm-task lm-task-idle"><span class="fa-solid fa-check" aria-hidden="true"></span><div><b>已经整理完毕</b><small>目前没有等待处理的内容</small></div></div>';
    return `
        <aside class="lm-task-rail ${expanded ? 'lm-task-expanded' : ''}" aria-label="记忆整理进度" data-summary-state="${summaryState}">
            <header>
                <div class="lm-task-heading"><span class="lm-kicker">自动整理</span><h3>记忆整理进度</h3><span class="lm-task-summary">${escapeHtml(summary)}</span></div>
                <div class="lm-task-controls">
                    <button type="button" class="lm-text-button" id="lm-queue-toggle" aria-pressed="${q.paused ? 'true' : 'false'}" aria-label="${q.paused ? '继续后台整理' : '暂停新的整理工作'}">${q.paused ? '继续' : '暂停'}</button>
                    <button type="button" class="lm-task-disclosure" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="lm-task-list"><span>${expanded ? '收起' : '展开'}</span><span aria-hidden="true">⌄</span></button>
                </div>
            </header>
            <div class="lm-task-list" id="lm-task-list">
                ${inFlight ? renderTask(inFlight, 'running') : (!queued.length && !failed.length ? idleTask : '')}
                ${queued.slice(0, 4).map(job => renderTask(job, 'queued')).join('')}
                ${queued.length > 4 ? `<p class="lm-task-overflow">另有 ${queued.length - 4} 个任务等待</p>` : ''}
                ${failed.map(job => renderTask(job, 'failed')).join('')}
            </div>
            <div class="lm-recent-activity">
                <h4>最近完成</h4>
                ${recent.length ? recent.map(log => `<div><span aria-hidden="true">●</span><p>${escapeHtml(formatActivityMessage(log.message))}<small>${formatRelativeTime(log.t)}</small></p></div>`).join('') : '<p class="lm-muted">这段聊天还没有整理记录。</p>'}
            </div>
        </aside>`;
}

function renderTask(job, state) {
    const labels = {
        extract: '整理本轮出现的新记忆',
        narrative_summary: '补齐真实楼层剧情记录',
        narrative_chapter: '合并 25 楼剧情章节',
        chapter_summary: '整理一段剧情摘要',
        volume_compress: '精简很久以前的剧情摘要',
        proofread: '检查已有记忆',
        state_gc: '合并重复的记忆',
        migrate_chapter: '补写旧聊天的剧情摘要',
        migrate_extract_chapter: '补记旧聊天的重要内容',
        migrate_extract_floor: '补记剩余的旧对话',
        migrate_finalize: '完成旧聊天补记',
        history_rebuild_segment: '逐条核对旧聊天',
        history_rebuild_chapter: '合并旧剧情章节',
        history_rebuild_commit: '安全替换旧结果',
    };
    if (job.type === 'history_rebuild_commit'
        && (job.payload?.reviewOnly || getChatData().history_rebuild?.stage_mode !== 'chapters')) {
        labels.history_rebuild_commit = '准备检查对话记录';
    }
    const target = job.payload?.pairIndex != null ? pairFloorRangeLabel(job.payload.pairIndex)
        : job.payload?.startPair != null ? pairFloorRangeLabel(job.payload.startPair, job.payload.endPair)
            : job.payload?.startFloor != null
                ? (job.payload.startFloor === job.payload.endFloor
                    ? `第 ${job.payload.startFloor} 楼`
                    : `第 ${job.payload.startFloor}–${job.payload.endFloor} 楼`)
            : '';
    const stateLabel = state === 'running' ? '正在处理' : state === 'failed' ? '需要处理' : '等待处理';
    const attempt = job.attempt ? ` · 已尝试 ${job.attempt}/${job.maxAttempts || job.attempt} 次` : '';
    return `
        <div class="lm-task" data-state="${state}" data-job-id="${escapeHtml(job.id || '')}" data-job-type="${escapeHtml(job.type || '')}">
            <span class="lm-task-dot" aria-hidden="true"></span>
            <div class="lm-task-copy">
                <b>${escapeHtml(labels[job.type] || '整理记忆')}</b>
                <small>${escapeHtml(target || stateLabel)}${escapeHtml(attempt)}</small>
                ${job.lastError ? '<p>这次没有处理成功。请重新处理；如果仍然失败，请检查记忆模型连接。</p>' : ''}
            </div>
            <span class="lm-task-state">${stateLabel}</span>
            ${state === 'failed' ? `<div class="lm-task-actions"><button type="button" class="lm-text-button" data-queue-act="retry">重新处理</button><button type="button" class="lm-text-button" data-queue-act="dismiss">不再提醒</button></div>` : ''}
        </div>`;
}

function bindQueueControls(body) {
    const rail = body?.querySelector('.lm-task-rail');
    const disclosure = rail?.querySelector('.lm-task-disclosure');
    disclosure?.addEventListener('click', () => {
        const expanded = rail.classList.toggle('lm-task-expanded');
        disclosure.setAttribute('aria-expanded', String(expanded));
        disclosure.querySelector('span').textContent = expanded ? '收起' : '展开';
    });
    const toggle = body?.querySelector('#lm-queue-toggle');
    toggle?.addEventListener('click', () => {
        toggle.disabled = true;
        setQueuePaused(!getQueueSnapshot().paused);
    });
    body?.querySelectorAll('[data-queue-act]').forEach(button => {
        button.addEventListener('click', async () => {
            const task = button.closest('[data-job-id]');
            const jobId = task?.dataset.jobId;
            const jobType = task?.dataset.jobType || '';
            if (!jobId) {
                return;
            }
            button.disabled = true;
            if (button.dataset.queueAct === 'retry') {
                if (jobType.startsWith('history_rebuild_')) {
                    const retried = await retryHistoryRebuildJob(jobId);
                    if (retried) toastr?.info?.('已经从这个失败点继续，不会重做已完成的内容。');
                } else {
                    retryFailedJob(jobId);
                }
            } else {
                dismissFailedJob(jobId);
            }
        });
    });
}

function renderInjectionFooter() {
    const data = getChatData();
    const settings = getSettings();
    const context = SillyTavern.getContext();
    const pairs = getPairs();
    const coreParts = buildCoreMemoryParts({ data, settings, context, pairs });
    const l1 = coreParts.l1;
    const l2 = coreParts.l2;
    const coreMemory = [coreParts.l1, coreParts.l2, coreParts.raw].filter(Boolean).join('\n\n');
    const hits = settings.l4Enabled ? retrieveHits(data, settings.budgetL4) : [];
    const l4 = settings.l4Enabled ? renderL4Block(hits, settings.budgetL4) : '';
    const presentation = injectionPresentation(false);
    const anchor = presetAnchorPresentation(getPresetAnchorStatus(context));
    const preview = [
        coreMemory && `【核心剧情记忆】\n${coreMemory}`,
        l4 && `【与当前剧情相关的旧记忆】\n${l4}`,
    ].filter(Boolean).join('\n\n');
    return `
        <footer class="lm-injection-footer">
            <div>
                <span class="lm-kicker">${presentation.kicker}</span>
                <strong>${presentation.title}</strong>
            </div>
            <div class="lm-budget-chips">
                <span>当前事实 ${estimateTokens(l1)} / ${settings.budgetL1}</span>
                <span>剧情摘要 ${estimateTokens(l2)}</span>
                <span>近期完整原文 ${coreParts.rawWindow.tokens} / ${settings.recentRawTokens}</span>
                <span>相关旧记忆 ${settings.l4Enabled ? `${hits.length} 条` : '未开启'}</span>
                <span>${escapeHtml(anchor.title)}</span>
            </div>
            <button type="button" class="lm-text-button" id="lm-preview-injection">${presentation.action}</button>
            <dialog class="lm-dialog" id="lm-injection-dialog">
                <form method="dialog" class="lm-dialog-frame">
                    <header><div><span class="lm-kicker">只读预览</span><h3>${presentation.dialogTitle}</h3></div><button value="cancel" class="lm-icon-button" aria-label="关闭">×</button></header>
                    <p class="lm-muted">${escapeHtml(anchor.detail)}</p>
                    <p class="lm-muted">这里只显示插件补充的记忆。酒馆原有的角色设定、世界书和最近聊天也会照常发送。</p>
                    <pre>${escapeHtml(preview)}</pre>
                </form>
            </dialog>
        </footer>`;
}

function bindStateTab(body) {
    body.querySelectorAll('[data-fact-view]').forEach(button => button.addEventListener('click', () => {
        currentFactView = button.dataset.factView;
        renderActiveTab();
    }));
    bindQueueControls(body);
    body.querySelectorAll('[data-dismiss-notice]').forEach(button => button.addEventListener('click', async () => {
        const id = button.closest('[data-notice-id]')?.dataset.noticeId;
        const data = getChatData();
        data.notices = (data.notices || []).filter(item => item.id !== id);
        await saveChatData(data);
        renderActiveTab();
    }));
    const addEntry = async () => {
        const draft = await openEntryEditor();
        if (!draft) {
            return;
        }
        const data = getChatData();
        const before = null;
        const id = `e_${String(data.progress.next_entry_seq++).padStart(4, '0')}`;
        const entry = {
            id, ...draft,
            established_floor: 'manual', updated_floor: 'manual',
            evidence: '', pinned: false, source: 'manual',
        };
        data.state_table.entries.push(entry);
        data.state_table.version += 1;
        recordManualEvent(data, { op: 'upsert', before, after: entry, reason: 'manual_add' });
        await saveChatData(data);
        recordMigrationEdit({ beforeEntry: before, afterEntry: entry, op: 'add' });
        updateInjection();
        renderActiveTab();
    };
    body.querySelector('#lm-add-entry')?.addEventListener('click', addEntry);
    body.querySelector('[data-empty-add]')?.addEventListener('click', addEntry);

    const applyMemoryFilter = () => {
        const query = body.querySelector('#lm-memory-search')?.value.trim().toLowerCase() || '';
        const slot = body.querySelector('#lm-slot-filter')?.value || '';
        let visible = 0;
        body.querySelectorAll('.lm-memory-group').forEach(group => {
            let groupVisible = 0;
            group.querySelectorAll('.lm-memory-card').forEach(card => {
                const match = (!query || card.dataset.search?.includes(query))
                    && (!slot || group.dataset.slot === slot);
                card.hidden = !match;
                if (match) {
                    groupVisible += 1;
                    visible += 1;
                }
            });
            group.hidden = groupVisible === 0;
        });
        body.querySelectorAll('.lm-discovery-card').forEach(card => {
            const match = (!query || card.dataset.search?.includes(query))
                && (!slot || card.dataset.slot === slot);
            card.hidden = !match;
            if (match) visible += 1;
        });
        const empty = body.querySelector('.lm-no-results');
        if (empty) {
            empty.hidden = visible > 0 || getChatData().state_table.entries.length === 0;
        }
    };
    body.querySelector('#lm-memory-search')?.addEventListener('input', applyMemoryFilter);
    body.querySelector('#lm-slot-filter')?.addEventListener('change', applyMemoryFilter);

    body.querySelectorAll('.lm-discovery-card[data-candidate-id]').forEach(card => {
        const candidateId = card.dataset.candidateId;
        const anchor = () => {
            const pair = getPairs().filter(item => item.sealed).at(-1);
            return pair ? { floorKey: pair.floorKey, pairIndex: pair.pairIndex, contentFingerprint: pair.contentFingerprint } : {};
        };
        card.querySelector('[data-candidate-action="activate"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const result = activateFactCandidate(data, candidateId, anchor());
            if (!result || result.error) {
                const candidate = factCandidateView(data).find(item => item.id === candidateId);
                const draft = await openEntryEditor(editableCandidateFact(candidate?.fact));
                if (!draft) return;
                const edited = activateEditedFactCandidate(data, candidateId, { ...draft, topic: candidate?.fact?.topic || draft.value, evidence: '' }, anchor());
                for (const replaced of edited?.replaced || []) recordManualEvent(data, { op: 'delete', before: replaced, after: null, reason: 'candidate_edit_superseded', sourceCandidate: edited.candidate });
                if (edited?.entry && !edited.existed) recordManualEvent(data, { op: 'upsert', before: null, after: edited.entry, reason: 'candidate_edit_activate', sourceCandidate: edited.candidate });
            } else if (!result.existed) {
                for (const replaced of result.replaced || []) {
                    recordManualEvent(data, { op: 'delete', before: replaced, after: null, reason: 'candidate_superseded', sourceCandidate: result.candidate });
                }
                recordManualEvent(data, { op: 'upsert', before: null, after: result.entry, reason: 'candidate_activate', sourceCandidate: result.candidate });
            }
            await saveChatData(data);
            updateInjection();
            toastr?.success?.('已加入当前记忆，会用于你之后发起的聊天。');
            renderActiveTab();
        });
        card.querySelector('[data-candidate-action="edit"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const candidate = factCandidateView(data).find(item => item.id === candidateId);
            const draft = await openEntryEditor(editableCandidateFact(candidate?.fact));
            if (!draft) return;
            const edited = activateEditedFactCandidate(data, candidateId, { ...draft, topic: candidate?.fact?.topic || draft.value, evidence: '' }, anchor());
            for (const replaced of edited?.replaced || []) recordManualEvent(data, { op: 'delete', before: replaced, after: null, reason: 'candidate_edit_superseded', sourceCandidate: edited.candidate });
            if (edited?.entry && !edited.existed) recordManualEvent(data, { op: 'upsert', before: null, after: edited.entry, reason: 'candidate_edit_activate', sourceCandidate: edited.candidate });
            await saveChatData(data);
            updateInjection();
            renderActiveTab();
        });
        card.querySelector('[data-candidate-action="dismiss"]')?.addEventListener('click', async () => {
            const data = getChatData();
            dismissFactCandidate(data, candidateId, anchor());
            await saveChatData(data);
            renderActiveTab();
        });
    });

    body.querySelector('#lm-preview-injection')?.addEventListener('click', () => {
        const dialog = body.querySelector('#lm-injection-dialog');
        if (dialog?.showModal) {
            dialog.showModal();
        }
    });

    body.querySelector('#lm-proof-now')?.addEventListener('click', () => {
        enqueue('proofread', {}, QUEUE_PRIORITY.proofread);
        toastr?.info?.('已经开始检查记忆');
    });

    body.querySelector('#lm-report-error')?.addEventListener('click', () => openReportDialog({}));

    body.querySelectorAll('.lm-memory-card[data-id]').forEach(li => {
        const id = li.dataset.id;
        li.querySelector('[data-act="pin"]')?.addEventListener('click', async () => {
            const e = getChatData().state_table.entries.find(x => x.id === id);
            if (e) {
                const data = getChatData();
                const before = structuredClone(e);
                e.pinned = !e.pinned;
                recordManualEvent(data, { op: 'upsert', before, after: e, reason: 'manual_pin' });
                await saveChatData(data);
                renderActiveTab();
            }
        });
        li.querySelector('[data-act="edit"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const e = data.state_table.entries.find(x => x.id === id);
            if (!e) {
                return;
            }
            const before = structuredClone(e);
            const draft = await openEntryEditor(e);
            if (!draft) {
                return;
            }
            Object.assign(e, draft);
            e.source = e.source === 'auto' ? 'manual' : e.source;
            data.state_table.version += 1;
            recordManualEvent(data, { op: 'upsert', before, after: e, reason: 'manual_edit' });
            await saveChatData(data);
            recordMigrationEdit({ beforeEntry: before, afterEntry: e, op: 'update' });
            updateInjection();
            renderActiveTab();
        });
        li.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const found = data.state_table.entries.find(x => x.id === id);
            if (!found) return;
            const confirmed = await openConfirmDialog({
                kicker: '永久删除',
                title: '删除这条记忆？',
                description: '删除后无法恢复，之后的聊天也不会再使用这条记忆。',
                details: [found.value || found.subject || '未命名记忆'],
                confirmLabel: '永久删除记忆',
                cancelLabel: '保留这条记忆',
            });
            if (!confirmed) {
                return;
            }
            const before = structuredClone(found);
            data.state_table.entries = data.state_table.entries.filter(x => x.id !== id);
            data.state_table.version += 1;
            recordManualEvent(data, { op: 'delete', before, after: null, reason: 'manual_delete' });
            await saveChatData(data);
            recordMigrationEdit({ beforeEntry: before, afterEntry: null, op: 'delete' });
            updateInjection();
            renderActiveTab();
        });
        li.querySelector('[data-act="report"]')?.addEventListener('click', () => {
            openReportDialog({ entryId: id, type: 'wrong' });
        });
    });
}

function openEntryEditor(entry = null) {
    return openFormDialog({
        kicker: entry ? '修改已有内容' : '记住新的内容',
        title: entry ? '编辑记忆' : '添加一条记忆',
        description: '只写现在仍然成立、以后还可能影响剧情的内容。',
        submitLabel: '保存这条记忆',
        cancelLabel: '不保存',
        className: 'lm-entry-dialog',
        buildFields(fields) {
            const makeField = ({ label, name, value = '', placeholder = '', maxLength = 80, textarea = false, help = '' }) => {
                const wrapper = document.createElement('label');
                wrapper.className = 'lm-dialog-field';
                const title = document.createElement('span');
                title.textContent = label;
                const control = document.createElement(textarea ? 'textarea' : 'input');
                control.name = name;
                control.maxLength = maxLength;
                control.value = String(value || '');
                control.placeholder = placeholder;
                if (textarea) control.rows = 3;
                wrapper.append(title, control);
                if (help) {
                    const small = document.createElement('small');
                    small.textContent = help;
                    wrapper.appendChild(small);
                }
                return wrapper;
            };
            const slotField = document.createElement('label');
            slotField.className = 'lm-dialog-field';
            const slotLabel = document.createElement('span');
            slotLabel.textContent = '这是什么类型的记忆？';
            const slot = document.createElement('select');
            slot.name = 'slot';
            for (const key of SLOTS) {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = SLOT_LABELS[key];
                option.selected = entry?.slot === key;
                slot.appendChild(option);
            }
            slotField.append(slotLabel, slot);
            const people = document.createElement('div');
            people.className = 'lm-field-grid';
            people.append(
                makeField({ label: '这条记忆关于谁或什么？', name: 'subject', value: entry?.subject, placeholder: '例如：林晚、铜钥匙、北港' }),
                makeField({ label: '还和谁有关？（可选）', name: 'object', value: entry?.object, placeholder: '例如：周衡' }),
            );
            fields.append(
                slotField,
                people,
                makeField({ label: '要记住什么？', name: 'value', value: entry?.value, placeholder: '例如：左臂受伤，暂时不能用力', textarea: true, help: '写下现在仍然成立、以后还可能影响剧情的内容。' }),
                makeField({ label: '它会怎样影响后续剧情？（可选）', name: 'cause', value: entry?.cause, placeholder: '例如：到达北港前需要重新包扎', maxLength: 120 }),
            );
        },
        readValue(form) {
            const values = new FormData(form);
            return {
                slot: String(values.get('slot') || 'other'),
                subject: String(values.get('subject') || '').trim(),
                object: String(values.get('object') || '').trim(),
                value: String(values.get('value') || '').trim(),
                cause: String(values.get('cause') || '').trim(),
            };
        },
        validate(value) {
            if (!value.subject) return '请填写这条记忆关于谁或什么。';
            if (!value.value) return '请填写要记住的内容。';
            return '';
        },
        initialFocus: '[name="subject"]',
    });
}

async function openReportDialog({ entryId = null, type = 'miss', pairIndex = null } = {}) {
    const pairs = getPairs().filter(p => p.sealed);
    if (!pairs.length) {
        await openMessageDialog({
            kicker: '无法报告',
            title: '当前还没有完整对话',
            description: '完成一轮对话后，才能把具体楼层和原文保存为纠错记录。',
        });
        return null;
    }
    let defaultPair = pairAt(pairIndex ?? pairs.at(-1)?.pairIndex ?? 0, pairs) || pairs.at(-1);
    if (entryId && pairIndex == null) {
        const entry = getChatData().state_table.entries.find(item => item.id === entryId);
        if (Number.isFinite(Number(entry?.updated_floor))) {
            const floor = Number(entry.updated_floor);
            defaultPair = pairs.find(pair => {
                const bounds = pairFloorBounds(pair);
                return bounds && floor >= bounds[0] && floor <= bounds[1];
            }) || pairAt(floor, pairs) || defaultPair;
        }
    }
    const defaultFloor = pairFloorBounds(defaultPair)?.[1] ?? 0;
    const result = await openFormDialog({
        kicker: '纠正记忆',
        title: '报告记忆问题',
        description: '选择问题类型和真实聊天楼层。保存后只会新增一条纠错记录，不会自动改写当前记忆。',
        submitLabel: '保存纠错记录',
        cancelLabel: '暂不报告',
        className: 'lm-report-dialog',
        buildFields(fields, dialog) {
            const typeField = document.createElement('fieldset');
            typeField.className = 'lm-dialog-choice-group';
            typeField.innerHTML = '<legend>这次出了什么问题？</legend>';
            const choices = [
                ['miss', '漏记了重要内容'],
                ['spurious', '记住了不该记的内容'],
                ['wrong', '记错了内容'],
            ];
            for (const [value, label] of choices) {
                const choice = document.createElement('label');
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = 'type';
                input.value = value;
                input.checked = value === type;
                choice.append(input, document.createTextNode(label));
                typeField.appendChild(choice);
            }
            const floorField = document.createElement('label');
            floorField.className = 'lm-dialog-field';
            floorField.innerHTML = '<span>问题出现在哪一楼？</span>';
            const floorInput = document.createElement('input');
            floorInput.type = 'number';
            floorInput.name = 'floor';
            floorInput.min = '0';
            floorInput.max = String(latestChatFloor(pairs) ?? defaultFloor);
            floorInput.value = String(defaultFloor);
            floorField.appendChild(floorInput);
            const source = document.createElement('section');
            source.className = 'lm-dialog-source lm-report-source';
            source.setAttribute('aria-live', 'polite');
            const updateSource = () => {
                const requested = Number(floorInput.value);
                const pair = pairs.find(item => {
                    const bounds = pairFloorBounds(item);
                    return bounds && requested >= bounds[0] && requested <= bounds[1];
                });
                if (!pair) {
                    source.innerHTML = '<h4>原文预览</h4><p class="lm-warn">没有找到包含这一楼的完整对话。</p>';
                    return;
                }
                const texts = getPairTexts(pair);
                source.innerHTML = `<h4>${escapeHtml(pairFloorRangeLabel(pair.pairIndex, pair.pairIndex, pairs))}</h4><div class="lm-dialog-source-block"><strong>用户</strong><p>${escapeHtml(texts.userText)}</p></div><div class="lm-dialog-source-block"><strong>角色</strong><p>${escapeHtml(texts.aiText)}</p></div>`;
            };
            floorInput.addEventListener('input', updateSource);
            const expectedField = document.createElement('label');
            expectedField.className = 'lm-dialog-field';
            expectedField.innerHTML = '<span>你希望插件怎样记录？</span>';
            const expected = document.createElement('textarea');
            expected.name = 'expected';
            expected.rows = 4;
            expected.maxLength = 500;
            expected.placeholder = '用一句话写出正确结果';
            expectedField.appendChild(expected);
            const syncExpected = () => {
                const selected = dialog.querySelector('[name="type"]:checked')?.value;
                expectedField.hidden = selected === 'spurious';
            };
            typeField.addEventListener('change', syncExpected);
            fields.append(typeField, floorField, source, expectedField);
            updateSource();
            syncExpected();
        },
        readValue(form) {
            const values = new FormData(form);
            return {
                type: String(values.get('type') || 'miss'),
                requestedFloor: Number(values.get('floor')),
                expectedNote: String(values.get('expected') || '').trim(),
            };
        },
        validate(value) {
            const pair = pairs.find(item => {
                const bounds = pairFloorBounds(item);
                return bounds && value.requestedFloor >= bounds[0] && value.requestedFloor <= bounds[1];
            });
            if (!pair) return `找不到第 ${value.requestedFloor} 楼对应的完整对话，请检查楼层号。`;
            if (value.type !== 'spurious' && !value.expectedNote) return '请用一句话写出希望插件记录的正确结果。';
            return '';
        },
        initialFocus: '[name="type"]:checked',
    });
    if (!result) return null;
    const pair = pairs.find(item => {
        const bounds = pairFloorBounds(item);
        return bounds && result.requestedFloor >= bounds[0] && result.requestedFloor <= bounds[1];
    });
    const snap = snapshotForPair(pair?.pairIndex);
    if (!snap) {
        await openMessageDialog({
            kicker: '无法保存',
            title: '没有找到完整原文',
            description: '这轮对话可能刚刚发生变化。请重新打开报告窗口并选择楼层。',
        });
        return null;
    }
    let expected = { note: result.expectedNote };
    if (result.type === 'spurious') {
        expected = { should_be_empty: true };
    } else if (result.expectedNote) {
        expected = { contains_value: result.expectedNote };
    }
    addEvalCase({
        pipeline: 'per_floor',
        type: result.type,
        source: 'panel_report',
        floor_key: snap.floor_key,
        user_mes: snap.user_mes,
        ai_mes: snap.ai_mes,
        state_table_snapshot: snap.state_table_snapshot,
        expected,
        note: result.expectedNote,
    });
    toastr?.success?.('纠错记录已保存，可在“设置 → 开发者工具”中查看。');
    return true;
}

export function turnSummaryDisplaySource(data) {
    const rebuild = data.history_rebuild;
    const currentTotal = getPairs().filter(pair => pair.sealed).length;
    const stalePausedState = rebuild && ['stopped', 'error', 'review'].includes(rebuild.status)
        && Number(rebuild.total) !== currentTotal;
    const rebuilding = rebuild && rebuild.status !== 'complete' && !stalePausedState && Array.isArray(rebuild.turn_summaries);
    const stagedItems = rebuilding ? normalizedTurnSummaries({ turn_summaries: rebuild.turn_summaries }) : [];
    if (stagedItems.length) return { items: rebuild.turn_summaries, staged: true, source: 'staged' };

    const matchingFormal = currentMatchingTurnSummaries(data);
    const rawFormal = data.turn_summaries || [];
    const items = matchingFormal.length ? matchingFormal : rawFormal;
    return {
        items,
        staged: false,
        source: rebuilding && items.length ? 'formal_during_rebuild'
            : matchingFormal.length ? 'formal' : rawFormal.length ? 'legacy_formal' : 'empty',
    };
}

function renderTurnsTab() {
    const data = getChatData();
    const snapshot = getHistoryRebuildSnapshot();
    const source = turnSummaryDisplaySource(data);
    const turns = normalizedTurnSummaries({ turn_summaries: source.items });
    const formalCount = normalizedTurnSummaries(data).length;
    const size = getSettings().chapterSize || 25;
    const groups = [];
    for (let offset = 0; offset < turns.length; offset += size) {
        const items = turns.slice(offset, offset + size);
        groups.push({ items, partial: items.length < size });
    }
    const chapterRunning = snapshot.stage_mode === 'chapters' && ['running', 'stopping'].includes(snapshot.status);
    const remaining = Math.max(0, (snapshot.turnProgress?.total || 0) - (snapshot.turnProgress?.completed || 0));
    const countLabel = source.source === 'staged' ? `新记录 ${turns.length} 轮 · 还剩 ${remaining} 轮对话`
        : source.source === 'formal_during_rebuild' ? `正式记录 ${turns.length} 轮 · 重建还剩 ${remaining} 轮对话`
            : `已生成 ${turns.length} / ${snapshot.turnProgress?.total || turns.length} 轮`;
    const sourceTitle = source.source === 'staged' ? '当前显示本次重建草稿'
        : source.source === 'formal_during_rebuild' ? '本次重建尚无草稿，当前显示原来的正式记录'
            : source.source === 'legacy_formal' ? '当前显示旧版本保存的正式记录'
                : '编辑会保留为人工修改';
    const sourceDetail = source.source === 'formal_during_rebuild'
        ? `原来的 ${formalCount} 轮记录没有被删除；本次重建还有 ${remaining} 轮对话未整理。`
        : chapterRunning ? '章节正在生成；为避免当前章节使用旧内容，请先停止章节任务再编辑。'
            : '编辑这里只改变剧情记录；人物身份、关系和其他结构化事实请到“当前记忆”修改。';
    let html = `<div class="lm-page-heading"><div><span class="lm-kicker">每轮对话都保留</span><h3>对话记录</h3><p>一轮记录包含一条用户消息和紧随其后的角色回复，并直接标出酒馆里的真实楼层。</p><small>${escapeHtml(floorProgressText(snapshot.turnProgress?.completed || 0, snapshot.turnProgress?.total || 0, source.items))}</small></div><div class="lm-page-count">${escapeHtml(countLabel)}</div></div>`;
    html += '<div class="lm-page-content lm-turns-content">';
    html += `<div class="lm-workflow-progress">${renderTurnProgressCard(snapshot, { controls: true, showOpen: false, preservedCount: formalCount })}</div>`;
    html += `<aside class="lm-quality-alert"><span class="fa-solid fa-pen" aria-hidden="true"></span><div><strong>${escapeHtml(sourceTitle)}</strong><p>${escapeHtml(sourceDetail)}</p></div></aside>`;
    html += '<div class="lm-turn-list">';
    for (const group of groups.reverse()) {
        html += renderTurnSummaryDisclosure(group.items, {
            draft: source.staged,
            editable: !chapterRunning,
            partial: group.partial,
        });
    }
    if (!turns.length) {
        html += '<div class="lm-empty-state"><span class="fa-solid fa-list-ol" aria-hidden="true"></span><h3>还没有对话记录</h3><p>点击上方按钮后，每轮记录会按真实聊天楼层出现在这里。</p></div>';
    }
    html += '</div></div>';
    return html;
}

function renderChaptersTab() {
    const data = getChatData();
    const snapshot = getHistoryRebuildSnapshot();
    const rebuilding = data.history_rebuild && data.history_rebuild.status !== 'complete' && Array.isArray(data.history_rebuild.chapters);
    const staged = rebuilding && data.history_rebuild.chapters.length > 0;
    const showingPreserved = rebuilding && !staged && (data.chapters || []).length > 0;
    const chapters = [...(staged ? data.history_rebuild.chapters : (data.chapters || []))]
        .sort((a, b) => (b.floor_range?.[1] || 0) - (a.floor_range?.[1] || 0));
    const volumes = staged ? [] : (data.volumes || []);
    const hasStoryTime = chapters.some(chapter => chapter.story_time_range?.label);
    let html = `<div class="lm-page-heading"><div><span class="lm-kicker">按章节回顾</span><h3>章节摘要</h3><p>只根据已经确认的对话记录生成；关键事件优先展示，完整摘要按需展开。</p></div><div class="lm-page-count">${snapshot.chapterProgress?.completed || chapters.length} / ${snapshot.chapterProgress?.total || chapters.length} 章</div></div>`;
    html += '<div class="lm-page-content lm-chapters-content">';
    html += `<div class="lm-workflow-progress">${renderChapterProgressCard(snapshot, { controls: true, showOpen: false })}</div>`;
    if (showingPreserved) {
        html += `<aside class="lm-quality-alert"><span class="fa-solid fa-book" aria-hidden="true"></span><div><strong>本次重建尚无章节草稿，当前显示原来的章节摘要</strong><p>原来的 ${chapters.length} 章没有被删除；重建全部通过后才会一次性替换。</p></div></aside>`;
    }
    if (volumes.length) {
        html += '<section class="lm-volume-strip"><h4>很久以前的剧情</h4><div>';
        for (const v of volumes) {
            html += `<article class="lm-volume-card"><header><b>${escapeHtml(formatArchiveLabel(v.id, '长期摘要'))}</b>${v.stale ? '<span class="lm-state-tag" data-state="error">等待重新整理</span>' : '<span class="lm-state-tag">已整理</span>'}</header><p>${escapeHtml(displayNarrativeText(v.summary))}</p></article>`;
        }
        html += '</div></section>';
    }
    if (chapters.length && !hasStoryTime) {
        html += '<p class="lm-time-note"><span class="fa-solid fa-clock" aria-hidden="true"></span>这些章节的原文没有明确剧情时间，因此不会显示推测日期。</p>';
    }
    html += '<section class="lm-timeline" aria-label="章节列表">';
    for (const c of chapters) {
        const state = c.stale_reason === 'turn_summary_edit' ? '<span class="lm-state-tag" data-state="error">对话记录已修改 · 等待更新本章</span>'
            : c.stale ? '<span class="lm-state-tag" data-state="error">原对话已修改 · 等待重新整理</span>'
            : c.demoted ? '<span class="lm-state-tag">已整理进长期摘要</span>'
                : '<span class="lm-state-tag" data-state="success">摘要已保存</span>';
        const qualityState = Array.isArray(c.quality_warnings) && c.quality_warnings.length
            ? '<span class="lm-state-tag">概述较精简 · 已完整覆盖</span>'
            : '';
        const events = Array.isArray(c.key_events) ? c.key_events.filter(event => event?.text).slice(0, 6) : [];
        const summaryLabel = '查看完整摘要';
        html += `<article class="lm-chapter-card" data-cid="${escapeHtml(c.id)}" data-staged="${staged ? 'true' : 'false'}">
            <span class="lm-timeline-node" aria-hidden="true"></span>
            <header><div><span class="lm-kicker">剧情章节</span><h4>${pairFloorRangeLabel(c.floor_range?.[0], c.floor_range?.[1])}</h4>${c.story_time_range?.label ? `<small class="lm-story-time">剧情时间：${escapeHtml(c.story_time_range.label)}</small>` : ''}</div><div class="lm-chapter-state">${c.pinned ? '<span class="fa-solid fa-thumbtack" title="始终保留" aria-label="始终保留"></span>' : ''}${state}${qualityState}</div></header>
            ${events.length ? `<section class="lm-key-events"><h5>关键事件</h5><ol>${events.map(event => `<li><span>${pairFloorRangeLabel(event.floor_range?.[0], event.floor_range?.[1])}</span>${escapeHtml(displayNarrativeText(event.text))}</li>`).join('')}</ol></section>` : ''}
            ${c.keywords?.length ? `<div class="lm-keywords">${c.keywords.map(k => `<span>${escapeHtml(k)}</span>`).join('')}</div>` : ''}
            <details class="lm-chapter-summary" data-closed-label="${summaryLabel}" data-open-label="收起完整摘要"><summary><span>${summaryLabel}</span></summary><p>${escapeHtml(displayNarrativeText(c.summary))}</p></details>
            ${staged ? '' : `<div class="lm-row-actions">
                <button type="button" data-act="edit" class="lm-text-button">编辑摘要</button>
                ${c.stale_reason === 'turn_summary_edit' ? '<button type="button" data-act="regenerate" class="lm-button">根据修改后的记录重新生成本章</button>' : ''}
                <button type="button" data-act="pin" class="lm-text-button">${c.pinned ? '恢复自动整理' : '始终保留本章'}</button>
            </div>`}
        </article>`;
    }
    html += '</section>';
    if (!chapters.length) {
        html += `<div class="lm-empty-state"><span class="fa-solid fa-book-open" aria-hidden="true"></span><h3>还没有章节摘要</h3><p>${snapshot.chapterProgress?.status === 'locked' ? '先生成完整的对话记录，再由你决定是否生成章节。' : '点击上方按钮后，只会处理已经凑满一章的记录。'}</p></div>`;
    }
    html += '</div>';
    return html;
}

export function normalizedTurnSummaries(data) {
    return (data?.turn_summaries || [])
        .filter(item => Number.isInteger(item?.pairIndex) && String(item?.summary || '').trim())
        .map(item => ({ pairIndex: item.pairIndex, summary: String(item.summary).trim(), story_time: item.story_time || null, manual_override: Boolean(item.manual_override) }))
        .sort((a, b) => a.pairIndex - b.pairIndex);
}

export function uncoveredTurnSummaryGroups(turnSummaries, chapters) {
    const covered = turnSummaries.filter(item => (chapters || []).some(chapter => {
        const [start, end] = chapter.floor_range || [];
        return Number.isInteger(start) && Number.isInteger(end) && item.pairIndex >= start && item.pairIndex <= end;
    }));
    const coveredFloors = new Set(covered.map(item => item.pairIndex));
    const groups = [];
    for (const item of turnSummaries.filter(summary => !coveredFloors.has(summary.pairIndex))) {
        const current = groups.at(-1);
        if (current && current.at(-1).pairIndex + 1 === item.pairIndex) current.push(item);
        else groups.push([item]);
    }
    return groups.reverse();
}

function renderTurnSummaryDisclosure(items, { loose = false, draft = false, editable = false, partial = false } = {}) {
    if (!items.length) return '';
    const start = items[0].pairIndex;
    const end = items.at(-1).pairIndex;
    const subject = draft
        ? `${partial ? '尚未凑满一章 · ' : ''}${pairFloorRangeLabel(start, end)} · ${items.length} 轮草稿`
        : loose
            ? `尚未合并的对话记录 · ${pairFloorRangeLabel(start, end)} · ${items.length} 轮`
            : `${items.length} 轮对话记录`;
    const closedLabel = `查看 ${subject}`;
    const openLabel = `收起 ${subject}`;
    return `<details class="lm-turn-records ${loose || draft ? 'lm-turn-records-loose' : ''}" data-closed-label="${escapeHtml(closedLabel)}" data-open-label="${escapeHtml(openLabel)}">
        <summary><span>${escapeHtml(closedLabel)}</span></summary>
        ${loose ? '<p>这些记录还没有凑满一章；Fork 或精简到这里时，插件会直接使用它们。</p>' : ''}
        ${draft && partial ? '<p>这部分会保留为对话记录，不会因为不足一章而丢失；以后凑满章节所需记录后再合并。</p>' : ''}
        <ol>${items.map(item => `<li><span>${pairFloorRangeLabel(item.pairIndex)}${item.manual_override ? '<em>人工修改</em>' : ''}${item.story_time?.label ? `<em class="lm-time-label">${escapeHtml(item.story_time.label)}</em>` : ''}</span><p>${escapeHtml(displayNarrativeText(item.summary))}</p>${editable ? `<button type="button" class="lm-text-button" data-turn-edit="${item.pairIndex}" data-draft="${draft ? 'true' : 'false'}">编辑</button>` : ''}</li>`).join('')}</ol>
    </details>`;
}

function bindDisclosureLabels(body) {
    body?.querySelectorAll('details[data-closed-label]').forEach(details => {
        const summary = details.querySelector(':scope > summary');
        const label = summary?.querySelector('span');
        const sync = () => {
            summary?.setAttribute('aria-expanded', String(details.open));
            if (label) label.textContent = details.open ? details.dataset.openLabel : details.dataset.closedLabel;
        };
        details.addEventListener('toggle', sync);
        sync();
    });
    body?.querySelectorAll('.lm-settings-disclosure').forEach(details => {
        const summary = details.querySelector(':scope > summary');
        const label = summary?.querySelector('.lm-disclosure-label');
        const sync = () => {
            summary?.setAttribute('aria-expanded', String(details.open));
            if (label) label.textContent = details.open ? '收起' : '展开';
        };
        details.addEventListener('toggle', sync);
        sync();
    });
}

function bindTurnsTab(body) {
    bindHistoryBackfillControls(body, body);
    bindDisclosureLabels(body);
    body.querySelectorAll('[data-turn-edit]').forEach(button => {
        button.addEventListener('click', async () => {
            const data = getChatData();
            const pairIndex = Number(button.dataset.turnEdit);
            const draft = button.dataset.draft === 'true';
            const collection = draft ? data.history_rebuild?.turn_summaries : data.turn_summaries;
            const item = collection?.find(summary => summary.pairIndex === pairIndex);
            if (!item) return;
            const pair = pairAt(pairIndex);
            const texts = pair ? getPairTexts(pair) : { userText: '', aiText: '' };
            const edited = await openTextEditorDialog({
                kicker: draft ? '修改记录草稿' : '修改对话记录',
                title: `编辑${pairFloorRangeLabel(pairIndex)}`,
                description: '这里只修改这轮对话的剧情记录，不会改变“当前记忆”中的结构化事实。',
                label: '这轮对话发生了什么？',
                value: displayNarrativeText(item.summary),
                sourceSections: [
                    { label: '用户原文', text: texts.userText || '没有可显示的用户原文' },
                    { label: '角色回复', text: texts.aiText || '没有可显示的角色回复' },
                ],
                saveLabel: '保存对话记录',
            });
            if (edited == null) return;
            const summary = normalizeHistoryUserSummary(edited, SillyTavern.getContext().name1 || '');
            item.summary = summary;
            item.manual_override = true;
            item.updatedAt = Date.now();
            if (draft) {
                data.history_rebuild.chapters = (data.history_rebuild.chapters || []).filter(chapter =>
                    pairIndex < chapter.floor_range?.[0] || pairIndex > chapter.floor_range?.[1]);
            } else {
                const floorEvent = (data.floor_events || []).find(event => event.pairIndex === pairIndex);
                if (floorEvent) floorEvent.turnSummary = summary;
                markChapterStaleForTurnSummaryEdit(data, pairIndex);
            }
            await saveChatData(data);
            updateInjection();
            renderActiveTab();
            toastr?.success?.(draft ? '记录草稿已保存。生成章节时会使用修改后的内容。' : '记录已保存，只需重新生成它所属的章节。');
        });
    });
}

function bindChaptersTab(body) {
    bindHistoryBackfillControls(body, body);
    bindDisclosureLabels(body);
    body.querySelectorAll('article[data-cid]').forEach(card => {
        if (card.dataset.staged === 'true') return;
        const id = card.dataset.cid;
        card.querySelector('[data-act="edit"]')?.addEventListener('click', async () => {
            const c = getChatData().chapters.find(x => x.id === id);
            if (!c) {
                return;
            }
            const summary = await openTextEditorDialog({
                kicker: '人工修改章节',
                title: `编辑${pairFloorRangeLabel(c.floor_range?.[0], c.floor_range?.[1])}`,
                description: '保存后这段摘要会标记为人工修改；除非原对话发生变化，否则插件不会自动改写。',
                label: '完整章节摘要',
                value: c.summary,
                sourceSections: (c.key_events || []).slice(0, 6).map((event, index) => ({
                    label: `关键事件 ${index + 1} · ${pairFloorRangeLabel(event.floor_range?.[0], event.floor_range?.[1])}`,
                    text: event.text || '没有事件说明',
                })),
                saveLabel: '保存章节摘要',
            });
            if (summary == null) {
                return;
            }
            c.summary = summary;
            c.frozen = true;
            c.stale = false;
            c.manual_override = true;
            await saveChatData();
            updateInjection();
            renderActiveTab();
        });
        card.querySelector('[data-act="pin"]')?.addEventListener('click', async () => {
            const c = getChatData().chapters.find(x => x.id === id);
            if (c) {
                c.pinned = !c.pinned;
                await saveChatData();
                renderActiveTab();
            }
        });
        card.querySelector('[data-act="regenerate"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const chapter = data.chapters.find(candidate => candidate.id === id);
            if (!chapter) return;
            const button = card.querySelector('[data-act="regenerate"]');
            if (button) button.disabled = true;
            enqueue('chapter_summary', {
                startPair: chapter.floor_range[0], endPair: chapter.floor_range[1], reason: 'turn_summary_edit',
            }, QUEUE_PRIORITY.chapter_summary);
            toastr?.info?.(`只会重新生成${pairFloorRangeLabel(chapter.floor_range[0], chapter.floor_range[1])}这一章。`);
            renderActiveTab();
        });
    });
}

function renderReviewTab() {
    const q = (getChatData().review_queue || []).filter(item => item.kind !== 'alert');
    const entries = getChatData().state_table?.entries || [];
    let html = `<div class="lm-page-heading"><div><span class="lm-kicker">待处理</span><h3>待处理</h3><p>插件不会悄悄修改有冲突的记忆。请在这里决定是否采用建议。</p></div><div class="lm-page-count">${q.length} 项</div></div><div class="lm-page-content lm-review-content"><div class="lm-review-list">`;
    for (const item of q) {
        const kind = item.kind === 'flag_conflict' ? '两条记忆互相矛盾' : item.kind === 'proofread' ? '检查后发现的建议' : item.kind === 'volume_compress_ask' ? '整理旧摘要前确认' : '需要注意';
        const risk = item.kind === 'flag_conflict' ? 'error' : item.kind === 'proofread' ? 'warning' : 'info';
        const relatedEntry = entries.find(entry => entry.id === item.entry_id);
        const title = item.subject || relatedEntry?.subject || '一条记忆建议';
        const needsEdit = (item.kind === 'flag_conflict' && !item.candidate_id)
            || (item.kind === 'proofread' && item.op !== 'add');
        const canApprove = item.kind === 'volume_compress_ask' || Boolean(item.candidate_id)
            || item.kind === 'proofread' || Boolean(relatedEntry);
        const approveLabel = needsEdit ? '查看并编辑' : '采用这条建议';
        html += `<article class="lm-review-card" data-rid="${escapeHtml(item.id)}">
            <div class="lm-review-mark" data-state="${risk}" aria-hidden="true"></div>
            <div class="lm-review-copy"><span class="lm-state-tag" data-state="${risk}">${kind}</span><h4>${escapeHtml(title)}</h4><p>${escapeHtml(formatReviewNote(item.note || item.value || '需要你的确认'))}</p>${item.object ? `<small>关联：${escapeHtml(item.object)}</small>` : ''}</div>
            <div class="lm-row-actions">
                <button type="button" data-act="reject" class="lm-text-button">不采用</button>
                ${canApprove ? `<button type="button" data-act="approve" class="lm-button lm-button-primary">${approveLabel}</button>` : ''}
            </div>
        </article>`;
    }
    html += '</div>';
    if (!q.length) {
        html += '<div class="lm-empty-state"><span class="fa-solid fa-check" aria-hidden="true"></span><h3>现在没有待处理内容</h3><p>以后发现互相矛盾的记忆或需要核对的整理建议时，它们会出现在这里。</p></div>';
    }
    html += '</div>';
    return html;
}

function bindReviewTab(body) {
    body.querySelectorAll('[data-rid]').forEach(li => {
        const id = li.dataset.rid;
        li.querySelector('[data-act="reject"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const item = data.review_queue.find(x => x.id === id);
            if (item?.candidate_id) {
                const pair = getPairs().filter(candidate => candidate.sealed).at(-1);
                dismissFactCandidate(data, item.candidate_id, pair ? {
                    floorKey: pair.floorKey,
                    pairIndex: pair.pairIndex,
                    contentFingerprint: pair.contentFingerprint,
                } : {});
            }
            data.review_queue = data.review_queue.filter(x => x.id !== id);
            await saveChatData(data);
            renderActiveTab();
        });
        li.querySelector('[data-act="approve"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const item = data.review_queue.find(x => x.id === id);
            if (!item) {
                return;
            }
            let applied = false;
            if (item.kind === 'volume_compress_ask') {
                enqueue('volume_compress', { confirmed: true, force: true }, QUEUE_PRIORITY.volume_compress);
                applied = true;
            } else if (item.kind === 'proofread') {
                const current = item.entry_id ? data.state_table.entries.find(entry => entry.id === item.entry_id) : null;
                if (item.op !== 'add' && !current) {
                    toastr?.error?.('原来的事实已经不存在，这条建议没有被删除。');
                    return;
                }
                const proposed = {
                    ...(current || {}),
                    slot: item.slot || current?.slot || 'other',
                    subject: item.subject || current?.subject || '',
                    object: item.object || current?.object || '',
                    value: item.value || current?.value || '',
                };
                const draft = await openEntryEditor(proposed);
                if (!draft) return;
                if (current) {
                    const before = structuredClone(current);
                    Object.assign(current, draft, { source: 'manual', manual_override: true, updated_floor: 'manual' });
                    data.state_table.version += 1;
                    recordManualEvent(data, { op: 'upsert', before, after: current, reason: 'proofread_edit_approval' });
                } else {
                    const entry = {
                        id: `e_${String(data.progress.next_entry_seq++).padStart(4, '0')}`,
                        ...draft,
                        established_floor: 'proofread', updated_floor: 'manual', evidence: '',
                        pinned: false, source: 'manual', manual_override: true,
                    };
                    data.state_table.entries.push(entry);
                    data.state_table.version += 1;
                    recordManualEvent(data, { op: 'upsert', after: entry, reason: 'proofread_add_approval' });
                }
                applied = true;
            } else if (item.kind === 'flag_conflict' && item.candidate_id) {
                const pair = getPairs().filter(candidate => candidate.sealed).at(-1);
                const result = activateFactCandidate(data, item.candidate_id, pair ? {
                    floorKey: pair.floorKey,
                    pairIndex: pair.pairIndex,
                    contentFingerprint: pair.contentFingerprint,
                } : {});
                if (!result || result.error) {
                    toastr?.error?.(result?.error || '这条候选事实已经不存在，待处理项仍会保留。');
                    return;
                }
                if (result?.entry && !result.existed) {
                    for (const replaced of result.replaced || []) {
                        recordManualEvent(data, { op: 'delete', before: replaced, after: null, reason: 'conflict_candidate_superseded', sourceCandidate: result.candidate });
                    }
                    recordManualEvent(data, { op: 'upsert', before: null, after: result.entry, reason: 'conflict_candidate_approval', sourceCandidate: result.candidate });
                }
                applied = true;
            } else if (item.kind === 'flag_conflict' && item.entry_id) {
                const current = data.state_table.entries.find(entry => entry.id === item.entry_id);
                if (!current) {
                    toastr?.error?.('发生矛盾的原事实已经不存在，待处理项仍会保留。');
                    return;
                }
                const before = structuredClone(current);
                const draft = await openEntryEditor(current);
                if (!draft) return;
                Object.assign(current, draft, { source: 'manual', manual_override: true, updated_floor: 'manual' });
                data.state_table.version += 1;
                recordManualEvent(data, { op: 'upsert', before, after: current, reason: 'conflict_manual_resolution' });
                applied = true;
            }
            if (!applied) return;
            data.review_queue = data.review_queue.filter(x => x.id !== id);
            await saveChatData(data);
            updateInjection();
            renderActiveTab();
        });
    });
}

function renderSettingsTab() {
    const s = getSettings();
    const profiles = listConnectionProfiles();
    const profileOpts = profiles.map(p => {
        const id = p.id || p.name || p;
        const name = p.name || p.id || p;
        const model = p.model || p.modelId || p.model_id || '';
        const label = model ? `${name} — ${model}` : name;
        return `<option value="${escapeHtml(String(id))}" ${String(s.connectionProfile) === String(id) ? 'selected' : ''}>${escapeHtml(String(label))}</option>`;
    }).join('');
    const modelSource = ['direct', 'profile', 'current'].includes(s.memoryModelSource) ? s.memoryModelSource : 'current';

    const q = getQueueSnapshot();
    const rebuild = getHistoryRebuildSnapshot();
    const baseline = getChatData().progress?.baseline_pair;
    const currentPairs = getPairs().filter(pair => pair.sealed);
    const nextFloor = pairFloorBounds(pairAt((baseline ?? -1) + 1, currentPairs))?.[0]
        ?? ((latestChatFloor(currentPairs) ?? -1) + 1);
    const baselineText = baseline == null ? '插件还没有开始记录这段聊天'
        : baseline < 0 ? '这是一段新聊天，所有对话都会自动整理'
            : `插件将从第 ${nextFloor} 楼开始自动记录；更早的内容可以在这里补记`;
    return `
        <div class="lm-page-heading"><div><span class="lm-kicker">使用设置</span><h3>设置</h3><p>决定以后怎样连接模型、整理对话和使用相关旧记忆。</p></div></div>
        <div class="lm-settings-layout">
            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-plug" aria-hidden="true"></span><div><h4>记忆模型连接</h4><p>选择用哪个模型整理记忆，并决定插件是否工作。</p></div></div></header>
                <div class="lm-settings-fields">
                    <label class="lm-switch-row"><span><b>启用记忆插件</b><small>关闭后不再向模型发送记忆，也不会开始新的整理工作。</small></span><input type="checkbox" id="lm-enabled" ${s.enabled ? 'checked' : ''}/></label>
                    <label>记忆模型从哪里连接？
                        <small>三种方式互不兜底。你选哪一种，插件就只用哪一种，不会失败后偷偷换模型。</small>
                        <select id="lm-model-source">
                            <option value="direct" ${modelSource === 'direct' ? 'selected' : ''}>自己填写 API、密钥和模型</option>
                            <option value="profile" ${modelSource === 'profile' ? 'selected' : ''}>使用 SillyTavern 已保存的连接</option>
                            <option value="current" ${modelSource === 'current' ? 'selected' : ''}>跟随当前聊天模型</option>
                        </select>
                    </label>
                    <div class="lm-model-source-panel" data-model-source="direct" ${modelSource === 'direct' ? '' : 'hidden'}>
                        <div class="lm-field-grid">
                            <label>模型服务地址<small>填写 OpenAI 兼容接口的基础地址，例如 https://api.deepseek.com。</small><input id="lm-direct-url" type="url" inputmode="url" placeholder="https://api.deepseek.com" value="${escapeHtml(s.directBaseUrl)}"/></label>
                            <label>模型名称<small>可以手动填写，也可以先获取服务商提供的模型列表。</small><input id="lm-direct-model" list="lm-direct-model-list" placeholder="deepseek-v4-flash" value="${escapeHtml(s.directModel)}"/><datalist id="lm-direct-model-list"></datalist></label>
                        </div>
                        <label>访问密钥<small>只保存在你的 SillyTavern 设置中，检查结果和日志不会显示密钥。</small><input id="lm-direct-key" placeholder="${s.directApiKey ? '已经保存；留空不会更改' : '请输入服务商提供的密钥'}" type="password" value="" autocomplete="new-password"/></label>
                        ${s.directApiKey ? '<label class="lm-compact-check"><input type="checkbox" id="lm-direct-clear-key"/> 删除已经保存的访问密钥</label>' : ''}
                        <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-list-models">获取模型列表</button><output id="lm-model-list-result" class="lm-connection-result" aria-live="polite"></output></div>
                    </div>
                    <div class="lm-model-source-panel" data-model-source="profile" ${modelSource === 'profile' ? '' : 'hidden'}>
                        <label>选择已保存的连接<small>列表同时显示连接名称和它当前保存的模型。</small><select id="lm-profile"><option value="">请选择一个已保存的连接</option>${profileOpts}</select></label>
                        <label>临时改用另一个模型（可选）<small>留空时使用该连接中保存的模型；填写后只替换模型名称，不改变地址和密钥。</small><input id="lm-profile-model" placeholder="留空则使用连接配置中的模型" value="${escapeHtml(s.profileModelOverride)}"/></label>
                    </div>
                    <div class="lm-model-source-panel" data-model-source="current" ${modelSource === 'current' ? '' : 'hidden'}>
                        <p class="lm-security-note"><span class="fa-solid fa-circle-info" aria-hidden="true"></span>插件会跟着当前聊天正在使用的模型走。你在酒馆里切换聊天模型后，记忆模型也会一起改变；这里不能单独指定模型。</p>
                    </div>
                    <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-test-connection">测试连接</button><output id="lm-connection-result" class="lm-connection-result" aria-live="polite"></output></div>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></span><div><h4>自动整理</h4><p>决定多久生成章节、检查事实和提醒你处理冲突。</p></div></div></header>
                <div class="lm-settings-fields lm-field-grid">
                    <label>每多少轮整理一次剧情摘要
                        <small>推荐 25。数值越小，摘要更新越频繁，也会产生更多后台请求。</small>
                        <input type="number" id="lm-ch" min="5" value="${s.chapterSize}"/>
                    </label>
                    <label>每多少轮自动检查一次记忆
                        <small>推荐 75。发现矛盾时会先请你确认，不会直接覆盖已有记忆。</small>
                        <input type="number" id="lm-pr" min="5" value="${s.proofreadEvery}"/>
                    </label>
                </div>
                <div class="lm-settings-fields">
                    <label class="lm-switch-row"><span><b>精简很久以前的摘要前先询问我</b><small>需要进一步压缩旧剧情时，先放到“待处理”页面。</small></span><input type="checkbox" id="lm-vc" ${s.volumeCompressConfirm ? 'checked' : ''}/></label>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-paper-plane" aria-hidden="true"></span><div><h4>相关旧记忆</h4><p>按需找回与当前内容直接相关的旧人物、物品或地点。</p></div></div></header>
                <div class="lm-settings-fields">
                    <label class="lm-switch-row"><span><b>需要时找回相关的旧记忆</b><small>当前对话提到旧人物、物品或地点时，尝试找回相关剧情。只靠关键词判断，默认关闭。</small></span><input type="checkbox" id="lm-l4" ${s.l4Enabled ? 'checked' : ''}/></label>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-puzzle-piece" aria-hidden="true"></span><div><h4>兼容性</h4><p>告诉插件怎样从角色回复中识别真正的正文。</p></div></div></header>
                <div class="lm-settings-fields">
                    <label>AI 正文提取规则
                        <small>插件只整理规则中第一个括号捕获的正文。留空会读取整条回复；规则偶尔失效时也会自动读取整条回复，不会漏掉这一轮。</small>
                        <textarea id="lm-body-regex" rows="2" spellcheck="false" placeholder="例如：&lt;content&gt;([\\s\\S]*?)&lt;/content&gt;">${escapeHtml(s.bodyExtractionRegex)}</textarea>
                    </label>
                    <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-test-body">用最近一条回复测试</button><output id="lm-body-result" class="lm-connection-result" aria-live="polite"></output></div>
                    <p class="lm-security-note"><span class="fa-solid fa-circle-info" aria-hidden="true"></span>插件会自动从 Chat Completion 请求中隐藏已经接管的旧前文，不需要再为不同预设编写“删除历史”的正则。如果预设仍主动要求模型每轮另写一份摘要，可自行关闭那条生成指令；插件不会修改预设。</p>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-clock-rotate-left" aria-hidden="true"></span><div><h4>历史与恢复</h4><p>${escapeHtml(baselineText)}</p></div></div></header>
                <div class="lm-settings-fields">
                    <p>完整的生成和重建操作分别放在“对话记录”和“章节”页面；这里仅显示当前状态和恢复入口。</p>
                    <div class="lm-workflow-links">
                        <div><span><b>对话记录</b><small>${escapeHtml(floorProgressText(rebuild.turnProgress?.completed || 0, rebuild.turnProgress?.total || 0, getChatData().history_rebuild?.turn_summaries || []))}</small></span><button type="button" class="lm-text-button" data-settings-jump="turns">前往对话记录</button></div>
                        <div><span><b>章节</b><small>${escapeHtml(`${rebuild.chapterProgress?.completed || 0} / ${rebuild.chapterProgress?.total || 0} 章`)}</small></span><button type="button" class="lm-text-button" data-settings-jump="chapters">前往章节</button></div>
                    </div>
                    ${getChatData().rebuild_backup ? '<div class="lm-settings-actions"><button type="button" class="lm-button lm-button-danger" id="lm-restore-rebuild">恢复重建前结果</button></div>' : ''}
                </div>
            </section>

            <details class="lm-settings-section lm-settings-disclosure">
                <summary><div><span class="fa-solid fa-sliders" aria-hidden="true"></span><div><h4>高级设置</h4><p>记忆容量和相关旧记忆的发送位置。不了解这些选项时，请保持默认。</p></div></div><span class="lm-disclosure-label">展开</span></summary>
                <div class="lm-settings-fields lm-field-grid lm-field-grid-three">
                    <label>近期完整原文容量<small>按插件统一估算，固定保留连续完整楼层，不依赖模型上下文。推荐 16000。</small><select id="lm-raw-tokens"><option value="8000" ${s.recentRawTokens === 8000 ? 'selected' : ''}>8000</option><option value="16000" ${s.recentRawTokens === 16000 ? 'selected' : ''}>16000（推荐）</option><option value="32000" ${s.recentRawTokens === 32000 ? 'selected' : ''}>32000</option></select></label>
                    <label>当前事实容量<small>长期有效的人物状态、关系和约定。推荐 2000。</small><input type="number" id="lm-b1" min="200" value="${s.budgetL1}"/></label>
                    <label>剧情摘要容量<small>以前发生过的剧情。推荐 5000。</small><input type="number" id="lm-b2" min="500" value="${s.budgetL2}"/></label>
                    <label>相关旧记忆容量<small>临时找回的旧内容。推荐 1500。</small><input type="number" id="lm-b4" min="0" value="${s.budgetL4}"/></label>
                    <label>相关旧记忆的发送位置<small>推荐 4，让临时找回的内容靠近最近对话。</small><input type="number" id="lm-d4" min="0" value="${s.depthL4}"/></label>
                </div>
            </details>

            <details class="lm-settings-section lm-settings-disclosure">
                <summary><div><span class="fa-solid fa-screwdriver-wrench" aria-hidden="true"></span><div><h4>开发者工具</h4><p>查看纠错记录和后台处理状态。普通使用不需要打开。</p></div></div><span class="lm-disclosure-label">展开</span></summary>
                <div class="lm-settings-fields">
                    <label class="lm-switch-row"><span><b>整理旧聊天后收集我的修改</b><small>把手动修改保存成纠错参考，方便以后检查记忆效果。</small></span><input type="checkbox" id="lm-mig-review" ${s.migrationReviewMode ? 'checked' : ''}/></label>
                    <p>纠错记录 ${listEvalCases().length} 条 · 正在处理 ${q.inFlight ? '1' : '0'} 项 · 等待 ${q.queued?.length || 0} 项 · 需要处理 ${q.failed?.length || 0} 项</p>
                    <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-eval-export">下载纠错记录</button><button type="button" class="lm-text-button" id="lm-eval-rerun">重新检查全部记录</button></div>
                    <ul class="lm-diagnostic-list">${listEvalCases().slice(-10).reverse().map(c =>
        `<li><span>${escapeHtml(formatEvalCaseLabel(c))}</span><span><button type="button" class="lm-text-button lm-rerun-one" data-id="${escapeHtml(c.id)}">重新检查</button><button type="button" class="lm-text-button lm-del-case" data-id="${escapeHtml(c.id)}">删除</button></span></li>`).join('')}</ul>
                </div>
            </details>
        </div>
        <div class="lm-settings-savebar"><span>修改后请保存</span><button type="button" class="lm-button lm-button-primary" id="lm-save">保存设置</button></div>
    `;
}

function bindSettingsTab(body) {
    bindDisclosureLabels(body);
    body.querySelectorAll('input, select, textarea').forEach(control => {
        control.addEventListener('input', () => { settingsDirty = true; });
        control.addEventListener('change', () => { settingsDirty = true; });
    });
    body.querySelector('#lm-restore-rebuild')?.addEventListener('click', async () => {
        const backup = getChatData().rebuild_backup;
        const confirmed = await openConfirmDialog({
            kicker: '历史与恢复',
            title: '恢复重建前的结果？',
            description: '当前自动生成的重建结果会被替换；手动聊天内容不会改变。',
            details: [
                `恢复 ${backup?.state_table?.entries?.length || 0} 条当前记忆`,
                `恢复 ${backup?.turn_summaries?.length || 0} 轮对话记录`,
                `恢复 ${backup?.chapters?.length || 0} 个章节`,
            ],
            confirmLabel: '恢复重建前结果',
            cancelLabel: '保留当前结果',
        });
        if (!confirmed) return;
        if (await restoreRebuildBackup()) {
            updateInjection();
            renderActiveTab();
            toastr?.success?.('已经恢复重建前的记忆结果。');
        }
    });
    const syncModelSourcePanels = () => {
        const source = body.querySelector('#lm-model-source')?.value || 'current';
        body.querySelectorAll('[data-model-source]').forEach(section => {
            section.hidden = section.dataset.modelSource !== source;
        });
    };
    body.querySelector('#lm-model-source')?.addEventListener('change', syncModelSourcePanels);
    syncModelSourcePanels();
    ['#lm-model-source', '#lm-profile', '#lm-profile-model', '#lm-direct-url', '#lm-direct-key', '#lm-direct-model', '#lm-direct-clear-key'].forEach(selector => {
        body.querySelector(selector)?.addEventListener('input', () => {
            lastConnectionTest = null;
            renderShellStatus();
        });
        body.querySelector(selector)?.addEventListener('change', () => {
            lastConnectionTest = null;
            renderShellStatus();
        });
    });
    const readFormDraft = () => {
        const current = getSettings();
        const readNumber = (selector, fallback, min = -Infinity) => {
            const value = Number(body.querySelector(selector)?.value);
            return Number.isFinite(value) ? Math.max(min, value) : fallback;
        };
        const next = {
            ...current,
            enabled: body.querySelector('#lm-enabled').checked,
            migrationReviewMode: body.querySelector('#lm-mig-review').checked,
            memoryModelSource: body.querySelector('#lm-model-source').value,
            connectionProfile: body.querySelector('#lm-profile').value,
            profileModelOverride: body.querySelector('#lm-profile-model').value.trim(),
            directBaseUrl: body.querySelector('#lm-direct-url').value.trim(),
            directModel: body.querySelector('#lm-direct-model').value.trim(),
            bodyExtractionRegex: body.querySelector('#lm-body-regex').value.trim(),
            recentRawTokens: readNumber('#lm-raw-tokens', 16000, 8000),
            budgetL1: readNumber('#lm-b1', 2000, 200),
            budgetL2: readNumber('#lm-b2', 5000, 500),
            budgetL4: readNumber('#lm-b4', 1500, 0),
            chapterSize: readNumber('#lm-ch', 25, 5),
            proofreadEvery: readNumber('#lm-pr', 75, 5),
            depthL4: readNumber('#lm-d4', 4, 0),
            l4Enabled: body.querySelector('#lm-l4').checked,
            volumeCompressConfirm: body.querySelector('#lm-vc').checked,
        };
        const nextKey = body.querySelector('#lm-direct-key').value;
        if (body.querySelector('#lm-direct-clear-key')?.checked) {
            next.directApiKey = '';
        } else if (nextKey) {
            next.directApiKey = nextKey;
        }
        // Keep legacy mirrors until old installations have had time to migrate.
        next.fallbackEnabled = next.memoryModelSource === 'direct';
        next.fallbackBaseUrl = next.directBaseUrl;
        next.fallbackApiKey = next.directApiKey;
        next.fallbackModel = next.directModel;
        return next;
    };
    const persistForm = () => {
        Object.assign(getSettings(), readFormDraft());
        saveSettings();
        updateInjection();
        settingsDirty = false;
    };
    body.querySelector('#lm-save')?.addEventListener('click', () => {
        persistForm();
        const button = body.querySelector('#lm-save');
        button.textContent = '已保存';
        button.classList.add('lm-success');
        setTimeout(() => {
            if (button.isConnected) {
                button.textContent = '保存设置';
                button.classList.remove('lm-success');
            }
        }, 1800);
    });
    body.querySelector('#lm-test-connection')?.addEventListener('click', async () => {
        const button = body.querySelector('#lm-test-connection');
        const output = body.querySelector('#lm-connection-result');
        button.disabled = true;
        button.textContent = '正在检查模型连接…';
        output.dataset.state = 'working';
        output.textContent = '正在确认模型能否正常回复';
        try {
            const result = await testAuxModelConnection({ settings: readFormDraft() });
            lastConnectionTest = result;
            output.dataset.state = result.ok ? 'success' : 'error';
            output.textContent = result.ok
                ? `${result.message} · ${result.model} · 用时 ${Math.max(0.1, result.elapsedMs / 1000).toFixed(1)} 秒`
                : result.message;
        } catch {
            output.dataset.state = 'error';
            output.textContent = '这次没有检查成功。请确认网络正常，然后再试一次。';
        } finally {
            button.disabled = false;
            button.textContent = '测试连接';
            renderShellStatus();
        }
    });
    body.querySelector('#lm-list-models')?.addEventListener('click', async () => {
        const button = body.querySelector('#lm-list-models');
        const output = body.querySelector('#lm-model-list-result');
        const modelInput = body.querySelector('#lm-direct-model');
        const datalist = body.querySelector('#lm-direct-model-list');
        button.disabled = true;
        button.textContent = '正在获取…';
        output.dataset.state = 'working';
        output.textContent = '正在读取服务商提供的模型';
        try {
            const settings = readFormDraft();
            const models = await listDirectModels({ baseUrl: settings.directBaseUrl, apiKey: settings.directApiKey });
            datalist.innerHTML = models.map(model => `<option value="${escapeHtml(model)}"></option>`).join('');
            output.dataset.state = models.length ? 'success' : 'error';
            output.textContent = models.length ? `找到 ${models.length} 个模型；请在上方输入框中选择` : '服务商没有返回可选模型；你仍然可以手动填写。';
            if (models.length && !modelInput.value) modelInput.value = models[0];
        } catch (error) {
            output.dataset.state = 'error';
            output.textContent = '没有取到模型列表。请检查地址和密钥，也可以直接手动填写模型名称。';
        } finally {
            button.disabled = false;
            button.textContent = '获取模型列表';
        }
    });
    body.querySelector('#lm-test-body')?.addEventListener('click', () => {
        const output = body.querySelector('#lm-body-result');
        const pair = [...getPairs()].reverse().find(item => item.ai);
        if (!pair) {
            output.dataset.state = 'error';
            output.textContent = '当前聊天还没有可测试的 AI 回复。';
            return;
        }
        const { aiText } = getPairTexts(pair);
        const pattern = body.querySelector('#lm-body-regex').value.trim();
        const result = extractAiBody(aiText, pattern);
        if (!pattern) {
            output.dataset.state = 'success';
            output.textContent = `当前会读取整条回复，约 ${[...result.text].length} 字。`;
            return;
        }
        if (result.mode === 'regex') {
            const preview = result.text.replace(/\s+/g, ' ').trim().slice(0, 100);
            output.dataset.state = 'success';
            output.textContent = `识别成功，约 ${[...result.text].length} 字：${preview}${result.text.length > 100 ? '…' : ''}`;
            return;
        }
        output.dataset.state = 'error';
        output.textContent = result.error.startsWith('invalid_regex:')
            ? '规则格式有误；实际整理时会自动读取整条回复。'
            : '最近一条回复没有匹配；实际整理时会自动读取整条回复。';
    });
    body.querySelectorAll('[data-settings-jump]').forEach(button => {
        button.addEventListener('click', () => selectTab(button.dataset.settingsJump));
    });
    body.querySelector('#lm-eval-export')?.addEventListener('click', () => {
        const blob = new Blob([exportEvalCasesJson()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'layered-memory-eval-cases.json';
        a.click();
    });
    body.querySelector('#lm-eval-rerun')?.addEventListener('click', async () => {
        const results = await rerunAllEvalCases();
        const pass = results.filter(r => r.pass).length;
        toastr?.info?.(`检查完成：${results.length} 条记录中有 ${pass} 条已经通过。`);
    });
    body.querySelectorAll('.lm-rerun-one').forEach(btn => {
        btn.addEventListener('click', async () => {
            const r = await rerunEvalCase(btn.dataset.id);
            if (r.pass) toastr?.success?.('这条记录已经通过检查。');
            else toastr?.info?.('这条记录仍然有问题，可以保留它继续改进记忆效果。');
        });
    });
    body.querySelectorAll('.lm-del-case').forEach(btn => {
        btn.addEventListener('click', () => {
            removeEvalCase(btn.dataset.id);
            renderActiveTab();
        });
    });
}

function formatEvalCaseLabel(item) {
    const typeLabels = {
        miss: '漏记了重要内容',
        spurious: '记住了不该记的内容',
        wrong: '记错了内容',
    };
    const pipelineLabels = {
        per_floor: '每轮记忆整理',
        migration: '旧聊天补记',
        proofread: '自动检查',
    };
    return `${typeLabels[item?.type] || '一条纠错记录'} · ${pipelineLabels[item?.pipeline] || '记忆处理'}`;
}

function formatReviewNote(note) {
    return String(note || '')
        .replace(/L2/g, '剧情摘要')
        .replace(/卷压缩/g, '精简旧摘要')
        .replace(/状态表/g, '当前记忆')
        .replace(/存量迁移|迁移/g, '补记旧聊天')
        .replace(/新楼层/g, '新的对话')
        .replace(/楼层/g, '聊天楼层')
        .replace(/\bper-floor\b/gi, '逐轮整理');
}

function formatArchiveLabel(id, fallback) {
    const sequence = String(id || '').match(/(\d+)$/)?.[1];
    return sequence ? `${fallback} ${Number(sequence)}` : fallback;
}

function formatActivityMessage(message) {
    const text = String(message || '');
    let match = text.match(/提取完成\s+楼#(\d+):\s*\+(\d+)\s+丢(\d+)\s+冲突(\d+)/);
    if (match) {
        return `${pairFloorRangeLabel(Number(match[1]))}整理完成：新增 ${match[2]} 条，忽略 ${match[3]} 条，需要确认 ${match[4]} 条`;
    }
    match = text.match(/章节摘要(?:完成|原地更新)\s+\S+\s+\[(\d+)-(\d+)\]/);
    if (match) {
        return `${pairFloorRangeLabel(Number(match[1]), Number(match[2]))}的剧情摘要已经整理完成`;
    }
    match = text.match(/状态表整理：\s*(\d+)\s*→\s*(\d+)/);
    if (match) {
        return `已有记忆已整理：从 ${match[1]} 条精简为 ${match[2]} 条`;
    }
    if (/卷压缩完成/.test(text)) {
        return '很久以前的剧情摘要已经精简完成';
    }
    if (/回滚/.test(text)) {
        return '一项未完成的记忆工作已经安全恢复';
    }
    return '一项记忆整理工作已经完成';
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatFloorLabel(value) {
    if (typeof value === 'number') {
        return pairFloorRangeLabel(value);
    }
    if (typeof value === 'string' && value) {
        return value === 'manual' ? '手动添加' : value === 'proofread' ? '校对建议' : value;
    }
    return '来源未知';
}

export function displayRound(value) {
    const number = Number(value);
    return Number.isInteger(number) ? number + 1 : '?';
}

function formatRelativeTime(timestamp) {
    const delta = Math.max(0, Date.now() - Number(timestamp || 0));
    if (delta < 60_000) {
        return '刚刚';
    }
    if (delta < 3_600_000) {
        return `${Math.floor(delta / 60_000)} 分钟前`;
    }
    if (delta < 86_400_000) {
        return `${Math.floor(delta / 3_600_000)} 小时前`;
    }
    return `${Math.floor(delta / 86_400_000)} 天前`;
}

/**
 * Message menu: report miss on this floor.
 */
export function registerMessageMenu() {
    const ctx = SillyTavern.getContext();
    if (typeof ctx.MenuButtons?.add === 'function') {
        // best-effort; ST APIs vary
    }
    // Fallback: event on message blocks via MutationObserver is heavy; use click delegation
    document.body.addEventListener('contextmenu', (ev) => {
        const mes = ev.target.closest?.('.mes');
        if (!mes || !ev.altKey) {
            return;
        }
        // Alt+右键：报错快捷方式
        const mesId = mes.getAttribute('mesid');
        if (mesId == null) {
            return;
        }
        ev.preventDefault();
        const chat = SillyTavern.getContext().chat;
        const msg = chat[Number(mesId)];
        const pairs = getPairs();
        const pair = pairs.find(p => p.user === msg || p.ai === msg);
        if (pair) {
            openReportDialog({ type: 'miss', pairIndex: pair.pairIndex });
        }
    });
}

void getPairTexts;
