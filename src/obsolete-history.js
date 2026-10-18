import { renderL2Block } from './render.js';

/** Full branch history before the reviewed turn, with existing compression only.
 * No main-model token budget, retrieval, new summarization or future messages.
 */
export function renderObsoleteHistory(data, pair, pairs = [], narrativeSources = []) {
    const endFloor = Number(pair.userFloor) - 1;
    if (!Number.isInteger(endFloor) || endFloor < 0) return '';
    const pastPairs = pairs.filter(item => item.pairIndex < pair.pairIndex);
    const visible = (data.narrative_summaries || []).length || (data.narrative_chapters || []).length;
    const pastData = visible ? data : {
        ...data,
        turn_summaries: (data.turn_summaries || []).filter(item => item.pairIndex < pair.pairIndex),
        chapters: (data.chapters || []).filter(item => item.floor_range?.[1] < pair.pairIndex),
    };
    if (!visible) {
        const ids = new Set(pastData.chapters.map(item => item.id));
        pastData.volumes = (data.volumes || []).filter(item => item.chapter_ids?.length
            && item.chapter_ids.every(id => ids.has(id)));
    }
    const text = renderL2Block(pastData, {
        // This mode bypasses the UI preview cap; main-model budgets do not apply.
        forInjection: true,
        pairs: pastPairs,
        narrativeSources: visible ? narrativeSources.filter(source => source.messageIndex <= endFloor) : [],
        maxFloor: endFloor,
    });
    return text ? [
        `## 此前完整剧情回顾（截至第 ${endFloor} 楼）`,
        '供判断旧事实是否仍有后续价值。大总结覆盖的楼不重复放小总结；以下都是过去剧情，不得重新当作本轮新增事实。',
        text,
    ].join('\n') : '';
}
