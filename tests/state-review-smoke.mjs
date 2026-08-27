import assert from 'node:assert/strict';

const {
    applyStateReviewBatch,
    normalizeStateReview,
    stateReviewEntries,
    STATE_REVIEW_KIND,
    buildStateReviewPrompt,
    automaticStateReviewRequest,
    buildStateAuditOverview,
    buildStateEvidenceCatalog,
    normalizeLifecycleAudit,
    normalizeLifecycleVerification,
    applyLifecycleAudit,
    stateReviewSignature,
    latestNarrativeFloor,
    stageOrganizationBatch,
    applyStagedOrganization,
    refreshStagedOrganizationPolicy,
    stagedOrganizationCompatibility,
    rollbackLastOrganization,
} = await import('../src/state-review.js');
const { applyDormancyPolicy, dormancyAssessment } = await import('../src/lifecycle-policy.js');

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
    established_source: { status: 'exact', messageIndex: 1, messageKey: `m-${id}`, contentFingerprint: `fp-${id}` },
    updated_source: { status: 'exact', messageIndex: 1, messageKey: `m-${id}`, contentFingerprint: `fp-${id}` },
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

const lifecycleData = {
    state_table: {
        version: 20,
        entries: [
            entry('old_cold_war', { slot: 'relationship', topic: '关系状态', value: '双方仍在冷战' }),
            entry('duplicate_location', { value: '当前站在门口' }),
            entry('current_relation', { slot: 'relationship', topic: '关系状态', value: '双方已经恢复合作', updated_floor: 88 }),
            entry('protected_secret', { slot: 'identity', pinned: true, value: '真实身份仍未公开' }),
        ],
    },
    narrative_summaries: [
        { messageIndex: 87, summary: '双方仍在冷战。', segments: [] },
        { messageIndex: 88, summary: '双方结束冷战并恢复合作。', segments: [{ time_change: null, events: [{ text: '双方恢复合作。', evidence: '结束冷战并恢复合作' }] }] },
    ],
    review_queue: [],
    manual_events: [],
    retired_facts: [],
    dormant_facts: [],
    historical_facts: [],
    memory_organization: {
        version: 1, status: 'idle', staged: null, last_snapshot: null,
        last_applied_at: null, last_applied_floor: -1,
    },
    state_lifecycle: {
        version: 1, status: 'idle', active_run: null, last_completed_at: null,
        last_state_signature: '', last_narrative_floor: -1, last_result: null,
    },
};
const catalog = buildStateEvidenceCatalog(lifecycleData);
assert.equal(catalog.length, 2);
assert.match(catalog[1].text, /结束冷战并恢复合作/u);
assert.equal(automaticStateReviewRequest(lifecycleData), null,
    'opening a legacy chat before user adoption must never schedule a full mutation');
assert.equal(automaticStateReviewRequest(lifecycleData, { force: true })?.mode, 'full_stage');

const longHistory = {
    ...lifecycleData,
    narrative_chapters: [],
    narrative_summaries: Array.from({ length: 75 }, (_, messageIndex) => ({
        messageIndex,
        summary: `第 ${messageIndex} 楼发生了不同的剧情。`,
        segments: [{ time_change: null, events: [{ text: `事件 ${messageIndex}`, evidence: `原文证据 ${messageIndex}` }] }],
    })),
};
const boundedOverview = buildStateAuditOverview(longHistory);
assert.equal(boundedOverview.length, 3, 'histories without frozen chapters must get deterministic 25-floor overview blocks');
assert.deepEqual(boundedOverview[0].range, [0, 24]);

const lifecycleEntries = lifecycleData.state_table.entries;
const primary = normalizeLifecycleAudit({
    decisions: [
        {
            entry_id: 'old_cold_war', verdict: 'retire', category: 'superseded', keep_id: 'current_relation',
            reason: '后文明确结束冷战', confidence: 'high', evidence: [{ source_id: 'floor:88', quote: '结束冷战并恢复合作' }],
        },
        {
            entry_id: 'duplicate_location', verdict: 'history', category: 'scene_local', keep_id: '',
            reason: '只是当时位置', confidence: 'medium', evidence: [{ source_id: 'fact:duplicate_location', quote: '当前站在门口' }],
        },
        { entry_id: 'current_relation', verdict: 'keep', reason: '仍是现行状态', confidence: 'high', evidence: [] },
        {
            entry_id: 'protected_secret', verdict: 'retire', category: 'contradicted', keep_id: '',
            reason: '不应删除保护条目', confidence: 'high', evidence: [{ source_id: 'floor:88', quote: '结束冷战并恢复合作' }],
        },
    ],
}, lifecycleData, lifecycleEntries, catalog);
assert.equal(primary.complete, true);
assert.equal(primary.decisions.find(item => item.entry_id === 'old_cold_war').evidence_valid, true);
assert.equal(primary.decisions.find(item => item.entry_id === 'protected_secret').verdict, 'keep', 'protected facts must be forced to keep');

