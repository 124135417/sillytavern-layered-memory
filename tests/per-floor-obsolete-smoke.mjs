import assert from 'node:assert/strict';
import { EMPTY_CHAT_DATA } from '../src/constants.js';
let data = EMPTY_CHAT_DATA();
const context = {
    chat: [
        { is_user: true, mes: '先放在桌边。', extra: { layered_memory_id: 'u0' } },
        { is_user: false, mes: '角色递来温水。', extra: { layered_memory_id: 'a0' } },
        { is_user: true, mes: '事情办完了。', extra: { layered_memory_id: 'u1' } },
        { is_user: false, mes: '款项已经结清，伤口也已经痊愈。两人结束恋爱关系。', extra: { layered_memory_id: 'a1' } },
    ],
    get chatMetadata() { return { layered_memory: data }; },
    extensionSettings: { layered_memory: { enabled: true, memoryModelSource: 'current', bodyExtractionRegex: '', chapterSize: 25 } },
    saveMetadata: async () => {}, saveChat: async () => {}, saveSettingsDebounced: () => {}, name1: '玩家',
};
globalThis.SillyTavern = { getContext: () => context, libs: {} };
const { getPairs } = await import('../src/ids.js');
const { snapshotObsoleteTargets } = await import('../src/obsolete.js');
const { mergeExtractResult, rollbackFloor, renderStateTableCompact } = await import('../src/merge.js');
const { normalizeExtractOutput } = await import('../src/validate.js');
const { renderL1Block, renderDormantRetrievalBlock } = await import('../src/render.js');
const { replayBranchData, captureBranchCheckpoint } = await import('../src/branch.js');
const { restoreArchivedFact } = await import('../src/fact-management.js');
const { handleExtractJob } = await import('../src/extract.js');
const { getQueueSnapshot } = await import('../src/queue.js');
const pair = getPairs()[1];
function fact(id, value, extra = {}) { return { id, slot: 'other', topic: id, subject: '角色', value, evidence: '角色递来温水', source: 'auto', updated_floor: 0, ...extra }; }
function seed() {
    data = EMPTY_CHAT_DATA(); data.progress.baseline_pair = -1;
    data.state_table.entries = [
        fact('e_water', 'TEMP_WATER_CANARY，角色递来一杯温水'),
        fact('e_paid', '款项尚未结清'),
        fact('e_injury', '伤口尚未痊愈', { slot: 'body' }),
        fact('e_relationship', '两人处于恋爱关系', { slot: 'relationship', object: '玩家', topic: '双方关系状态' }),
        fact('e_pinned', 'PINNED_CANARY', { pinned: true }),
        fact('e_manual', 'MANUAL_CANARY', { source: 'manual' }),
    ];
    data.progress.next_entry_seq = 100;
    // Seed before the retiring floor, so replay must actually apply its delete.
    const full = context.chat; context.chat = full.slice(0, 2);
    captureBranchCheckpoint(data, 'test_seed'); context.chat = full;
    data.branch_checkpoints[0].createdAt = 1;
}
function ctx() { return { pipeline: 'per_floor', pairIndex: pair.pairIndex, floorKey: pair.floorKey, contentFingerprint: pair.contentFingerprint, sourceText: context.chat[2].mes+'\n'+context.chat[3].mes, stateTable: data.state_table, obsoleteTargets: snapshotObsoleteTargets(data.state_table), persist: false }; }
function command(entry_id, category = 'scene_local', evidence = '') { return { entry_id, category, reason: '本次事情已结束，旧现场动作没有持续作用', evidence }; }
seed();
const modelResult = { turn_summary: '角色结清款项，伤口痊愈，并结束恋爱关系。', obsolete: [command('e_water'), command('e_paid','completed','款项已经结清'), command('e_injury','completed','伤口也已经痊愈')], relationship: [{ topic: '双方关系状态', subject: '角色', object: '玩家', old_value: '两人处于恋爱关系', new_value: '两人已经分手', evidence: '两人结束恋爱关系' }] };
let result = await mergeExtractResult(normalizeExtractOutput(modelResult), ctx());
assert.equal(result.applied,4);
assert.equal(data.retired_facts.length,3);
assert(!data.state_table.entries.some(e=>['e_water','e_paid','e_injury'].includes(e.id)));
assert.equal(data.state_table.entries.find(e=>e.id==='e_relationship').value,'两人已经分手');
assert.equal(data.state_lifecycle.last_completed_at,null,'No manually adopted lifecycle baseline is required');
assert(!renderL1Block(data).includes('TEMP_WATER_CANARY'));
assert(!renderStateTableCompact(data.state_table).includes('TEMP_WATER_CANARY'));
assert(!renderDormantRetrievalBlock(data,'角色温水',500).includes('TEMP_WATER_CANARY'),'Retired facts must never use dormant recall');
assert.equal(data.floor_events[0].entryChanges.filter(e=>e.op==='delete').length,3);
const parent=structuredClone(data);
let replay=replayBranchData(parent,getPairs(),'test');
assert(!replay.state_table.entries.some(e=>e.id==='e_water'));
assert.equal(replay.retired_facts.length,3);
replay=replayBranchData(parent,getPairs().slice(0,1),'test');
assert(replay.state_table.entries.some(e=>e.id==='e_water'));
assert.equal(replay.retired_facts.length,0,'Fork before obsolete must not inherit its archive');
context.chat[3].swipes=[context.chat[3].mes,'另一候选没有结清款项。'];context.chat[3].swipe_id=1;
replay=replayBranchData(parent,getPairs(),'test');
assert(replay.state_table.entries.some(e=>e.id==='e_paid'));
assert.equal(replay.retired_facts.length,0,'Alternate swipe must not inherit obsolete decisions');
context.chat[3].swipe_id=0;
await rollbackFloor(pair.floorKey);
assert.equal(data.retired_facts.length,0);
assert(data.state_table.entries.some(e=>e.id==='e_water'));
assert.equal(data.state_table.entries.find(e=>e.id==='e_relationship').value,'两人处于恋爱关系');

