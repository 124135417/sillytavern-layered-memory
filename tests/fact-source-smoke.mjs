import assert from 'node:assert/strict';

const user = {
    is_user: true, mes: '我把钥匙交给阿尔德瑞思。', send_date: 'u1',
    extra: { layered_memory_id: 'user-10' },
};
const assistant = {
    is_user: false, mes: '<content>阿尔德瑞思接过钥匙，收进内袋。</content>', send_date: 'a1',
    extra: { layered_memory_id: 'assistant-11' },
};
const context = {
    chat: [user, assistant],
    extensionSettings: { layered_memory: { bodyExtractionRegex: '<content>([\\s\\S]*?)</content>' } },
    chatMetadata: {}, saveChat: async () => {}, saveSettingsDebounced() {},
};
globalThis.SillyTavern = { getContext: () => context };

const { getPairs } = await import('../src/ids.js');
const {
    backfillFactSourceCoordinates,
    locateFactEvidence,
    pairMessageSources,
    sourceOrder,
} = await import('../src/fact-source.js');

const pair = getPairs()[0];
const sources = pairMessageSources(pair);
const located = locateFactEvidence('接过钥匙', sources);
assert.equal(located.messageKey, 'assistant-11');
assert.equal(located.messageIndex, 1);
assert.equal(located.role, 'assistant');
assert.ok(located.contentFingerprint.startsWith('v1:'));
assert.equal(Object.hasOwn(located, 'text'), false, 'fact coordinates must not duplicate raw message bodies');

const data = {
    state_table: { entries: [{
        id: 'e_key', slot: 'possession', topic: '钥匙', subject: '阿尔德瑞思', object: '',
        value: '持有钥匙', evidence: '接过钥匙', established_floor: 0, updated_floor: 0,
    }] },
};
assert.equal(backfillFactSourceCoordinates(data, [pair]), 2);
assert.equal(data.state_table.entries[0].established_source.messageKey, 'assistant-11');
assert.equal(sourceOrder(data.state_table.entries[0]), 1);
assert.equal(backfillFactSourceCoordinates(data, [pair]), 0, 'coordinate backfill must be idempotent');

console.log('fact source smoke: stable message coordinates, compact provenance, and idempotent backfill passed');
