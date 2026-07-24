import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { CHAPTER_JSON_SCHEMA, CHAPTER_SYSTEM } from './prompts.js';
import { storyTimeRange } from './story-time.js';

function promptForNotes(notes, retryNote = '') {
    return [
        retryNote ? `上次输出没有通过校验：${retryNote}\n请重新覆盖全部轮次。\n\n` : '',
        ...notes.map(item => `【第 ${item.pairIndex} 轮${item.story_time?.label ? `｜剧情时间：${item.story_time.label}` : ''}】${item.summary}`),
    ].join('\n\n');
}

function detectChapterNumbering(coverage, keyEvents, startPair, endPair) {
    const size = endPair - startPair + 1;
    const coverageFloors = coverage.map(item => Number(item?.floor)).filter(Number.isFinite);
    const eventFloors = keyEvents.flatMap(event => Array.isArray(event?.floor_range)
        ? event.floor_range.map(Number).filter(Number.isFinite)
        : []);
    const numbers = coverageFloors.length ? coverageFloors : eventFloors;
    if (!numbers.length || numbers.every(value => value >= startPair && value <= endPair)) {
        return value => value;
    }
    const exactZeroBased = coverageFloors.length === size
        && coverageFloors.every((value, index) => value === index);
    const exactOneBased = coverageFloors.length === size
        && coverageFloors.every((value, index) => value === index + 1);
    const allZeroBased = numbers.every(value => Number.isInteger(value) && value >= 0 && value < size);
    const allOneBased = numbers.every(value => Number.isInteger(value) && value >= 1 && value <= size);
    if (exactZeroBased || allZeroBased && numbers.includes(0)) {
        return value => startPair + value;
    }
    if (exactOneBased || allOneBased) {
        return value => startPair + value - 1;
    }
    return value => value;
}

function coverageFromEvents(expected, events) {
    const coverage = [];
    for (const floor of expected) {
        const eventIndex = events.findIndex(event => floor >= event.floor_range[0] && floor <= event.floor_range[1]);
        if (eventIndex < 0) return null;
        coverage.push({ floor, event_index: eventIndex });
    }
    return coverage;
}

