import { buildChatTimeline, buildCoreMemoryParts, isTimelineBusy, updateInjection } from '../inject.js';
import { makeTimelineCorrection, parseCalendarDate } from '../timeline.js';
import { getChatData, getSettings, saveChatData, saveSettings } from '../settings.js';
import { openFormDialog, openMessageDialog } from './dialogs.js';
import { displayNarrativeText } from '../quality.js';
const escape = value => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let limit = 40;
function eventRow(event) {
    const labels = { current: '经历', past: '往事', future: '未来提及 / 安排', ongoing: '持续状态', unknown: '时间待定位' };
    return `<article class="lm-time-event" data-time-key="${escape(event.key)}"><div class="lm-time-event-head"><strong>${escape(event.date || '发生日期未知')}</strong><span>${escape(labels[event.kind] || '时间待定位')} · ${escape(event.relative)}</span></div><p>${escape(displayNarrativeText(event.text))}</p>${event.referenceDate ? `<p class="lm-time-help">原文“${escape(event.referenceLabel)}”指 ${escape(event.referenceDate)}</p>` : ''}<div class="lm-time-actions"><span>${escape(event.recordedDate ? `记录于 ${event.recordedDate}` : '记录日期也未明确')} · 第 ${event.floor} 楼${event.manual ? ' · 已校正' : ''}</span><button type="button" class="lm-text-button" data-time-source="${escape(event.key)}">来源</button><button type="button" class="lm-text-button" data-time-edit="${escape(event.key)}">校正</button></div></article>`;
}
export function renderTimelineTab() {
    const timeline = buildChatTimeline();
    const now = timeline.current;
    const minute = Number.isInteger(now?.minute) ? `${String(Math.floor(now.minute / 60)).padStart(2, '0')}:${String(now.minute % 60).padStart(2, '0')}` : '时刻未明确';
    const sorted = [...timeline.events].sort((a, b) => b.floor - a.floor);
    const visible = sorted.slice(0, limit);
    const groups = [
        ['过去与当天的经历', e => e.date && e.kind !== 'future' && e.kind !== 'ongoing'],
        ['未来提及与约定', e => e.kind === 'future'],
        ['持续状态与日期待定位', e => e.kind === 'ongoing' || (!e.date && e.kind !== 'future')],
    ];
    return `<div class="lm-time-page lm-page-content"><header class="lm-time-now"><span class="lm-kicker">当前分支 · 剧情日历</span><h3>${escape(now?.date || '日期未明确')}</h3><p>${escape(minute)}${now ? ` · 来源第 ${now.floor} 楼${now.manual ? ' · 手动校正' : ''}` : ' · 等待剧情日期，不使用现实日期代填'}</p><button id="lm-time-now-edit" type="button" class="lm-button" ${timeline.sources.length ? '' : 'disabled'}>校正当前日期</button></header><label class="lm-time-toggle"><input id="lm-time-enabled" type="checkbox" ${getSettings().timelineEnabled !== false ? 'checked' : ''}> 向模型提供时间定位</label><p class="lm-time-help">距今多久随剧情时间重算。记录日期与发生日期分别保留；未来安排不会因为到期自动变成已发生。</p>${timeline.conflicts.length ? `<details class="lm-time-conflicts"><summary>有 ${timeline.conflicts.length} 处时间冲突待核对</summary>${timeline.conflicts.map(c => `<p>第 ${c.floor} 楼：${escape(c.reason)} <button type="button" class="lm-text-button" data-time-clock-source="${escape(c.messageKey)}">查看来源</button> <button type="button" class="lm-text-button" data-time-clock-edit="${escape(c.messageKey)}">校正该楼</button></p>`).join('')}</details>` : ''}${groups.map(([label, match]) => `<section class="lm-time-group"><h4>${label}</h4>${visible.filter(match).map(eventRow).join('') || '<p class="lm-time-help">暂无可定位记录</p>'}</section>`).join('')}${sorted.length > limit ? '<button id="lm-time-more" type="button" class="lm-button">显示更多记录</button>' : ''}<details class="lm-time-preview"><summary>模型会收到什么</summary><pre>展开时读取当前请求的时间定位</pre></details></div>`;
}
async function editTime(eventKey, rerender, clockSourceKey = null) {
    if (isTimelineBusy()) { await openMessageDialog({ title: '正在生成', description: '请等回复结束后再校正时间，避免修改正在使用的时间依据。' }); return; }
    const data = getChatData();
    const timeline = buildChatTimeline();
    const event = eventKey ? timeline.events.find(e => e.key === eventKey) : null;
    const source = clockSourceKey ? timeline.sources.find(s => s.messageKey === clockSourceKey) : event ? timeline.sources.find(s => s.messageKey === event.messageKey) : timeline.sources.at(-1);
    if (!source) return;
    const result = await openFormDialog({
        title: event ? '校正事件发生时间' : clockSourceKey ? '校正该楼剧情日期' : '校正当前剧情日期',
        description: '只更正时间定位，不修改原文。校正跟随当前候选和分支，回到更早位置不会带入未来的校正。', submitLabel: '保存校正',
        buildFields(fields) {
            const label = document.createElement('label'); label.textContent = '剧情日期';
            const input = document.createElement('input'); input.type = 'date'; input.name = 'date'; input.value = (event ? event.date : clockSourceKey ? timeline.clocks.find(c => c.messageKey === clockSourceKey)?.date : timeline.current?.date) || ''; label.append(input); fields.append(label);
            if (event) {
                const kindLabel = document.createElement('label'); kindLabel.textContent = '这是什么时间';
                const select = document.createElement('select'); select.name = 'kind';
                for (const [value, name] of [['past', '已经发生的经历'], ['future', '未来提及 / 约定，尚未发生'], ['ongoing', '持续状态的起始时间']]) {
                    const option = document.createElement('option'); option.value = value; option.textContent = name; select.append(option);
                }
                select.value = event.kind === 'current' || event.kind === 'unknown' ? 'past' : event.kind; kindLabel.append(select); fields.append(kindLabel);
            }
            const resetLabel = document.createElement('label'); const reset = document.createElement('input'); reset.type = 'checkbox'; reset.name = 'reset'; resetLabel.append(reset, ' 撤销本项手动校正，恢复自动定位'); fields.append(resetLabel);
        },
        readValue(form) { return { date: form.elements.date.value, kind: form.elements.kind?.value || 'current', reset: form.elements.reset.checked }; },
        validate(value) { return !value.reset && !parseCalendarDate(value.date) ? '请选择有效日期，或勾选恢复自动定位。' : ''; },
    });
    if (!result) return;
    if (isTimelineBusy()) return;
    if (getChatData() !== data) { await openMessageDialog({ title: '聊天已经变化', description: '请在当前分支重新打开校正，原分支没有改动。' }); return; }
    const latest = buildChatTimeline();
    const stillValid = latest.sources.find(s => s.messageKey === source.messageKey && s.contentFingerprint === source.contentFingerprint);
    if ((!event && !clockSourceKey && latest.sources.at(-1)?.messageKey !== source.messageKey) || !stillValid || (event && !latest.events.some(e => e.key === event.key && e.fingerprint === event.fingerprint))) { rerender(); return; }
    const correction = makeTimelineCorrection(latest.sources, { messageKey: source.messageKey, eventKey, ...result });
    data.timeline_corrections = [...(data.timeline_corrections || []), correction];
    try { await saveChatData(data); updateInjection(); rerender(); }
    catch (error) { data.timeline_corrections = data.timeline_corrections.filter(c => c.id !== correction.id); throw error; }
}
export function bindTimelineTab(body, rerender) {
    const reportSaveError = error => { console.error(error); void openMessageDialog({ title: '时间校正未保存', description: error?.message || '保存失败，请重试。原文没有改动。' }); };
    body.querySelector('.lm-time-preview')?.addEventListener('toggle', event => { if (event.target.open) { const parts = buildCoreMemoryParts(); event.target.querySelector('pre').textContent = parts.temporal ? [parts.temporal, '以下为本轮选中的历史摘要（时间已合入，未另发完整事件表）：', parts.l2].filter(Boolean).join('\n\n') : '当前时间定位未启用或还没有可定位的日期。'; } });
    body.querySelectorAll('[data-time-clock-edit]').forEach(button => button.addEventListener('click', () => void editTime(null, rerender, button.dataset.timeClockEdit).catch(reportSaveError)));
    body.querySelectorAll('[data-time-clock-source]').forEach(button => button.addEventListener('click', () => {
        const source = buildChatTimeline().sources.find(s => s.messageKey === button.dataset.timeClockSource);
        if (source) void openMessageDialog({ title: `第 ${source.messageIndex} 楼 · 时间来源`, description: `${source.sceneContext?.raw || ''}\n${String(source.narrativeText || '').slice(0, 600)}` });
    }));
    body.querySelector('#lm-time-now-edit')?.addEventListener('click', () => void editTime(null, rerender).catch(reportSaveError));
    body.querySelector('#lm-time-enabled')?.addEventListener('change', event => { getSettings().timelineEnabled = event.target.checked; saveSettings(); updateInjection(); });
    body.querySelector('#lm-time-more')?.addEventListener('click', () => { limit += 40; rerender(); });
    body.querySelectorAll('[data-time-edit]').forEach(button => button.addEventListener('click', () => void editTime(button.dataset.timeEdit, rerender).catch(reportSaveError)));
    body.querySelectorAll('[data-time-source]').forEach(button => button.addEventListener('click', () => {
        const event = buildChatTimeline().events.find(e => e.key === button.dataset.timeSource);
        if (event) void openMessageDialog({ title: `第 ${event.floor} 楼 · 时间来源`, description: event.evidence || '旧摘要没有逐项原文证据；未自动认定事件发生日期。' });
    }));
}
