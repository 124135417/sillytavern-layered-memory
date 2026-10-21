import assert from 'node:assert/strict';
import { EMPTY_CHAT_DATA } from '../src/constants.js';
import { setAuthorNpcDrive, effectiveNpcDrives, snapshotNpcDriveTargets, applyNpcDriveUpdates, npcDriveId, selectNpcDriveRows, renderNpcDriveReview } from '../src/npc-drives.js';
import { selectL1Entries } from '../src/render.js';
const msg=(id,user,mes)=>({is_user:user,mes,extra:{layered_memory_id:id}});
const context={characterId:0,characters:[{avatar:'fixture.png'}],chat:[],chatMetadata:{},extensionSettings:{layered_memory:{enabled:true,memoryModelSource:'current',chapterSize:1000,proofreadEvery:1000}},saveMetadata:async()=>{},saveChat:async()=>{},saveSettingsDebounced(){},name1:'玩家'};
globalThis.SillyTavern={getContext:()=>context,libs:{}};
let open=true;globalThis.SillyTavernSecretSwitches={isOpen:()=>open};
const {getPairs}=await import('../src/ids.js');
const {captureBranchCheckpoint,replayBranchData}=await import('../src/branch.js');
const {handleConfirmedExtractJob}=await import('../src/extract.js');
const settings=context.extensionSettings.layered_memory;
const author=setAuthorNpcDrive(settings,context,{character:'舟',drive:'长期希望得到信任，得到一次认可后仍然珍视并争取亲近。',requires_secrets:['species']});
let data=EMPTY_CHAT_DATA();data.job_queue.paused=true;data.progress.baseline_pair=-1;context.chatMetadata.layered_memory=data;
captureBranchCheckpoint(data,'before_story');data.branch_checkpoints[0].createdAt=1;
assert.equal(effectiveNpcDrives(data,settings,{...context,characterId:1}).length,0,'different card has no author rows');
assert.equal(effectiveNpcDrives(data,settings,context)[0].drive,author.drive);
open=false;assert.equal(selectL1Entries(data,2000,context).text,'','locked authored identity never enters model memory');assert.equal(effectiveNpcDrives(data,settings,context,{includeHidden:true}).length,1);open=true;
context.chat=[msg('u0',true,'我拍拍舟的肩膀。'),msg('a0',false,'舟说：“我一直想获得你的信任。”'),msg('u1',true,'那就慢慢来。')];
const pair=getPairs()[0];let calls=0;
context.generateRaw=async({prompt,systemPrompt})=>{calls++;assert(systemPrompt.includes('npc_drives'));assert(prompt.includes('author_fixed')); return JSON.stringify({obsolete:[],keep_ids:[],floors:[{floor:0,summary:'<user>拍拍舟的肩膀。',segments:[{time_change:null,events:[{text:'<user>拍拍舟的肩膀。',evidence:'我拍拍舟的肩膀。'}]}]},{floor:1,summary:'舟表达希望得到信任。',segments:[{time_change:null,events:[{text:'舟表达持续渴望。',evidence:'我一直想获得你的信任。'}]}]}],npc_drives:[{character:'舟',drive:'不得覆盖作者的方向',progress:'收到拍肩，仍希望建立信任。',evidence:'我拍拍舟的肩膀。'}]})};
await handleConfirmedExtractJob({floorKey:pair.floorKey,pairIndex:0});await handleConfirmedExtractJob({floorKey:pair.floorKey,pairIndex:0});
assert.equal(calls,1,'summaries, facts, obsolete and drives use one call');assert.equal(data.npc_drives.length,1);assert.equal(effectiveNpcDrives(data,settings,context)[0].drive,author.drive);assert.match(effectiveNpcDrives(data,settings,context)[0].progress,/拍肩/);assert.equal(data.floor_events[0].npcDriveChanges.length,1);
const parent=structuredClone(data);context.chat=context.chat.slice(0,2);let fork=replayBranchData(parent,getPairs(),'parent');assert.equal(fork.npc_drives.length,0,'fork at the reply removes its later confirmed progress');assert.equal(effectiveNpcDrives(fork,settings,context)[0].drive,author.drive,'author direction remains even before its creation');assert.equal(effectiveNpcDrives(fork,settings,context)[0].progress,'');
context.chat.push(msg('u1',true,'那就慢慢来。'));fork=replayBranchData(parent,getPairs(),'parent');assert.match(effectiveNpcDrives(fork,settings,context)[0].progress,/拍肩/);
let changes=applyNpcDriveUpdates(fork,[{character:'舟',op:'remove',evidence:'我拍拍舟的肩膀。'}],{floorKey:'x',contentFingerprint:'fp',sourceText:'我拍拍舟的肩膀。',authorDrives:[author],npcDriveTargets:snapshotNpcDriveTargets(fork)});assert.equal(changes.length,0,'automatic deletion cannot remove authored direction');
changes=applyNpcDriveUpdates(fork,[{character:'陌生人',drive:'想统治世界',evidence:'不存在的证据'}],{floorKey:'x',contentFingerprint:'fp',sourceText:'普通闲聊',npcDriveTargets:snapshotNpcDriveTargets(fork)});assert.equal(changes.length,0);
const f={id:'same',slot:'other',subject:'舟',value:'完整重复方向',evidence:'完整重复方向',source:'auto'};data.state_table.entries=[f];author.covered_facts=[{id:f.id,subject:f.subject,value:f.value}];let selected=selectL1Entries(data,2000,context);assert.equal(selected.covered,1);assert.equal(selected.entries.length,0);assert(selected.tokens<=2000);f.value='不同分支复用ID的另一个事实';selected=selectL1Entries(data,2000,context);assert.equal(selected.covered,0);assert(selected.entries.some(x=>x.id===f.id));assert(selected.tokens<=2000);
assert.equal(npcDriveId(' 舟 '),author.id);
console.log('NPC drives: single-call extraction, author protection, exact branch rollback, secret gating, scope isolation, evidence checks, deduplication and unchanged budget passed');

