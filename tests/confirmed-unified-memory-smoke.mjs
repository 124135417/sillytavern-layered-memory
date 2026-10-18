import assert from 'node:assert/strict';
import { EMPTY_CHAT_DATA } from '../src/constants.js';
const msg=(id,is_user,mes)=>({is_user,mes,extra:{layered_memory_id:id}});
const data=EMPTY_CHAT_DATA();data.progress.baseline_pair=-1;data.job_queue.paused=true;
const context={chat:[msg('u0',true,'先坐一会。'),msg('a0',false,'角色在办公室递来温水。')],chatMetadata:{layered_memory:data},extensionSettings:{layered_memory:{enabled:true,memoryModelSource:'current',chapterSize:1000,proofreadEvery:1000}},saveMetadata:async()=>{},saveChat:async()=>{},saveSettingsDebounced(){},name1:'玩家'};
globalThis.SillyTavern={getContext:()=>context,libs:{}};
const {getPairs}=await import('../src/ids.js');
const {rebuildAndEnqueuePending,getQueueSnapshot,registerHandler,setQueuePaused}=await import('../src/queue.js');
const {handleConfirmedExtractJob}=await import('../src/extract.js');
const {handleNarrativeSummaryJob,currentNarrativeSources,reconcileNarrativeSummaries}=await import('../src/narrative.js');
const {captureBranchCheckpoint,replayBranchData}=await import('../src/branch.js');
const fact={id:'e_0001',slot:'possession',topic:'旧桌角温水',subject:'玩家',value:'办公室桌角放着温水',evidence:'递来温水',source:'auto',updated_floor:0,established_floor:0};data.state_table.entries=[fact];data.progress.next_entry_seq=2;captureBranchCheckpoint(data,'fixture');
registerHandler('extract',handleConfirmedExtractJob);registerHandler('narrative_summary',handleNarrativeSummaryJob);
let calls=0,release;context.generateRaw=async({prompt,systemPrompt})=>{calls++;assert(systemPrompt.includes('{subject,object,topic,value,evidence}'),'combined prompt must spell out all fact fields');assert(prompt.includes('e_0001'),'full facts must be provided');assert(!systemPrompt.includes('最后写一条 80–200'),'do not request the legacy summary');return new Promise(resolve=>{release=()=>resolve(JSON.stringify({floors:[{floor:0,summary:'<user>希望先坐一会。',segments:[{time_change:null,events:[{text:'<user>希望先坐一会。',evidence:'先坐一会。'}]}]},{floor:1,summary:'角色递来温水并说明自己是图书管理员。',segments:[{time_change:null,events:[{text:'角色说明自己是图书管理员。',evidence:'我是图书管理员'}]}]}],identity:[{topic:'职业',subject:'角色',value:'是图书管理员',evidence:'我是图书管理员'}],obsolete:[{entry_id:'e_0001',category:'scene_local',reason:'旧办公室现场的递水动作已无持续作用',evidence:''}]}))})};
for(let i=0;i<11;i++){context.chat[1].mes=`候选${i}：我们已离开办公室。角色说：“我是图书管理员。”`;await rebuildAndEnqueuePending({forceLastSealed:true});assert.equal(getQueueSnapshot().queued.length,0,'completed output, swipe and reopen must not process an unconfirmed pair')}
assert.equal(calls,0);assert.equal(data.narrative_summaries.length,0);
const oldNarrativePayload=()=>({messageKeys:currentNarrativeSources().map(s=>s.messageKey),fingerprints:currentNarrativeSources().map(s=>s.contentFingerprint)});
await handleNarrativeSummaryJob(oldNarrativePayload());assert.equal(calls,0,'persisted legacy jobs must not process an unconfirmed reply');
context.chat.push(msg('u1',true,'好，那回家。'));await rebuildAndEnqueuePending();
assert.equal(getQueueSnapshot().queued.filter(j=>j.type==='extract').length,1);
assert.equal(getQueueSnapshot().queued.filter(j=>j.type==='narrative_summary').length,0,'the same floors must never be queued for a separate narrative call');
await handleNarrativeSummaryJob(oldNarrativePayload());assert.equal(calls,0,'old standalone jobs must yield the confirmed pair to its unified job');
await setQueuePaused(false);for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.equal(calls,1);
// The next main reply may stream while its predecessor is being summarized.
context.chat.push(msg('a1',false,'这是尚未确认的新回复。'));release();
for(let i=0;i<100&&getQueueSnapshot().running.length;i++)await new Promise(r=>setTimeout(r,5));
assert.equal(data.narrative_summaries.length,2);assert.equal(data.retired_facts.length,1);assert(data.state_table.entries.some(e=>e.value==='是图书管理员'));
assert.equal(data.turn_summaries.length,1,'derive legacy compatibility data from the same response');
assert.equal(data.turn_summaries[0].summary,data.narrative_summaries.map(x=>x.summary).join(' '));
await rebuildAndEnqueuePending({forceLastSealed:true});assert.equal(calls,1,'reply finish and reopening must not process the newest candidate');
assert.equal(getQueueSnapshot().queued.length,0);assert.equal(data.extracted_keys.length,1);
const parent=structuredClone(data),pair=getPairs()[0];
let branch=replayBranchData(parent,[],'fork');assert(!branch.state_table.entries.some(e=>e.value==='是图书管理员'),'fork before the processed turn must not inherit its fact changes');
// Already-confirmed old turns can be edited; a changed source version must not reuse their records.
context.chat[1].mes='换一个没有身份披露的候选。';branch=replayBranchData(parent,getPairs(),'swipe');assert(!branch.state_table.entries.some(e=>e.value==='是图书管理员'));
reconcileNarrativeSummaries(branch,currentNarrativeSources());assert(!branch.narrative_summaries.some(x=>x.messageKey===pair.aiKey));
// A malformed paid reply fails visibly, without a second model call or queue retry.
const invalidData=EMPTY_CHAT_DATA();invalidData.progress.baseline_pair=-1;context.chatMetadata.layered_memory=invalidData;
let invalidCalls=0;context.generateRaw=async()=>{invalidCalls++;return '{"obsolete":['};
await assert.rejects(handleConfirmedExtractJob({floorKey:getPairs()[0].floorKey,pairIndex:0}),error=>error.status===422);
assert.equal(invalidCalls,1);
assert.equal((await import('../src/queue.js')).isRetryableError({status:422}),false);
console.log('Confirmed unified memory: 11 candidates cost zero, next user confirms one call for summaries/facts/obsolete, no duplicate queue, reopen exclusion, compatibility and fork/swipe passed');
