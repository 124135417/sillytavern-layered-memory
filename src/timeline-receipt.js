import { messageContentFingerprint, messageStableKey } from './ids.js';
import { getChatData, saveChatData } from './settings.js';

/** Persist only a matching generation receipt; a late old branch cannot touch the new one. */
export function recordTimelineReceipt(context, messageId, receipt) {
    const message = context?.chat?.[messageId];
    if (!receipt || !message || receipt.message !== message || message.is_user
        || (receipt.request?.metadata && receipt.request.metadata !== context.chatMetadata)
        || receipt.swipeId !== message.swipe_id) return false;
    const data = getChatData();
    const key = messageStableKey(message);
    // Native streaming finalization syncs mes -> swipes after MESSAGE_RECEIVED.
    const fingerprint = messageContentFingerprint({ ...message, swipes: undefined });
    const old = data.timeline_incomplete || [];
    const remaining = old.filter(item => item.messageKey !== key || item.fingerprint !== fingerprint);
    if (receipt.stopped) remaining.push({ messageKey: key, fingerprint });
    if (JSON.stringify(old) === JSON.stringify(remaining)) return false;
    data.timeline_incomplete = remaining;
    void saveChatData(data).catch(error => {
        if (error?.code !== 'CHAT_SCOPE_CHANGED') console.warn('[layered-memory] 时间候选状态保存失败', error);
    });
    return true;
}
