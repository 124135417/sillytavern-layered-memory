import { SLOT_LABELS, SLOTS } from '../constants.js';
import { listConnectionProfiles } from '../aux-model.js';
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
import { enqueue, getQueueSnapshot, rebuildAndEnqueuePending } from '../queue.js';
import { QUEUE_PRIORITY } from '../constants.js';
import { getChatData, getSettings, saveChatData, saveSettings } from '../settings.js';
import { updateInjection } from '../inject.js';

const ROOT_ID = 'layered-memory-panel';

export function injectPanel() {
    if (document.getElementById(ROOT_ID)) {
        return;
    }
    const host = document.getElementById('extensions_settings')
        || document.getElementById('rm_extensions_block')
        || document.body;

    const wrap = document.createElement('div');
    wrap.id = ROOT_ID;
    wrap.className = 'layered-memory-root';
    wrap.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>分层长程记忆</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display:none;">
                <div class="lm-tabs">
                    <button type="button" data-tab="state" class="menu_button lm-tab active">状态表</button>
                    <button type="button" data-tab="chapters" class="menu_button lm-tab">章节</button>
                    <button type="button" data-tab="review" class="menu_button lm-tab">待审</button>
                    <button type="button" data-tab="settings" class="menu_button lm-tab">设置</button>
                </div>
                <div class="lm-body"></div>
            </div>
        </div>
    `;
    host.appendChild(wrap);

    const drawer = wrap.querySelector('.inline-drawer-toggle');
    const content = wrap.querySelector('.inline-drawer-content');
    drawer.addEventListener('click', async () => {
        const open = content.style.display !== 'none';
        content.style.display = open ? 'none' : 'block';
        if (!open) {
            await rebuildAndEnqueuePending({ forceLastSealed: true });
            renderActiveTab();
        }
    });

    wrap.querySelectorAll('.lm-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            wrap.querySelectorAll('.lm-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderActiveTab();
        });
    });
}

function activeTab() {
    return document.querySelector(`#${ROOT_ID} .lm-tab.active`)?.dataset.tab || 'state';
}

export function renderActiveTab() {
    const body = document.querySelector(`#${ROOT_ID} .lm-body`);
    if (!body) {
        return;
    }
    const tab = activeTab();
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
        body.innerHTML = renderSettingsTab();
        bindSettingsTab(body);
    }
}

function renderStateTab() {
    const data = getChatData();
    const entries = data.state_table?.entries || [];
    let html = `
        <div class="lm-toolbar">
            <button type="button" class="menu_button" id="lm-add-entry">+ 手动添加</button>
            <button type="button" class="menu_button" id="lm-report-error">报错（记入错例）</button>
            <button type="button" class="menu_button" id="lm-proof-now">立即校对</button>
            <span class="lm-muted">共 ${entries.length} 条 · 表版本 ${data.state_table?.version ?? 0}</span>
        </div>
    `;
    for (const slot of SLOTS) {
        const group = entries.filter(e => e.slot === slot);
        if (!group.length) {
            continue;
        }
        html += `<h4>${SLOT_LABELS[slot]}</h4><ul class="lm-list">`;
        for (const e of group) {
            html += `<li data-id="${e.id}" class="${e.pinned ? 'lm-pinned' : ''}">
                <div><b>${escapeHtml(e.subject)}</b>${e.object ? ' ↔ ' + escapeHtml(e.object) : ''}：${escapeHtml(e.value)}
                <span class="lm-muted">(${escapeHtml(String(e.updated_floor ?? e.established_floor))})</span></div>
                <div class="lm-row-actions">
                    <button type="button" data-act="pin" class="menu_button">${e.pinned ? '取消钉住' : '钉住'}</button>
                    <button type="button" data-act="edit" class="menu_button">编辑</button>
                    <button type="button" data-act="del" class="menu_button">删除</button>
                    <button type="button" data-act="report" class="menu_button">报错</button>
                </div>
            </li>`;
        }
        html += '</ul>';
    }
    if (!entries.length) {
        html += '<p class="lm-muted">状态表为空。定格楼层会在下一楼用户发言时（或打开本面板时）提取。</p>';
    }
    return html;
}

