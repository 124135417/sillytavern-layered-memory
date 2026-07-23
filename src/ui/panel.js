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
    requestHistoryRebuildAbort,
    restoreRebuildBackup,
    startHistoryRebuild,
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
import { updateInjection } from '../inject.js';
import { renderL1Block, renderL2Block, renderL4Block } from '../render.js';
import { retrieveHits } from '../retrieve.js';
import { estimateTokens } from '../tokens.js';
import { extractAiBody } from '../body.js';
import { recordManualEvent } from '../branch.js';
import { displayEntityName, usableMemoryEntries } from '../quality.js';

const ROOT_ID = 'layered-memory-panel';
const DRAWER_ID = 'layered-memory-drawer';
const BACKDROP_ID = 'layered-memory-backdrop';
const SETTINGS_CARD_ID = 'layered-memory-settings-entry';
const MENU_ENTRY_ID = 'layered-memory-menu-entry';
let lastDrawerTrigger = null;
let lastConnectionTest = null;
let settingsDirty = false;

export function injectPanel() {
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
                <button id="lm-tab-chapters" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="false" tabindex="-1" data-tab="chapters" class="lm-tab">剧情时间线</button>
                <button id="lm-tab-review" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="false" tabindex="-1" data-tab="review" class="lm-tab">待确认 <span class="lm-tab-count" hidden></span></button>
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

    panel?.querySelectorAll('.lm-tab').forEach(btn => {
        btn.addEventListener('click', () => selectTab(btn.dataset.tab));
        btn.addEventListener('keydown', onTabKeydown);
    });

    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !document.getElementById(ROOT_ID)?.hasAttribute('hidden')) {
            openMemoryCenter(false);
        }
    });
    globalThis.addEventListener?.('layered-memory:queue-changed', refreshQueueUi);

    renderShellStatus();
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
    snapshot = snapshot || { status: 'idle', total: 0, completed: 0, queued: 0, failed: [] };
    const total = Number(snapshot.total) || 0;
    const completed = Math.min(total, Number(snapshot.completed) || 0);
    const measuredPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
    const percent = snapshot.status === 'complete' ? 100 : Math.min(99, measuredPercent);
    const statusCopy = {
        idle: ['尚未开始安全重建', '点击后会先保留旧结果，再在后台逐轮重建；未完成前不会替换当前记忆。'],
        running: ['正在安全重建旧聊天', snapshot.stage],
        stopping: ['正在安全停止', '未开始的任务已经取消；正在请求模型的这一项结束后停止。'],
        stopped: ['安全重建已停止', `已经保留前面完成的 ${completed} 轮，可以随时继续。`],
        complete: ['安全重建完成', '旧聊天已经逐轮核对，并一次性替换为通过校验的新结果。'],
        error: ['安全重建遇到问题', snapshot.error || '旧结果仍然保留。处理失败项后可以继续重建。'],
    };
    const [title, detail] = statusCopy[snapshot.status] || statusCopy.idle;
    const canStart = !['running', 'stopping'].includes(snapshot.status);
    const canStop = snapshot.status === 'running';
    const startLabel = ['stopped', 'error'].includes(snapshot.status) ? '继续安全重建' : snapshot.status === 'complete' ? '重新安全重建' : '安全重建旧结果';
    const waiting = snapshot.queued > 0 ? ` · 还有 ${snapshot.queued} 项等待处理` : '';
    return `<div class="lm-backfill-card" data-state="${escapeHtml(snapshot.status)}" aria-live="polite">
        <div class="lm-backfill-heading"><div><b>${escapeHtml(title)}</b><p>${escapeHtml(detail || '')}</p></div><strong>${completed} / ${total} 轮</strong></div>
        <progress max="100" value="${percent}" aria-label="旧聊天安全重建进度：${percent}%">${percent}%</progress>
        <div class="lm-backfill-meta"><span>${percent}% 已完成${escapeHtml(waiting)}</span>${snapshot.inFlight ? '<span>当前有 1 项正在处理</span>' : ''}</div>
        <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-migrate" ${canStart ? '' : 'disabled'}>${escapeHtml(startLabel)}</button><button type="button" class="lm-text-button" id="lm-migrate-abort" ${canStop ? '' : 'disabled'}>停止重建</button></div>
    </div>`;
}

function refreshHistoryBackfillUi(body) {
    const host = body?.querySelector('#lm-backfill-status');
    if (!host) return;
    host.innerHTML = renderHistoryBackfillStatus();
    bindHistoryBackfillControls(host, body);
}

