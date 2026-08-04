import assert from 'node:assert/strict';
import { EMPTY_CHAT_DATA } from '../src/constants.js';

function makeChat(prefix, count) {
    return Array.from({ length: count }, (_, index) => [
        {
            is_user: true,
            mes: `${prefix}-${index} 用户输入`,
            extra: { layered_memory_id: `${prefix}-${index}-user` },
        },
        {
            is_user: false,
            mes: prefix === 'REVALIDATE'
                ? (index === 0 ? '林晚和周衡从亲近转入冷战。' : '林晚与周衡结束冷战，恢复和解。')
                : `${prefix}-${index} 角色回复`,
            extra: { layered_memory_id: `${prefix}-${index}-assistant` },
        },
    ]).flat();
}

function makeData(scope) {
    const data = EMPTY_CHAT_DATA();
    data.job_queue.scope_id = scope;
    data.progress.baseline_pair = -1;
    return data;
}

const scenarios = {
    order: {
        chat: makeChat('ORDER', 3),
        data: makeData('extract-order'),
    },
    revalidate: {
        chat: makeChat('REVALIDATE', 2),
        data: makeData('extract-revalidate'),
    },
};
scenarios.revalidate.data.state_table.entries.push({
    id: 'e_0001',
    slot: 'relationship',
    topic: '双方关系状态',
    subject: '林晚',
    object: '周衡',
    value: '亲近',
    cause: '',
    established_floor: -1,
    updated_floor: -1,
    evidence: '两人原本关系亲近',
    pinned: false,
    source: 'auto',
});
scenarios.revalidate.data.progress.next_entry_seq = 2;

let active = 'order';
let generateRaw = null;
const settings = {
    enabled: true,
    memoryModelSource: 'current',
    bodyExtractionRegex: '',
    chapterSize: 25,
    proofreadEvery: 75,
};
const context = {
    get chat() { return scenarios[active].chat; },
    get chatMetadata() { return { layered_memory: scenarios[active].data }; },
    extensionSettings: { layered_memory: settings },
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    generateRaw: args => generateRaw(args),
    name1: '测试用户',
};
globalThis.SillyTavern = { getContext: () => context, libs: {} };

const { getPairs } = await import('../src/ids.js');
const { handleExtractJob } = await import('../src/extract.js');
const { enqueue, getQueueSnapshot, registerHandler } = await import('../src/queue.js');
registerHandler('extract', handleExtractJob);

async function waitUntil(predicate, message, timeout = 3_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(message);
}

function noChangeResult(index) {
    return JSON.stringify({
        turn_summary: `<user>推进 ORDER-${index}，角色完成对应回复。`,
        story_time: null,
        promise: '无变化',
        body: '无变化',
        relationship: '无变化',
        identity: '无变化',
        possession: '无变化',
        world: '无变化',
        other: '无变化',
        conflicts: [],
    });
}

const orderStarted = [];
const orderReleases = new Map();
let activeOrderCalls = 0;
let maxOrderCalls = 0;
generateRaw = async ({ prompt }) => {
    const index = Number(prompt.match(/ORDER-(\d+) 用户输入/u)?.[1]);
    orderStarted.push(index);
    activeOrderCalls += 1;
    maxOrderCalls = Math.max(maxOrderCalls, activeOrderCalls);
    return new Promise(resolve => {
        orderReleases.set(index, () => {
            activeOrderCalls -= 1;
            resolve(noChangeResult(index));
        });
    });
};

for (const pair of getPairs()) enqueue('extract', { floorKey: pair.floorKey, pairIndex: pair.pairIndex }, 100);
await waitUntil(() => orderStarted.length === 3, 'three live extract model requests should overlap');
assert.equal(maxOrderCalls, 3);
assert.equal(getQueueSnapshot().running.length, 3);
orderReleases.get(2)();
orderReleases.get(1)();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(scenarios.order.data.turn_summaries.length, 0,
    'later model responses must wait for the first commit slot');
orderReleases.get(0)();
await waitUntil(() => getQueueSnapshot().running.length === 0 && getQueueSnapshot().queued.length === 0,
    'ordered extract queue should drain');
assert.deepEqual(scenarios.order.data.turn_summaries.map(item => item.pairIndex), [0, 1, 2]);
assert.deepEqual(scenarios.order.data.logs
    .filter(item => item.message.startsWith('提取完成'))
    .map(item => Number(item.message.match(/楼#(\d+)/u)?.[1])), [0, 1, 2]);

active = 'revalidate';
const revalidateStarted = [];
const initialReleases = new Map();
const callsByFloor = new Map();
const retryPrompts = [];
let activeRevalidateCalls = 0;
let maxRevalidateCalls = 0;
generateRaw = async ({ prompt }) => {
    const index = Number(prompt.match(/REVALIDATE-(\d+) 用户输入/u)?.[1]);
    const count = (callsByFloor.get(index) || 0) + 1;
    callsByFloor.set(index, count);
    revalidateStarted.push(`${index}:${count}`);
    activeRevalidateCalls += 1;
    maxRevalidateCalls = Math.max(maxRevalidateCalls, activeRevalidateCalls);
    const finish = () => {
        activeRevalidateCalls -= 1;
        const oldValue = index === 0 || count === 1 ? '亲近' : '冷战';
        const newValue = index === 0 ? '冷战' : '和解';
        const evidence = index === 0 ? '从亲近转入冷战' : '结束冷战，恢复和解';
        return JSON.stringify({
            turn_summary: index === 0
                ? '<user>推动林晚与周衡的关系转入冷战。'
                : '<user>推动林晚与周衡结束冷战并恢复和解。',
            story_time: null,
            relationship: [{
                topic: '双方关系状态',
                subject: '林晚',
                object: '周衡',
                old_value: oldValue,
                new_value: newValue,
                evidence,
            }],
            conflicts: [],
        });
    };
    if (index === 1 && count === 2) {
        retryPrompts.push(prompt);
        return finish();
    }
    return new Promise(resolve => initialReleases.set(index, () => resolve(finish())));
};

for (const pair of getPairs()) enqueue('extract', { floorKey: pair.floorKey, pairIndex: pair.pairIndex }, 100);
await waitUntil(() => revalidateStarted.length === 2, 'two state-dependent analyses should start together');
assert.equal(maxRevalidateCalls, 2);
initialReleases.get(1)();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(scenarios.revalidate.data.state_table.entries[0].value, '亲近');
initialReleases.get(0)();
await waitUntil(() => getQueueSnapshot().running.length === 0 && getQueueSnapshot().queued.length === 0,
    'revalidated extract queue should drain');
assert.equal(callsByFloor.get(0), 1);
assert.equal(callsByFloor.get(1), 2, 'only the stale later floor should be regenerated');
assert.match(retryPrompts[0], /冷战/u, 'regeneration must receive the latest fact table');
assert.equal(scenarios.revalidate.data.state_table.entries[0].value, '和解');
assert.equal(scenarios.revalidate.data.review_queue.length, 0,
    'the discarded optimistic merge must not leave a false conflict');
assert.deepEqual(scenarios.revalidate.data.turn_summaries.map(item => item.pairIndex), [0, 1]);

console.log('extract concurrency smoke: three overlapping requests, ordered commits, and stale-result regeneration passed');
