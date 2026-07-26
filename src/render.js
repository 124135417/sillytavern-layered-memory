import { SLOT_LABELS, SLOTS } from './constants.js';
import { estimateTokens, truncateToBudget } from './tokens.js';
import { usableMemoryEntries } from './quality.js';

export function renderL1Block(data, budget = 2000, context = null) {
    const entries = usableMemoryEntries(data);
    if (!entries.length) {
        return '';
    }
    const lines = [
        '## 长期记忆使用规则',
        '- 最近保留的完整对话负责最新变化；若与旧摘要冲突，以最近完整对话为准。',
        '- 当前事实描述现在仍然成立的状态；剧情摘要只说明过去发生过什么，不得反向覆盖当前状态。',
        '- 只需自然地保持连续性，不要复述、解释或提及记忆系统。',
        '',
    ];
    const userName = String(context?.name1 || '').trim();
    const roleName = String(context?.name2 || context?.characters?.[context?.characterId]?.name || '').trim();
    if (userName || roleName) {
        lines.push('## 当前对话身份');
        if (userName) lines.push(`- <user>：当前显示名为${userName}`);
        if (roleName) lines.push(`- 当前角色卡：${roleName}`);
        lines.push('');
    }
    lines.push(
        '## 当前确立的事实',
        '以下是先前剧情中确立、至今仍然为真的事实。生成时必须与之保持一致，但不要主动复述或提及本列表的存在。',
        '',
    );
    for (const slot of SLOTS) {
        const group = entries.filter(e => e.slot === slot);
        if (!group.length) {
            continue;
        }
        lines.push(`### ${SLOT_LABELS[slot]}`);
        for (const e of group) {
            const obj = e.object ? `↔${e.object}` : '';
            const floor = formatFloor(e.updated_floor ?? e.established_floor);
            const cause = e.cause ? `（因${e.cause}，${floor}）` : `（${floor}）`;
            lines.push(`- ${e.subject}${obj}：${e.value}${cause}`);
        }
        lines.push('');
    }
    return truncateToBudget(lines.join('\n').trim(), budget);
}

function validFloorRange(value) {
    if (!Array.isArray(value) || value.length < 2) {
        return null;
    }
    const start = Number(value[0]);
    const end = Number(value[1]);
    return Number.isInteger(start) && Number.isInteger(end) && start <= end ? [start, end] : null;
}

function hasSummary(value) {
    return Boolean(String(value ?? '').trim());
}

function rangeOverlaps([start, end], ranges) {
    return ranges.some(([coveredStart, coveredEnd]) => start <= coveredEnd && end >= coveredStart);
}

function floorIsCovered(floor, ranges) {
    return ranges.some(([start, end]) => floor >= start && floor <= end);
}

function narrativeRangeLabel(startPair, endPair, pairs = []) {
    const pairByIndex = new Map((Array.isArray(pairs) ? pairs : [])
        .filter(pair => Number.isInteger(pair?.pairIndex))
        .map(pair => [pair.pairIndex, pair]));
    const start = pairByIndex.get(startPair);
    const end = pairByIndex.get(endPair);
    const startFloor = Number(start?.userFloor);
    const endFloor = Number(end?.aiFloor ?? end?.userFloor);
    if (Number.isInteger(startFloor) && Number.isInteger(endFloor)) {
        return startFloor === endFloor ? `第 ${startFloor} 楼` : `第 ${startFloor}–${endFloor} 楼`;
    }
    const firstTurn = startPair + 1;
    const lastTurn = endPair + 1;
    return firstTurn === lastTurn ? `第 ${firstTurn} 轮对话` : `第 ${firstTurn}–${lastTurn} 轮对话`;
}

function renderStructuredSegments(segments, timeState) {
    const lines = [];
    for (const segment of Array.isArray(segments) ? segments : []) {
        const label = String(segment?.time_change?.label || '').trim();
        if (label && label !== timeState.current) {
            lines.push(`【剧情时间推进：${label}】`);
            timeState.current = label;
        }
        for (const event of Array.isArray(segment?.events) ? segment.events : []) {
            const text = String(event?.text || '').trim();
            if (text) lines.push(`- ${text}`);
        }
    }
    return lines.join('\n');
}

function renderNarrativeItem(item, pairs, timeState = { current: '' }) {
    const range = item.floorUnit === 'message'
        ? (item.start === item.end ? `第 ${item.start} 楼` : `第 ${item.start}–${item.end} 楼`)
        : narrativeRangeLabel(item.start, item.end, pairs);
    const structured = renderStructuredSegments(item.segments, timeState);
    const storyTime = !structured && item.storyTime ? `（剧情时间：${item.storyTime}）` : '';
    if (!structured && item.storyTime) timeState.current = item.storyTimeEnd || item.storyTime;
    return [
        `### ${item.kind}｜${range}${storyTime}`,
        structured || item.summary,
        `【本段范围结束｜${range}】`,
    ].join('\n');
}