function bindHistoryBackfillControls(host, body) {
    if (!host) return;
    host.querySelector('#lm-migrate')?.addEventListener('click', async () => {
        if (!confirm('开始安全重建旧聊天？插件会保留现有结果，在后台逐轮核对；只有全部成功后才会一次性替换。')) return;
        const button = host.querySelector('#lm-migrate');
        if (button) button.disabled = true;
        await startHistoryRebuild();
        refreshHistoryBackfillUi(body);
        toastr?.info?.('安全重建已经开始。旧结果会保留到新结果全部通过检查。');
    });
    host.querySelector('#lm-migrate-abort')?.addEventListener('click', async () => {
        const button = host.querySelector('#lm-migrate-abort');
        if (button) button.disabled = true;
        await requestHistoryRebuildAbort();
        refreshHistoryBackfillUi(body);
        toastr?.info?.('停止请求已收到，已取消尚未开始的重建任务。');
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

export function openMemoryCenter(open = true, targetTab = null) {
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
        document.body.classList.add('lm-memory-center-open');
        document.getElementById(DRAWER_ID)?.classList.add('lm-open');
        trigger.setAttribute('aria-expanded', 'true');
        if (targetTab) {
            selectTab(targetTab);
        } else {
            renderActiveTab();
        }
        panel.querySelector('#lm-center-title')?.focus();
    } else {
        if (settingsDirty) {
            if (!confirm('设置尚未保存，仍要关闭记忆中心吗？')) {
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
        if (lastDrawerTrigger instanceof HTMLElement && document.contains(lastDrawerTrigger)) {
            lastDrawerTrigger.focus();
        } else {
            trigger.focus();
        }
    }
}

function selectTab(tab) {
    if (activeTab() === 'settings' && tab !== 'settings' && settingsDirty) {
        if (!confirm('设置尚未保存，仍要离开吗？')) {
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
                : { key: 'idle', text: '运行正常' };
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
    const syncLabel = rebuild?.status === 'complete'
        ? `已安全重建 ${rebuild.completed} / ${rebuild.total} 轮`
        : rebuild?.status === 'running' || rebuild?.status === 'stopping'
            ? `正在安全重建 ${rebuild.completed} / ${rebuild.total} 轮`
            : syncedThrough >= liveStart
        ? (syncedThrough === maxSealed ? `已整理到第 ${syncedThrough} 轮` : `已整理到第 ${syncedThrough} 轮 · 后面有遗漏`)
        : (maxSealed >= liveStart ? `第 ${liveStart} 轮起有内容尚未整理` : baseline >= 0 ? `从第 ${liveStart} 轮开始记录` : '新聊天');
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
            <span class="lm-metric"><b>${entries.length}</b><small>当前事实</small></span>
            <span class="lm-metric"><b>${reviews.length}</b><small>待你确认</small></span>
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
    const entries = usableMemoryEntries(data);
    const quarantined = data.quarantined_entries || [];
    const notices = data.notices || [];
    const statusBanners = [
        quarantined.length ? `<aside class="lm-quality-alert"><div><strong>已隔离 ${quarantined.length} 条异常结果</strong><p>它们缺少主体、事实或原文证据，不会发送给模型。完成安全重建后会由新结果替换。</p></div></aside>` : '',
        notices.length ? `<section class="lm-notice-strip" aria-label="状态通知">${notices.slice(-3).map(item => `<article data-notice-id="${escapeHtml(item.id)}"><span>${escapeHtml(item.note || '')}</span><button type="button" class="lm-text-button" data-dismiss-notice>知道了</button></article>`).join('')}</section>` : '',
    ].filter(Boolean).join('');
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
    return `
        <div class="lm-dashboard">
            <main class="lm-memory-main" id="lm-memory-main">
                ${statusBanners}
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
                    <button type="button" class="lm-icon-button" id="lm-proof-now" title="立即检查记忆" aria-label="立即检查记忆"><span class="fa-solid fa-spell-check" aria-hidden="true"></span></button>
                    <button type="button" class="lm-button lm-button-primary" id="lm-add-entry"><span aria-hidden="true">＋</span> 添加记忆</button>
                </div>
                <div class="lm-memory-meta">
                    <span>当前确立的事实</span>
                    <small>${entries.length} 条</small>
                </div>
                <div id="lm-memory-groups">${groups}</div>
                <p class="lm-no-results" hidden>没有找到匹配的记忆。可以试试人物名、物品名或对话轮数。</p>
            </main>
            ${renderTaskRail()}
        </div>
        ${renderInjectionFooter()}
    `;
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
    const recent = [...(data.logs || [])].reverse().filter(x => /完成|更新|回滚/.test(x.message || '')).slice(0, 4);
    const inFlight = q.inFlight;
    const activeCount = Number(Boolean(inFlight)) + queued.length + failed.length;
    const summary = failed.length
        ? `${activeCount} 项工作 · ${failed.length} 项需要处理`
        : activeCount
            ? `正在处理 ${activeCount} 项工作`
            : '已全部处理完成';
    const summaryState = failed.length ? 'error' : activeCount ? 'working' : 'idle';
    return `
        <aside class="lm-task-rail" aria-label="记忆整理进度" data-summary-state="${summaryState}">
            <header>
                <div class="lm-task-heading"><span class="lm-kicker">自动整理</span><h3>记忆整理进度</h3><span class="lm-task-summary">${escapeHtml(summary)}</span></div>
                <div class="lm-task-controls">
                    <button type="button" class="lm-text-button" id="lm-queue-toggle" aria-pressed="${q.paused ? 'true' : 'false'}">${q.paused ? '继续整理' : '暂停新的整理工作'}</button>
                    <button type="button" class="lm-task-disclosure" aria-expanded="false" aria-controls="lm-task-list"><span>展开</span><span aria-hidden="true">⌄</span></button>
                </div>
            </header>
            <div class="lm-task-list" id="lm-task-list">
                ${inFlight ? renderTask(inFlight, 'running') : (!queued.length && !failed.length ? '<div class="lm-task lm-task-idle"><span class="fa-solid fa-check" aria-hidden="true"></span><div><b>已经整理完毕</b><small>目前没有等待处理的内容</small></div></div>' : '')}
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
        chapter_summary: '整理一段剧情摘要',
        volume_compress: '精简很久以前的剧情摘要',
        proofread: '检查已有记忆',
        state_gc: '合并重复的记忆',
        migrate_chapter: '补写旧聊天的剧情摘要',
        migrate_extract_chapter: '补记旧聊天的重要内容',
        migrate_extract_floor: '补记剩余的旧对话',
        migrate_finalize: '完成旧聊天补记',
        history_rebuild_segment: '逐轮核对旧聊天',
        history_rebuild_chapter: '合并旧剧情章节',
        history_rebuild_commit: '安全替换旧结果',
    };
    const target = job.payload?.pairIndex != null ? `第 ${job.payload.pairIndex} 轮对话`
        : job.payload?.startPair != null ? `第 ${job.payload.startPair}–${job.payload.endPair} 轮对话`
            : '';
    const stateLabel = state === 'running' ? '正在处理' : state === 'failed' ? '需要处理' : '等待处理';
    const attempt = job.attempt ? ` · 已尝试 ${job.attempt}/${job.maxAttempts || job.attempt} 次` : '';
    return `
        <div class="lm-task" data-state="${state}" data-job-id="${escapeHtml(job.id || '')}">
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
        const expanded = rail.classList.toggle('lm-mobile-expanded');
        disclosure.setAttribute('aria-expanded', String(expanded));
        disclosure.querySelector('span').textContent = expanded ? '收起' : '展开';
    });
    const toggle = body?.querySelector('#lm-queue-toggle');
    toggle?.addEventListener('click', () => {
        toggle.disabled = true;
        setQueuePaused(!getQueueSnapshot().paused);
    });
    body?.querySelectorAll('[data-queue-act]').forEach(button => {
        button.addEventListener('click', () => {
            const jobId = button.closest('[data-job-id]')?.dataset.jobId;
            if (!jobId) {
                return;
            }
            button.disabled = true;
            if (button.dataset.queueAct === 'retry') {
                retryFailedJob(jobId);
            } else {
                dismissFailedJob(jobId);
            }
        });
    });
}

function renderInjectionFooter() {
    const data = getChatData();
    const settings = getSettings();
    const handoff = data.context_handoff;
    const removedThrough = Number.isInteger(handoff?.removedThrough) ? handoff.removedThrough : -1;
    const l1 = renderL1Block(data, settings.budgetL1);
    const l2 = renderL2Block(data, { budget: settings.budgetL2, throughPair: removedThrough });
    const hits = settings.l4Enabled ? retrieveHits(data, settings.budgetL4) : [];
    const l4 = settings.l4Enabled ? renderL4Block(hits, settings.budgetL4) : '';
    const pairs = getPairs();
    const minRecent = settings.minRecentPairs || settings.recentPairs || 6;
    const recent = pairs.slice(-minRecent);
    const range = handoff?.status === 'trimmed'
        ? `第 ${handoff.keptFrom}–${pairs.at(-1)?.pairIndex ?? handoff.keptFrom} 轮对话`
        : recent.length ? `至少保留第 ${recent[0].pairIndex}–${recent.at(-1).pairIndex} 轮对话` : '还没有完整对话';
    const blockedReasons = {
        summary_gap: '较早聊天还没有被有效摘要连续覆盖，为避免断档，本轮没有精简。',
        message_mapping: '无法安全确认请求消息对应的原楼层，为避免误删，本轮没有精简。',
        recent_floor: '聊天还没有超过必须保留的最近轮数，本轮没有精简。',
        archive_budget: '用于接替旧聊天的压缩档案仍然太长，为避免摘要被截断，本轮没有精简。',
        invalid_budget: '聊天历史容量设置无效，本轮没有精简。',
        generation_type: '这次不是普通回复，插件没有改动聊天历史。',
    };
    const isActual = handoff?.status === 'trimmed' || handoff?.reason === 'within_budget' || handoff?.status === 'blocked';
    const handoffText = handoff?.status === 'trimmed'
        ? `最近一次普通回复已用压缩档案接替第 0–${removedThrough} 轮；聊天历史约从 ${handoff.historyTokensBefore} 减至 ${handoff.historyTokensAfter} token。${handoff.reason === 'coverage_limit' ? '更早内容已精简到当前安全边界，剩余部分交给酒馆继续计算。' : ''}`
        : handoff?.reason === 'within_budget'
            ? `最近一次普通回复中，聊天历史约 ${handoff.historyTokensBefore} token，未超过 ${handoff.historyBudget} token 的目标。`
            : blockedReasons[handoff?.reason] || '尚未发生下一次真实请求。以下是预计内容；真正发送时会根据当时的上下文容量决定加入哪些剧情摘要。';
    const preview = [
        `【上下文交接】\n${handoffText}`,
        l1 && `【当前仍然成立的事实】\n${l1}`,
        l2 && `【以前的剧情摘要】\n${l2}`,
        l4 && `【与当前剧情相关的旧记忆】\n${l4}`,
        `【最近保留的完整对话】\n${range}`,
    ].filter(Boolean).join('\n\n');
    return `
        <footer class="lm-injection-footer">
            <div>
                <span class="lm-kicker">${isActual ? '上一次真实请求' : '下一次请求预计'}</span>
                <strong>${isActual ? '模型实际使用的记忆范围' : '预计发送给模型的记忆'}</strong>
            </div>
            <div class="lm-budget-chips">
                <span>当前事实 ${estimateTokens(l1)} / ${settings.budgetL1}</span>
                <span>剧情摘要 ${estimateTokens(l2)} / ${settings.budgetL2}</span>
                <span>相关旧记忆 ${settings.l4Enabled ? `${hits.length} 条` : '未开启'}</span>
                <span>完整对话 ${escapeHtml(range)}</span>
            </div>
            <button type="button" class="lm-text-button" id="lm-preview-injection">查看发送给模型的内容</button>
            <dialog class="lm-dialog" id="lm-injection-dialog">
                <form method="dialog" class="lm-dialog-frame">
                    <header><div><span class="lm-kicker">只读预览</span><h3>${isActual ? '上一次真实请求使用的记忆' : '下一次请求的预计记忆'}</h3></div><button value="cancel" class="lm-icon-button" aria-label="关闭">×</button></header>
                    <p class="lm-muted">这里只显示插件补充的记忆。酒馆原有的角色设定、世界书和最近聊天也会照常发送。</p>
                    <pre>${escapeHtml(preview)}</pre>
                </form>
            </dialog>
        </footer>`;
}

function bindStateTab(body) {
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
        const empty = body.querySelector('.lm-no-results');
        if (empty) {
            empty.hidden = visible > 0 || getChatData().state_table.entries.length === 0;
        }
    };
    body.querySelector('#lm-memory-search')?.addEventListener('input', applyMemoryFilter);
    body.querySelector('#lm-slot-filter')?.addEventListener('change', applyMemoryFilter);

    body.querySelector('#lm-preview-injection')?.addEventListener('click', () => {
        const dialog = body.querySelector('#lm-injection-dialog');
        if (dialog?.showModal) {
            dialog.showModal();
        }
    });

    body.querySelector('#lm-proof-now')?.addEventListener('click', () => {
        enqueue('proofread', {}, QUEUE_PRIORITY.proofread);
        toastr?.info?.('已经开始检查记忆') || alert('已经开始检查记忆');
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
            if (!confirm('永久删除这条记忆？删除后无法恢复。')) {
                return;
            }
            const data = getChatData();
            const found = data.state_table.entries.find(x => x.id === id);
            if (!found) return;
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
    const dialog = document.createElement('dialog');
    dialog.className = 'lm-dialog lm-entry-dialog';
    dialog.innerHTML = `
        <form method="dialog" class="lm-dialog-frame lm-entry-form">
            <header><div><span class="lm-kicker">${entry ? '修改已有内容' : '记住新的内容'}</span><h3>${entry ? '编辑记忆' : '添加一条记忆'}</h3></div><button type="submit" value="cancel" formnovalidate class="lm-icon-button" aria-label="关闭">×</button></header>
            <div class="lm-entry-fields">
                <label>这是什么类型的记忆？<select name="slot">${SLOTS.map(slot => `<option value="${slot}" ${entry?.slot === slot ? 'selected' : ''}>${escapeHtml(SLOT_LABELS[slot])}</option>`).join('')}</select></label>
                <div class="lm-field-grid"><label>这条记忆关于谁或什么？<input name="subject" required maxlength="80" value="${escapeHtml(entry?.subject || '')}" placeholder="例如：林晚、铜钥匙、北港"/></label><label>还和谁有关？（可选）<input name="object" maxlength="80" value="${escapeHtml(entry?.object || '')}" placeholder="例如：周衡"/></label></div>
                <label>要记住什么？<textarea name="value" required maxlength="80" rows="3" placeholder="例如：左臂受伤，暂时不能用力">${escapeHtml(entry?.value || '')}</textarea><small>写下现在仍然成立、以后还可能影响剧情的内容。</small></label>
                <label>它会怎样影响后续剧情？（可选）<input name="cause" maxlength="120" value="${escapeHtml(entry?.cause || '')}" placeholder="例如：到达北港前需要重新包扎"/></label>
            </div>
            <footer><button type="submit" value="cancel" formnovalidate class="lm-text-button">不保存</button><button type="submit" value="save" class="lm-button lm-button-primary">保存这条记忆</button></footer>
        </form>`;
    document.body.appendChild(dialog);
    const promise = new Promise(resolve => {
        dialog.addEventListener('close', () => {
            if (dialog.returnValue !== 'save') {
                resolve(null);
            } else {
                const form = dialog.querySelector('form');
                const values = new FormData(form);
                resolve({
                    slot: String(values.get('slot') || 'other'),
                    subject: String(values.get('subject') || '').trim(),
                    object: String(values.get('object') || '').trim(),
                    value: String(values.get('value') || '').trim(),
                    cause: String(values.get('cause') || '').trim(),
                });
            }
            dialog.remove();
        }, { once: true });
    });
    dialog.showModal();
    dialog.querySelector('[name="subject"]')?.focus();
    return promise;
}

function openReportDialog({ entryId = null, type = 'miss', pairIndex = null } = {}) {
    const pairs = getPairs().filter(p => p.sealed);
    const defaultIdx = pairIndex ?? (pairs.at(-1)?.pairIndex ?? 0);
    const typeNumber = type === 'spurious' ? '2' : type === 'wrong' ? '3' : '1';
    const typeInput = prompt('这次出了什么问题？请输入数字：\n1 = 漏记了重要内容\n2 = 记住了不该记的内容\n3 = 记错了内容', typeNumber);
    if (!typeInput) {
        return;
    }
    const typeSel = ({ '1': 'miss', '2': 'spurious', '3': 'wrong' })[typeInput.trim()];
    if (!typeSel) {
        alert('请输入 1、2 或 3 来选择问题类型。');
        return;
    }
    let floor = defaultIdx;
    if (typeSel === 'miss' || pairIndex == null) {
        const input = prompt(`问题出现在哪一轮对话？请输入 0–${Math.max(0, pairs.length - 1)} 之间的数字。`, String(defaultIdx));
        if (input == null) {
            return;
        }
        floor = Number(input);
    } else if (entryId) {
        const e = getChatData().state_table.entries.find(x => x.id === entryId);
        if (typeof e?.updated_floor === 'number') {
            floor = e.updated_floor;
        }
    }
    const expectedNote = prompt('你希望插件怎样记录？请用一句话说明。', '') || '';
    const snap = snapshotForPair(floor);
    if (!snap) {
        alert('找不到这轮对话，请检查输入的数字。');
        return;
    }
    let expected = { note: expectedNote };
    if (typeSel === 'spurious') {
        expected = { should_be_empty: true };
    } else if (expectedNote) {
        expected = { contains_value: expectedNote };
    }
    addEvalCase({
        pipeline: 'per_floor',
        type: typeSel,
        source: 'panel_report',
        floor_key: snap.floor_key,
        user_mes: snap.user_mes,
        ai_mes: snap.ai_mes,
        state_table_snapshot: snap.state_table_snapshot,
        expected,
        note: expectedNote,
    });
    alert('已保存这条纠错记录。以后可以在“设置 → 开发者工具”中查看。');
}

function renderChaptersTab() {
    const data = getChatData();
    const chapters = [...(data.chapters || [])].sort((a, b) => (b.floor_range?.[1] || 0) - (a.floor_range?.[1] || 0));
    const volumes = data.volumes || [];
    let html = `<div class="lm-page-heading"><div><span class="lm-kicker">剧情回顾</span><h3>剧情时间线</h3><p>插件会按时间整理较早的剧情。修改过原对话时，对应摘要会自动重新整理。</p></div><div class="lm-page-count">${chapters.length} 章 · ${volumes.length} 份长期摘要</div></div>`;
    if (volumes.length) {
        html += '<section class="lm-volume-strip"><h4>很久以前的剧情</h4><div>';
        for (const v of volumes) {
            html += `<article class="lm-volume-card"><header><b>${escapeHtml(formatArchiveLabel(v.id, '长期摘要'))}</b>${v.stale ? '<span class="lm-state-tag" data-state="error">等待重新整理</span>' : '<span class="lm-state-tag">已整理</span>'}</header><p>${escapeHtml(v.summary)}</p></article>`;
        }
        html += '</div></section>';
    }
    html += '<section class="lm-timeline" aria-label="章节列表">';
    for (const c of chapters) {
        const state = c.stale ? '<span class="lm-state-tag" data-state="error">原对话已修改 · 等待重新整理</span>'
            : c.demoted ? '<span class="lm-state-tag">已整理进长期摘要</span>'
                : '<span class="lm-state-tag" data-state="success">摘要已保存</span>';
        const events = Array.isArray(c.key_events) ? c.key_events.filter(event => event?.text) : [];
        html += `<article class="lm-chapter-card" data-cid="${escapeHtml(c.id)}">
            <span class="lm-timeline-node" aria-hidden="true"></span>
            <header><div><span class="lm-kicker">剧情章节</span><h4>第 ${c.floor_range?.[0]}–${c.floor_range?.[1]} 轮对话</h4></div><div class="lm-chapter-state">${c.pinned ? '<span title="始终保留">📌</span>' : ''}${state}</div></header>
            <p>${escapeHtml(c.summary)}</p>
            ${events.length ? `<details class="lm-key-events"><summary>查看 ${events.length} 个关键事件</summary><ol>${events.map(event => `<li><span>第 ${event.floor_range?.[0]}–${event.floor_range?.[1]} 轮</span>${escapeHtml(event.text)}</li>`).join('')}</ol></details>` : ''}
            ${c.keywords?.length ? `<div class="lm-keywords">${c.keywords.map(k => `<span>${escapeHtml(k)}</span>`).join('')}</div>` : ''}
            <div class="lm-row-actions">
                <button type="button" data-act="edit" class="lm-text-button">编辑摘要</button>
                <button type="button" data-act="pin" class="lm-text-button">${c.pinned ? '恢复自动整理' : '始终保留本章'}</button>
            </div>
        </article>`;
    }
    html += '</section>';
    if (!chapters.length) {
        html += '<div class="lm-empty-state"><span class="fa-solid fa-book-open" aria-hidden="true"></span><h3>还没有可以回顾的章节</h3><p>聊天达到设定轮数后，插件会自动整理出第一段剧情摘要。</p></div>';
    }
    return html;
}

function bindChaptersTab(body) {
    body.querySelectorAll('article[data-cid]').forEach(card => {
        const id = card.dataset.cid;
        card.querySelector('[data-act="edit"]')?.addEventListener('click', async () => {
            const c = getChatData().chapters.find(x => x.id === id);
            if (!c) {
                return;
            }
            const summary = prompt('编辑这段剧情摘要。保存后，除非原对话发生变化，否则插件不会自动改写它。', c.summary);
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
    });
}

function renderReviewTab() {
    const q = (getChatData().review_queue || []).filter(item => item.kind !== 'alert');
    const entries = getChatData().state_table?.entries || [];
    let html = `<div class="lm-page-heading"><div><span class="lm-kicker">需要你决定</span><h3>待你确认</h3><p>插件不会悄悄修改有冲突的记忆。请在这里决定是否采用建议。</p></div><div class="lm-page-count">${q.length} 项</div></div><div class="lm-review-list">`;
    for (const item of q) {
        const kind = item.kind === 'flag_conflict' ? '两条记忆互相矛盾' : item.kind === 'proofread' ? '检查后发现的建议' : item.kind === 'volume_compress_ask' ? '整理旧摘要前确认' : '需要注意';
        const risk = item.kind === 'flag_conflict' ? 'error' : item.kind === 'proofread' ? 'warning' : 'info';
        const relatedEntry = entries.find(entry => entry.id === item.entry_id);
        const title = item.subject || relatedEntry?.subject || '一条记忆建议';
        html += `<article class="lm-review-card" data-rid="${escapeHtml(item.id)}">
            <div class="lm-review-mark" data-state="${risk}" aria-hidden="true"></div>
            <div class="lm-review-copy"><span class="lm-state-tag" data-state="${risk}">${kind}</span><h4>${escapeHtml(title)}</h4><p>${escapeHtml(formatReviewNote(item.note || item.value || '需要你的确认'))}</p>${item.object ? `<small>关联：${escapeHtml(item.object)}</small>` : ''}</div>
            <div class="lm-row-actions">
                <button type="button" data-act="reject" class="lm-text-button">${isAlert ? '知道了' : '不采用'}</button>
                ${isAlert ? '' : '<button type="button" data-act="approve" class="lm-button lm-button-primary">采用这条建议</button>'}
            </div>
        </article>`;
    }
    html += '</div>';
    if (!q.length) {
        html += '<div class="lm-empty-state"><span class="fa-solid fa-check" aria-hidden="true"></span><h3>现在没有需要你决定的内容</h3><p>以后发现互相矛盾的记忆或需要确认的整理建议时，它们会出现在这里。</p></div>';
    }
    return html;
}

function bindReviewTab(body) {
    body.querySelectorAll('[data-rid]').forEach(li => {
        const id = li.dataset.rid;
        li.querySelector('[data-act="reject"]')?.addEventListener('click', async () => {
            const data = getChatData();
            data.review_queue = data.review_queue.filter(x => x.id !== id);
            await saveChatData();
            renderActiveTab();
        });
        li.querySelector('[data-act="approve"]')?.addEventListener('click', async () => {
            const data = getChatData();
            const item = data.review_queue.find(x => x.id === id);
            if (!item) {
                return;
            }
            if (item.kind === 'volume_compress_ask') {
                enqueue('volume_compress', { confirmed: true, force: true }, QUEUE_PRIORITY.volume_compress);
            } else if (item.kind === 'proofread' && item.op === 'add') {
                const entry = {
                    id: `e_${String(data.progress.next_entry_seq++).padStart(4, '0')}`,
                    slot: item.slot || 'other',
                    subject: item.subject || '',
                    object: item.object || '',
                    value: item.value || '',
                    cause: '',
                    established_floor: 'proofread',
                    updated_floor: 'proofread',
                    evidence: '',
                    pinned: false,
                    source: 'proofread',
                };
                data.state_table.entries.push(entry);
                data.state_table.version += 1;
                recordManualEvent(data, { op: 'upsert', after: entry, reason: 'proofread_approval' });
            } else if (item.entry_id && item.kind === 'flag_conflict') {
                // approve conflict = no auto change; just dismiss (user may edit manually)
            }
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
    const baseline = getChatData().progress?.baseline_pair;
    const baselineText = baseline == null ? '插件还没有开始记录这段聊天'
        : baseline < 0 ? '这是一段新聊天，所有对话都会自动整理'
            : `插件从第 ${baseline + 1} 轮开始自动记录；更早的内容可以在这里补记`;
    return `
        <div class="lm-page-heading"><div><span class="lm-kicker">使用设置</span><h3>设置</h3><p>常用选项放在前面。标为高级的内容通常保持默认即可。</p></div></div>
        <div class="lm-settings-layout">
            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-toggle-on" aria-hidden="true"></span><div><h4>常用设置</h4><p>选择用哪个模型整理记忆，并决定插件是否工作。</p></div></div></header>
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
                    <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-test-connection">保存并检查模型连接</button><output id="lm-connection-result" class="lm-connection-result" aria-live="polite"></output></div>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></span><div><h4>记忆怎样自动整理</h4><p>这些选项决定保留多少最近对话，以及多久整理和检查一次。</p></div></div></header>
                <div class="lm-settings-fields lm-field-grid">
                    <label>希望保留多少最近剧情？
                        <small>插件会先让预设和正则整理聊天，再按这里的目标精简更早内容。</small>
                        <select id="lm-history-mode">
                            <option value="compact" ${s.historyBudgetMode === 'compact' ? 'selected' : ''}>节省上下文</option>
                            <option value="balanced" ${s.historyBudgetMode === 'balanced' ? 'selected' : ''}>平衡（推荐）</option>
                            <option value="detailed" ${s.historyBudgetMode === 'detailed' ? 'selected' : ''}>尽量完整</option>
                            <option value="custom" ${s.historyBudgetMode === 'custom' ? 'selected' : ''}>使用高级设置中的自定义容量</option>
                        </select>
                    </label>
                    <label>至少保留最近几轮完整对话
                        <small>推荐 6。即使空间紧张，这些对话也不会被插件精简。</small>
                        <input type="number" id="lm-n" min="1" value="${s.minRecentPairs}"/>
                    </label>
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
                    <label>AI 正文提取规则
                        <small>插件只整理规则中第一个括号捕获的正文。留空会读取整条回复；规则偶尔失效时也会自动读取整条回复，不会漏掉这一轮。</small>
                        <textarea id="lm-body-regex" rows="2" spellcheck="false" placeholder="例如：&lt;content&gt;([\\s\\S]*?)&lt;/content&gt;">${escapeHtml(s.bodyExtractionRegex)}</textarea>
                    </label>
                    <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-test-body">用最近一条回复测试</button><output id="lm-body-result" class="lm-connection-result" aria-live="polite"></output></div>
                    <p class="lm-security-note"><span class="fa-solid fa-circle-info" aria-hidden="true"></span>如果要让插件完全接管摘要，请关闭预设中“每轮生成摘要”的指令和只发送旧摘要的配套正则。插件不会自动修改你的预设。</p>
                </div>
                <div class="lm-settings-fields">
                    <label class="lm-switch-row"><span><b>需要时找回相关的旧记忆</b><small>当前对话提到旧人物、物品或地点时，尝试找回相关剧情。只靠关键词判断，默认关闭。</small></span><input type="checkbox" id="lm-l4" ${s.l4Enabled ? 'checked' : ''}/></label>
                    <label class="lm-switch-row"><span><b>精简很久以前的摘要前先询问我</b><small>需要进一步压缩旧剧情时，先放到“待你确认”页面。</small></span><input type="checkbox" id="lm-vc" ${s.volumeCompressConfirm ? 'checked' : ''}/></label>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-clock-rotate-left" aria-hidden="true"></span><div><h4>安全重建以前的聊天</h4><p>${escapeHtml(baselineText)}</p></div></div></header>
                <div class="lm-settings-fields"><p>插件会把旧聊天分段逐轮核对，在独立暂存区生成新结果。只有全部通过检查后才会替换当前自动记忆。</p><div id="lm-backfill-status">${renderHistoryBackfillStatus()}</div>${getChatData().rebuild_backup ? '<div class="lm-settings-actions"><button type="button" class="lm-text-button" id="lm-restore-rebuild">恢复重建前结果</button></div>' : ''}</div>
            </section>

            <details class="lm-settings-section lm-settings-disclosure">
                <summary><div><span class="fa-solid fa-sliders" aria-hidden="true"></span><div><h4>高级设置</h4><p>记忆容量和发送位置。不了解这些选项时，请保持默认。</p></div></div><span class="lm-disclosure-label">展开</span></summary>
                <div class="lm-settings-fields lm-field-grid lm-field-grid-three">
                    <label>自定义聊天历史容量<small>仅在上方选择“自定义”时使用；这里只计算正则处理后的聊天。</small><input type="number" id="lm-history-budget" min="500" value="${s.historyTokenBudget}"/></label>
                    <label>当前事实容量<small>长期有效的人物状态、关系和约定。推荐 2000。</small><input type="number" id="lm-b1" min="200" value="${s.budgetL1}"/></label>
                    <label>剧情摘要容量<small>以前发生过的剧情。推荐 5000。</small><input type="number" id="lm-b2" min="500" value="${s.budgetL2}"/></label>
                    <label>相关旧记忆容量<small>临时找回的旧内容。推荐 1500。</small><input type="number" id="lm-b4" min="0" value="${s.budgetL4}"/></label>
                    <label>当前事实的发送位置<small>数字越大越靠前。推荐 100。</small><input type="number" id="lm-d1" min="0" value="${s.depthL1}"/></label>
                    <label>剧情摘要的发送位置<small>数字越大越靠前。推荐 100。</small><input type="number" id="lm-d2" min="0" value="${s.depthL2}"/></label>
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
    body.querySelectorAll('input, select, textarea').forEach(control => {
        control.addEventListener('input', () => { settingsDirty = true; });
        control.addEventListener('change', () => { settingsDirty = true; });
    });
    body.querySelector('#lm-restore-rebuild')?.addEventListener('click', async () => {
        if (!confirm('恢复安全重建前的旧结果？当前自动生成的重建结果会被替换，手动聊天内容不会改变。')) return;
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
    const persistForm = () => {
        const s = getSettings();
        const readNumber = (selector, fallback, min = -Infinity) => {
            const value = Number(body.querySelector(selector)?.value);
            return Number.isFinite(value) ? Math.max(min, value) : fallback;
        };
        s.enabled = body.querySelector('#lm-enabled').checked;
        s.migrationReviewMode = body.querySelector('#lm-mig-review').checked;
        s.memoryModelSource = body.querySelector('#lm-model-source').value;
        s.connectionProfile = body.querySelector('#lm-profile').value;
        s.profileModelOverride = body.querySelector('#lm-profile-model').value.trim();
        s.directBaseUrl = body.querySelector('#lm-direct-url').value.trim();
        const nextKey = body.querySelector('#lm-direct-key').value;
        if (body.querySelector('#lm-direct-clear-key')?.checked) {
            s.directApiKey = '';
        } else if (nextKey) {
            s.directApiKey = nextKey;
        }
        s.directModel = body.querySelector('#lm-direct-model').value.trim();
        // Keep legacy mirrors until old installations have had time to migrate.
        s.fallbackEnabled = s.memoryModelSource === 'direct';
        s.fallbackBaseUrl = s.directBaseUrl;
        s.fallbackApiKey = s.directApiKey;
        s.fallbackModel = s.directModel;
        s.historyBudgetMode = body.querySelector('#lm-history-mode').value;
        s.bodyExtractionRegex = body.querySelector('#lm-body-regex').value.trim();
        s.historyTokenBudget = readNumber('#lm-history-budget', 12000, 500);
        s.budgetL1 = readNumber('#lm-b1', 2000, 200);
        s.budgetL2 = readNumber('#lm-b2', 5000, 500);
        s.budgetL4 = readNumber('#lm-b4', 1500, 0);
        s.minRecentPairs = readNumber('#lm-n', 6, 1);
        s.recentPairs = s.minRecentPairs;
        s.chapterSize = readNumber('#lm-ch', 25, 5);
        s.proofreadEvery = readNumber('#lm-pr', 75, 5);
        s.depthL1 = readNumber('#lm-d1', 100, 0);
        s.depthL2 = readNumber('#lm-d2', 100, 0);
        s.depthL4 = readNumber('#lm-d4', 4, 0);
        s.l4Enabled = body.querySelector('#lm-l4').checked;
        s.volumeCompressConfirm = body.querySelector('#lm-vc').checked;
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
        persistForm();
        const button = body.querySelector('#lm-test-connection');
        const output = body.querySelector('#lm-connection-result');
        button.disabled = true;
        button.textContent = '正在检查模型连接…';
        output.dataset.state = 'working';
        output.textContent = '正在确认模型能否正常回复';
        try {
            const result = await testAuxModelConnection();
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
            button.textContent = '保存并检查模型连接';
            renderShellStatus();
        }
    });
    body.querySelector('#lm-list-models')?.addEventListener('click', async () => {
        persistForm();
        const button = body.querySelector('#lm-list-models');
        const output = body.querySelector('#lm-model-list-result');
        const modelInput = body.querySelector('#lm-direct-model');
        const datalist = body.querySelector('#lm-direct-model-list');
        button.disabled = true;
        button.textContent = '正在获取…';
        output.dataset.state = 'working';
        output.textContent = '正在读取服务商提供的模型';
        try {
            const settings = getSettings();
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
    bindHistoryBackfillControls(body.querySelector('#lm-backfill-status'), body);
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
        alert(`检查完成：${results.length} 条记录中有 ${pass} 条已经通过。`);
    });
    body.querySelectorAll('.lm-rerun-one').forEach(btn => {
        btn.addEventListener('click', async () => {
            const r = await rerunEvalCase(btn.dataset.id);
            alert(r.pass ? '这条记录已经通过检查。' : '这条记录仍然有问题，可以保留它继续改进记忆效果。');
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
        .replace(/楼层/g, '轮对话')
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
        return `第 ${match[1]} 轮对话整理完成：新增 ${match[2]} 条，忽略 ${match[3]} 条，需要确认 ${match[4]} 条`;
    }
    match = text.match(/章节摘要(?:完成|原地更新)\s+\S+\s+\[(\d+)-(\d+)\]/);
    if (match) {
        return `第 ${match[1]}–${match[2]} 轮的剧情摘要已经整理完成`;
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
        return `第 ${value} 轮对话`;
    }
    if (typeof value === 'string' && value) {
        return value === 'manual' ? '手动添加' : value === 'proofread' ? '校对建议' : value;
    }
    return '来源未知';
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
