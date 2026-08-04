import { getPairTexts, getPairs, isPendingSwipeMessage } from './ids.js';
import { getSettings } from './settings.js';
import { stripStyleResetCommands } from './style-reset.js';

/**
 * Lexical retrieval over keyword_index.
 */
export function retrieveHits(data, budgetTokens = 1500, { excludeTrailingAssistant = false } = {}) {
    const settings = getSettings();
    if (!settings.l4Enabled) {
        return [];
    }
    const pairs = getPairs({ excludeTrailingAssistant });
    const last = pairs.filter(p => p.sealed).at(-1);
    let scan = '';
    if (last) {
        const t = getPairTexts(last);
        scan += `${stripStyleResetCommands(t.userText).text}\n${t.aiText}\n`;
    }
    // Current user input: last message if user
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat || [];
    const trailingMessage = chat.at(-1);
    const projectedChat = trailingMessage && !trailingMessage.is_user
        && (excludeTrailingAssistant || isPendingSwipeMessage(trailingMessage))
        ? chat.slice(0, -1)
        : chat;
    const lastMes = projectedChat.at(-1);
    if (lastMes?.is_user) {
        scan += stripStyleResetCommands(lastMes.mes || '').text;
    }

    const index = data.keyword_index || {};
    const scores = new Map();
    const lower = scan.toLowerCase();
    for (const [kw, chapterIds] of Object.entries(index)) {
        if (!kw || kw.length < 2) {
            continue;
        }
        if (lower.includes(kw) || scan.includes(kw)) {
            for (const id of chapterIds) {
                scores.set(id, (scores.get(id) || 0) + 1);
            }
        }
    }

    const ranked = [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id]) => (data.chapters || []).find(c => c.id === id))
        .filter(Boolean);

    return ranked;
}
