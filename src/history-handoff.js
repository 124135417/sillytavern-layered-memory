import { currentNarrativeSources } from './narrative.js';
import { getContext, getSettings } from './settings.js';

function result(status, reason, extra = {}) {
    return { status, reason, ignoredMessages: 0, ...extra };
}

/**
 * A trailing assistant message is an active generation target (continue,
 * impersonate, tool recursion, etc.). A swipe has already been popped from the
 * request copy, but still exists in the stored chat until its replacement is
 * saved, so it must use the same projection explicitly.
 */
export function requestExcludesTrailingAssistant(chat, type = null) {
    return type === 'swipe' || Boolean(chat?.at?.(-1) && !chat.at(-1).is_user);
}

/**
 * Keep the post-regex request objects available to SillyTavern's world-info
 * and depth logic, while marking the plugin-managed historical prefix so the
 * Chat Completion formatter omits it from the provider request.
 *
 * All writes are made to replacement request objects. The stored chat and its
 * nested `extra` objects remain untouched.
 */
export function handOffManagedHistory(chat, type = null, {
    context = getContext(),
    settings = getSettings(),
} = {}) {
    if (!settings?.enabled) return result('skipped', 'plugin_disabled');
    if (context?.mainApi && context.mainApi !== 'openai') {
        return result('skipped', 'unsupported_backend');
    }
    if (typeof context?.setExtensionPrompt !== 'function') {
        return result('skipped', 'injection_unavailable');
    }
    const ignore = context?.symbols?.ignore;
    if (typeof ignore !== 'symbol') return result('skipped', 'ignore_symbol_unavailable');
    if (!Array.isArray(chat) || !chat.length) return result('kept', 'no_chat');

    const excludeTrailingAssistant = requestExcludesTrailingAssistant(chat, type);
    const managedKeys = new Set(currentNarrativeSources({ excludeTrailingAssistant })
        .map(source => source.messageKey)
        .filter(Boolean));
    if (!managedKeys.size) {
        return result('kept', 'no_managed_history', { excludeTrailingAssistant });
    }

    const requestKeys = chat.map(message => message?.extra?.layered_memory_id || null);
    if (requestKeys.some(key => !key)) {
        return result('skipped', 'message_mapping', { excludeTrailingAssistant });
    }

    const managedIndices = requestKeys.flatMap((key, index) => managedKeys.has(key) ? [index] : []);
    if (!managedIndices.length) {
        return result('kept', 'no_managed_request_messages', { excludeTrailingAssistant });
    }
    const firstActiveIndex = requestKeys.findIndex(key => !managedKeys.has(key));
    if (firstActiveIndex >= 0 && managedIndices.some(index => index > firstActiveIndex)) {
        return result('skipped', 'non_prefix_mapping', { excludeTrailingAssistant });
    }

    for (const index of managedIndices) {
        const message = chat[index];
        const extra = { ...(message.extra || {}) };
        extra[ignore] = true;
        chat[index] = { ...message, extra };
    }

    return result('handed_off', 'managed_prefix', {
        ignoredMessages: managedIndices.length,
        keptMessages: chat.length - managedIndices.length,
        excludeTrailingAssistant,
    });
}
