import { extractAiBody } from './body.js';
import {
    getPairTexts,
    messageContentFingerprint,
    messageStableKey,
} from './ids.js';
import { getSettings } from './settings.js';
import { stripStyleResetCommands } from './style-reset.js';

function cleanEvidence(value) {
    return String(value || '').trim();
}

function messageSource(message, messageIndex, role, text, pair) {
    return {
        status: 'exact',
        messageKey: messageStableKey(message),
        messageIndex: Number.isInteger(messageIndex) ? messageIndex : null,
        role,
        contentFingerprint: messageContentFingerprint(message),
        pairIndex: Number.isInteger(pair?.pairIndex) ? pair.pairIndex : null,
        floorKey: pair?.floorKey || null,
        text: String(text || ''),
    };
}

/** Stable, swipe-aware raw sources for one sealed user/assistant pair. */
export function pairMessageSources(pair, {
    userText = null,
    aiText = null,
    bodyExtractionRegex = getSettings().bodyExtractionRegex,
} = {}) {
    if (!pair) return [];
    const texts = getPairTexts(pair);
    const cleanedUser = userText == null
        ? stripStyleResetCommands(texts.userText).text
        : String(userText || '');
    const cleanedAssistant = aiText == null
        ? extractAiBody(texts.aiText, bodyExtractionRegex).text
        : String(aiText || '');
    return [
        pair.user ? messageSource(pair.user, pair.userFloor, 'user', cleanedUser, pair) : null,
        pair.ai ? messageSource(pair.ai, pair.aiFloor, 'assistant', cleanedAssistant, pair) : null,
    ].filter(Boolean);
}

/** Resolve extractor-preserved evidence to one exact visible message coordinate. */
export function locateFactEvidence(evidence, sources = []) {
    const quote = cleanEvidence(evidence);
    if (!quote) return null;
    const matches = sources.filter(source => String(source?.text || '').includes(quote));
    if (!matches.length) return null;
    // An assistant assertion normally establishes world state. If the same quote
    // appears on both sides, prefer the later visible floor deterministically.
    const source = matches.slice().sort((a, b) =>
        Number(b.messageIndex ?? -1) - Number(a.messageIndex ?? -1))[0];
    const { text: _text, ...coordinate } = source;
    return { ...coordinate, quote };
}

export function unresolvedFactSource(entry, kind = 'established') {
    const pairIndex = Number(entry?.[kind === 'updated' ? 'updated_floor' : 'established_floor']);
    return {
        status: 'unresolved',
        messageKey: null,
        messageIndex: null,
        role: null,
        contentFingerprint: null,
        pairIndex: Number.isInteger(pairIndex) ? pairIndex : null,
        floorKey: null,
        quote: cleanEvidence(entry?.evidence),
    };
}

export function sourceOrder(entry) {
    const source = entry?.updated_source || entry?.established_source;
    const messageIndex = Number(source?.messageIndex);
    if (Number.isInteger(messageIndex)) return messageIndex;
    // Legacy pair indices are not comparable to real message floors; callers
    // must treat this only as an unresolved fallback, never exact evidence.
    return -1;
}

/** Backfill exact coordinates without regenerating or rewriting any fact prose. */
export function backfillFactSourceCoordinates(data, pairs = []) {
    const byPair = new Map((pairs || []).map(pair => [pair.pairIndex, pair]));
    let changed = 0;
    for (const entry of data?.state_table?.entries || []) {
        for (const kind of ['established', 'updated']) {
            const key = `${kind}_source`;
            if (entry[key]?.status === 'exact' && entry[key]?.messageKey) continue;
            const pairIndex = Number(entry?.[`${kind}_floor`]);
            const pair = Number.isInteger(pairIndex) ? byPair.get(pairIndex) : null;
            const resolved = pair
                ? locateFactEvidence(entry.evidence, pairMessageSources(pair))
                : null;
            const next = resolved || unresolvedFactSource(entry, kind);
            if (JSON.stringify(entry[key] || null) === JSON.stringify(next)) continue;
            entry[key] = next;
            changed += 1;
        }
    }
    return changed;
}
