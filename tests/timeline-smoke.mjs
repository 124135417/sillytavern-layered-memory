import assert from 'node:assert/strict';
import { parseCalendarDate, resolveCalendarDate, calendarDayDifference, buildTimeline, renderTimelinePrompt, makeTimelineCorrection, annotateTimelineHistory, validateEventWhen } from '../src/timeline.js';
const source = (floor, body, date = null, role = 'assistant') => ({ messageKey: `m${floor}`, contentFingerprint: `fp${floor}:${body}`, messageIndex: floor, role, text: date ? `『书店｜${date}｜12:00-12:10』\n${body}` : body, narrativeText: body });
const record = (s, text, evidence = text, when = null, time = null) => ({ messageKey: s.messageKey, contentFingerprint: s.contentFingerprint, messageIndex: s.messageIndex, summary: text, segments: [{ time_change: time, events: [{ text, evidence, ...(when ? { when } : {}) }] }] });
assert.equal(parseCalendarDate('2024年2月29日'), '2024-02-29');
assert.equal(parseCalendarDate('2023-02-29'), null);
assert.equal(parseCalendarDate('2024-13-01'), null);
assert.equal(parseCalendarDate('11月10日'), null, 'yearless date must not borrow the real year');
assert.equal(resolveCalendarDate('一个月后', '2024-01-31'), '2024-02-29');
assert.equal(resolveCalendarDate('一年后', '2024-02-29'), '2025-02-28');
assert.equal(resolveCalendarDate('三十一天前', '2024-08-17'), '2024-07-17');
assert.equal(resolveCalendarDate('昨天', '2024-01-01'), '2023-12-31');
assert.equal(resolveCalendarDate('两周后', '2024-07-17'), '2024-07-31');
assert.equal(resolveCalendarDate('一个月后', null), null);
assert.equal(calendarDayDifference('2024-07-17', '2024-08-17'), 31);

let a = source(0, '两人一起吃饭。', '2024-07-17');
let b = source(1, '一个月后，回到书店。', null, 'user');
let t = buildTimeline({ sources: [a, b], records: [record(a, '两人一起吃饭。')] });
assert.equal(t.current.date, '2024-08-17');
assert.equal(t.events[0].date, '2024-07-17');
assert.match(t.events[0].relative, /31天/u);
assert.match(renderTimelinePrompt(t), /2024-08-17 星期六/u);
assert.match(renderTimelinePrompt(t, { rawFloors: [0] }), /2024-07-17.*距今31天/u);
assert(!renderTimelinePrompt(t).includes('两人一起吃饭'), 'clock block never repeats event prose');
assert.match(annotateTimelineHistory('### 章节摘要｜第 0–1 楼\n旧事', t), /本段记录时点.*距今/u);

let c = source(2, '他回忆：“昨天我们吵过架。”', '2024-08-17');
let when = { kind: 'past', label: '昨天', evidence: '昨天我们吵过架' };
t = buildTimeline({ sources: [a, b, c], records: [record(a, '两人一起吃饭。'), record(c, '他提到昨天吵架。', '昨天我们吵过架', when)] });
assert.equal(t.events[1].date, '2024-08-16');
let d = source(3, '一个月后，搬到新住处。', null, 'user');
t = buildTimeline({ sources: [a, b, c, d], records: [record(a, '两人一起吃饭。'), record(c, '他提到昨天吵架。', '昨天我们吵过架', when)] });
assert.equal(t.current.date, '2024-09-17');
assert.equal(t.events[1].date, '2024-08-16', 'old yesterday remains anchored to its own floor');
assert.match(t.events[1].relative, /32天/u);

for (const body of ['“一个月后见。”', '他想起一个月前的事。', '他打算一个月后搬家。', '假如一个月后下雨。']) {
 const s = source(1, body, null, 'user');
 const r = record(s, body, body, null, { label: '一个月后', evidence: '一个月后', kind: 'relative' });
 assert.equal(buildTimeline({ sources: [a, s], records: [r] }).current.date, '2024-07-17', body);
}
let plan = source(1, '他约好明天来见面。');
t = buildTimeline({ sources: [a, plan], records: [record(plan, plan.narrativeText)] });
assert.equal(t.current.date, '2024-07-17');
assert.equal(t.events[0].date, '2024-07-18');
assert.equal(t.events[0].kind, 'future');
assert.match(annotateTimelineHistory('### 逐楼剧情记录｜第 1 楼\n他约好明天来见面。', t), /未来安排：2024-07-18/u);

let recall = source(1, '他想起小时候的第一次远行。');
t = buildTimeline({ sources: [a, recall], records: [record(recall, recall.narrativeText)] });
assert.equal(t.events[0].date, null);
assert.equal(t.events[0].recordedDate, '2024-07-17');
assert.equal(t.events[0].kind, 'unknown');
assert.equal(buildTimeline({ sources: [source(0, '屋里很安静。')] }).current, null);
assert.equal(validateEventWhen({ kind: 'past', label: '昨天', evidence: '昨天吃饭' }, '他今天离开'), null);