seed();let c=ctx();data.state_table.entries.find(e=>e.id==='e_water').value='用户刚改过的内容';
result=await mergeExtractResult(normalizeExtractOutput({obsolete:[command('e_water'),command('e_pinned'),command('e_manual'),command('unknown')]}),c);
assert.equal(result.applied,0);assert.equal(data.retired_facts.length,0);
seed();result=await mergeExtractResult(normalizeExtractOutput({obsolete:[command('e_paid','completed','模型虚构的证据'),command('e_paid','completed','款项已经结清')]}),ctx());
assert.equal(result.applied,0,'Malformed first duplicate cannot use a later duplicate to bypass validation');
assert(data.state_table.entries.some(e=>e.id==='e_paid'));
seed();c=ctx();let normalized=normalizeExtractOutput({obsolete:[command('e_water')],other:[{topic:'e_water',subject:'角色',value:'新的温水尚在手边',evidence:'款项已经结清'}]});
result=await mergeExtractResult(normalized,c);assert(data.state_table.entries.some(e=>e.id==='e_water'),'An update in the same response wins over retirement');assert.equal(data.retired_facts.length,0);
seed();await mergeExtractResult(normalizeExtractOutput({obsolete:[command('e_water')]}),ctx());
let old=normalizeExtractOutput({other:[{topic:'e_water',subject:'角色',value:'TEMP_WATER_CANARY，角色递来一杯温水',evidence:'角色递来温水'}]});
c=ctx();c.pairIndex=0;c.floorKey='old-floor';c.contentFingerprint='old-fp';c.sourceText='角色递来温水';
assert.equal((await mergeExtractResult(old,c)).applied,0,'Old extraction cannot resurrect archived fact');
c.pairIndex=2;c.floorKey='new-floor';c.contentFingerprint='new-fp';assert.equal((await mergeExtractResult(old,c)).applied,1,'New later evidence may establish it again');
const archived=data.retired_facts[0];const restored=restoreArchivedFact(data,'retired_facts',archived.id);assert(!restored.error);assert.equal(restored.entry.source,'manual');assert.equal(data.retired_facts.length,0);

// Exercise the real extract handler: one existing model call, full current table,
// direct archive, and persisted JSON, with no separate state-review job.
seed();let calls=0, sent='', persisted=null;
context.generateRaw=async({prompt})=>{calls++;sent=prompt;return JSON.stringify({turn_summary:'<user>说事情办完，角色说明款项已经结清。',obsolete:[command('e_water'),command('e_paid','completed','款项已经结清')]})};
context.saveMetadata=async()=>{persisted=JSON.stringify(data)};
await handleExtractJob({floorKey:pair.floorKey,pairIndex:pair.pairIndex,ignoreBaseline:true});
assert.equal(calls,1);assert(sent.includes('TEMP_WATER_CANARY')&&sent.includes('[e_manual]')&&sent.includes('[e_relationship]'),'The extraction must see every current fact');
assert.equal(data.retired_facts.length,2);assert(persisted&&JSON.parse(persisted).retired_facts.length===2);
assert(!getQueueSnapshot().queued.some(job=>job.type==='state_review'));
console.log('per-floor obsolete: one-call full-table extraction, no-baseline retirement, excluded inputs, update/protection/race guards, old-replay suppression, restore, swipe/fork/rollback and persistence passed');
