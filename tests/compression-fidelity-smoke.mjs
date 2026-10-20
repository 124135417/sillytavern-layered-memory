import assert from 'node:assert/strict';
import { EMPTY_CHAT_DATA } from '../src/constants.js';
import { handleVolumeCompressJob } from '../src/volume.js';

const data = EMPTY_CHAT_DATA();
data.narrative_chapters = Array.from({ length: 8 }, (_, i) => ({
    id: `nch_${i + 1}`, floor_range: [i * 25, i * 25 + 24],
    summary: `第${i + 1}章的独立剧情结果。`, keywords: [], demoted: false, pinned: false,
}));
data.state_table.entries = [{ id: 'e_0001', slot: 'identity', topic: '公开职位', subject: '甲', object: '', value: '调查员', evidence: '甲是调查员', source: 'auto' }];
const requests = [];
const summary = '甲乙持续共同生活三个月，后来明确分居，现为分别居住；两人的保密约定仍有效。';
globalThis.SillyTavern = { getContext: () => ({
    chat: [], chatMetadata: { layered_memory: data },
    extensionSettings: { layered_memory: { memoryModelSource: 'current', volumeCompressConfirm: false } },
    generateRaw: async ({ systemPrompt, prompt }) => {
        requests.push({ systemPrompt, prompt });
        const ids = [...prompt.matchAll(/^### (\S+)/gm)].map(match => match[1]);
        return JSON.stringify({ summary, covered_chapter_ids: ids });
    },
    saveMetadata: async () => {}, saveSettingsDebounced() {},
}) };
const { getChatData } = await import('../src/settings.js');
getChatData();
assert.equal(data.state_table.entries.length, 1);
const factsBefore = JSON.stringify(data.state_table);

await handleVolumeCompressJob({ force: true, narrative: true });
assert.equal(requests.length, 1, 'normal compression must remain one model call');
assert.equal(data.narrative_volumes.length, 1);
const volume = data.narrative_volumes[0];
assert.equal(volume.summary, summary);
assert.equal(volume.chapter_ids.length, 6, 'the existing compression grouping must not change');
assert.equal(data.narrative_chapters.filter(c => !c.demoted).length, 2);
assert.equal(JSON.stringify(data.state_table), factsBefore, 'compression must never edit facts');

volume.stale = true;
await handleVolumeCompressJob({ force: true, narrative: true, staleVolumes: [volume.id] });
assert.equal(requests.length, 2, 'explicit regeneration must remain one additional call');
assert.equal(data.narrative_volumes.length, 1, 'regeneration must replace in place');
assert.equal(volume.stale, false);
assert.equal(JSON.stringify(data.state_table), factsBefore);
assert.equal(requests[0].prompt, requests[1].prompt, 'both paths must send identical source chapters and compression instructions');
assert.ok(requests[0].prompt.lastIndexOf('上限900字') > requests[0].prompt.lastIndexOf('### nch_6'),
    'the compression requirement must follow the source material in the actual outgoing request');
console.log('compression-fidelity-smoke: normal and regeneration paths, one call each, facts unchanged');
