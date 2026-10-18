/** Branch-derived story calendar. No real clock, storage writes or model calls. */
const DAY = 86400000;
const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const datePattern = /(?<!\d)(\d{4})\s*(?:[-/.年])\s*(\d{1,2})\s*(?:[-/.月])\s*(\d{1,2})(?:日)?(?!\d)/u;
const relativePattern = /(?:昨天|昨日|前天|今天|今日|明天|明日|后天|次日|翌日|第二天|(?:\d+|[零〇一二两三四五六七八九十百]+)\s*(?:个)?(?:天|日|周|星期|月|年)(?:之)?[前后])/u;
const recallPattern = /回忆|回想|想起|当年|小时候|童年|曾经|多年前/u;
const planPattern = /约好|约定|打算|计划|准备|将于|到时候|下周|下个月|明天|明日|后天/u;
const text = value => String(value ?? '').trim();

export function parseCalendarDate(value) {
    const m = datePattern.exec(text(value));
    if (!m) return null;
    const [y, mo, d] = m.slice(1).map(Number);
    if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const date = new Date(0); date.setUTCFullYear(y, mo - 1, d); date.setUTCHours(0, 0, 0, 0);
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function dateObject(iso) {
    const date = new Date(0); const [y, m, d] = iso.split('-').map(Number);
    date.setUTCFullYear(y, m - 1, d); date.setUTCHours(0, 0, 0, 0); return date;
}
const epochCache = new Map();
function calendarEpoch(value) {
    const key = text(value);
    if (epochCache.has(key)) return epochCache.get(key);
    const iso = parseCalendarDate(key);
    if (!iso) return null;
    const epoch = Number(dateObject(iso));
    if (epochCache.size > 2048) epochCache.clear();
    epochCache.set(key, epoch); return epoch;
}
export function calendarDayDifference(from, to) {
    const a = calendarEpoch(from), b = calendarEpoch(to);
    return a === null || b === null ? null : Math.round((b - a) / DAY);
}
function count(value) {
    value = value.replace(/^[零〇]+/u, '');
    if (!value) return 0;
    if (/^\d+$/u.test(value)) return Number(value);
    if (value === '十') return 10;
    if (value.includes('百')) { const [a, b] = value.split('百'); return (digits[a] || 1) * 100 + (b ? count(b) : 0); }
    if (value.includes('十')) { const [a, b] = value.split('十'); return (digits[a] || 1) * 10 + (digits[b] || 0); }
    return digits[value] ?? NaN;
}
export function resolveCalendarDate(label, base) {
    const absolute = parseCalendarDate(label);
    if (absolute) return absolute;
    if (!parseCalendarDate(base)) return null;
    const raw = text(label);
    const fixed = /前天/u.test(raw) ? -2 : /后天/u.test(raw) ? 2 : /昨天|昨日/u.test(raw) ? -1
        : /明天|明日|次日|翌日|第二天/u.test(raw) ? 1 : /今天|今日/u.test(raw) ? 0 : null;
    const match = /([\d零〇一二两三四五六七八九十百]+)\s*(?:个)?(天|日|周|星期|月|年)(?:之)?([前后])/u.exec(raw);
    if (fixed === null && !match) return null;
    const date = dateObject(base);
    let n = match ? count(match[1]) * (match[3] === '前' ? -1 : 1) : fixed;
    if (!Number.isFinite(n) || Math.abs(n) > 365000) return null;
    if (match && ['月', '年'].includes(match[2])) {
        const originalDay = date.getUTCDate(); date.setUTCDate(1);
        if (match[2] === '年') date.setUTCFullYear(date.getUTCFullYear() + n);
        else date.setUTCMonth(date.getUTCMonth() + n);
        const last = new Date(date.getTime()); last.setUTCMonth(last.getUTCMonth() + 1, 0);
        date.setUTCDate(Math.min(originalDay, last.getUTCDate()));
    } else date.setUTCDate(date.getUTCDate() + n * (match && ['周', '星期'].includes(match[2]) ? 7 : 1));
    if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
    return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
export function relativeCalendarLabel(date, now) {
    const days = calendarDayDifference(date, now);
    if (days === null) return '发生日期未明确';
    if (!days) return '同一剧情日';
    return days > 0 ? `距今${days}天${days === 1 ? '（昨天）' : days === 2 ? '（前天）' : ''}` : `还有${-days}天，尚未发生`;
}
function minuteOf(value) {
    const matches = [...text(value).matchAll(/(?<!\d)([01]?\d|2[0-3])[:：]([0-5]\d)(?!\d)/gu)];
    const m = matches.at(-1); return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function clockCandidate(source) {
    const raw = text(source.text);
    const heading = /^\s*『([^』]{1,600})』/u.exec(raw)?.[1];
    const region = source.sceneContext?.status === 'matched' ? source.sceneContext.time : heading;
    let date = parseCalendarDate(region);
    const startDate = date;
    const minute = minuteOf(region);
    const overnight = /([01]?\d|2[0-3]):([0-5]\d)\s*[-–—~至]\s*([01]?\d|2[0-3]):([0-5]\d)/u.exec(text(region));
    if (date && overnight && Number(overnight[3]) * 60 + Number(overnight[4]) < Number(overnight[1]) * 60 + Number(overnight[2])) date = resolveCalendarDate('次日', date);
    return { date, startDate, minute, evidence: text(region), kind: 'scene' };
}
function sceneAdvances(source, record) {
    const body = text(source.narrativeText ?? source.text).replace(/^『[^』]*』\s*/u, '');
    const result = [];
    const add = (label, evidence, position) => {
        const prefix = body.slice(0, position);
        const nearby = prefix.slice(-28);
        const quoted = (prefix.match(/“/gu) || []).length > (prefix.match(/”/gu) || []).length
            || (prefix.match(/「/gu) || []).length > (prefix.match(/」/gu) || []).length
            || (prefix.match(/"/gu) || []).length % 2;
        const after = body.slice(position + label.length);
        if (quoted || /回忆|回想|想起|约好|约定|计划|打算|曾经|假如|假设|承诺|答应|提到|他说|她说|出生|生日|童年|小时候|当年|那年/u.test(nearby)) return;
        if (after && !/^[）)\s，,。！!：:]/u.test(after)) return;
        if (!parseCalendarDate(label) && !/^(?:次日|翌日|第二天|[\d一二两三四五六七八九十百]+\s*个?(?:天|周|星期|月|年)(?:之)?后)$/u.test(label)) return;
        if (!result.some(item => item.position === position)) result.push({ label, evidence, position });
    };
    const opening = /^[（(\s]*(次日|翌日|第二天|(?:[\d一二两三四五六七八九十百]+)\s*个?(?:天|周|星期|月|年)(?:之)?后)(?=[）)\s，,。！!：:]|$)/u.exec(body);
    if (opening) add(opening[1], opening[1], body.indexOf(opening[1]));
    const absolute = datePattern.exec(body);
    if (absolute?.index === 0) add(absolute[0], absolute[0], 0);
    let searchFrom = 0;
    for (const segment of record?.segments || []) {
        const change = segment.time_change;
        if (!change?.evidence || !body.includes(change.evidence)) continue;
        const evidencePosition = body.indexOf(change.evidence, searchFrom);
        const position = body.indexOf(change.label, Math.max(0, evidencePosition));
        if (evidencePosition >= 0 && position >= 0 && position < evidencePosition + change.evidence.length) {
            add(change.label, change.evidence, position); searchFrom = evidencePosition + change.evidence.length;
        }
    }
    return result.sort((a, b) => a.position - b.position);
}
export const TEMPORAL_EVENT_INSTRUCTION = `\n【事件发生时间】每条 event 可另附 when:{kind:"current|past|future|ongoing|unknown",label:"时间原词",evidence:"正文连续引文"}。区分本楼说话时间与所述事情发生时间：回忆昨天的事标 past，约明天见面标 future（尚未发生），持续状态标 ongoing；日期不明的童年往事标 unknown，不能当成本楼新发生。label/evidence 必须出自该楼正文，禁止自行算日期。没有独立时间线索可不填 when。time_change 仅用于叙事现场真实推进，不把回忆、对白中提到的日期、假设或未来约定写成场景跳时。`;
export function validateEventWhen(raw, source) {
    if (!raw || !['current', 'past', 'future', 'ongoing', 'unknown'].includes(raw.kind)) return null;
    const label = text(raw.label), evidence = text(raw.evidence);
    if (!label || label.length > 80 || !evidence || evidence.length > 160 || !text(source).includes(evidence) || !evidence.includes(label)) return null;
    return { kind: raw.kind, label, evidence };
}
function validCorrection(correction, sources, index) {
    const source = sources[index];
    return correction?.messageKey === source.messageKey && correction.fingerprint === source.contentFingerprint
        && Array.isArray(correction.prefix) && correction.prefix.length === index + 1
        && correction.prefix.every((p, i) => p.key === sources[i].messageKey && p.fingerprint === sources[i].contentFingerprint);
}
export function makeTimelineCorrection(sources, { messageKey, eventKey = null, date = null, kind = 'current', reset = false }) {
    const index = sources.findIndex(s => s.messageKey === messageKey);
    if (index < 0) throw new Error('来源已变化，请重新打开时间页面。');
    if (!reset && !parseCalendarDate(date)) throw new Error('请输入有效日期。');
    return { id: globalThis.crypto.randomUUID(), messageKey, fingerprint: sources[index].contentFingerprint,
        prefix: sources.slice(0, index + 1).map(s => ({ key: s.messageKey, fingerprint: s.contentFingerprint })),
        eventKey, date: reset ? null : parseCalendarDate(date), kind, reset };
}
function inferredWhen(event) {
    const evidence = text(event.evidence), label = relativePattern.exec(evidence)?.[0] || datePattern.exec(evidence)?.[0];
    if (recallPattern.test(evidence) && !label) return { kind: 'unknown', label: '往事，日期未明确' };
    if (label && /询问|追问|提问|问|否认|澄清|纠正/u.test(text(event.text))) return { kind: 'current', label: '', reference: label };
    if (label) return { kind: /前|昨天|昨日/u.test(label) ? 'past' : /后|明天|明日/u.test(label) || planPattern.test(evidence) ? 'future' : 'current', label };
    if (planPattern.test(evidence)) return { kind: 'future', label: '未来安排，日期未明确' };
    return { kind: 'current', label: '' };
}

export function buildTimeline({ sources = [], records = [], corrections = [], incomplete = [] } = {}) {
    sources = sources.filter(s => !incomplete.some(item => item.messageKey === s.messageKey && item.fingerprint === s.contentFingerprint) && !s.message?.is_system && s.narrativeText !== '' && !s.message?.extra?.backstage);
    const byKey = new Map(records.map(r => [r.messageKey, r]));
    const clocks = [], events = [], conflicts = [];
    let current = null;
    for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        const candidate = byKey.get(source.messageKey);
        const record = candidate?.contentFingerprint === source.contentFingerprint ? candidate : null;
        const manual = new Map(corrections.filter(c => validCorrection(c, sources, index)).map(c => [c.eventKey, c]));
        const previous = current;
        const header = source.role === 'assistant' ? clockCandidate(source) : { date: null };
        const changes = sceneAdvances(source, record);
        let jumped = null;
        for (const change of changes) { change.date = resolveCalendarDate(change.label, jumped || current?.date); jumped = change.date || jumped; }
        const jump = changes.map(change => change.label).join(' → ');
        let date = jumped || header.date || current?.date || null;
        let minute = jumped ? null : header.date && header.date !== current?.date ? header.minute ?? null : header.minute ?? current?.minute ?? null;
        const clockFix = manual.get(null);
        if (clockFix && !clockFix.reset) { date = clockFix.date; minute = null; }
        else if (jumped && header.date && jumped !== header.date) {
            conflicts.push({ messageKey: source.messageKey, floor: source.messageIndex, reason: `跳时应为${jumped}，场景栏写作${header.date}；暂按明确跳时处理。` });
        } else if (date && current?.date && calendarDayDifference(current.date, date) < 0) {
            conflicts.push({ messageKey: source.messageKey, floor: source.messageIndex, reason: `场景日期从${current.date}倒退至${date}；保留先前时间，待核对。` });
            date = current.date; minute = current.minute;
        } else if (!jumped && header.date === current?.date && header.minute !== null && current?.minute !== null && header.minute < current.minute) {
            conflicts.push({ messageKey: source.messageKey, floor: source.messageIndex, reason: '同日场景时间倒退；保留先前时刻，待核对。' });
            minute = current.minute;
        }
        if (date) current = { date, minute, messageKey: source.messageKey, floor: source.messageIndex,
            evidence: clockFix && !clockFix.reset ? '手动校正' : jumped ? jump : header.evidence || current?.evidence || '', manual: Boolean(clockFix && !clockFix.reset) };
        clocks.push({ messageKey: source.messageKey, floor: source.messageIndex, date, minute, evidence: current?.evidence || '' });
        const segments = record?.segments || [];
        let eventDate = changes.length ? previous?.date || date : header.startDate && header.startDate !== header.date ? null : date;
        let eventIndex = 0;
        for (const segment of segments) {
            if (segment.time_change?.label) {
                const change = changes.find(item => item.evidence === segment.time_change.evidence && !item.used);
                if (change) { eventDate = change.date || eventDate; change.used = true; }
            }
            for (const event of segment.events || []) {
                const key = `${source.messageKey}:${eventIndex++}`;
                const when = validateEventWhen(event.when, source.narrativeText ?? source.text) || inferredWhen(event);
                if (changes.some(change => change.label === when.label) && jumped) { when.kind = 'current'; when.label = ''; }
                let occurred = when.kind === 'unknown' || when.kind === 'ongoing' ? null : when.label ? resolveCalendarDate(when.label, eventDate) : eventDate;
                const fix = manual.get(key);
                let kind = when.kind;
                if (fix && !fix.reset) { occurred = fix.date; kind = fix.kind; }
                events.push({ key, messageKey: source.messageKey, fingerprint: source.contentFingerprint, floor: source.messageIndex,
                    text: text(event.text), evidence: text(event.evidence), date: occurred, recordedDate: date,
                    kind, originalTime: when.label, referenceLabel: when.reference || '', referenceDate: when.reference ? resolveCalendarDate(when.reference, eventDate) : null, manual: Boolean(fix && !fix.reset) });
            }
        }
        if (!segments.length && record?.summary) {
            const key = `${source.messageKey}:summary`, fix = manual.get(key);
            const corrected = fix && !fix.reset;
            events.push({ key, messageKey: source.messageKey, fingerprint: source.contentFingerprint,
                floor: source.messageIndex, text: record.summary, evidence: '', date: corrected ? fix.date : null,
                recordedDate: date, kind: corrected ? fix.kind : 'unknown', manual: Boolean(corrected), originalTime: '旧摘要，事件日期待定位' });
        }
        // For multi-day floors, a dated ending status is the last scene, not every event's date.
        if (!header.date && eventDate && current && calendarDayDifference(current.date, eventDate) > 0) current = { ...current, date: eventDate, minute: null };
    }
    return { current, clocks, events: events.map(e => {
        const elapsed = calendarDayDifference(e.date, current?.date);
        const relative = e.kind === 'ongoing' ? `持续状态${e.date ? `，起始于${e.date}，${relativeCalendarLabel(e.date, current?.date)}` : '，起始日未知'}，不等于刚发生`
            : e.kind === 'future' && elapsed !== null && elapsed >= 0 ? `约定${elapsed ? `日期已过${elapsed}天` : '在本日'}，是否兑现未确认`
                : e.date ? relativeCalendarLabel(e.date, current?.date) : '发生日期未明确';
        return { ...e, relative };
    }), conflicts, sources };
}

/** Compact clock only. Event prose belongs to selected history, never a second retrieval list. */
export function renderTimelinePrompt(timeline, { rawFloors = [] } = {}) {
    if (!timeline?.current && !timeline?.events?.length && !timeline?.conflicts?.length) return '';
    const now = timeline.current;
    const weekday = now ? ['日', '一', '二', '三', '四', '五', '六'][dateObject(now.date).getUTCDay()] : '';
    const time = Number.isInteger(now?.minute) ? ` ${String(Math.floor(now.minute / 60)).padStart(2, '0')}:${String(now.minute % 60).padStart(2, '0')}` : '';
    const raw = new Set(rawFloors);
    const clocks = (timeline.clocks || []).filter(c => raw.has(c.floor) && c.date);
    const span = clocks.length ? `近期原文第${clocks[0].floor}–${clocks.at(-1).floor}楼记录于${recordSpan(clocks, now?.date)}。\n` : '';
    return `[剧情时间定位]\n唯一当前剧情日期：${now ? `${now.date} 星期${weekday}${time}（来源第${now.floor}楼）` : '尚未明确；不使用现实日期补齐'}。\n历史“昨天/明天”等相对原记录日期，不相对现在；记录日期不等于事件发生日期。摘要内事件时间优先于段落记录时点，未标注的往事发生日保持未知。过去经历不重演成刚发生；回忆、假设、预约不推进当前日期；未来安排即使到期也不代表已兑现，不得重演成刚发生或新的待办。\n${span}[/剧情时间定位]`;
}

function recordSpan(clocks, now) {
    const first = clocks[0].date, last = clocks.at(-1).date;
    return first === last ? `${first}（${relativeCalendarLabel(first, now)}）`
        : `${first}→${last}（${relativeCalendarLabel(first, now)}→${relativeCalendarLabel(last, now)}）`;
}

function eventTimeLabel(event) {
    const occurrence = event.kind === 'future' ? `未来安排：${event.date || '日期未知'}，${event.relative}，兑现未确认`
        : event.kind === 'ongoing' ? event.relative
            : `${event.date || '发生日未知'}${event.date ? `，${event.relative}` : ''}`;
    return `${occurrence}${event.referenceDate ? `；原文“${event.referenceLabel}”指${event.referenceDate}` : ''}`;
}

/** Attach dates only to event wording already present in a selected summary.
 * No fuzzy semantic match: conflicting dates for identical wording stay unassigned.
 * Most same-day events inherit the section's record date without per-event overhead.
 */
export function annotateTimelineHistory(value, timeline) {
    const clocks = timeline?.clocks || [];
    const events = timeline?.events || [];
    return String(value || '').replace(/^(### [^\n]*?第 (\d+)(?:[–—-](\d+))? 楼[^\n]*)\n([\s\S]*?)(?=^### |^## 剧情记忆结束|(?![\s\S]))/gmu, (_block, heading, first, last, body) => {
        const start = Number(first), end = Number(last || first);
        const matched = clocks.filter(c => c.floor >= start && c.floor <= end && c.date);
        const dateSet = new Set(matched.map(c => c.date));
        const candidates = events.filter(e => e.floor >= start && e.floor <= end);
        const labels = new Map();
        for (const event of candidates) {
            const phrase = text(event.text).replace(/[。！？.!?]+$/u, '');
            if (phrase.length < (start === end ? 2 : 4) || !body.includes(phrase)) continue;
            const entry = labels.get(phrase) || { labels: new Set(), special: false };
            entry.labels.add(eventTimeLabel(event));
            entry.special ||= event.manual || event.referenceDate || event.kind !== 'current'
                || event.date !== event.recordedDate || dateSet.size > 1;
            labels.set(phrase, entry);
        }
        const spans = [];
        for (const [phrase, entry] of labels) {
            let offset = 0, at;
            while ((at = body.indexOf(phrase, offset)) !== -1) {
                const end = at + phrase.length;
                spans.push({ at, end, entry, label: [...entry.labels][0] });
                offset = end;
            }
        }
        const overlaps = (a, b) => a.at < b.end && a.end > b.at;
        const conflicts = span => spans.some(other => overlaps(span, other)
            && (other.entry.labels.size !== 1 || other.label !== span.label));
        const positions = [];
        // Prefer a longer exact match only when all overlapping matches agree.
        for (const span of spans.sort((a, b) => (b.end - b.at) - (a.end - a.at))) {
            if (span.entry.special && span.entry.labels.size === 1 && !conflicts(span)
                && !positions.some(p => overlaps(span, p))) positions.push(span);
        }
        // Compression can remove punctuation or retain just a verbatim clause.
        // Require that entire clause (>=12 letters/digits) exists in source event
        // wording, and all supporting events agree. Do not date semantic paraphrases.
        const normalize = value => value.replace(/[^\p{L}\p{N}]/gu, '');
        const normalized = candidates.map(event => ({ event, value: normalize(event.text) }));
        for (const match of body.matchAll(/[^，。！？；\n]+/gu)) {
            const clause = normalize(match[0]);
            if (clause.length < 12 || /^\s*(?:###|【)/u.test(match[0])) continue;
            const supporting = normalized.filter(item => item.value.includes(clause)).map(item => item.event);
            if (!supporting.length) continue;
            const agreed = new Set(supporting.map(eventTimeLabel));
            const special = supporting.some(event => event.manual || event.referenceDate || event.kind !== 'current'
                || event.date !== event.recordedDate || dateSet.size > 1);
            const at = match.index, end = at + match[0].length;
            const span = { at, end, label: [...agreed][0] };
            if (special && agreed.size === 1 && !conflicts(span) && !positions.some(p => overlaps(span, p))) positions.push(span);
        }
        for (const { at, label } of positions.sort((a, b) => b.at - a.at)) body = `${body.slice(0, at)}〔事件：${label}〕${body.slice(at)}`;
        const bounds = matched.length ? `\n【本段记录时点：${recordSpan(matched, timeline.current?.date)}；仅为记录时间，往事/计划不据此定日】` : '';
        return `${heading}${bounds}\n${body}`;
    });
}
