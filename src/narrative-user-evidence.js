import { evidenceSpansInSource } from './tokens.js';

/** Retain short player input verbatim when the model omitted usable events.
 * This is an event record, never an inferred fact or an assistant fallback.
 */
export function recoverShortUserEvents(segments, source) {
    const text = String(source?.narrativeText ?? source?.text ?? '').trim();
    if (source?.role !== 'user' || !text || text === '继续' || [...text].length > 180) return segments;
    const rows = Array.isArray(segments) ? segments : [];
    // Do not flatten a model's time segmentation or replace valid extraction.
    if (rows.some(row => row?.time_change || (Array.isArray(row?.events) && row.events.some(event => {
        const value = String(event?.text || '').replace(/\s+/gu, ' ').trim();
        const evidence = String(event?.evidence || '').trim();
        return [...value].length >= 2 && [...value].length <= 240
            && [...evidence].length >= 1 && [...evidence].length <= 500
            && evidenceSpansInSource(evidence, text);
    })))) return segments;
    return [{ time_change: null, events: [{ text: `<user>原文：${text}`, evidence: text }] }];
}
