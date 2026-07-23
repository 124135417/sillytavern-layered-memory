import { SLOT_LABELS, SLOTS } from './constants.js';
import { estimateTokens, truncateToBudget } from './tokens.js';

export function renderL1Block(data, budget = 2000) {
    const entries = data.state_table?.entries || [];
    if (!entries.length) {
        return '';
    }
    const lines = [
        '## 当前确立的事实',
        '以下是先前剧情中确立、至今仍然为真的事实。生成时必须与之保持一致，但不要主动复述或提及本列表的存在。',
        '',
    ];
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
    const parts = [];
    const chaptersById = new Map((data.chapters || []).map(c => [c.id, c]));
    const bounded = Number.isInteger(throughPair);
    const coveredChapterIds = new Set();
    const volumes = (data.volumes || [])
        .filter(v => bounded ? !v.stale : (!v.stale || forBudget))
        .map(v => ({ ...v, floor_range: getVolumeFloorRange(v, chaptersById) }))
        .filter(v => !bounded || (v.floor_range && v.floor_range[1] <= throughPair))
        .sort((a, b) => (a.floor_range?.[0] ?? 0) - (b.floor_range?.[0] ?? 0));
    for (const v of volumes) {
        parts.push(`### 很久以前的剧情摘要\n${v.summary}`);
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
        parts.push(`### 第 ${c.floor_range[0]}–${c.floor_range[1]} 轮对话的剧情摘要\n${c.summary}`);
    }
    const text = parts.join('\n\n').trim();
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
