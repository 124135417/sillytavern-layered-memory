import { evidenceInSource } from './tokens.js';

function clean(value) {
    return String(value ?? '').trim();
}

/** Story time must be grounded in the same floor; no invented calendar dates. */
export function normalizeStoryTime(raw, sourceText = '') {
    if (!raw || raw === '未明确' || raw === '无变化') return null;
    const input = typeof raw === 'string' ? { label: raw } : raw;
    const label = clean(input?.label || input?.text);
    const evidence = clean(input?.evidence);
    if (!label || !evidence || !evidenceInSource(evidence, sourceText) || !evidenceInSource(label, sourceText)) return null;
    return {
        label: [...label].slice(0, 40).join(''),
        evidence: [...evidence].slice(0, 50).join(''),
        kind: ['absolute', 'relative', 'time_of_day'].includes(input?.kind) ? input.kind : 'relative',
    };
}

export function storyTimeRange(items = []) {
    const points = items
        .map(item => ({ floor: item.pairIndex, time: item.story_time }))
        .filter(item => item.time?.label);
    if (!points.length) return null;
    const labels = points.map(item => item.time.label).filter((value, index, all) => all.indexOf(value) === index);
    return {
        start: labels[0],
        end: labels.at(-1),
        label: labels.length === 1 ? labels[0] : `${labels[0]} → ${labels.at(-1)}`,
        evidence_floors: points.map(item => item.floor),
    };
}
