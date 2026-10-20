import { renderNarrativeConflicts } from './memory-conflicts.js';

export function renderRecordEvents(segments, timeState = { current: '' }) {
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

function uniqueLegacySummary(summary, structured) {
    const comparable = text => String(text).replace(/\s+/gu, ' ').trim();
    const events = comparable(structured);
    return (summary.match(/[^。！？；\n]+[。！？；]?/gu) || [])
        .filter(sentence => !events.includes(comparable(sentence.replace(/[。！？；]$/u, ''))))
        .join('').trim();
}

export function renderNarrativeBody(record, structured = renderRecordEvents(record.segments)) {
    const summary = String(record.summary || '').trim();
    const notes = renderNarrativeConflicts(record.memory_conflicts);
    if (record.manual_override || !structured) return [notes, summary].filter(Boolean).join('\n');
    if (record.injection_format === 'events-v1') return [notes, structured].filter(Boolean).join('\n');
    const extra = uniqueLegacySummary(summary, structured);
    return [notes, extra && `本楼摘要：${extra}`, '补充事件：', structured].filter(Boolean).join('\n');
}
