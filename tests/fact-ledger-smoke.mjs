import assert from 'node:assert/strict';

globalThis.crypto ??= (await import('node:crypto')).webcrypto;

const {
    activateFactCandidate,
    activateEditedFactCandidate,
    dismissFactCandidate,
    ensureFactLedger,
    factCandidateView,
    factIdentityKey,
    makeFactCandidate,
} = await import('../src/facts.js');
const { normalizeStoryTime, storyTimeRange } = await import('../src/story-time.js');
const { renderL1Block, renderL2Block } = await import('../src/render.js');

function baseData() {
    return {
        state_table: { version: 1, entries: [], changelog: [] },
        floor_events: [],
        quarantined_entries: [],
        fact_ledger: [],
        fact_decisions: [],
        progress: { next_entry_seq: 1 },
        chapters: [],
        volumes: [],
        turn_summaries: [],
    };
}

const legacy = baseData();
legacy.floor_events = [{
    floorKey: 'floor-1', pairIndex: 1, contentFingerprint: 'fp-1',
    entryChanges: [
        { op: 'upsert', after: { id: 'e_0001', slot: 'promise', subject: '林许', object: '<user>', value: '不再讨论用户', evidence: '不会再讨论您', source: 'auto' } },
        { op: 'upsert', after: { id: 'e_0001', slot: 'promise', subject: '林许', object: '<user>', value: '必要时收回施压', evidence: '我立刻收回指令', source: 'auto' } },
    ],
}];
legacy.state_table.entries.push({ id: 'e_0001', slot: 'promise', subject: '林许', object: '<user>', value: '必要时收回施压', evidence: '我立刻收回指令', source: 'auto' });
ensureFactLedger(legacy);
assert.equal(legacy.fact_ledger.length, 2, 'legacy destructive updates must migrate into two visible discoveries');
assert.equal(factCandidateView(legacy).filter(item => item.status === 'active').length, 1);
assert.equal(factCandidateView(legacy).filter(item => item.status === 'superseded').length, 1);

const data = baseData();
data.state_table.entries.push({ id: 'e_0001', slot: 'identity', topic: '防卫局职位', subject: '林许', object: '', value: '基层特工', evidence: '他是基层特工', source: 'auto' });
data.progress.next_entry_seq = 2;
const independent = makeFactCandidate({ fact: { slot: 'identity', topic: '秘密身份', subject: '林许', object: '', value: '卧底', evidence: '他承认自己是卧底' }, floor: 5, floorKey: 'f5' });
const replacement = makeFactCandidate({ fact: { slot: 'identity', topic: '防卫局职位', subject: '林许', object: '', value: '特调组组长', evidence: '任命为特调组组长' }, floor: 6, floorKey: 'f6' });
assert.notEqual(
    makeFactCandidate({ fact: replacement.fact, floor: 6, floorKey: 'f6', contentFingerprint: 'swipe-a' }).id,
    makeFactCandidate({ fact: replacement.fact, floor: 6, floorKey: 'f6', contentFingerprint: 'swipe-b' }).id,
    'candidate identity must include the source swipe fingerprint',
);
data.fact_ledger.push(independent, replacement);
assert.notEqual(factIdentityKey(independent.fact), factIdentityKey(data.state_table.entries[0]), 'different identity topics must coexist');
const first = activateFactCandidate(data, independent.id, { pairIndex: 6 });
assert.equal(first.replaced.length, 0);
assert.equal(data.state_table.entries.length, 2);
const second = activateFactCandidate(data, replacement.id, { pairIndex: 6 });
assert.equal(second.replaced.length, 1, 'same concrete topic must switch current state');
assert.equal(data.state_table.entries.some(entry => entry.value === '基层特工'), false);
assert.equal(factCandidateView(data).find(item => item.id === replacement.id).status, 'active');

dismissFactCandidate(data, independent.id, { pairIndex: 7 });
assert.equal(factCandidateView(data).find(item => item.id === independent.id).status, 'dismissed');
activateFactCandidate(data, independent.id, { pairIndex: 8 });
assert.equal(factCandidateView(data).find(item => item.id === independent.id).status, 'active',
    're-activating an existing value must override an earlier dismissal decision');

const edited = activateEditedFactCandidate(data, replacement.id, {
    ...replacement.fact, value: '防卫局副局长', evidence: '',
}, { pairIndex: 8 });
assert.equal(edited.entry.value, '防卫局副局长');
assert.equal(data.state_table.entries.some(entry => entry.value === '特调组组长'), false,
    'editing a discovery must replace the current value for the same concrete topic');

const changelogOnly = baseData();
changelogOnly.state_table.entries.push({
    id: 'e_old', slot: 'identity', topic: '公开身份', subject: '顾南', object: '',
    value: '调查员', cause: '完成任命', evidence: '他成为调查员', source: 'auto',
});
changelogOnly.state_table.changelog.push({
    op: 'update', id: 'e_old', floor: 9, floorKey: 'floor-9',
    before: { value: '见习员', cause: '尚未转正' },
    after: { value: '调查员', cause: '完成任命' },
});
ensureFactLedger(changelogOnly);
assert.deepEqual(new Set(changelogOnly.fact_ledger.map(item => item.fact.value)), new Set(['见习员', '调查员']),
    'changelog-only old chats must recover both readable values using the current entry identity');
assert.equal(changelogOnly.fact_ledger.every(item => item.fact.slot === 'identity' && item.fact.subject === '顾南'), true);

const time = normalizeStoryTime({ label: '次日清晨', kind: 'relative', evidence: '次日清晨' }, '次日清晨，阳光穿过窗户');
assert.deepEqual(time, { label: '次日清晨', kind: 'relative', evidence: '次日清晨' });
assert.equal(normalizeStoryTime({ label: '第三天', evidence: '原文没有' }, '当晚他回到家'), null, 'invented story time must be rejected');
assert.equal(normalizeStoryTime({ label: '第三天', evidence: '当晚' }, '当晚他回到家'), null,
    'a grounded quote must not be used to smuggle in an invented story date');
assert.equal(storyTimeRange([{ pairIndex: 1, story_time: time }, { pairIndex: 2, story_time: { label: '当日下午' } }]).label, '次日清晨 → 当日下午');

const renderedData = baseData();
renderedData.state_table.entries.push({ id: 'e_1', slot: 'identity', topic: '身份', subject: '<user>', object: '', value: '旅店老板', evidence: '我是旅店老板', source: 'auto' });
assert.match(renderL1Block(renderedData, 2000, { name1: '临川', name2: '任意角色卡' }), /当前角色卡：任意角色卡/u);
assert.doesNotMatch(renderL1Block(renderedData, 2000, { name1: '临川', name2: '任意角色卡' }), /阿尔德/u);
renderedData.turn_summaries.push({ pairIndex: 1, summary: '发生了一件事。', story_time: time });
assert.match(renderL2Block(renderedData), /剧情时间：次日清晨/u);

console.log('fact ledger smoke: ok');
