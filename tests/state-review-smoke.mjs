import assert from 'node:assert/strict';

const {
    applyStateReviewBatch,
    normalizeStateReview,
    stateReviewEntries,
    STATE_REVIEW_KIND,
    buildStateReviewPrompt,
} = await import('../src/state-review.js');

const entry = (id, extra = {}) => ({
    id,
    slot: 'other',
    topic: id,
    subject: '阿尔德瑞思',
    object: '',
    value: `状态 ${id}`,
    evidence: `证据 ${id}`,
    established_floor: 1,
    updated_floor: 1,
    source: 'auto',
    pinned: false,
    ...extra,
});
const data = {
    state_table: {
        version: 12,
        entries: [
            entry('expired'),
            entry('duplicate'),
            entry('current', { updated_floor: 99 }),
            entry('pinned', { pinned: true }),
            entry('manual', { source: 'manual' }),
        ],
    },
    review_queue: [],
    manual_events: [],
};

const batch = normalizeStateReview({
    changes: [
        {
            retire_ids: ['expired', 'pinned', 'manual', 'unknown'],
            keep_id: '',
            category: 'expired',
            reason: '后文已经完成',
            confidence: 'high',
        },
        {
            retire_ids: ['duplicate', 'expired'],
            keep_id: 'current',
            category: 'redundant',
            reason: '当前条目已经取代旧版本',
            confidence: 'medium',
        },
    ],
}, data, {
    id: 'review-1',
    now: 123,
    anchor: { floorKey: 'u+a', pairIndex: 50, contentFingerprint: 'fp' },
});

assert.equal(batch.kind, STATE_REVIEW_KIND);
assert.equal(batch.base_version, 12);
assert.equal(batch.retire_count, 2, 'unknown, pinned, manual, and duplicate targets must be rejected');
assert.deepEqual(batch.proposals.flatMap(item => item.retire_ids), ['expired', 'duplicate']);
assert.equal(batch.proposals[1].keep_id, 'current');
assert.equal(batch.floorKey, 'u+a');
assert.equal(stateReviewEntries(data, batch).retired.length, 2);

const priorSillyTavern = globalThis.SillyTavern;
globalThis.SillyTavern = {
    getContext: () => ({
        chat: [],
        chatMetadata: { layered_memory: data },
        extensionSettings: { layered_memory: { bodyExtractionRegex: '' } },
        saveChat: async () => {},
    }),
};
const reviewPrompt = buildStateReviewPrompt(data);
assert.match(reviewPrompt, /\[pinned\].*受玩家保护，不得移出/u);
assert.match(reviewPrompt, /\[manual\].*受玩家保护，不得移出/u);
if (priorSillyTavern) globalThis.SillyTavern = priorSillyTavern;
else delete globalThis.SillyTavern;

data.review_queue.push(batch);
const recorded = [];
const applied = applyStateReviewBatch(data, batch, {
    recordEvent: (_data, event) => recorded.push(event),
});
assert.equal(applied.error, null);
assert.equal(applied.removed, 2);
assert.deepEqual(data.state_table.entries.map(item => item.id), ['current', 'pinned', 'manual']);
assert.equal(data.state_table.version, 13);
assert.equal(recorded.length, 2);
assert.ok(recorded.every(event => event.op === 'delete' && event.reason === 'state_review_approval'));
assert.equal(data.review_queue.length, 0);

const staleData = {
    state_table: { version: 14, entries: [entry('expired')] },
    review_queue: [batch],
};
assert.equal(applyStateReviewBatch(staleData, batch, { recordEvent() {} }).error, 'stale');
assert.equal(staleData.state_table.entries.length, 1, 'stale review must not change memory');

console.log('state review smoke: validation, protection, anchoring, approval, and stale closure passed');