function bindStateTab(body) {
    body.querySelector('#lm-add-entry')?.addEventListener('click', async () => {
        const subject = prompt('主体（subject）');
        if (!subject) {
            return;
        }
        const value = prompt('值（value）');
        if (!value) {
            return;
        }
        const slot = prompt(`槽位：${SLOTS.join('/')}`, 'other') || 'other';
        const data = getChatData();
        const before = null;
        const id = `e_${String(data.progress.next_entry_seq++).padStart(4, '0')}`;
        const entry = {
            id, slot, subject, object: '', value, cause: '',
            established_floor: 'manual', updated_floor: 'manual',
            evidence: '', pinned: false, source: 'manual',
        };
        data.state_table.entries.push(entry);
        data.state_table.version += 1;
        await saveChatData();
        recordMigrationEdit({ beforeEntry: before, afterEntry: entry, op: 'add' });
        updateInjection();
        renderActiveTab();
    });

    body.querySelector('#lm-proof-now')?.addEventListener('click', () => {
        enqueue('proofread', {}, QUEUE_PRIORITY.proofread);
        toastr?.info?.('已入队校对任务') || alert('已入队校对任务');
    });

    body.querySelector('#lm-report-error')?.addEventListener('click', () => openReportDialog({}));

    body.querySelectorAll('li[data-id]').forEach(li => {
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
            const value = prompt('新的 value', e.value);
            if (value == null) {
                return;
            }
            e.value = value;
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
    const chapters = data.chapters || [];
    const volumes = data.volumes || [];
    let html = `<div class="lm-toolbar"><span class="lm-muted">章节 ${chapters.length} · 卷 ${volumes.length}</span></div>`;
    if (volumes.length) {
        html += '<h4>卷摘要</h4><ul class="lm-list">';
        for (const v of volumes) {
            html += `<li><b>${v.id}</b>${v.stale ? ' [stale]' : ''}<pre class="lm-pre">${escapeHtml(v.summary)}</pre></li>`;
        }
        html += '</ul>';
    }
    html += '<h4>章节</h4><ul class="lm-list">';
    for (const c of chapters) {
        html += `<li data-cid="${c.id}">
            <div><b>${c.id}</b> 第${c.floor_range[0]}–${c.floor_range[1]}对
            ${c.pinned ? '📌' : ''} ${c.demoted ? '[已降级]' : ''} ${c.stale ? '[stale]' : ''}</div>
            <pre class="lm-pre">${escapeHtml(c.summary)}</pre>
            <div class="lm-row-actions">
                <button type="button" data-act="edit" class="menu_button">编辑</button>
                <button type="button" data-act="pin" class="menu_button">${c.pinned ? '取消钉住' : '钉住整章'}</button>
            </div>
        </li>`;
    }
    html += '</ul>';
    if (!chapters.length) {
        html += '<p class="lm-muted">尚无章节摘要。默认每 25 对楼生成一章。</p>';
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
    let html = '<ul class="lm-list">';
    for (const item of q) {
        html += `<li data-rid="${item.id}">
            <div><b>${escapeHtml(item.kind)}</b> ${escapeHtml(item.note || item.value || '')}</div>
            <div class="lm-row-actions">
                <button type="button" data-act="approve" class="menu_button">批准</button>
                <button type="button" data-act="reject" class="menu_button">驳回</button>
            </div>
        </li>`;
    }
    html += '</ul>';
    if (!q.length) {
        html += '<p class="lm-muted">待审列表为空。</p>';
    }
    return html;
}

function bindReviewTab(body) {
    body.querySelectorAll('li[data-rid]').forEach(li => {
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
    return `
        <label class="lm-field"><input type="checkbox" id="lm-enabled" ${s.enabled ? 'checked' : ''}/> 启用插件</label>
        <label class="lm-field"><input type="checkbox" id="lm-mig-review" ${s.migrationReviewMode ? 'checked' : ''}/> 迁移校对模式（开启时手动改表才自动记错例）</label>
        <p class="lm-muted">激活基线：第 ${getChatData().progress?.baseline_pair ?? '（尚未初始化）'} 对 — 此前历史仅能通过「存量迁移」处理，不会自动提取。</p>
        <label class="lm-field">Connection Profile（优先）
            <select id="lm-profile"><option value="">（当前主连接 / generateRaw）</option>${profileOpts}</select>
        </label>
        <details class="lm-field">
            <summary>Fallback API（可能遇 CORS；Key 会写入 ST settings.json）</summary>
            <label><input type="checkbox" id="lm-fb-on" ${s.fallbackEnabled ? 'checked' : ''}/> 启用 fallback</label>
            <input class="text_pole" id="lm-fb-url" placeholder="Base URL" value="${escapeHtml(s.fallbackBaseUrl)}"/>
            <input class="text_pole" id="lm-fb-key" placeholder="API Key" type="password" value="${escapeHtml(s.fallbackApiKey)}"/>
            <input class="text_pole" id="lm-fb-model" placeholder="模型名" value="${escapeHtml(s.fallbackModel)}"/>
            <p class="lm-warn">Key 将保存在 ST 服务器设置中，共享/备份 settings.json 时注意。</p>
        </details>
        <div class="lm-grid">
            <label>L1 预算 <input class="text_pole" type="number" id="lm-b1" value="${s.budgetL1}"/></label>
            <label>L2 预算 <input class="text_pole" type="number" id="lm-b2" value="${s.budgetL2}"/></label>
            <label>L4 预算 <input class="text_pole" type="number" id="lm-b4" value="${s.budgetL4}"/></label>
            <label>近 N 对 <input class="text_pole" type="number" id="lm-n" value="${s.recentPairs}"/></label>
            <label>章大小 <input class="text_pole" type="number" id="lm-ch" value="${s.chapterSize}"/></label>
            <label>校对周期 <input class="text_pole" type="number" id="lm-pr" value="${s.proofreadEvery}"/></label>
            <label>L1 depth <input class="text_pole" type="number" id="lm-d1" value="${s.depthL1}"/></label>
            <label>L2 depth <input class="text_pole" type="number" id="lm-d2" value="${s.depthL2}"/></label>
            <label>L4 depth <input class="text_pole" type="number" id="lm-d4" value="${s.depthL4}"/></label>
        </div>
        <label class="lm-field"><input type="checkbox" id="lm-l4" ${s.l4Enabled ? 'checked' : ''}/> 启用 L4 检索</label>
        <label class="lm-field"><input type="checkbox" id="lm-vc" ${s.volumeCompressConfirm ? 'checked' : ''}/> 卷压缩需确认</label>
        <button type="button" class="menu_button" id="lm-save">保存设置</button>
        <hr/>
        <h4>存量迁移</h4>
        <button type="button" class="menu_button" id="lm-migrate">开始迁移</button>
        <button type="button" class="menu_button" id="lm-migrate-abort">中止迁移</button>
        <p class="lm-muted">请迁移后人工校对状态表；并从 RP 预设中移除「每轮顺带摘要」类指令。</p>
        <hr/>
        <h4>错例库（全局 ${listEvalCases().length} 条）</h4>
        <button type="button" class="menu_button" id="lm-eval-export">导出 JSON</button>
        <button type="button" class="menu_button" id="lm-eval-rerun">全部重跑</button>
        <ul class="lm-list">${listEvalCases().slice(-20).reverse().map(c =>
        `<li>${escapeHtml(c.type)} · ${escapeHtml(c.pipeline)} · ${escapeHtml(c.source)}
            <button type="button" class="menu_button lm-rerun-one" data-id="${c.id}">重跑</button>
            <button type="button" class="menu_button lm-del-case" data-id="${c.id}">删</button>
            </li>`).join('')}</ul>
        <p class="lm-muted">队列：进行中 ${q.inFlight?.type || '无'} · 等待 ${q.queued.length}</p>
    `;
}

function bindSettingsTab(body) {
    body.querySelector('#lm-save')?.addEventListener('click', () => {
        const s = getSettings();
        s.enabled = body.querySelector('#lm-enabled').checked;
        s.migrationReviewMode = body.querySelector('#lm-mig-review').checked;
        s.connectionProfile = body.querySelector('#lm-profile').value;
        s.fallbackEnabled = body.querySelector('#lm-fb-on').checked;
        s.fallbackBaseUrl = body.querySelector('#lm-fb-url').value.trim();
        s.fallbackApiKey = body.querySelector('#lm-fb-key').value;
        s.fallbackModel = body.querySelector('#lm-fb-model').value.trim();
        s.budgetL1 = Number(body.querySelector('#lm-b1').value) || 2000;
        s.budgetL2 = Number(body.querySelector('#lm-b2').value) || 5000;
        s.budgetL4 = Number(body.querySelector('#lm-b4').value) || 1500;
        s.recentPairs = Number(body.querySelector('#lm-n').value) || 3;
        s.chapterSize = Number(body.querySelector('#lm-ch').value) || 25;
        s.proofreadEvery = Number(body.querySelector('#lm-pr').value) || 75;
        s.depthL1 = Number(body.querySelector('#lm-d1').value) || 100;
        s.depthL2 = Number(body.querySelector('#lm-d2').value) || 100;
        s.depthL4 = Number(body.querySelector('#lm-d4').value) || 4;
        s.l4Enabled = body.querySelector('#lm-l4').checked;
        s.volumeCompressConfirm = body.querySelector('#lm-vc').checked;
        saveSettings();
        updateInjection();
        alert('已保存');
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
