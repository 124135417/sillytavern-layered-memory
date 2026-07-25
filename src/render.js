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

export function renderL2Block(data, { forBudget = false, forInjection = false, budget = 5000 } = {}) {
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
            text: `### 很久以前的剧情摘要\n${String(v.summary).trim()}`,
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
            text: `### 第 ${c.floor_range[0]}–${c.floor_range[1]} 轮对话的剧情摘要${c.story_time_range?.label ? `（剧情时间：${c.story_time_range.label}）` : ''}\n${String(c.summary).trim()}`,
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
            text: `### 第 ${item.pairIndex} 轮对话的剧情记录${item.story_time?.label ? `（剧情时间：${item.story_time.label}）` : ''}\n${String(item.summary).trim()}`,
        });
    }
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    const text = items.map(item => item.text).join('\n\n').trim();
    if (!text) {
        return '';
    }
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