const wrong = source(1, '他递来一本书。', '2024-07-16');
t = buildTimeline({ sources: [a, wrong] });
assert.equal(t.current.date, '2024-07-17');
assert.equal(t.conflicts.length, 1);
const swiped = { ...a, contentFingerprint: 'different', narrativeText: '另一候选', text: '另一候选' };
assert.equal(buildTimeline({ sources: [swiped], records: [record(a, '两人一起吃饭。')] }).events.length, 0);
assert.equal(buildTimeline({ sources: [a], records: [record(a, '两人一起吃饭。')] }).current.date, '2024-07-17', 'fork truncation restores earlier clock');
const correction = makeTimelineCorrection([a, b], { messageKey: b.messageKey, date: '2024-09-01' });
assert.equal(buildTimeline({ sources: [a, b], corrections: [correction] }).current.date, '2024-09-01');
assert.equal(buildTimeline({ sources: [a], corrections: [correction] }).current.date, '2024-07-17');
assert.equal(buildTimeline({ sources: [swiped, b], corrections: [correction] }).current, null, 'prefix mismatch invalidates manual correction');
const eventCorrection = makeTimelineCorrection([a], { messageKey: a.messageKey, eventKey: 'm0:0', date: '2024-07-10', kind: 'past' });
t = buildTimeline({ sources: [a], records: [record(a, '两人一起吃饭。')], corrections: [eventCorrection] });
assert.equal(t.events[0].date, '2024-07-10');
assert.match(t.events[0].relative, /7天/u);
const reset = makeTimelineCorrection([a], { messageKey: a.messageKey, eventKey: 'm0:0', reset: true });
assert.equal(buildTimeline({ sources: [a], records: [record(a, '两人一起吃饭。')], corrections: [eventCorrection, reset] }).events[0].date, '2024-07-17');
const before = JSON.stringify([a, b]); buildTimeline({ sources: [a, b], records: [] }); assert.equal(JSON.stringify([a, b]), before);
console.log('Timeline: Gregorian arithmetic, old-yesterday rebasing, scene/recall/plan separation, evidence, candidate prefixes, fork truncation and manual reset passed.');
// Manual corrections also work on legacy summary-only records.
const legacy = { ...record(a, '旧记录'), segments: [] };
const legacyFix = makeTimelineCorrection([a], { messageKey: a.messageKey, eventKey: 'm0:summary', date: '2024-06-01', kind: 'past' });
assert.equal(buildTimeline({ sources: [a], records: [legacy], corrections: [legacyFix] }).events[0].date, '2024-06-01');
const futurePassed = source(2, '两天后，回到书店。', null, 'user');
const overdue = buildTimeline({ sources: [a, plan, futurePassed], records: [record(plan, plan.narrativeText)] });
assert.match(overdue.events[0].relative, /日期已过1天.*兑现未确认/u);
const question = source(1, '他问昨天的钥匙在哪里。', '2024-07-18');
const asked = buildTimeline({ sources: [a, question], records: [record(question, question.narrativeText)] });
assert.equal(asked.events[0].date, '2024-07-18', 'asking today about yesterday is not an event that happened yesterday');
assert.equal(asked.events[0].referenceDate, '2024-07-17');
assert.match(annotateTimelineHistory('### 逐楼剧情记录｜第 1 楼\n他问昨天的钥匙在哪里。', asked), /原文“昨天”指2024-07-17/u);
assert(renderTimelinePrompt(t, { maxChars: 1000 }).length <= 1000);
const multi = source(1, '第二天，他开门。三天后，他关门。');
const multiRecord = { ...record(multi, '先开门后关门'), segments: [
 { time_change: { label: '第二天', evidence: '第二天' }, events: [{ text: '他开门', evidence: '他开门' }] },
 { time_change: { label: '三天后', evidence: '三天后' }, events: [{ text: '他关门', evidence: '他关门' }] },
] };
const crossed = buildTimeline({ sources: [a, multi], records: [multiRecord] });
assert.equal(crossed.current.date, '2024-07-21');
assert.deepEqual(crossed.events.map(e => e.date), ['2024-07-18', '2024-07-21']);

assert.equal(resolveCalendarDate('一百零二天前', '2024-08-17'), '2024-05-07');
const midnight = { ...source(1, '他们走过午夜。'), text: '『书店｜2024-12-31｜23:55-00:05』\n他们走过午夜。' };
assert.equal(buildTimeline({ sources: [midnight] }).current.date, '2025-01-01');
assert.equal(buildTimeline({ sources: [midnight] }).current.minute, 5);
const noTime = { ...source(1, '他开门。'), text: '『书店｜2024-07-18｜清晨』\n他开门。' };
assert.equal(buildTimeline({ sources: [a, noTime] }).current.minute, null, 'new day with unknown hour must not inherit yesterday exact hour');

