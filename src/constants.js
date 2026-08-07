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
    /** A generation is waiting for this exact floor before resetting raw style. */
    style_reset_narrative: 1000,
    extract: 100,
    narrative_summary: 95,
    narrative_chapter: 85,
    chapter_summary: 80,
    volume_compress: 60,
    proofread: 50,
    state_gc: 40,
    migrate: 10,
    migrate_complete: 9,
    history_rebuild_segment: 10,
    history_rebuild_chapter: 9,
    history_rebuild_commit: 8,
};

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    /** Explicit auxiliary-model source: direct | profile | current. */
    memoryModelSource: 'current',
    /** Optional model override for the selected Connection Manager profile. */
    profileModelOverride: '',
    directBaseUrl: '',
    directApiKey: '',
    directModel: '',
    /** ST Connection Manager profile id/name; empty = current main connection via generateRaw */
    connectionProfile: '',
    /** @deprecated Legacy direct-connection fields, kept for <= 0.4.0 migration. */
    fallbackEnabled: false,
    fallbackBaseUrl: '',
    fallbackApiKey: '',
    fallbackModel: '',
    budgetL1: 2000,
    budgetL2: 5000,
    budgetL4: 1500,
    /** Fixed plugin-owned allowance for a suffix of complete raw message floors. */
    recentRawTokens: 16000,
    /** Empty means the complete AI reply. Capture group 1 is the narrative body. */
    bodyExtractionRegex: '',
    chapterSize: 25,
    proofreadEvery: 75,
    /** @deprecated L1 is a mandatory IN_PROMPT block; retained for settings compatibility. */
    depthL1: 100,
    /** @deprecated L2 is a mandatory IN_PROMPT block; retained for settings compatibility. */
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
    version: 7,
    state_table: {
        version: 1,
        entries: [],
        changelog: [],
    },
    turn_summaries: [],
    /** One summary per real SillyTavern message floor, used by narrative injection. */
    narrative_summaries: [],
    /** Frozen 25-message narrative chapters. Pair-based legacy chapters stay separate. */
    narrative_chapters: [],
    narrative_volumes: [],
    /** Replayable per-floor materialized changes used to restore Fork branches. */
    floor_events: [],
    /** Compact user edits, anchored to the visible branch at the time of editing. */
    manual_events: [],
    /** State-table snapshots anchored to a stable floor key. */
    branch_checkpoints: [],
    branch_origin: null,
    history_backfill: {
        status: 'idle',
        total: 0,
        completed: 0,
        startedAt: null,
        finishedAt: null,
        stoppedAt: null,
        error: null,
    },
    chapters: [],
    volumes: [],
    keyword_index: {},
    review_queue: [],
    notices: [],
    quarantined_entries: [],
    /** Immutable discoveries; current facts are a user-controllable view over this ledger. */
    fact_ledger: [],
    /** User choices over immutable discoveries; anchored for Fork-safe replay. */
    fact_decisions: [],
    /** Non-canon player/narrator discussions and their swipe-safe revisions. */
    backstage: {
        version: 1,
        activeSessionId: null,
        pendingGeneration: null,
        sessions: [],
    },
    history_rebuild: null,
    rebuild_backup: null,
    pending_floors: [],
    extracted_keys: [],
    job_queue: {
        scope_id: null,
        paused: false,
        queued: [],
        running: [],
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
    logs: [],
});
