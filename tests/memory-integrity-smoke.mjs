import assert from 'node:assert/strict';
import { EMPTY_CHAT_DATA } from '../src/constants.js';
import { normalizeExtractOutput } from '../src/validate.js';
import { mergeExtractResult } from '../src/merge.js';
import { snapshotObsoleteTargets } from '../src/obsolete.js';
import { getChatData } from '../src/settings.js';
import { getPairs } from '../src/ids.js';
import { handleConfirmedExtractJob } from '../src/extract.js';
import { renderNarrativeBody } from '../src/narrative-text.js';
import { summarizeChapterNotes } from '../src/archive.js';
import { captureBranchCheckpoint, replayBranchData } from '../src/branch.js';
import { memoryConflictGuard } from '../src/memory-conflicts.js';

let data;
const context = { chat: [], get chatMetadata() { return { layered_memory: data }; },
    extensionSettings: { layered_memory: { memoryModelSource: 'current', chapterSize: 1000, proofreadEvery: 1000 } },
    saveMetadata: async () => {}, saveChat: async () => {}, saveSettingsDebounced() {}, name1: '乙' };
globalThis.SillyTavern = { getContext: () => context };
const source = '甲说：“今晚是你第一次在我家过夜。”';
const quote = '今晚是你第一次在我家过夜';
const fact = (id, topic, value) => ({ id, slot: 'other', topic, subject: '甲', object: '乙', value, evidence: value, source: 'auto', established_floor: 0, updated_floor: 0 });
function seed() {
    data = EMPTY_CHAT_DATA(); data.progress.baseline_pair = -1; data.job_queue.paused = true;
    context.chat = [
        { is_user: true, mes: '我们共同生活三个月了。', extra: { layered_memory_id: 'u0' } },
        { is_user: false, mes: '甲乙已经共同生活三个月。', extra: { layered_memory_id: 'a0' } },
        { is_user: true, mes: '继续', extra: { layered_memory_id: 'u1' } },
        { is_user: false, mes: source, extra: { layered_memory_id: 'a1' } },
        { is_user: true, mes: '继续说。', extra: { layered_memory_id: 'u2' } },
    ];
    data.state_table.entries = [fact('e_home', '共同生活安排', '甲乙已经共同生活三个月'), fact('e_temp', '旧递送', '旧桌角的一杯水')];
    data.progress.next_entry_seq = 3;
    data.npc_drives = [{ id: 'npc:甲', character: '甲', drive: '维持共同生活', progress: '已经共同生活三个月', evidence: '已经共同生活三个月', source: 'auto' }];
    getChatData();
    const fullChat = context.chat;
    context.chat = fullChat.slice(0, 2);
    captureBranchCheckpoint(data, 'fixture');
    context.chat = fullChat;
}
function ctx() {
    const pair = getPairs()[1];
    return { pipeline: 'per_floor', floorKey: pair.floorKey, contentFingerprint: pair.contentFingerprint, pairIndex: pair.pairIndex,
        sourceText: '继续\n' + source, stateTable: data.state_table, obsoleteTargets: snapshotObsoleteTargets(data.state_table),
        npcDriveTargets: Object.fromEntries(data.npc_drives.map(row => [row.id, structuredClone(row)])), persist: false };
}
const retire = entry_id => ({ entry_id, reason: '已经结束，无需常驻', category: 'completed' });
seed();
const shortQuote = memoryConflictGuard([{ entry_id: 'e_home', evidence: '甲', note: '指向已有状态' }], { entries: data.state_table.entries, sourceText: source });
assert(shortQuote.ids.has('e_home'));
assert(!shortQuote.blocksEvidence('甲拿走钥匙'), 'a generic short quote cannot block unrelated facts');
await mergeExtractResult(normalizeExtractOutput({ keep_ids: ['e_home'], obsolete: [retire('e_home'), retire('e_temp')] }), ctx());
assert(data.state_table.entries.some(x => x.id === 'e_home'), 'keep wins over contradictory obsolete');
assert.equal(data.retired_facts.length, 1, 'unrelated valid cleanup must proceed');
assert.equal(data.retired_facts[0].entry_id, 'e_temp');

const conflicting = {
    conflicts: [{ entry_id: 'e_home', note: '已有共同生活经历，本楼无搬离或失忆过程', evidence: quote }],
    other: [{ subject: '甲', object: '乙', topic: '共同生活安排', value: '今晚才首次留宿', evidence: quote },
        { subject: '甲', object: '乙', topic: '换个名称也不能绕过', value: '首次留宿', evidence: quote }],
    obsolete: [retire('e_home')],
    npc_drives: [{ character: '甲', drive: '维持共同生活', progress: '今晚首次留宿', evidence: quote }],
};
seed();
const oldDrive = structuredClone(data.npc_drives);
let result = await mergeExtractResult(normalizeExtractOutput(conflicting), ctx());
assert.equal(result.applied, 0);
assert.equal(result.guarded, 2);
assert.equal(data.state_table.entries.find(x => x.id === 'e_home').value, '甲乙已经共同生活三个月');
assert.deepEqual(data.npc_drives, oldDrive, 'flagged evidence must not contaminate NPC progress');
assert.equal(data.retired_facts.length, 0);
assert.equal(data.review_queue.length, 1);

