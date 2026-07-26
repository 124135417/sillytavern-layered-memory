import {
    appendLog,
    getChatData,
    getContext,
    saveChatData,
    saveChatMessages,
} from './settings.js';

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
    if (changed) {
        void saveChatMessages().catch(err => {
            // Do not append to metadata here: the rejection may arrive after a
            // chat switch, in which case logging through getChatData() would
            // attach the error to the newly opened chat.
            console.error(`[layered-memory] 消息稳定 ID 保存失败: ${err?.message ?? err}`);
        });
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

function fnv1a(value, seed = 0x811c9dc5) {
    let hash = seed;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Fingerprint one visible SillyTavern message, including the active swipe. */
export function messageContentFingerprint(mes) {
    const text = getActiveMesText(mes);
    const payload = [
        messageStableKey(mes),
        mes?.is_user ? 'user' : 'assistant',
        text,
    ].join('\0');
    return `v1:${fnv1a(payload)}${fnv1a(payload, 0x9e3779b9)}:${payload.length}`;
}

/**
 * Visible chat messages are the narrative floor unit. The trailing user
 * message is normally excluded because SillyTavern already sends it verbatim
 * as the current request while the next assistant floor is being generated.
 */
export function getMessageFloors({ includeTrailingUser = false } = {}) {
    ensureMessageIds();
    const { chat } = getContext();
    const lastIndex = chat.length - 1;
    return chat.flatMap((message, messageIndex) => {
        if (!includeTrailingUser && messageIndex === lastIndex && message?.is_user) {
            return [];
        }
        return [{
            message,
            messageKey: messageStableKey(message),
            messageIndex,
            role: message?.is_user ? 'user' : 'assistant',
            text: getActiveMesText(message),
            contentFingerprint: messageContentFingerprint(message),
        }];
    });
}

/** Detect edits and non-current swipe Forks even when SillyTavern keeps message IDs. */
export function pairContentFingerprint(pair) {
    const { userText, aiText } = getPairTexts(pair);
    const payload = [
        pair?.userKey || messageStableKey(pair?.user),
        pair?.aiKey || messageStableKey(pair?.ai),
        userText,
        aiText,
    ].join('\0');
    return `v1:${fnv1a(payload)}${fnv1a(payload, 0x9e3779b9)}:${payload.length}`;
}

/**
 * Walk chat as pairs: each pair = one user message + following non-user reply (if any).
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
            break;
        }
        if (j < chat.length && !chat[j].is_user) {
            ai = chat[j];
        }
        const pair = {
            pairIndex: pairs.length,
            // These are the real SillyTavern message floors shown by `mesid`.
            // Keep pairIndex as the stable internal processing index, but never
            // present it to people as though it were a chat floor.
            userFloor: i,
            aiFloor: ai ? j : null,
            user,
            ai,
            userKey: messageStableKey(user),
            aiKey: ai ? messageStableKey(ai) : null,
            floorKey: ai ? `${messageStableKey(user)}+${messageStableKey(ai)}` : messageStableKey(user),
            sealed: Boolean(ai),
        };
        pair.contentFingerprint = pairContentFingerprint(pair);
        pairs.push(pair);
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
        if (hasLaterUser || i < pairs.length - 1) {
            frozen.push(p);
        }
    }
    return frozen;
}

/**
 * Record activation baseline once per chat: max sealed pairIndex at first touch.
 * Live per-floor extract only processes pairIndex > baseline_pair.
 */
export function ensureActivationBaseline() {
    const data = getChatData();
    if (data.progress.baseline_pair !== null && data.progress.baseline_pair !== undefined) {
        return data.progress.baseline_pair;
    }
    const sealed = getPairs().filter(p => p.sealed);
    const baseline = sealed.length ? Math.max(...sealed.map(p => p.pairIndex)) : -1;
    data.progress.baseline_pair = baseline;
    if (baseline >= 0) {
        const firstNewPair = getPairs().find(pair => pair.pairIndex === baseline + 1);
        const note = firstNewPair
            ? `插件将从第 ${firstNewPair.userFloor} 楼开始自动记录。更早的聊天不会自动整理；如果需要，请前往“设置 → 安全重建以前的聊天”。`
            : '插件会从下一条用户消息开始自动记录。更早的聊天不会自动整理；如果需要，请前往“设置 → 安全重建以前的聊天”。';
        const notices = data.notices || [];
        if (!notices.some(x => String(x.note || '').includes('开始自动记录'))) {
            notices.push({
                id: crypto.randomUUID(),
                kind: 'notice',
                note,
                createdAt: Date.now(),
            });
            data.notices = notices;
        }
        appendLog('info', note);
    } else {
        appendLog('info', '激活基线：-1（新聊天，全部楼层走实时提取）');
    }
    void saveChatData(data);
    return baseline;
}

export function getBaselinePair() {
    return ensureActivationBaseline();
}
