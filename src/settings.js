import { DEFAULT_SETTINGS, EMPTY_CHAT_DATA, MODULE_NAME } from './constants.js';
import { quarantineInvalidEntries } from './quality.js';
import { ensureFactLedger } from './facts.js';

export function getContext() {
    return SillyTavern.getContext();
}

export function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = extensionSettings[MODULE_NAME];
    // <= 0.4.0 exposed an implicit priority chain. Migrate it once to an
    // explicit route so the plugin never silently uses a different model.
    if (!Object.hasOwn(settings, 'memoryModelSource')) {
        settings.memoryModelSource = settings.fallbackEnabled
            && settings.fallbackBaseUrl
            && settings.fallbackApiKey
            ? 'direct'
            : settings.connectionProfile
                ? 'profile'
                : 'current';
    }
    if (!['direct', 'profile', 'current'].includes(settings.memoryModelSource)) {
        settings.memoryModelSource = 'current';
    }
    if (!Object.hasOwn(settings, 'directBaseUrl')) {
        settings.directBaseUrl = settings.fallbackBaseUrl || '';
    }
    if (!Object.hasOwn(settings, 'directApiKey')) {
        settings.directApiKey = settings.fallbackApiKey || '';
    }
    if (!Object.hasOwn(settings, 'directModel')) {
        settings.directModel = settings.fallbackModel || '';
    }
    if (!Object.hasOwn(settings, 'minRecentPairs')) {
        const legacyRecent = Number(settings.recentPairs);
        settings.minRecentPairs = Math.max(6, Number.isFinite(legacyRecent) ? legacyRecent : 0);
    }
    if (!['compact', 'balanced', 'detailed', 'custom'].includes(settings.historyBudgetMode)) {
        settings.historyBudgetMode = 'balanced';
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = structuredClone(DEFAULT_SETTINGS[key]);
        }
    }
    if (!Array.isArray(settings.eval_cases)) {
        settings.eval_cases = [];
    }
    return settings;
}

export function saveSettings() {
    const { saveSettingsDebounced } = getContext();
    saveSettingsDebounced();
}

function getActiveChatData() {
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
    data.version = Math.max(Number(data.version) || 1, blank.version);
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
    data.notices = Array.isArray(data.notices) ? data.notices : [];
    data.review_queue = Array.isArray(data.review_queue) ? data.review_queue : [];
    const alerts = data.review_queue.filter(item => item?.kind === 'alert');
    if (alerts.length) {
        const known = new Set(data.notices.map(item => item.id));
        for (const item of alerts) {
            if (!known.has(item.id)) data.notices.push({ ...item, kind: 'notice' });
        }
        data.review_queue = data.review_queue.filter(item => item?.kind !== 'alert');
    }
    if (data.history_backfill?.status === 'complete' || data.history_rebuild?.status === 'complete') {
        data.notices = data.notices.filter(item => !/父聊天还没有可继承|从下一轮开始正常记录|开始自动记录/.test(String(item.note || '')));
    }
    quarantineInvalidEntries(data);
    ensureFactLedger(data);
    return data;
}

export function getChatData() {
    return getActiveChatData();
}

export function assertChatData(data) {
    if (getActiveChatData() !== data) {
        const error = new Error('聊天已切换，已取消旧聊天任务的保存');
        error.code = 'CHAT_SCOPE_CHANGED';
        throw error;
    }
}

export async function saveChatData(expectedData = null) {
    if (expectedData) assertChatData(expectedData);
    const { saveMetadata } = getContext();
    await saveMetadata();
    // Prevent callers from continuing their completion path against a newly
    // opened chat if the switch happened while the save request was pending.
    if (expectedData) assertChatData(expectedData);
}

/** Persist message-level fields such as extra.layered_memory_id. */
export async function saveChatMessages() {
    const context = getContext();
    const save = context.saveChat || context.saveChatConditional;
    if (typeof save !== 'function') {
        throw new Error('当前 SillyTavern 版本未暴露聊天保存接口');
    }
    // Invoke while the originating chat is still current. ensureMessageIds()
    // only reports true once, so this does not create a save loop/storm.
    await save.call(context);
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
