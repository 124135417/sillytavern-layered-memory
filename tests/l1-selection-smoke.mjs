import assert from 'node:assert/strict';

const { selectL1Entries, renderL1Block } = await import('../src/render.js');
const { estimateTokens } = await import('../src/tokens.js');

const slots = ['promise', 'body', 'relationship', 'identity', 'possession', 'world', 'other'];
const makeEntry = (id, slot, floor, extra = {}) => ({
    id,
    slot,
    topic: `${slot}-topic-${id}`,
    subject: extra.subject || `主体${id}`,
    object: slot === 'relationship' ? '另一人' : '',
    value: extra.value || `${slot} 当前状态 ${id}`,
    evidence: `证据${id}`,
    established_floor: floor,
    updated_floor: floor,
    source: 'auto',
    pinned: false,
    ...extra,
});

const entries = [
    ...Array.from({ length: 36 }, (_, index) => makeEntry(`old-promise-${index}`, 'promise', index)),
    ...slots.map((slot, index) => makeEntry(`recent-${slot}`, slot, 500 + index)),
    makeEntry('pinned-old', 'body', 1, { pinned: true, value: '置顶身体状态必须优先' }),
    makeEntry('manual-old', 'identity', 1, { source: 'manual', value: '人工身份必须优先' }),
];
const data = { state_table: { entries } };
const context = { name1: '伯滔', name2: '阿尔德瑞思' };
const selection = selectL1Entries(data, 1050, context);

assert.ok(selection.omitted > 0, 'the fixture must exceed the L1 allowance');
assert.ok(selection.tokens <= 1050, 'selection must stay within the configured allowance');
assert.equal(estimateTokens(selection.text), selection.tokens);
assert.equal(selection.entries.some(entry => entry.id === 'pinned-old'), true, 'pinned facts must win');
assert.equal(selection.entries.some(entry => entry.id === 'manual-old'), true, 'manual facts must win');
for (const slot of slots) {
    assert.equal(selection.entries.some(entry => entry.slot === slot), true, `slot ${slot} needs a fair first pass`);
}
assert.equal(selection.entries.some(entry => entry.id === 'recent-world'), true,
    'a recent world fact must not be crowded out by old promises');
assert.doesNotMatch(selection.text, /…（已截断）/u, 'L1 must never be hard-truncated');
for (const entry of selection.entries) {
    assert.ok(selection.text.includes(entry.value), `selected entry ${entry.id} must be rendered whole`);
}
assert.equal(renderL1Block(data, 1050, context), selection.text);

console.log('L1 selection smoke: protected, fair, recent, atomic, and budget-safe facts passed');
