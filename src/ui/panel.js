import { SLOT_LABELS, SLOTS } from '../constants.js';
import { listConnectionProfiles, testAuxModelConnection } from '../aux-model.js';
import {
    addEvalCase,
    exportEvalCasesJson,
    listEvalCases,
    removeEvalCase,
    rerunAllEvalCases,
    rerunEvalCase,
    snapshotForPair,
} from '../eval/cases.js';
import { recordMigrationEdit, requestMigrateAbort, startMigration } from '../eval/migrate.js';
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

const ROOT_ID = 'layered-memory-panel';
const DRAWER_ID = 'layered-memory-drawer';
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
        <section id="${ROOT_ID}" class="layered-memory-root" role="dialog" aria-modal="false"
            aria-labelledby="lm-center-title" hidden>
            <header class="lm-center-header">
                <div class="lm-center-heading">
                    <span class="lm-eyebrow">MEMORY CENTER</span>
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
                <button id="lm-tab-review" type="button" role="tab" aria-controls="lm-tab-panel" aria-selected="false" tabindex="-1" data-tab="review" class="lm-tab">待审 <span class="lm-tab-count" hidden></span></button>
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
        const panel = drawer.querySelector(`#${ROOT_ID}`);
        openMemoryCenter(panel?.hasAttribute('hidden'));
    });
    drawer.querySelector('.lm-close')?.addEventListener('click', () => openMemoryCenter(false));

    drawer.querySelectorAll('.lm-tab').forEach(btn => {
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
            <p>记忆内容、后台任务与诊断已移至独立记忆中心。</p>
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
    const trigger = document.querySelector(`#${DRAWER_ID} .lm-drawer-trigger`);
    if (!panel || !trigger) {
        return;
    }
    if (open) {
        lastDrawerTrigger = document.activeElement;
        panel.removeAttribute('hidden');
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
        panel.setAttribute('hidden', '');
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
    const entries = data.state_table?.entries || [];
    const reviews = data.review_queue || [];
    const failed = queue.failed || [];
    const pendingCount = queue.queued?.length || 0;
    const status = failed.length ? { key: 'error', text: `${failed.length} 个任务需处理` }
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
    const historical = pairs.filter(p => p.pairIndex <= baseline);
    const migratedHistory = historical.length > 0 && historical.every(p => extracted.has(`migrated:${p.floorKey}`));
    const historyNote = baseline >= 0 && !migratedHistory ? ' · 历史未迁移' : '';
    const syncLabel = syncedThrough >= liveStart
        ? (syncedThrough === maxSealed ? `已同步至 ${syncedThrough} 对` : `同步至 ${syncedThrough} 对 · 后续有缺口`)
        : (maxSealed >= liveStart ? `从 ${liveStart} 对起尚未连续同步` : baseline >= 0 ? `从 ${liveStart} 对开始接管` : '新聊天');
    const configuredConnection = settings.connectionProfile
        ? 'Profile 已选择'
        : settings.fallbackEnabled && settings.fallbackBaseUrl && settings.fallbackApiKey
            ? 'Fallback 已配置'
            : '当前连接';
    const connectionLabel = lastConnectionTest
        ? `${lastConnectionTest.ok ? '可用' : '不可用'} · ${lastConnectionTest.message}`
        : `${configuredConnection} · 未测试`;
    const metrics = panel.querySelector('.lm-header-metrics');
    if (metrics) {
        metrics.innerHTML = `
            <span class="lm-metric"><b>${escapeHtml(syncLabel + historyNote)}</b><small>同步进度</small></span>
            <span class="lm-metric"><b>${entries.length}</b><small>当前事实</small></span>
            <span class="lm-metric"><b>${reviews.length}</b><small>待你确认</small></span>
            <span class="lm-metric lm-connection"><b>${escapeHtml(connectionLabel)}</b><small>副模型连接</small></span>
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
    const entries = data.state_table?.entries || [];
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
                <p>上一楼定格后，持续影响剧情的事实会出现在这里。你也可以先手动添加一条。</p>
                <button type="button" class="lm-button lm-button-primary" data-empty-add>添加第一条记忆</button>
            </div>`;
    }
    return `
        <div class="lm-dashboard">
            <main class="lm-memory-main" id="lm-memory-main">
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
                    <button type="button" class="lm-icon-button" id="lm-proof-now" title="立即校对" aria-label="立即校对"><span class="fa-solid fa-spell-check" aria-hidden="true"></span></button>
                    <button type="button" class="lm-button lm-button-primary" id="lm-add-entry"><span aria-hidden="true">＋</span> 添加记忆</button>
                </div>
                <div class="lm-memory-meta">
                    <span>当前确立的事实</span>
                    <small>${entries.length} 条 · v${data.state_table?.version ?? 0}</small>
                </div>
                <div id="lm-memory-groups">${groups}</div>
                <p class="lm-no-results" hidden>没有匹配的记忆。试试人物名或来源楼层。</p>
            </main>
            ${renderTaskRail()}
        </div>
        ${renderInjectionFooter()}
    `;
}

function renderMemoryCard(entry) {
    const subject = entry.object
        ? `${escapeHtml(entry.subject)} <span aria-hidden="true">→</span> ${escapeHtml(entry.object)}`
        : escapeHtml(entry.subject || '未命名主体');
    const floor = formatFloorLabel(entry.updated_floor ?? entry.established_floor);
    const searchable = [entry.subject, entry.object, entry.value, entry.evidence, floor].filter(Boolean).join(' ').toLowerCase();
    return `
        <article class="lm-memory-card ${entry.pinned ? 'lm-pinned' : ''}" data-id="${escapeHtml(entry.id)}" data-search="${escapeHtml(searchable)}">
            <div class="lm-card-leading">
                <div class="lm-card-title"><strong>${subject}</strong><span>${escapeHtml(floor)}</span></div>
                <p>${escapeHtml(entry.value || '未填写事实')}</p>
                ${entry.cause ? `<div class="lm-impact"><span>持续影响</span>${escapeHtml(entry.cause)}</div>` : ''}
                ${entry.evidence ? `<details class="lm-evidence"><summary>查看原文证据</summary><blockquote>${escapeHtml(entry.evidence)}</blockquote></details>` : ''}
            </div>
            <div class="lm-card-actions" aria-label="记忆操作">
                <button type="button" data-act="pin" class="lm-icon-button" title="${entry.pinned ? '取消钉住' : '钉住'}" aria-label="${entry.pinned ? '取消钉住' : '钉住'}"><span class="fa-solid fa-thumbtack" aria-hidden="true"></span></button>
                <button type="button" data-act="edit" class="lm-icon-button" title="编辑" aria-label="编辑"><span class="fa-solid fa-pen" aria-hidden="true"></span></button>
                <button type="button" data-act="report" class="lm-icon-button" title="报告错误" aria-label="报告错误"><span class="fa-solid fa-flag" aria-hidden="true"></span></button>
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
        ? `${activeCount} 个任务 · ${failed.length} 个失败`
        : activeCount
            ? `${activeCount} 个任务处理中`
            : '当前空闲';
    const summaryState = failed.length ? 'error' : activeCount ? 'working' : 'idle';
    return `
        <aside class="lm-task-rail" aria-label="后台任务" data-summary-state="${summaryState}">
            <header>
                <div class="lm-task-heading"><span class="lm-kicker">BACKGROUND</span><h3>后台任务</h3><span class="lm-task-summary">${escapeHtml(summary)}</span></div>
                <div class="lm-task-controls">
                    <button type="button" class="lm-text-button" id="lm-queue-toggle" aria-pressed="${q.paused ? 'true' : 'false'}">${q.paused ? '继续处理' : '暂停新任务'}</button>
                    <button type="button" class="lm-task-disclosure" aria-expanded="false" aria-controls="lm-task-list"><span>展开</span><span aria-hidden="true">⌄</span></button>
                </div>
            </header>
            <div class="lm-task-list" id="lm-task-list">
                ${inFlight ? renderTask(inFlight, 'running') : (!queued.length && !failed.length ? '<div class="lm-task lm-task-idle"><span class="fa-solid fa-check" aria-hidden="true"></span><div><b>当前空闲</b><small>没有正在运行的任务</small></div></div>' : '')}
                ${queued.slice(0, 4).map(job => renderTask(job, 'queued')).join('')}
                ${queued.length > 4 ? `<p class="lm-task-overflow">另有 ${queued.length - 4} 个任务等待</p>` : ''}
                ${failed.map(job => renderTask(job, 'failed')).join('')}
            </div>
            <div class="lm-recent-activity">
                <h4>最近完成</h4>
                ${recent.length ? recent.map(log => `<div><span aria-hidden="true">●</span><p>${escapeHtml(log.message)}<small>${formatRelativeTime(log.t)}</small></p></div>`).join('') : '<p class="lm-muted">当前会话还没有完成记录。</p>'}
            </div>
        </aside>`;
}

function renderTask(job, state) {
    const labels = {
        extract: '提取楼层记忆',
        chapter_summary: '生成章节摘要',
        volume_compress: '整理卷摘要',
        proofread: '校对记忆',
        state_gc: '整理状态表',
        migrate_chapter: '迁移历史章节',
        migrate_extract_chapter: '迁移章节记忆',
        migrate_extract_floor: '迁移尾部楼层',
        migrate_finalize: '完成迁移',
    };
    const target = job.payload?.pairIndex != null ? `第 ${job.payload.pairIndex} 对`
        : job.payload?.startPair != null ? `第 ${job.payload.startPair}–${job.payload.endPair} 对`
            : '';
    const stateLabel = state === 'running' ? '运行中' : state === 'failed' ? '失败' : '等待';
    const attempt = job.attempt ? ` · 第 ${job.attempt}/${job.maxAttempts || job.attempt} 次` : '';
    return `
        <div class="lm-task" data-state="${state}" data-job-id="${escapeHtml(job.id || '')}">
            <span class="lm-task-dot" aria-hidden="true"></span>
            <div class="lm-task-copy">
                <b>${escapeHtml(labels[job.type] || job.type || '后台任务')}</b>
                <small>${escapeHtml(target || stateLabel)}${escapeHtml(attempt)}</small>
                ${job.lastError ? `<p>${escapeHtml(job.lastError)}</p>` : ''}
            </div>
            <span class="lm-task-state">${stateLabel}</span>
            ${state === 'failed' ? `<div class="lm-task-actions"><button type="button" class="lm-text-button" data-queue-act="retry">重试</button><button type="button" class="lm-text-button" data-queue-act="dismiss">忽略</button></div>` : ''}
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
    const l1 = renderL1Block(data, settings.budgetL1);
    const l2 = renderL2Block(data, { budget: settings.budgetL2 });
    const hits = settings.l4Enabled ? retrieveHits(data, settings.budgetL4) : [];
    const l4 = settings.l4Enabled ? renderL4Block(hits, settings.budgetL4) : '';
    const pairs = getPairs();
    const recent = pairs.slice(-(settings.recentPairs || 3));
    const range = recent.length ? `第 ${recent[0].pairIndex}–${recent.at(-1).pairIndex} 对` : '暂无楼层';
    const preview = [
        l1 && `【L1 当前事实】\n${l1}`,
        l2 && `【L2 剧情摘要】\n${l2}`,
        l4 && `【L4 检索结果】\n${l4}`,
        `【L3 保留原文】\n${range}`,
    ].filter(Boolean).join('\n\n');
    return `
        <footer class="lm-injection-footer">
            <div>
                <span class="lm-kicker">NEXT GENERATION</span>
                <strong>下一次普通生成的记忆上下文</strong>
            </div>
            <div class="lm-budget-chips">
                <span>L1 ${estimateTokens(l1)} / ${settings.budgetL1}</span>
                <span>L2 ${estimateTokens(l2)} / ${settings.budgetL2}</span>
                <span>L4 ${settings.l4Enabled ? `${hits.length} 命中` : '已关闭'}</span>
                <span>L3 ${escapeHtml(range)}</span>
            </div>
            <button type="button" class="lm-text-button" id="lm-preview-injection">预览模型所见</button>
            <dialog class="lm-dialog" id="lm-injection-dialog">
                <form method="dialog" class="lm-dialog-frame">
                    <header><div><span class="lm-kicker">READ ONLY</span><h3>模型所见预览</h3></div><button value="cancel" class="lm-icon-button" aria-label="关闭">×</button></header>
                    <p class="lm-muted">这里展示插件生成的分层记忆块；最终上下文还会包含酒馆原生提示和保留的聊天原文。</p>
                    <pre>${escapeHtml(preview)}</pre>
                </form>
            </dialog>
        </footer>`;
}

function bindStateTab(body) {
    bindQueueControls(body);
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
        await saveChatData();
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
        toastr?.info?.('已入队校对任务') || alert('已入队校对任务');
    });

    body.querySelector('#lm-report-error')?.addEventListener('click', () => openReportDialog({}));

    body.querySelectorAll('.lm-memory-card[data-id]').forEach(li => {
        const id = li.dataset.id;
        li.querySelector('[data-act="pin"]')?.addEventListener('click', async () => {
            const e = getChatData().state_table.entries.find(x => x.id === id);
            if (e) {
                e.pinned = !e.pinned;
                await saveChatData();
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
            await saveChatData();
            recordMigrationEdit({ beforeEntry: before, afterEntry: e, op: 'update' });
            updateInjection();
            renderActiveTab();
        });
        li.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
            if (!confirm('删除该条目？')) {
                return;
            }
            const data = getChatData();
            const before = data.state_table.entries.find(x => x.id === id);
            data.state_table.entries = data.state_table.entries.filter(x => x.id !== id);
            data.state_table.version += 1;
            await saveChatData();
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
            <header><div><span class="lm-kicker">${entry ? 'EDIT MEMORY' : 'NEW MEMORY'}</span><h3>${entry ? '编辑记忆' : '添加一条记忆'}</h3></div><button type="submit" value="cancel" formnovalidate class="lm-icon-button" aria-label="关闭">×</button></header>
            <div class="lm-entry-fields">
                <label>类型<select name="slot">${SLOTS.map(slot => `<option value="${slot}" ${entry?.slot === slot ? 'selected' : ''}>${escapeHtml(SLOT_LABELS[slot])}</option>`).join('')}</select></label>
                <div class="lm-field-grid"><label>主体<input name="subject" required maxlength="80" value="${escapeHtml(entry?.subject || '')}" placeholder="谁或什么"/></label><label>关联对象（可选）<input name="object" maxlength="80" value="${escapeHtml(entry?.object || '')}" placeholder="与谁相关"/></label></div>
                <label>当前事实<textarea name="value" required maxlength="80" rows="3" placeholder="现在仍然成立的事实">${escapeHtml(entry?.value || '')}</textarea><small>最多 80 个字符；只写当前仍然有效的状态。</small></label>
                <label>持续影响（可选）<input name="cause" maxlength="120" value="${escapeHtml(entry?.cause || '')}" placeholder="它会怎样影响后续剧情"/></label>
            </div>
            <footer><button type="submit" value="cancel" formnovalidate class="lm-text-button">取消</button><button type="submit" value="save" class="lm-button lm-button-primary">保存记忆</button></footer>
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
    const typeSel = prompt('类型：miss(漏了) / spurious(乱填) / wrong(填错)', type);
    if (!typeSel) {
        return;
    }
    let floor = defaultIdx;
    if (typeSel === 'miss' || pairIndex == null) {
        const input = prompt(`来源楼（对序号 0–${Math.max(0, pairs.length - 1)}）`, String(defaultIdx));
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
    const expectedNote = prompt('正确答案 / 期望简述（将写入错例）', '') || '';
    const snap = snapshotForPair(floor);
    if (!snap) {
        alert('找不到该楼');
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
    alert('已写入全局错例库');
}

function renderChaptersTab() {
    const data = getChatData();
    const chapters = [...(data.chapters || [])].sort((a, b) => (b.floor_range?.[1] || 0) - (a.floor_range?.[1] || 0));
    const volumes = data.volumes || [];
    let html = `<div class="lm-page-heading"><div><span class="lm-kicker">STORY ARCHIVE</span><h3>剧情时间线</h3><p>章节摘要写入后冻结；源消息变化时会明确标记过期。</p></div><div class="lm-page-count">${chapters.length} 章 · ${volumes.length} 卷</div></div>`;
    if (volumes.length) {
        html += '<section class="lm-volume-strip"><h4>卷摘要</h4><div>';
        for (const v of volumes) {
            html += `<article class="lm-volume-card"><header><b>${escapeHtml(v.id)}</b>${v.stale ? '<span class="lm-state-tag" data-state="error">需要重建</span>' : '<span class="lm-state-tag">已归档</span>'}</header><p>${escapeHtml(v.summary)}</p></article>`;
        }
        html += '</div></section>';
    }
    html += '<section class="lm-timeline" aria-label="章节列表">';
    for (const c of chapters) {
        const state = c.stale ? '<span class="lm-state-tag" data-state="error">源消息变化 · 等待重建</span>'
            : c.demoted ? '<span class="lm-state-tag">已收入卷摘要</span>'
                : '<span class="lm-state-tag" data-state="success">已冻结</span>';
        html += `<article class="lm-chapter-card" data-cid="${escapeHtml(c.id)}">
            <span class="lm-timeline-node" aria-hidden="true"></span>
            <header><div><span class="lm-kicker">${escapeHtml(c.id)}</span><h4>第 ${c.floor_range?.[0]}–${c.floor_range?.[1]} 对</h4></div><div class="lm-chapter-state">${c.pinned ? '<span title="已钉住">📌</span>' : ''}${state}</div></header>
            <p>${escapeHtml(c.summary)}</p>
            ${c.keywords?.length ? `<div class="lm-keywords">${c.keywords.map(k => `<span>${escapeHtml(k)}</span>`).join('')}</div>` : ''}
            <div class="lm-row-actions">
                <button type="button" data-act="edit" class="lm-text-button">编辑并冻结</button>
                <button type="button" data-act="pin" class="lm-text-button">${c.pinned ? '取消钉住' : '钉住整章'}</button>
            </div>
        </article>`;
    }
    html += '</section>';
    if (!chapters.length) {
        html += '<div class="lm-empty-state"><span class="fa-solid fa-book-open" aria-hidden="true"></span><h3>时间线还没有章节</h3><p>达到设置的章大小并完成提取后，章节摘要会自动出现在这里。</p></div>';
    }
    return html;
}

function bindChaptersTab(body) {
    body.querySelectorAll('li[data-cid]').forEach(li => {
        const id = li.dataset.cid;
        li.querySelector('[data-act="edit"]')?.addEventListener('click', async () => {
            const c = getChatData().chapters.find(x => x.id === id);
            if (!c) {
                return;
            }
            const summary = prompt('编辑章节摘要（编辑后冻结）', c.summary);
            if (summary == null) {
                return;
            }
            c.summary = summary;
            c.frozen = true;
            c.stale = false;
            await saveChatData();
            updateInjection();
            renderActiveTab();
        });
        li.querySelector('[data-act="pin"]')?.addEventListener('click', async () => {
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
    const q = getChatData().review_queue || [];
    let html = `<div class="lm-page-heading"><div><span class="lm-kicker">HUMAN REVIEW</span><h3>待你确认</h3><p>模型建议不会直接覆盖旧账；只有批准后才会生效。</p></div><div class="lm-page-count">${q.length} 项</div></div><div class="lm-review-list">`;
    for (const item of q) {
        const kind = item.kind === 'flag_conflict' ? '事实冲突' : item.kind === 'proofread' ? '校对建议' : item.kind === 'volume_compress_ask' ? '压缩确认' : '系统提醒';
        const risk = item.kind === 'flag_conflict' ? 'error' : item.kind === 'proofread' ? 'warning' : 'info';
        html += `<article class="lm-review-card" data-rid="${escapeHtml(item.id)}">
            <div class="lm-review-mark" data-state="${risk}" aria-hidden="true"></div>
            <div class="lm-review-copy"><span class="lm-state-tag" data-state="${risk}">${kind}</span><h4>${escapeHtml(item.subject || item.entry_id || '记忆系统')}</h4><p>${escapeHtml(item.note || item.value || '需要你的确认')}</p>${item.object ? `<small>关联：${escapeHtml(item.object)}</small>` : ''}</div>
            <div class="lm-row-actions">
                <button type="button" data-act="reject" class="lm-text-button">驳回</button>
                <button type="button" data-act="approve" class="lm-button lm-button-primary">批准</button>
            </div>
        </article>`;
    }
    html += '</div>';
    if (!q.length) {
        html += '<div class="lm-empty-state"><span class="fa-solid fa-check" aria-hidden="true"></span><h3>没有需要确认的内容</h3><p>冲突、校对建议和压缩请求会保留在这里，不会悄悄改动记忆。</p></div>';
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
            } else if (item.entry_id && item.kind === 'flag_conflict') {
                // approve conflict = no auto change; just dismiss (user may edit manually)
            }
            data.review_queue = data.review_queue.filter(x => x.id !== id);
            await saveChatData();
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
        return `<option value="${escapeHtml(String(id))}" ${s.connectionProfile === id ? 'selected' : ''}>${escapeHtml(String(name))}</option>`;
    }).join('');

    const q = getQueueSnapshot();
    const baseline = getChatData().progress?.baseline_pair;
    const baselineText = baseline == null ? '尚未初始化'
        : baseline < 0 ? '新聊天 · 全部楼层实时提取'
            : `第 ${baseline} 对 · 更早历史需手动迁移`;
    return `
        <div class="lm-page-heading"><div><span class="lm-kicker">CONTROL ROOM</span><h3>设置</h3><p>连接、记忆预算和历史迁移集中在这里；修改不会刷新页面。</p></div></div>
        <div class="lm-settings-layout">
            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-plug" aria-hidden="true"></span><div><h4>副模型连接</h4><p>优先使用酒馆 Connection Profile，Fallback 仅作备用。</p></div></div></header>
                <div class="lm-settings-fields">
                    <label>Connection Profile（优先）
                        <select id="lm-profile"><option value="">当前主连接 / generateRaw</option>${profileOpts}</select>
                    </label>
                    <label class="lm-switch-row"><span><b>启用 Fallback API</b><small>仅支持 OpenAI 兼容的 /chat/completions</small></span><input type="checkbox" id="lm-fb-on" ${s.fallbackEnabled ? 'checked' : ''}/></label>
                    <div class="lm-field-grid">
                        <label>Base URL<input id="lm-fb-url" type="url" inputmode="url" placeholder="https://api.example.com/v1" value="${escapeHtml(s.fallbackBaseUrl)}"/></label>
                        <label>模型名<input id="lm-fb-model" placeholder="gpt-4o-mini" value="${escapeHtml(s.fallbackModel)}"/></label>
                    </div>
                    <label>API Key<input id="lm-fb-key" placeholder="${s.fallbackApiKey ? '已保存 · 输入新 Key 可替换' : 'sk-…'}" type="password" value="" autocomplete="new-password"/></label>
                    ${s.fallbackApiKey ? '<label class="lm-compact-check"><input type="checkbox" id="lm-fb-clear-key"/> 清除已保存的 API Key</label>' : ''}
                    <p class="lm-security-note"><span class="fa-solid fa-shield-halved" aria-hidden="true"></span>Key 保存在 SillyTavern settings.json；诊断与连接测试不会显示 Key 或供应商原始响应。浏览器直连仍可能遇到 CORS。</p>
                    <div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-test-connection">保存并测试连接</button><output id="lm-connection-result" class="lm-connection-result" aria-live="polite"></output></div>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-layer-group" aria-hidden="true"></span><div><h4>记忆与注入</h4><p>控制常驻事实、摘要、检索与近楼原文的容量。</p></div></div></header>
                <div class="lm-settings-fields lm-field-grid lm-field-grid-three">
                    <label>L1 事实预算<input type="number" id="lm-b1" min="200" value="${s.budgetL1}"/></label>
                    <label>L2 摘要预算<input type="number" id="lm-b2" min="500" value="${s.budgetL2}"/></label>
                    <label>L4 检索预算<input type="number" id="lm-b4" min="0" value="${s.budgetL4}"/></label>
                    <label>近楼原文（对）<input type="number" id="lm-n" min="1" value="${s.recentPairs}"/></label>
                    <label>L1 depth<input type="number" id="lm-d1" min="0" value="${s.depthL1}"/></label>
                    <label>L2 depth<input type="number" id="lm-d2" min="0" value="${s.depthL2}"/></label>
                    <label>L4 depth<input type="number" id="lm-d4" min="0" value="${s.depthL4}"/></label>
                </div>
                <div class="lm-settings-fields">
                    <label class="lm-switch-row"><span><b>启用 L4 词法检索</b><small>只在关键词命中时注入</small></span><input type="checkbox" id="lm-l4" ${s.l4Enabled ? 'checked' : ''}/></label>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-gears" aria-hidden="true"></span><div><h4>自动整理</h4><p>决定章节、校对和卷压缩何时发生。</p></div></div></header>
                <div class="lm-settings-fields lm-field-grid lm-field-grid-three">
                    <label>每章楼数<input type="number" id="lm-ch" min="5" value="${s.chapterSize}"/></label>
                    <label>校对周期<input type="number" id="lm-pr" min="5" value="${s.proofreadEvery}"/></label>
                </div>
                <div class="lm-settings-fields">
                    <label class="lm-switch-row"><span><b>启用插件</b><small>关闭后停止注入与新任务</small></span><input type="checkbox" id="lm-enabled" ${s.enabled ? 'checked' : ''}/></label>
                    <label class="lm-switch-row"><span><b>卷压缩前需要确认</b><small>确认请求会进入待审</small></span><input type="checkbox" id="lm-vc" ${s.volumeCompressConfirm ? 'checked' : ''}/></label>
                    <label class="lm-switch-row"><span><b>迁移校对模式</b><small>迁移期间手动改表会记录错例</small></span><input type="checkbox" id="lm-mig-review" ${s.migrationReviewMode ? 'checked' : ''}/></label>
                </div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-clock-rotate-left" aria-hidden="true"></span><div><h4>存量迁移</h4><p>激活基线：${escapeHtml(baselineText)}</p></div></div></header>
                <div class="lm-settings-fields"><p>历史迁移会以最低优先级运行，不抢占新楼提取。完成后请人工校对记忆。</p><div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-migrate">开始迁移</button><button type="button" class="lm-text-button" id="lm-migrate-abort">中止迁移</button></div></div>
            </section>

            <section class="lm-settings-section">
                <header><div><span class="fa-solid fa-stethoscope" aria-hidden="true"></span><div><h4>诊断与错例</h4><p>全局错例 ${listEvalCases().length} 条 · 运行 ${q.inFlight ? '1' : '0'} · 等待 ${q.queued?.length || 0} · 失败 ${q.failed?.length || 0}</p></div></div></header>
                <div class="lm-settings-fields"><div class="lm-settings-actions"><button type="button" class="lm-button" id="lm-eval-export">导出 JSON</button><button type="button" class="lm-text-button" id="lm-eval-rerun">全部重跑</button></div><ul class="lm-diagnostic-list">${listEvalCases().slice(-10).reverse().map(c =>
        `<li><span>${escapeHtml(c.type)} · ${escapeHtml(c.pipeline)} · ${escapeHtml(c.source)}</span><span><button type="button" class="lm-text-button lm-rerun-one" data-id="${escapeHtml(c.id)}">重跑</button><button type="button" class="lm-text-button lm-del-case" data-id="${escapeHtml(c.id)}">删除</button></span></li>`).join('')}</ul></div>
            </section>
        </div>
        <div class="lm-settings-savebar"><span>设置修改后需保存才会生效</span><button type="button" class="lm-button lm-button-primary" id="lm-save">保存设置</button></div>
    `;
}

function bindSettingsTab(body) {
    body.querySelectorAll('input, select').forEach(control => {
        control.addEventListener('input', () => { settingsDirty = true; });
        control.addEventListener('change', () => { settingsDirty = true; });
    });
    ['#lm-profile', '#lm-fb-on', '#lm-fb-url', '#lm-fb-key', '#lm-fb-model', '#lm-fb-clear-key'].forEach(selector => {
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
        s.connectionProfile = body.querySelector('#lm-profile').value;
        s.fallbackEnabled = body.querySelector('#lm-fb-on').checked;
        s.fallbackBaseUrl = body.querySelector('#lm-fb-url').value.trim();
        const nextKey = body.querySelector('#lm-fb-key').value;
        if (body.querySelector('#lm-fb-clear-key')?.checked) {
            s.fallbackApiKey = '';
        } else if (nextKey) {
            s.fallbackApiKey = nextKey;
        }
        s.fallbackModel = body.querySelector('#lm-fb-model').value.trim();
        s.budgetL1 = readNumber('#lm-b1', 2000, 200);
        s.budgetL2 = readNumber('#lm-b2', 5000, 500);
        s.budgetL4 = readNumber('#lm-b4', 1500, 0);
        s.recentPairs = readNumber('#lm-n', 3, 1);
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
        button.textContent = '正在测试…';
        output.dataset.state = 'working';
        output.textContent = '正在验证连接和模型响应';
        try {
            const result = await testAuxModelConnection();
            lastConnectionTest = result;
            output.dataset.state = result.ok ? 'success' : 'error';
            output.textContent = result.ok
                ? `${result.message} · ${result.elapsedMs}ms`
                : result.message;
        } catch {
            output.dataset.state = 'error';
            output.textContent = '连接测试未完成，请稍后重试';
        } finally {
            button.disabled = false;
            button.textContent = '保存并测试连接';
            renderShellStatus();
        }
    });
    body.querySelector('#lm-migrate')?.addEventListener('click', () => {
        if (confirm('开始存量迁移？将异步回填章节摘要与状态表。')) {
            startMigration();
        }
    });
    body.querySelector('#lm-migrate-abort')?.addEventListener('click', () => requestMigrateAbort());
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
        alert(`重跑完成：${pass}/${results.length} pass`);
    });
    body.querySelectorAll('.lm-rerun-one').forEach(btn => {
        btn.addEventListener('click', async () => {
            const r = await rerunEvalCase(btn.dataset.id);
            alert(r.pass ? 'PASS' : 'FAIL');
        });
    });
    body.querySelectorAll('.lm-del-case').forEach(btn => {
        btn.addEventListener('click', () => {
            removeEvalCase(btn.dataset.id);
            renderActiveTab();
        });
    });
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
        return `第 ${value} 对`;
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
