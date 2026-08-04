import { getActiveMesText, isPendingSwipeMessage, messageStableKey } from './ids.js';

const STYLE_RESET_PATTERN = /（重置文风[ \t\u3000]+([^）]+?)）/gu;

function matchesIn(value) {
    const text = String(value ?? '');
    return [...text.matchAll(STYLE_RESET_PATTERN)]
        .map(match => ({
            raw: match[0],
            directive: String(match[1] || '').trim(),
            index: match.index ?? 0,
        }))
        .filter(match => match.directive);
}

/** Parse the last valid `（重置文风 具体要求）` command in one user message. */
export function parseStyleResetCommand(value) {
    return matchesIn(value).at(-1) || null;
}

/** Remove reset controls before a user floor enters raw continuity or summaries. */
export function stripStyleResetCommands(value) {
    const text = String(value ?? '');
    const commands = matchesIn(text);
    if (!commands.length) return { text, commands: [] };
    const controls = new Set(commands.map(command => command.raw));
    return {
        text: text.replace(STYLE_RESET_PATTERN, match => controls.has(match) ? '' : match).trim(),
        commands,
    };
}

function projectedChat(chat, { excludeTrailingAssistant = false } = {}) {
    const rows = Array.isArray(chat) ? chat : [];
    const last = rows.at(-1);
    if (last && !last.is_user && (excludeTrailingAssistant || isPendingSwipeMessage(last))) {
        return rows.slice(0, -1);
    }
    return rows;
}

/**
 * Resolve the newest reset boundary on the visible branch. `active` means the
 * reset-bearing user floor is the direct input for the assistant being made
 * now (including swipe/continue projections).
 */
export function resolveStyleReset({
    context = SillyTavern.getContext(),
    excludeTrailingAssistant = false,
} = {}) {
    const chat = projectedChat(context?.chat, { excludeTrailingAssistant });
    let latest = null;
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex += 1) {
        const message = chat[messageIndex];
        if (!message?.is_user) continue;
        const parsed = parseStyleResetCommand(getActiveMesText(message));
        if (!parsed) continue;
        latest = {
            ...parsed,
            message,
            messageIndex,
            messageKey: messageStableKey(message),
        };
    }
    if (!latest) return null;
    return {
        ...latest,
        active: latest.messageIndex === chat.length - 1,
    };
}
