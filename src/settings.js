import { DEFAULT_SETTINGS, EMPTY_CHAT_DATA, MODULE_NAME } from './constants.js';

export function getContext() {
    return SillyTavern.getContext();
}

export function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = structuredClone(DEFAULT_SETTINGS[key]);
        }
    }
    if (!Array.isArray(extensionSettings[MODULE_NAME].eval_cases)) {
        extensionSettings[MODULE_NAME].eval_cases = [];
    }
    return extensionSettings[MODULE_NAME];
}

export function saveSettings() {
    const { saveSettingsDebounced } = getContext();
    saveSettingsDebounced();
}

export function getChatData() {
    const { chatMetadata } = getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = EMPTY_CHAT_DATA();
    }
    const data = chatMetadata[MODULE_NAME];
    // Soft-migrate missing keys
    const blank = EMPTY_CHAT_DATA();
    for (const key of Object.keys(blank)) {
        if (!Object.hasOwn(data, key)) {
            data[key] = blank[key];
        }
    }
    if (!data.state_table) {
        data.state_table = blank.state_table;
    }
    if (!data.progress) {
        data.progress = blank.progress;
    } else {
        for (const pk of Object.keys(blank.progress)) {
            if (!Object.hasOwn(data.progress, pk)) {
                data.progress[pk] = blank.progress[pk];
            }
        }
        // Recover next_chapter_seq from existing chapters if missing/stale low
        if (!data.progress.next_chapter_seq || data.progress.next_chapter_seq < 1) {
            data.progress.next_chapter_seq = 1;
        }
        const maxSeq = (data.chapters || []).reduce((m, c) => {
            const n = Number(String(c.id || '').replace(/^ch_/, ''));
            return Number.isFinite(n) ? Math.max(m, n) : m;
        }, 0);
        if (maxSeq >= data.progress.next_chapter_seq) {
            data.progress.next_chapter_seq = maxSeq + 1;
        }
    }
    return data;
}

export async function saveChatData() {
    const { saveMetadata } = getContext();
    await saveMetadata();
}

export function appendLog(level, message, extra = null) {
    const data = getChatData();
    data.logs = data.logs || [];
    data.logs.push({
        t: Date.now(),
        level,
        message,
        extra,
    });
    if (data.logs.length > 200) {
        data.logs = data.logs.slice(-200);
    }
    console[level === 'error' ? 'error' : 'log'](`[layered-memory] ${message}`, extra ?? '');
}