seed();
result = await mergeExtractResult(normalizeExtractOutput({ conflicts: [{ entry_id: 'npc:甲', note: '进展与已有共同生活经历矛盾', evidence: quote }], npc_drives: conflicting.npc_drives }), ctx());
assert.equal(result.conflicts, 1);
assert.deepEqual(data.npc_drives, oldDrive, 'drive-only conflicts must also block progress updates');

seed();
const changed = { ...ctx(), sourceText: '甲乙明确决定分开居住，并搬回各自住处。' };
await mergeExtractResult(normalizeExtractOutput({ other: [{ topic: '共同生活安排', subject: '甲', object: '乙', old_value: '甲乙已经共同生活三个月', value: '甲乙已经分开居住', evidence: '搬回各自住处' }] }), changed);
assert.equal(data.state_table.entries.find(x => x.id === 'e_home').value, '甲乙已经分开居住', 'real state changes must still work');

seed(); let calls = 0;
context.generateRaw = async () => { calls += 1; return JSON.stringify({ ...conflicting, keep_ids: ['e_home', 'e_temp'], floors: [
    { floor: 2, summary: '<user>请求继续当前剧情。', segments: [] },
    { floor: 3, summary: '甲将共同生活说成首次留宿，存在矛盾。', segments: [{ time_change: null, events: [{ text: '甲把乙当成首次留宿。', evidence: quote }] }] },
] }); };
await handleConfirmedExtractJob({ floorKey: getPairs()[1].floorKey, pairIndex: 1, ignoreBaseline: true });
assert.equal(calls, 1, 'conflicts must never trigger a second paid request');
const record = data.narrative_summaries.find(x => x.messageIndex === 3);
assert.equal(record.injection_format, 'events-v1');
assert.equal(record.memory_conflicts[0].entry_id, 'e_home');
assert.match(renderNarrativeBody(record), /未确认矛盾/);
assert.equal(data.state_table.entries.find(x => x.id === 'e_home').value, '甲乙已经共同生活三个月');

const parent = structuredClone(data);
const earlier = replayBranchData(parent, getPairs().slice(0, 1), 'fixture');
assert(!earlier.narrative_summaries.some(x => x.messageIndex === 3), 'fork before the conflicting floor must remove its narrative warning');
assert.equal(earlier.state_table.entries.find(x => x.id === 'e_home').value, '甲乙已经共同生活三个月');
context.chat[3].swipes = [source, '甲倒了一杯茶，没有谈及共同生活。'];
context.chat[3].swipe_id = 1;
const alternate = replayBranchData(parent, getPairs(), 'fixture');
assert(!alternate.narrative_summaries.some(x => x.messageIndex === 3), 'a different swipe must not inherit the prior candidate warning');
context.chat[3].swipe_id = 0;

const events = [{ time_change: { label: '次日' }, events: [{ text: '乙拿走蓝色钥匙。', evidence: '蓝色钥匙' }] }];
assert.equal((renderNarrativeBody({ summary: '乙拿走蓝色钥匙。', segments: events }).match(/乙拿走蓝色钥匙/g) || []).length, 1, 'literal duplication in legacy records is removed');
assert.match(renderNarrativeBody({ summary: '另有红色封条尚未拆开。', segments: events }), /红色封条/, 'unique legacy summary details must survive');
assert.doesNotMatch(renderNarrativeBody({ summary: '只供浏览的索引', segments: events, injection_format: 'events-v1' }), /只供浏览/);
assert.match(renderNarrativeBody({ summary: '人工改写为未拿钥匙。', segments: events, injection_format: 'events-v1', manual_override: true }), /未拿钥匙/);
assert.doesNotMatch(renderNarrativeBody({ summary: '人工改写为未拿钥匙。', segments: events, injection_format: 'events-v1', manual_override: true }), /乙拿走/);

let chapterCalls = 0, chapterInput = '';
context.generateRaw = async ({ prompt }) => { chapterCalls++; chapterInput = prompt; return JSON.stringify({ summary: '完整的章节回顾。'.repeat(35), key_events: [{ floor_range: [3, 4], text: '记录两楼事件。' }], coverage: [{ floor: 3, event_index: 0 }, { floor: 4, event_index: 0 }], keywords: ['甲', '乙', '钥匙'] }); };
await summarizeChapterNotes([{ ...record, pairIndex: 3 }, { pairIndex: 4, summary: '界面索引不包含钥匙细节', segments: events, injection_format: 'events-v1' }], 3, 4, () => {}, { unit: 'floor' });
assert.equal(chapterCalls, 1);
assert.match(chapterInput, /蓝色钥匙/);
assert.match(chapterInput, /未确认矛盾/);
assert.doesNotMatch(chapterInput, /界面索引不包含/);
console.log('memory-integrity: retirement conflict, guarded fact/drive writes, real changes, one-call annotation, lossless legacy dedup, new event input, manual edits and chapter handoff passed');