const unresolvedProposal = normalizeLifecycleAudit({
    decisions: [{
        entry_id: 'old_cold_war', verdict: 'retire', category: 'superseded', keep_id: 'current_relation',
        reason: '后文已经取代旧状态', confidence: 'high', evidence: [],
    }],
}, lifecycleData, [lifecycleData.state_table.entries[0]], catalog).decisions[0];
assert.equal(unresolvedProposal.verdict, 'uncertain', 'missing exact evidence must still fail closed');
assert.equal(unresolvedProposal.proposed_verdict, 'retire',
    'the retirement intent must survive so the raw-evidence resolver can still investigate it');

const verified = normalizeLifecycleVerification({
    checks: [
        { entry_id: 'old_cold_war', verdict: 'confirm', reason: '后文直接取代旧关系状态' },
        { entry_id: 'duplicate_location', verdict: 'confirm', reason: '只是单场景位置' },
    ],
}, primary.decisions.filter(item => ['retire', 'history'].includes(item.verdict)));
const verificationById = new Map(verified.map(item => [item.entry_id, item.verification]));
const auditedDecisions = primary.decisions.map(item => ({
    ...item,
    verification: verificationById.get(item.entry_id) || { verdict: 'not_required', reason: '' },
}));
const lifecycleEvents = [];
const lifecycleResult = applyLifecycleAudit(lifecycleData, {
    run_id: 'run-1',
    base_version: 20,
    decisions: auditedDecisions,
}, {
    recordEvent: (_data, event) => {
        lifecycleEvents.push(event);
        return { anchorFloorKey: 'u+a', anchorPairIndex: 44, anchorFingerprint: 'fp' };
    },
});
assert.equal(lifecycleResult.error, null);
assert.equal(lifecycleResult.removed, 1, 'only high-confidence independently confirmed facts auto-retire');
assert.equal(lifecycleResult.pending, 1, 'medium-confidence retirement must remain reviewable');
assert.ok(!lifecycleData.state_table.entries.some(item => item.id === 'old_cold_war'));
assert.ok(lifecycleData.state_table.entries.some(item => item.id === 'duplicate_location'));
assert.equal(lifecycleData.retired_facts.length, 1, 'automatic retirement must remain archived');
assert.equal(lifecycleData.retired_facts[0].anchorPairIndex, 44);
assert.equal(lifecycleEvents[0].reason, 'state_lifecycle_auto_retired');
assert.equal(lifecycleData.review_queue[0].base_version, 21, 'pending review must bind to the post-auto-retirement version');

const dormantPolicyData = {
    state_table: {
        version: 1,
        entries: [
            entry('cold_route', {
                slot: 'world', topic: '北段黑市位置', value: '北段黑市离旧矿区一天半',
                updated_source: { status: 'exact', messageIndex: 10 },
            }),
            entry('core_identity', {
                slot: 'identity', topic: '真实身份', value: '真实身份仍未公开',
                updated_source: { status: 'exact', messageIndex: 10 },
            }),
        ],
    },
    narrative_summaries: [{ messageIndex: 600, summary: '他们一直在主堡讨论晚饭。', segments: [] }],
    dormant_facts: [], retired_facts: [], historical_facts: [], review_queue: [], manual_events: [],
};
assert.equal(dormancyAssessment(dormantPolicyData, dormantPolicyData.state_table.entries[0]).eligible, true);
const policyDecisions = applyDormancyPolicy(dormantPolicyData, [
    { entry_id: 'cold_route', verdict: 'keep', confidence: 'high', evidence: [] },
    { entry_id: 'core_identity', verdict: 'dormant', confidence: 'high', evidence: [] },
]);
assert.equal(policyDecisions[0].verdict, 'dormant');
assert.equal(policyDecisions[1].verdict, 'keep', 'identity facts must stay awake even if the model asks to sleep them');
const recentlyRelevantRouteData = structuredClone(dormantPolicyData);
recentlyRelevantRouteData.narrative_summaries = [
    { messageIndex: 590, summary: '他们正在重新核对北段黑市位置。', segments: [] },
    { messageIndex: 600, summary: '他们回到主堡。', segments: [] },
];
const recentRoute = dormancyAssessment(recentlyRelevantRouteData, recentlyRelevantRouteData.state_table.entries[0]);
assert.equal(recentRoute.eligible, false, 'a specific recent item mention must postpone dormancy');
assert.equal(recentRoute.recentlyRelevant, true);
assert.equal(applyDormancyPolicy(recentlyRelevantRouteData, [
    { entry_id: 'cold_route', verdict: 'dormant', confidence: 'high', evidence: [] },
])[0].verdict, 'keep', 'a model suggestion cannot bypass the recent-relevance guard');
const dormantApplied = applyLifecycleAudit(dormantPolicyData, {
    run_id: 'dormant-run', base_version: 1, decisions: policyDecisions,
}, {
    recordEvent: () => ({ anchorFloorKey: 'head', anchorPairIndex: 150, anchorFingerprint: 'fp' }),
});
assert.equal(dormantApplied.removed, 1);
assert.equal(dormantPolicyData.dormant_facts[0].entry_id, 'cold_route');
assert.deepEqual(dormantPolicyData.state_table.entries.map(item => item.id), ['core_identity']);

