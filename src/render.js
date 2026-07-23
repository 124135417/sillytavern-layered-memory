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

function getVolumeFloorRange(volume, chaptersById) {
    const chapters = (volume.chapter_ids || []).map(id => chaptersById.get(id)).filter(Boolean);
    if (!chapters.length || chapters.some(c => c.stale || !Array.isArray(c.floor_range))) {
        return null;
    }
    const sorted = chapters.slice().sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    let expected = sorted[0].floor_range[0];
    for (const chapter of sorted) {
        if (chapter.floor_range[0] > expected) {
            return null;
        }
        expected = Math.max(expected, chapter.floor_range[1] + 1);
    }
    return [sorted[0].floor_range[0], expected - 1];
}

/**
 * Render archived plot summaries. When throughPair is provided, only summaries
 * wholly contained in the request prefix that was actually removed are used.
 */
export function renderL2Block(data, { forBudget = false, budget = 5000, throughPair } = {}) {
    const items = [];
    const chaptersById = new Map((data.chapters || []).map(c => [c.id, c]));
    const bounded = Number.isInteger(throughPair);
    const coveredChapterIds = new Set();
    const coveredRanges = [];
    const volumes = (data.volumes || [])
        .filter(v => bounded ? !v.stale : (!v.stale || forBudget))
        .map(v => ({ ...v, floor_range: getVolumeFloorRange(v, chaptersById) }))
        .filter(v => !bounded || (v.floor_range && v.floor_range[1] <= throughPair))
        .sort((a, b) => (a.floor_range?.[0] ?? 0) - (b.floor_range?.[0] ?? 0));
    for (const v of volumes) {
        items.push({
            start: v.floor_range?.[0] ?? 0,
            end: v.floor_range?.[1] ?? 0,
            text: `### 很久以前的剧情摘要\n${v.summary}`,
        });
        if (v.floor_range) coveredRanges.push(v.floor_range);
        for (const id of v.chapter_ids || []) {
            coveredChapterIds.add(id);
        }
    }
    const chapters = (data.chapters || [])
        .filter(c => !c.stale)
        .filter(c => bounded
            ? Array.isArray(c.floor_range) && c.floor_range[1] <= throughPair && !coveredChapterIds.has(c.id)
            : !c.demoted)
        .sort((a, b) => a.floor_range[0] - b.floor_range[0]);
    for (const c of chapters) {
        items.push({
            start: c.floor_range[0],
            end: c.floor_range[1],
            text: `### 第 ${c.floor_range[0]}–${c.floor_range[1]} 轮对话的剧情摘要${c.story_time_range?.label ? `（剧情时间：${c.story_time_range.label}）` : ''}\n${c.summary}`,
        });
        coveredRanges.push(c.floor_range);
    }
    const turnSummaries = (data.turn_summaries || [])
        .filter(item => Number.isInteger(item.pairIndex) && item.summary)
        .filter(item => !bounded || item.pairIndex <= throughPair)
        .filter(item => !coveredRanges.some(([start, end]) => item.pairIndex >= start && item.pairIndex <= end));
    for (const item of turnSummaries) {
        items.push({
            start: item.pairIndex,
            end: item.pairIndex,
            text: `### 第 ${item.pairIndex} 轮对话的剧情记录${item.story_time?.label ? `（剧情时间：${item.story_time.label}）` : ''}\n${item.summary}`,
        });
    }
    items.sort((a, b) => a.start - b.start || a.end - b.end);
    const text = items.map(item => item.text).join('\n\n').trim();
    if (!text) {
        return '';
    }
    if (forBudget) {
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
