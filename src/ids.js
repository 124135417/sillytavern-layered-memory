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
        const note = `已记录激活基线：第 ${baseline} 对。此前历史不会自动提取，请用设置中的「存量迁移」。基线之后的新楼走实时延迟提取。`;
        const q = data.review_queue || [];
        if (!q.some(x => x.kind === 'alert' && String(x.note || '').includes('激活基线'))) {
            q.push({
                id: crypto.randomUUID(),
                kind: 'alert',
                note,
                createdAt: Date.now(),
            });
            data.review_queue = q;
        }
        appendLog('info', note);
    } else {
        appendLog('info', '激活基线：-1（新聊天，全部楼层走实时提取）');
    }
    void saveChatData();
    return baseline;
}

export function getBaselinePair() {
    return ensureActivationBaseline();
}
