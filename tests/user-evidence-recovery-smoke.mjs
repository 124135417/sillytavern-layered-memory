import assert from 'node:assert/strict';
import { EMPTY_CHAT_DATA } from '../src/constants.js';
const data = EMPTY_CHAT_DATA(); data.job_queue.paused = true;
const context = { chat: [], chatMetadata: { layered_memory: data }, extensionSettings: { layered_memory: { enabled: true } }, saveMetadata: async()=>{}, saveSettingsDebounced(){} };
globalThis.SillyTavern = { getContext:()=>context, libs:{} };
const { recoverShortUserEvents } = await import('../src/narrative-user-evidence.js');
const { validateNarrativeBatch } = await import('../src/narrative.js');
for (const text of ['我又给他拿了一个筷子，这次是铁筷子 “所以你过去一个都干什么了，说真的”', '我去给他拿睡衣放在浴室门口，然后就去看书了', '我吃']) {
    const source = {role:'user', messageIndex:95, narrativeText:text, text};
    for (const segments of [undefined, [], [{events:[]}], [{events:[{text:'用户继续交谈',evidence:'模型编的证据'}]}]]) {
        const raw = {floors:[{floor:95,summary:'<user>本轮的实际动作和对白。',segments}]};
        const result = validateNarrativeBatch(raw,[source],{allowPartial:true});
        assert(result.ok, result.errors.join(';'));
        assert.equal(result.results[0].segments[0].events[0].evidence,text);
        assert.equal(result.results[0].segments[0].events[0].text,`<user>原文：${text}`);
        assert(result.results[0].eventsComplete);
        assert.equal(result.results[0].summary,`<user>原文：${text}`);
    }
}
const valid = [{time_change:null,events:[{text:'<user>吃饭。',evidence:'我吃'}]}];
assert.equal(recoverShortUserEvents(valid,{role:'user',narrativeText:'我吃'}),valid);
for (const source of [{role:'assistant',narrativeText:'我吃'}, {role:'user',narrativeText:''}, {role:'user',narrativeText:'继续'}, {role:'user',narrativeText:'长'.repeat(181)}]) assert.equal(recoverShortUserEvents(undefined,source),undefined);
const timed = [{time_change:{date:'2024-11-30'},events:[]}];
assert.equal(recoverShortUserEvents(timed,{role:'user',narrativeText:'一个月之后'}),timed);
const {getQueueSnapshot,retryFailedJob} = await import('../src/queue.js');
getQueueSnapshot();
data.job_queue.failed.push({id:'failed-user',type:'extract',payload:{floorKey:'u+a',unified:true},attempt:1,maxAttempts:3,lastError:'第95楼没有可核验事件'});
assert(retryFailedJob('failed-user'));
const retry = getQueueSnapshot().queued.find(job=>job.id==='failed-user');
assert.equal(retry.payload.retryNote,'第95楼没有可核验事件');
assert.equal(retry.payload.floorKey,'u+a');
assert.equal(retry.attempt,0);
console.log('Short player event recovery: exact source retained, valid/assistant/long/time records untouched; manual retry carries failure reason');
// Exercise the actual unified extraction path: one request, not an extra paid repair.
const live = EMPTY_CHAT_DATA();live.progress.baseline_pair=-1;live.job_queue.paused=true;context.chatMetadata.layered_memory=live;
context.chat=[{is_user:true,mes:'我吃',extra:{layered_memory_id:'short-u'}},{is_user:false,mes:'他把碗递过来。',extra:{layered_memory_id:'short-a'}},{is_user:true,mes:'继续说',extra:{layered_memory_id:'next-u'}}];
context.extensionSettings.layered_memory.memoryModelSource='current';let calls=0;
context.generateRaw=async({prompt})=>{calls++;assert.equal(prompt.split('TEST_RETRY_REASON').length-1,1);return JSON.stringify({floors:[{floor:0,summary:'<user>开始吃东西。',segments:[{events:[{text:'<user>吃饭。',evidence:'错误的引用'}]}]},{floor:1,summary:'角色把碗递了过来。',segments:[{events:[{text:'角色递碗。',evidence:'他把碗递过来'}]}]}],obsolete:[],keep_ids:[]});};
const {getPairs}=await import('../src/ids.js');const {handleConfirmedExtractJob}=await import('../src/extract.js');
await handleConfirmedExtractJob({floorKey:getPairs()[0].floorKey,pairIndex:0,retryNote:'TEST_RETRY_REASON'});
assert.equal(calls,1);assert.equal(live.narrative_summaries.length,2);assert.equal(live.narrative_summaries[0].segments[0].events[0].evidence,'我吃');
console.log('Unified manual retry: prior failure appears once, short event is retained, both floors saved in one model call');