lifecycleData.state_lifecycle.last_completed_at = 999;
lifecycleData.state_lifecycle.last_state_signature = stateReviewSignature(lifecycleData);
lifecycleData.state_lifecycle.last_narrative_floor = latestNarrativeFloor(lifecycleData);
lifecycleData.memory_organization.last_applied_at = 999;
lifecycleData.memory_organization.last_applied_floor = latestNarrativeFloor(lifecycleData);
assert.equal(automaticStateReviewRequest(lifecycleData, { onOpen: true }), null, 'unchanged reopened chat needs no duplicate audit');
lifecycleData.narrative_summaries.push({ messageIndex: 89, summary: '新的剧情证据。', segments: [] });
assert.equal(automaticStateReviewRequest(lifecycleData, { onOpen: true })?.reason, 'new_evidence_before_open');

const organizationData = {
    state_table: {
        version: 3,
        entries: [
            entry('stay', { slot: 'identity' }),
            entry('sleep'),
            entry('past_action'),
            entry('protected', { pinned: true }),
        ],
    },
    dormant_facts: [], retired_facts: [], historical_facts: [], review_queue: [], manual_events: [],
    narrative_summaries: [{ messageIndex: 600, summary: '当前剧情。', segments: [] }],
    memory_organization: {
        version: 1, status: 'idle', staged: null, last_snapshot: null,
        last_applied_at: null, last_applied_floor: -1,
    },
    state_lifecycle: {
        version: 1, status: 'idle', active_run: null, last_completed_at: null,
        last_state_signature: '', last_narrative_floor: -1, last_result: null,
    },
};
const staged = stageOrganizationBatch(organizationData, {
    run_id: 'organize-1', base_version: 3,
    decisions: [
        { entry_id: 'stay', verdict: 'keep', confidence: 'high', evidence: [] },
        { entry_id: 'sleep', verdict: 'dormant', confidence: 'medium', reason: '近期无关', evidence: [] },
        {
            entry_id: 'past_action', verdict: 'history', category: 'scene_local', confidence: 'high',
            reason: '只属于当时动作', evidence: [{ source_id: 'fact:past_action', quote: '证据 past_action' }],
            evidence_valid: true, evidence_exact: true, verification: { verdict: 'confirm', reason: '一次性动作' },
        },
        {
            entry_id: 'protected', verdict: 'dormant', confidence: 'high', reason: '不应移动保护项', evidence: [],
        },
    ],
});
assert.equal(staged.error, null);
assert.deepEqual(organizationData.state_table.entries.map(item => item.id), ['stay', 'sleep', 'past_action', 'protected'],
    'staging a preview must not mutate formal memory');
organizationData.state_table.entries.push(entry('fresh'));
organizationData.state_table.version += 1;
assert.deepEqual(stagedOrganizationCompatibility(organizationData), { compatible: true, additionsPreserved: 1 },
    'a preview remains safe when its reviewed entries are unchanged and only new facts were appended');
assert.equal(refreshStagedOrganizationPolicy(organizationData), true,
    'preview totals must refresh when a new fact is preserved outside its decisions');
assert.equal(organizationData.memory_organization.staged.counts.current, 3);
assert.equal(refreshStagedOrganizationPolicy(organizationData), false, 'unchanged preview totals must not cause save loops');
const adopted = applyStagedOrganization(organizationData, {
    recordEvent: () => ({ anchorFloorKey: 'head', anchorPairIndex: 10, anchorFingerprint: 'fp' }),
});
assert.equal(adopted.error, null);
assert.equal(adopted.additionsPreserved, 1);
assert.deepEqual(organizationData.state_table.entries.map(item => item.id), ['stay', 'protected', 'fresh']);
assert.equal(organizationData.dormant_facts[0].entry_id, 'sleep');
assert.equal(organizationData.historical_facts[0].entry_id, 'past_action');
assert.ok(organizationData.memory_organization.last_snapshot, 'adoption must retain one rollback snapshot');
assert.equal(rollbackLastOrganization(organizationData).error, null);
assert.deepEqual(organizationData.state_table.entries.map(item => item.id), ['stay', 'sleep', 'past_action', 'protected', 'fresh']);

const changedData = structuredClone(organizationData);
const changedStage = stageOrganizationBatch(changedData, {
    run_id: 'organize-changed', base_version: changedData.state_table.version,
    decisions: changedData.state_table.entries.map(item => ({
        entry_id: item.id, verdict: 'keep', confidence: 'high', evidence: [],
    })),
});
assert.equal(changedStage.error, null);
changedData.state_table.entries.find(item => item.id === 'stay').value = '预览后被修改';
changedData.state_table.version += 1;
assert.deepEqual(stagedOrganizationCompatibility(changedData), { compatible: false, additionsPreserved: 0 },
    'changing any reviewed fact must invalidate the old preview');
assert.equal(applyStagedOrganization(changedData).error, 'stale');

console.log('state review smoke: preview adoption, post-source evidence, protection, rollback, and incremental gating passed');