export function validateChapterArchive(raw, startPair, endPair) {
    const rawSummary = String(raw?.summary || '').trim();
    const keyEvents = Array.isArray(raw?.key_events) ? raw.key_events : [];
    const coverage = Array.isArray(raw?.coverage) ? raw.coverage : [];
    const keywords = Array.isArray(raw?.keywords)
        ? raw.keywords.map(String).map(value => value.trim()).filter(Boolean).slice(0, 10)
        : [];
    const expected = Array.from({ length: endPair - startPair + 1 }, (_, index) => startPair + index);
    const normalizeFloor = detectChapterNumbering(coverage, keyEvents, startPair, endPair);
    const normalizedEvents = keyEvents.map(event => ({
        floor_range: [normalizeFloor(Number(event.floor_range?.[0])), normalizeFloor(Number(event.floor_range?.[1]))],
        text: String(event.text || '').trim(),
    }));
    let normalizedCoverage = coverage.map(item => ({
        floor: normalizeFloor(Number(item?.floor)),
        event_index: Number(item?.event_index),
    }));
    let actual = normalizedCoverage.map(item => item.floor);
    const errors = [];
    const warnings = [];
    const recommendedLength = Math.min(450, Math.max(180, expected.length * 18));
    const summaryLength = [...rawSummary].length;
    let summary = rawSummary;
    if (!summaryLength) {
        errors.push('章节概述为空');
    } else if (summaryLength < recommendedLength) {
        warnings.push(`章节概述较精简（${summaryLength} 字，建议至少 ${recommendedLength} 字）`);
    }
    if (summaryLength > 900) {
        summary = [...rawSummary].slice(0, 900).join('').trimEnd();
        warnings.push(`章节概述超过 900 字，已保留前 900 字`);
    }
    if (!keyEvents.length) errors.push('缺少关键事件');
    if (keywords.length < 3) errors.push('关键词少于 3 个');
    const midpoint = Math.floor((startPair + endPair) / 2);
    const ranges = normalizedEvents.map(event => event.floor_range)
        .filter(range => range.every(Number.isFinite));
    if (!ranges.some(range => Number(range[0]) <= midpoint)) errors.push('关键事件没有覆盖章节前半');
    if (!ranges.some(range => Number(range[1]) > midpoint)) errors.push('关键事件没有覆盖章节后半');
    for (const range of ranges) {
        if (Number(range[0]) < startPair || Number(range[1]) > endPair || Number(range[0]) > Number(range[1])) {
            errors.push('关键事件轮数越界');
        }
    }
    if (normalizedEvents.some(event => !event.text || !event.floor_range.every(Number.isFinite))) {
        errors.push('关键事件缺少文字或有效轮数范围');
    }
    let coverageValid = actual.length === expected.length
        && actual.every((value, index) => value === expected[index]);
    if (coverageValid) {
        for (let index = 0; index < normalizedCoverage.length; index += 1) {
            const eventIndex = normalizedCoverage[index].event_index;
            if (!Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex >= normalizedEvents.length) {
                coverageValid = false;
                break;
            }
            const [eventStart, eventEnd] = normalizedEvents[eventIndex].floor_range;
            if (actual[index] < eventStart || actual[index] > eventEnd) {
                coverageValid = false;
                break;
            }
        }
    }
    if (!coverageValid) {
        const rebuilt = coverageFromEvents(expected, normalizedEvents);
        if (rebuilt) {
            normalizedCoverage = rebuilt;
            actual = expected;
            coverageValid = true;
        }
    }
    if (!coverageValid) {
        errors.push(`coverage 必须依次包含 ${expected.join('、')}`);
    }
    for (let index = 0; coverageValid && index < normalizedCoverage.length; index += 1) {
        const eventIndex = normalizedCoverage[index].event_index;
        if (!Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex >= normalizedEvents.length) {
            errors.push(`第 ${actual[index]} 轮引用了不存在的关键事件`);
            continue;
        }
        const [eventStart, eventEnd] = normalizedEvents[eventIndex].floor_range;
        if (actual[index] < eventStart || actual[index] > eventEnd) {
            errors.push(`第 ${actual[index]} 轮没有落在对应关键事件的范围内`);
        }
    }
    return {
        ok: errors.length === 0,
        errors,
        warnings,
        chapter: {
            summary,
            key_events: normalizedEvents,
            coverage: normalizedCoverage,
            keywords,
            story_time_range: storyTimeRange([]),
            quality_warnings: warnings,
        },
    };
}

export async function summarizeChapterNotes(notes, startPair, endPair, assertCurrent = () => {}) {
    const expected = endPair - startPair + 1;
    if (notes.length !== expected) throw nonRetryable(`章节缺少对话记录：需要 ${expected} 轮，实际 ${notes.length} 轮`);
    let retryNote = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const { text } = await callAuxModel({
            purpose: 'chapter_summary',
            systemPrompt: CHAPTER_SYSTEM,
            userPrompt: promptForNotes(notes, retryNote),
            jsonSchema: CHAPTER_JSON_SCHEMA,
            temperature: 0.2,
        });
        assertCurrent();
        const checked = validateChapterArchive(parseJsonFromModel(text), startPair, endPair);
        if (checked.ok && (!checked.warnings.length || attempt === 1)) {
            checked.chapter.story_time_range = storyTimeRange(notes);
            return checked.chapter;
        }
        retryNote = checked.errors.length
            ? checked.errors.join('；')
            : `${checked.warnings.join('；')}。请在不编造、不重复和不灌水的前提下，补充遗漏的因果、角色决定、关系变化与未解决事项，使概述达到建议长度`;
    }
    throw nonRetryable(`章节连续两次未通过覆盖校验：${retryNote}`);
}

function nonRetryable(message) {
    const error = new Error(message);
    error.status = 422;
    return error;
}