// Multiple events in one floor keep their own occurrence dates; GUI data stays complete.
const mixed = source(1, '他今天来吃饭。他回忆昨天在码头丢失钥匙。他约好明天再来。', '2024-07-18');
const mixedRecord = { ...record(mixed, mixed.narrativeText), segments: [{ events: [
 { text: '他今天来吃饭。', evidence: '他今天来吃饭。' },
 { text: '他回忆昨天在码头丢失钥匙。', evidence: '昨天在码头丢失钥匙', when: { kind: 'past', label: '昨天', evidence: '昨天在码头丢失钥匙' } },
 { text: '他约好明天再来。', evidence: '他约好明天再来。' },
] }] };
const mixedTimeline = buildTimeline({ sources: [a, mixed], records: [mixedRecord] });
const body = '### 逐楼剧情记录｜第 1 楼\n他今天来吃饭。他回忆昨天在码头丢失钥匙。他约好明天再来。\n【本段范围结束｜第 1 楼】';
const annotated = annotateTimelineHistory(body, mixedTimeline);
assert.match(annotated, /〔事件：2024-07-17，距今1天[^〕]*〕他回忆昨天/u);
assert.match(annotated, /〔事件：未来安排：2024-07-19/u);
assert(!annotated.includes('〔事件：2024-07-18'), 'ordinary same-day events share section date');
assert.equal(mixedTimeline.events.length, 3, 'complete GUI timeline is not pruned');
assert.equal(annotated.replace(/〔事件：[^〕]*〕/gu, '').replace(/【本段记录时点：[^\n]*】\n/gu, ''), body, 'only time metadata is added, event prose is unchanged');
const compressed = '### 长期摘要｜第 0–1 楼\n他今天来吃饭。\n【本段范围结束｜第 0–1 楼】';
const compressedTime = annotateTimelineHistory(compressed, mixedTimeline);
assert(!compressedTime.includes('码头') && !compressedTime.includes('明天再来'), 'compression must not resurrect omitted events');
assert.match(compressedTime, /〔事件：2024-07-18，同一剧情日〕他今天来吃饭/u);
const notExact = annotateTimelineHistory('### 长期摘要｜第 0–1 楼\n他在码头经历了一场意外。', mixedTimeline);
assert(!notExact.includes('〔事件：'), 'paraphrases are not assigned guessed occurrence dates');
const conflictTimeline = { ...mixedTimeline, events: [
 ...mixedTimeline.events,
 { ...mixedTimeline.events[1], date: '2024-07-16', relative: '距今2天' },
] };
assert(!annotateTimelineHistory(body, conflictTimeline).includes('〕他回忆昨天'), 'ambiguous identical wording on different days stays unassigned');
assert(!annotateTimelineHistory('### 长期摘要｜第 0 楼\n他约好明天再来。', mixedTimeline).includes('〔事件：'), 'out-of-range events cannot annotate an earlier summary');
const budget = renderTimelinePrompt({ ...mixedTimeline, events: Array.from({ length: 5000 }, () => mixedTimeline.events[0]) });
assert(budget.length < 400 && !budget.includes('吃饭'), 'clock size is independent of event count');
const rebased = buildTimeline({ sources: [a, mixed, source(2, '一个月后，回到书店。', null, 'user')], records: [mixedRecord] });
assert.match(annotateTimelineHistory(body, rebased), /2024-07-17，距今32天/u);
assert.match(annotateTimelineHistory(body, rebased), /约定日期已过30天/u);
const rewound = buildTimeline({ sources: [a, mixed], records: [mixedRecord] });
assert.match(annotateTimelineHistory(body, rewound), /2024-07-17，距今1天/u);
console.log('Timeline dedup: selected-event dates, same-floor mixed times, compression boundaries, conservative matching, constant clock size and branch rebasing passed.');
const retainedClause = '他们昨天在码头找到遗失的蓝色钥匙';
const compressedEvent = { ...mixedTimeline.events[1], text: `他解释，${retainedClause}，后来才回家。` };
const literalClauseTimeline = { ...mixedTimeline, events: [compressedEvent] };
const clauseSummary = `### 长期摘要｜第 0–1 楼\n${retainedClause}。`;
assert.match(annotateTimelineHistory(clauseSummary, literalClauseTimeline), /2024-07-17，距今1天[^〕]*〕他们昨天/u, 'verbatim retained clauses can receive occurrence dates without restoring omitted prose');
assert(!annotateTimelineHistory(clauseSummary, { ...literalClauseTimeline, events: [compressedEvent, { ...compressedEvent, date: '2024-07-16', relative: '距今2天' }] }).includes('〔事件：'), 'conflicting verbatim clause matches must not guess a date');
assert.match(annotateTimelineHistory('### 逐楼剧情记录｜第 1 楼\n他开门。他关门。', crossed), /2024-07-18，距今3天[^〕]*〕他开门/u, 'multiple dated scenes within one floor keep event-level dates');

const nestedTimeline = { ...mixedTimeline, events: [
 { ...mixedTimeline.events[1], text: '他回忆昨天在码头丢失钥匙' },
 { ...mixedTimeline.events[1], text: '码头丢失钥匙', date: '2024-07-16', relative: '距今2天' },
] };
assert(!annotateTimelineHistory(body, nestedTimeline).includes('〔事件：'), 'overlapping wording with conflicting dates cannot choose a misleading longer match');