function completeNarrativeText(items, nextRawFloor = null) {
    if (!items.length) return '';
    const handoff = Number.isInteger(nextRawFloor)
        ? `以上摘要截至第 ${nextRawFloor - 1} 楼；紧随其后的完整原文从第 ${nextRawFloor} 楼开始，二者连续且不重叠。`
        : '后续提示词、最近完整对话及用户新输入均不属于上述任何摘要范围。';
    const timeState = { current: '' };
    return [
        '## 剧情记忆开始',
        '以下内容只记录已经发生的过去剧情，并按聊天楼层顺序排列。',
        '每个标题的范围只适用于该标题下方、对应“本段范围结束”之前的内容；各段互不包含。',
        '',
        items.map(item => renderNarrativeItem(item, [], timeState)).join('\n\n'),
        '',
        '## 剧情记忆结束',
        handoff,
    ].join('\n').trim();
}

function renderVisibleFloorNarrative(data, narrativeSources, maxFloor = null) {
    const records = (data.narrative_summaries || []).filter(item =>
        Number.isInteger(item?.messageIndex) && hasSummary(item.summary));
    const sources = narrativeSources.length ? narrativeSources : records.map(item => ({
        messageKey: item.messageKey,
        messageIndex: item.messageIndex,
        role: item.role,
        contentFingerprint: item.contentFingerprint,
        fallbackSummary: item.summary,
    }));
    if (!sources.length) return '';

    const recordByKey = new Map(records.map(item => [item.messageKey, item]));
    const validSources = sources
        .filter(source => !Number.isInteger(maxFloor) || source.messageIndex <= maxFloor)
        .slice()
        .sort((a, b) => a.messageIndex - b.messageIndex);
    if (!validSources.length) return '';
    const chaptersById = new Map((data.narrative_chapters || []).map(chapter => [chapter.id, chapter]));
    const coveredRanges = [];
    const items = [];
    const volumes = (data.narrative_volumes || [])
        .filter(volume => !volume.stale && hasSummary(volume.summary))
        .map(volume => ({ ...volume, floor_range: getVolumeFloorRange(volume, chaptersById) }))
        .filter(volume => volume.floor_range)
        .filter(volume => !Number.isInteger(maxFloor) || volume.floor_range[1] <= maxFloor)
        .sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    for (const volume of volumes) {
        if (rangeOverlaps(volume.floor_range, coveredRanges)) continue;
        items.push({
            start: volume.floor_range[0], end: volume.floor_range[1], floorUnit: 'message',
            kind: '长期摘要', summary: String(volume.summary).trim(),
        });
        coveredRanges.push(volume.floor_range);
    }
    const chapters = (data.narrative_chapters || [])
        .filter(chapter => !chapter.stale && hasSummary(chapter.summary))
        .map(chapter => ({ ...chapter, floor_range: validFloorRange(chapter.floor_range) }))
        .filter(chapter => chapter.floor_range)
        .filter(chapter => !Number.isInteger(maxFloor) || chapter.floor_range[1] <= maxFloor)
        .sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    for (const chapter of chapters) {
        if (rangeOverlaps(chapter.floor_range, coveredRanges)) continue;
        items.push({
            start: chapter.floor_range[0], end: chapter.floor_range[1], floorUnit: 'message',
            kind: '章节摘要', summary: String(chapter.summary).trim(), storyTime: chapter.story_time_range?.label,
            storyTimeEnd: chapter.story_time_range?.end,
        });
        coveredRanges.push(chapter.floor_range);
    }
    for (const source of validSources) {
        if (floorIsCovered(source.messageIndex, coveredRanges)) continue;
        const stored = recordByKey.get(source.messageKey);
        const matches = stored && stored.contentFingerprint === source.contentFingerprint;
        const summary = matches ? stored.summary : source.fallbackSummary;
        if (!hasSummary(summary)) continue;
        items.push({
            start: source.messageIndex, end: source.messageIndex, floorUnit: 'message',
            kind: matches ? '逐楼剧情记录' : '逐楼临时记录', summary: String(summary).trim(),
            storyTime: matches ? stored.story_time?.label : null,
            segments: matches ? stored.segments : null,
        });
    }
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    return completeNarrativeText(items, Number.isInteger(maxFloor) ? maxFloor + 1 : null);
}

function getVolumeFloorRange(volume, chaptersById) {
    const chapterIds = Array.isArray(volume?.chapter_ids) ? volume.chapter_ids : [];
    if (!chapterIds.length || new Set(chapterIds).size !== chapterIds.length) {
        return null;
    }

    const chapters = chapterIds.map(id => chaptersById.get(id));
    if (chapters.some(chapter => !chapter || chapter.stale || !hasSummary(chapter.summary))) {
        return null;
    }
    const ranged = chapters.map(chapter => ({ range: validFloorRange(chapter.floor_range) }));
    if (ranged.some(item => !item.range)) {
        return null;
    }
    ranged.sort((a, b) => a.range[0] - b.range[0]);
    let expected = ranged[0].range[0];
    for (const { range } of ranged) {
        if (range[0] !== expected) {
            return null;
        }
        expected = range[1] + 1;
    }
    return [ranged[0].range[0], expected - 1];
}

