export const MODULE_NAME = 'layered_memory';

export const PROMPT_KEYS = {
    L1: 'layered_memory_l1',
    L2: 'layered_memory_l2',
    L4: 'layered_memory_l4',
};

export const SLOT_LABELS = {
    promise: '承诺与约定',
    body: '身体状态',
    relationship: '关系',
    identity: '身份与秘密',
    possession: '持有物',
    world: '世界设定与变化',
    other: '其他重要内容',
};

export const SLOTS = Object.keys(SLOT_LABELS);

export const QUEUE_PRIORITY = {
    extract: 100,
    chapter_summary: 80,
    volume_compress: 60,
    proofread: 50,
    state_gc: 40,
    migrate: 10,
};

/**
 * Only these generate types may trim chat.
 * Unknown / quiet variants default to NOT trimming (safer than a denylist).
 */
export const TRIM_TYPES = new Set([
    '',
    'normal',
    'group_chat',
]);

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    /** ST Connection Manager profile id/name; empty = current main connection via generateRaw */
    connectionProfile: '',
    fallbackEnabled: false,
    fallbackBaseUrl: '',
    fallbackApiKey: '',
    fallbackModel: '',
    budgetL1: 2000,
    budgetL2: 5000,
    budgetL4: 1500,
    /** How much of the model context the post-regex chat history may use. */
    historyBudgetMode: 'balanced', // compact | balanced | detailed | custom
    historyTokenBudget: 12000,
    minRecentPairs: 6,
    /** @deprecated Kept for settings migration from <= 0.2.0. */
    recentPairs: 3,
    chapterSize: 25,
    proofreadEvery: 75,
    depthL1: 100,
    depthL2: 100,
    depthL4: 4,
    volumeCompressConfirm: false,
    l4Enabled: false,
    mentionStatMode: 'summary_and_table', // or 'full_text'
    chapterInputTokenCap: 20000,
    /** 仅在此模式下，手动改表才自动写入错例库 */
    migrationReviewMode: false,
    eval_cases: [],
});

export const EMPTY_CHAT_DATA = () => ({
    version: 1,
    state_table: {
        version: 1,
        entries: [],
        changelog: [],
    },
    chapters: [],
    volumes: [],
    keyword_index: {},
    review_queue: [],
    pending_floors: [],
    extracted_keys: [],
    job_queue: {
        scope_id: null,
        paused: false,
        queued: [],
        running: null,
        failed: [],
        updatedAt: null,
    },
    progress: {
        last_chapter_end_pair: -1,
        pairs_since_proofread: 0,
        next_entry_seq: 1,
        next_chapter_seq: 1,
        /**
         * Activation baseline: max sealed pairIndex when plugin first touched this chat.
         * null = not yet initialized.
         * Live per-floor extract only processes pairIndex > baseline_pair.
         * History at/before baseline is migration-only.
         */
        baseline_pair: null,
    },
    /** Last request-only context handoff. Contains counts/ranges, never chat text. */
    context_handoff: null,
    logs: [],
});
