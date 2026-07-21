/**
 * Rough token estimate. CJK chars ~1.5 tokens, latin words ~1.3 chars/token.
 * Same function used for all budgets so behavior is consistent.
 */
export function estimateTokens(text) {
    if (!text) {
        return 0;
    }
    const s = String(text);
    let cjk = 0;
    let other = 0;
    for (const ch of s) {
        if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(ch)) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    return Math.ceil(cjk * 1.5 + other / 3.5);
}

export function truncateToBudget(text, budget) {
    if (estimateTokens(text) <= budget) {
        return text;
    }
    // Binary-ish shrink by characters
    let lo = 0;
    let hi = text.length;
    let best = '';
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const slice = text.slice(0, mid);
        if (estimateTokens(slice) <= budget) {
            best = slice;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best + '\n…（已截断）';
}

export function normalizeWhitespace(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Evidence must be a substring of source after whitespace normalization.
 * Also try raw includes as fallback.
 */
export function evidenceInSource(evidence, source) {
    if (!evidence || !source) {
        return false;
    }
    const e = String(evidence).trim();
    if (!e) {
        return false;
    }
    if (source.includes(e)) {
        return true;
    }
    const nE = normalizeWhitespace(e);
    const nS = normalizeWhitespace(source);
    return nS.includes(nE);
}