// Admission is stricter than ordinary evidence matching, without an extra call.
const automatic = EMPTY_CHAT_DATA();
const autoCtx = text => ({ floorKey: 'auto-floor', contentFingerprint: 'auto-fp', pairIndex: 0,
    sourceText: text, npcDriveTargets: snapshotNpcDriveTargets(automatic) });
let command = { character: '岚', drive: '想查清来意', progress: '当场追问', evidence: '岚问：“你来做什么？”' };
assert.equal(applyNpcDriveUpdates(automatic, [command], autoCtx(command.evidence)).length, 0,
    'one-off action evidence cannot create a persistent drive');
const pledge = '岚说：“以后无论迁去哪里，我都会继续寻找失散的家人。”';
command = { character: '岚', drive: '寻找失散的家人', progress: '决定持续寻找', evidence: pledge,
    scope: 'enduring', why_persistent: '明确表示换住处后仍会继续寻找。', persistence_evidence: pledge };
assert.equal(applyNpcDriveUpdates(automatic, [{ ...command, persistence_evidence: '不存在的承诺' }], autoCtx(pledge)).length, 0);
assert.equal(applyNpcDriveUpdates(automatic, [command], autoCtx(pledge)).length, 1,
    'an explicit durable commitment can be established immediately');
const found = '岚说：“已经查明是认错人，没必要再追查。”';
assert.equal(applyNpcDriveUpdates(automatic, [{character:'岚',drive:'改为报复路人',evidence:found}], autoCtx(found)).length, 0,
    'rewriting a core goal also requires durable evidence');
assert.equal(applyNpcDriveUpdates(automatic, [{character:'岚',progress:'收到了地址',evidence:'岚收到地址。'}], autoCtx('岚收到地址。')).length, 1,
    'progress updates do not need to re-establish the goal');
assert.equal(applyNpcDriveUpdates(automatic, [{character:'岚',op:'remove',evidence:found}], autoCtx(found)).length, 1);
assert.equal(automatic.npc_drives.length, 0);

// Old branches retain their records for management, but cannot bypass admission.
const legacy = EMPTY_CHAT_DATA();
legacy.npc_drives = [{id:npcDriveId('岚'),character:'岚',source:'auto',drive:'检查门口的人',progress:'还在检查',evidence:'岚看了一眼门口。'}];
const savedLegacy = structuredClone(legacy.npc_drives);
assert(!selectNpcDriveRows(legacy, settings, context, 2000).text.includes('检查门口的人'));
assert(!renderNpcDriveReview(legacy, settings, context).includes('检查门口的人'));
assert.deepEqual(legacy.npc_drives,savedLegacy,'injection must not delete old branch records');
assert(selectNpcDriveRows(legacy, settings, context, 2000).text.includes(author.drive),
    'authored directions do not need automatic admission fields');
let legacyCtx={floorKey:'next',contentFingerprint:'next-fp',sourceText:'岚看了一眼门口。',npcDriveTargets:snapshotNpcDriveTargets(legacy)};
assert.equal(applyNpcDriveUpdates(legacy,[{character:'岚',progress:'继续检查',evidence:'岚看了一眼门口。'}],legacyCtx).length,0,
    'a progress-only refresh cannot grandfather an unqualified inherited goal');
legacyCtx={...legacyCtx,sourceText:pledge,npcDriveTargets:snapshotNpcDriveTargets(legacy)};
assert.equal(applyNpcDriveUpdates(legacy,[command],legacyCtx).length,1,
    'an inherited record can qualify later with real persistence evidence');
assert(selectNpcDriveRows(legacy, settings, context, 2000).text.includes('寻找失散的家人'));
