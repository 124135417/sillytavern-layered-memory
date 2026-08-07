import { estimateTokens } from './tokens.js';
import { isBackstageMarker } from './backstage.js';

function renderRawFloor(source) {
    if (isBackstageMarker(source.message)) {
        return `### 第 ${source.messageIndex} 楼｜幕间控制楼\n（此处发生过一次幕间讨论；讨论全文只用于紧随其后的正文生成，不属于剧情事件。）`;
    }
    const role = source.role === 'user' ? '用户原文' : '角色正文原文';
    const narrativeText = source.narrativeText ?? source.text;
    return `### 第 ${source.messageIndex} 楼｜${role}\n${String(narrativeText || '').trim()}`;
}

export function renderRecentRawBlock(sources = []) {
    if (!sources.length) return '';
    const ordered = sources.slice().sort((a, b) => a.messageIndex - b.messageIndex);
    const start = ordered[0].messageIndex;
    const end = ordered.at(-1).messageIndex;
    const handoff = start > 0
        ? `前面的剧情摘要截至第 ${start - 1} 楼；以下完整原文从第 ${start} 楼连续开始。`
        : '以下完整原文从聊天第 0 楼开始。';
    return [
        '## 最近完整剧情原文开始',
        handoff,
        '角色楼只包含按用户“AI 正文提取规则”识别出的正文；思考链、状态栏和其它附加内容不属于这里。',
        '原文比更早的摘要新；如两者存在差异，以后出现的原文为准。',
        '',
        ordered.map(renderRawFloor).join('\n\n'),
        '',
        `## 最近完整剧情原文结束｜第 ${start}–${end} 楼`,
        '紧随其后的 SillyTavern 最近消息和当前用户输入不属于以上原文范围。',
    ].join('\n').trim();
}

/** Select a continuous suffix of complete visible floors without cutting one. */
export function selectRecentRawWindow(sources = [], budget = 16_000, { minimumFloor = null } = {}) {
    const allowance = Math.max(0, Number(budget) || 0);
    const ordered = sources
        .filter(source => Number.isInteger(source?.messageIndex))
        .filter(source => !Number.isInteger(minimumFloor) || source.messageIndex >= minimumFloor)
        .slice()
        .sort((a, b) => a.messageIndex - b.messageIndex);
    let selected = [];
    let expectedFloor = ordered.at(-1)?.messageIndex;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const source = ordered[index];
        if (source.messageIndex !== expectedFloor) break;
        const candidate = [source, ...selected];
        if (estimateTokens(renderRecentRawBlock(candidate)) > allowance) break;
        selected = candidate;
        expectedFloor -= 1;
    }
    const text = renderRecentRawBlock(selected);
    return {
        sources: selected,
        text,
        tokens: estimateTokens(text),
        startFloor: selected[0]?.messageIndex ?? null,
        endFloor: selected.at(-1)?.messageIndex ?? null,
        minimumFloor: Number.isInteger(minimumFloor) ? minimumFloor : null,
    };
}
