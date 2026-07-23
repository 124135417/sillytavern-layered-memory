/**
 * Extract the narrative body from an AI reply. A user rule is an optimization,
 * never a hard dependency: invalid or unmatched rules fall back to full text.
 */
export function extractAiBody(aiText, pattern = '') {
    const fullText = String(aiText ?? '');
    const rule = String(pattern ?? '').trim();
    if (!rule) {
        return { text: fullText, mode: 'full', matched: true, error: '' };
    }

    try {
        const match = new RegExp(rule, 'u').exec(fullText);
        if (!match) {
            return { text: fullText, mode: 'fallback', matched: false, error: 'no_match' };
        }
        const captured = match.length > 1 ? match[1] : match[0];
        if (!String(captured ?? '').trim()) {
            return { text: fullText, mode: 'fallback', matched: false, error: 'empty_match' };
        }
        return { text: String(captured), mode: 'regex', matched: true, error: '' };
    } catch (error) {
        return {
            text: fullText,
            mode: 'fallback',
            matched: false,
            error: `invalid_regex:${error?.message ?? error}`,
        };
    }
}