export function renderL2Block(data, {
    forBudget = false,
    forInjection = false,
    budget = 5000,
    pairs = [],
    narrativeSources = [],
    maxFloor = null,
} = {}) {
    const hasVisibleFloorMaterial = narrativeSources.length
        || (data.narrative_summaries || []).length
        || (data.narrative_chapters || []).length;
    if (hasVisibleFloorMaterial) {
        const text = renderVisibleFloorNarrative(data, narrativeSources, maxFloor);
        if (forBudget || forInjection) return text;
        return truncateToBudget(text, budget);
    }
    const items = [];
    const chaptersById = new Map((data.chapters || []).map(c => [c.id, c]));
    const coveredRanges = [];
    const volumes = (data.volumes || [])
        .filter(v => !v.stale && hasSummary(v.summary))
        .map(v => ({ ...v, floor_range: getVolumeFloorRange(v, chaptersById) }))
        .filter(v => v.floor_range)
        .sort((a, b) => a.floor_range[0] - b.floor_range[0] || a.floor_range[1] - b.floor_range[1]);
    for (const v of volumes) {
        if (rangeOverlaps(v.floor_range, coveredRanges)) {
            continue;
        }
        items.push({
            start: v.floor_range[0],
            end: v.floor_range[1],
            kind: '长期摘要',
            summary: String(v.summary).trim(),
        });
        coveredRanges.push(v.floor_range);
    }
    // Do not filter demoted chapters here: they are the required fallback when
    // their higher-level volume is missing or invalid.
    const chapters = (data.chapters || [])
        .filter(c => !c.stale && hasSummary(c.summary))
        .map(c => ({ ...c, floor_range: validFloorRange(c.floor_range) }))
        .filter(c => c.floor_range)
        .sort((a, b) => a.floor_range[0] - b.floor_range[0] || a.floor_range[1] - b.floor_range[1]);
    for (const c of chapters) {
        if (rangeOverlaps(c.floor_range, coveredRanges)) {
            continue;
        }
        items.push({
            start: c.floor_range[0],
            end: c.floor_range[1],
            kind: '章节摘要',
            summary: String(c.summary).trim(),
            storyTime: c.story_time_range?.label,
        });
        coveredRanges.push(c.floor_range);
    }
    const turnSummariesByFloor = new Map();
    for (const item of data.turn_summaries || []) {
        if (Number.isInteger(item?.pairIndex) && hasSummary(item.summary)) {
            turnSummariesByFloor.set(item.pairIndex, item);
        }
    }
    const turnSummaries = [...turnSummariesByFloor.values()]
        .filter(item => !floorIsCovered(item.pairIndex, coveredRanges));
    for (const item of turnSummaries) {
        items.push({
            start: item.pairIndex,
            end: item.pairIndex,
            kind: '逐轮剧情记录',
            summary: String(item.summary).trim(),
            storyTime: item.story_time?.label,
        });
    }
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    if (!items.length) {
        return '';
    }
    const text = [
        '## 剧情记忆开始',
        '以下内容只记录已经发生的过去剧情，并按聊天楼层顺序排列。',
        '每个标题的范围只适用于该标题下方、对应“本段范围结束”之前的内容；各段互不包含。',
        '',
        (() => {
            const timeState = { current: '' };
            return items.map(item => renderNarrativeItem(item, pairs, timeState)).join('\n\n');
        })(),
        '',
        '## 剧情记忆结束',
        '后续提示词、最近完整对话及用户新输入均不属于上述任何摘要范围。',
    ].join('\n').trim();
    if (forBudget || forInjection) {
        return text;
    }
    return truncateToBudget(text, budget);
}

export function renderL4Block(hits, budget = 1500) {
    if (!hits?.length) {
        return '';
    }
    const lines = [
        '## 背景参考（可能相关的过往剧情）',
        '仅当与当前对话直接相关时才使用以下内容；若无关，完全忽略，不要主动提及。',
        '',
    ];
    for (const h of hits) {
        lines.push(`- [第 ${h.floor_range[0]}–${h.floor_range[1]} 轮对话] ${h.summary}`);
    }
    return truncateToBudget(lines.join('\n'), budget);
}

function formatFloor(floor) {
    if (typeof floor === 'number') {
        return `第 ${floor} 轮对话起`;
    }
    if (typeof floor === 'string') {
        if (floor === 'manual') {
            return '手动添加';
        }
        if (floor === 'proofread') {
            return '自动检查建议';
        }
        return floor.includes('ch_') ? '来自较早的剧情摘要' : String(floor);
    }
    return '';
}

export function l2TokenCount(data) {
    return estimateTokens(renderL2Block(data, { forBudget: true }));
}
