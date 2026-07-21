import { getContext } from './settings.js';

/**
 * Ensure every message has a stable layered_memory_id in extra.
 */
export function ensureMessageIds() {
    const { chat } = getContext();
    let changed = false;
    for (const mes of chat) {
        if (!mes.extra) {
            mes.extra = {};
        }
        if (!mes.extra.layered_memory_id) {
            mes.extra.layered_memory_id = crypto.randomUUID();
            changed = true;
        }
    }
    return changed;
}

export function messageStableKey(mes) {
    if (!mes) {
        return null;
    }
    if (mes.extra?.layered_memory_id) {
        return mes.extra.layered_memory_id;
    }
    const swipeId = mes.swipe_id ?? 0;
    return `${mes.send_date ?? 'nodate'}::${swipeId}::${mes.is_user ? 'u' : 'a'}`;
}

/**
 * Walk chat as pairs: each pair = one user message + following non-user reply (if any).
 * Returns [{ pairIndex, user, ai, userKey, aiKey, sealed }]
 * sealed = AI exists (pair is "定格" for delayed extract once a newer user message exists,
 * or when explicitly treated as pending after chat switch).
 */
export function getPairs() {
    ensureMessageIds();
    const { chat } = getContext();
    const pairs = [];
    let i = 0;
    while (i < chat.length) {
        const mes = chat[i];
        if (!mes.is_user) {
            i += 1;
            continue;
        }
        const user = mes;
        let ai = null;
        let j = i + 1;
        while (j < chat.length && chat[j].is_user) {
            // consecutive user messages: treat as incomplete pair without AI
            break;
        }
        if (j < chat.length && !chat[j].is_user) {
            ai = chat[j];
        }
        pairs.push({
            pairIndex: pairs.length,
            user,
            ai,
            userKey: messageStableKey(user),
            aiKey: ai ? messageStableKey(ai) : null,
            floorKey: ai ? `${messageStableKey(user)}+${messageStableKey(ai)}` : messageStableKey(user),
            sealed: Boolean(ai),
        });
        i = ai ? j + 1 : i + 1;
    }
    return pairs;
}

export function getActiveMesText(mes) {
    if (!mes) {
        return '';
    }
    if (Array.isArray(mes.swipes) && typeof mes.swipe_id === 'number' && mes.swipes[mes.swipe_id] != null) {
        return String(mes.swipes[mes.swipe_id]);
    }
    return String(mes.mes ?? '');
}

export function getPairTexts(pair) {
    return {
        userText: getActiveMesText(pair.user),
        aiText: getActiveMesText(pair.ai),
    };
}

/**
 * Pairs that are sealed and should be considered for extraction once "定格".
 * A sealed pair is frozen when there is a later user message OR we force pending rebuild.
 */
export function getFrozenPairs() {
    const pairs = getPairs();
    const frozen = [];
    for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        if (!p.sealed) {
            continue;
        }
        const hasLaterUser = pairs.slice(i + 1).some(x => x.user);
        // Last sealed pair becomes frozen when a new user turn exists after it,
        // OR when it is not the very last pair in chat (another pair started).
        if (hasLaterUser || i < pairs.length - 1) {
            frozen.push(p);
        }
    }
    // Also: if the last pair is sealed and chat ended (no pending user), still not frozen
    // until next user message — per delayed-extract design.
    return frozen;
}
