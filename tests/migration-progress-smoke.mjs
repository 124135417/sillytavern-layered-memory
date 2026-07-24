import assert from 'node:assert/strict';

function message(index, isUser) {
    const id = `${isUser ? 'u' : 'a'}${index}`;
    return { is_user: isUser, mes: id, extra: { layered_memory_id: id } };
}

const data = {
    version: 2,
    state_table: { version: 1, entries: [], changelog: [] },
    turn_summaries: [], floor_events: [], manual_events: [], branch_checkpoints: [], branch_origin: null,
    history_backfill: { status: 'idle', total: 0, completed: 0, startedAt: null, finishedAt: null, stoppedAt: null, error: null },
    chapters: [], volumes: [], keyword_index: {}, review_queue: [], pending_floors: [], extracted_keys: [], logs: [],
    job_queue: { scope_id: 'migration-scope', paused: true, queued: [], running: null, failed: [], updatedAt: null },
    progress: { last_chapter_end_pair: -1, pairs_since_proofread: 0, next_entry_seq: 1, next_chapter_seq: 1, baseline_pair: 3 },
};
const chat = [];
for (let i = 0; i < 4; i++) chat.push(message(i, true), message(i, false));
const context = {
    chat,
    chatMetadata: { layered_memory: data },
    extensionSettings: { layered_memory: { enabled: true, chapterSize: 2, migrationReviewMode: false } },
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
};
globalThis.SillyTavern = { getContext: () => context, libs: {} };

const {
    getHistoryBackfillSnapshot,
    handleMigrateCompleteJob,
    requestMigrateAbort,
    startMigration,
} = await import('../src/eval/migrate.js');
const { cancelQueuedJobs } = await import('../src/queue.js');

await startMigration();
let snapshot = getHistoryBackfillSnapshot();
assert.equal(snapshot.status, 'running');
assert.equal(snapshot.total, 4);
assert.equal(snapshot.completed, 0);
assert.ok(snapshot.queued >= 5, 'starting backfill must persist visible queued work');

data.extracted_keys.push('migrated:u0+a0');
snapshot = getHistoryBackfillSnapshot();
assert.equal(snapshot.completed, 1, 'progress must derive from completed historical pairs');

await requestMigrateAbort();
snapshot = getHistoryBackfillSnapshot();
assert.equal(snapshot.status, 'stopped');
assert.equal(snapshot.queued, 0, 'stopping must remove all not-yet-started migration jobs');
assert.equal(snapshot.completed, 1, 'stopping must preserve completed work');

data.extracted_keys = ['migrated:u0+a0', 'migrated:u1+a1', 'migrated:u2+a2', 'migrated:u3+a3'];
await startMigration();
await cancelQueuedJobs(['migrate_chapter', 'migrate_extract_chapter', 'migrate_extract_floor', 'migrate_finalize', 'migrate_complete']);
await handleMigrateCompleteJob();
snapshot = getHistoryBackfillSnapshot();
assert.equal(snapshot.status, 'complete');
assert.equal(snapshot.completed, 4);
assert.equal(data.review_queue.length, 0, 'completion notices must not count as actionable review items');
assert.match(data.notices.at(-1).note, /4 \/ 4/u);

console.log('migration progress smoke: start, persistent progress, stop, resume-safe completion passed');
