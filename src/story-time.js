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

export function storyTimeEvidencePosition(evidence, sourceText = '') {
    const rawEvidence = clean(evidence);
    const rawSource = String(sourceText ?? '');
    if (!rawEvidence || !rawSource) return -1;
    const exact = rawSource.indexOf(rawEvidence);
    if (exact >= 0) return exact;
    const normalizedEvidence = rawEvidence.replace(/\s+/g, ' ');
    return rawSource.replace(/\s+/g, ' ').indexOf(normalizedEvidence);
}

export function storyTimeRange(items = []) {
    const points = items
        .flatMap(item => {
            const floor = item.pairIndex ?? item.messageIndex;
            const segmentTimes = Array.isArray(item.segments)
                ? item.segments.map(segment => segment?.time_change).filter(time => time?.label)
                : [];
            const times = segmentTimes.length ? segmentTimes : [item.story_time].filter(time => time?.label);
            return times.map(time => ({ floor, time }));
        })
        .filter(item => item.time?.label);
    if (!points.length) return null;
    const labels = [];
    for (const point of points) {
        if (labels.at(-1) !== point.time.label) labels.push(point.time.label);
    }
    return {
        start: labels[0],
        end: labels.at(-1),
        label: labels.length === 1 ? labels[0] : `${labels[0]} → ${labels.at(-1)}`,
        evidence_floors: [...new Set(points.map(item => item.floor).filter(Number.isInteger))],
    };
}
