import assert from 'node:assert/strict';
import { loadBackstageWorldInfo } from '../src/backstage-world-info.js';
import { buildBackstageDiscussionRequest } from '../src/backstage.js';

const longContent = 'LONG_LORE_'.repeat(5000);
const entries = [
    { world: 'global', uid: 1, constant: true, content: 'BLUE_CONTENT' },
    { world: 'character', uid: 1, constant: false, key: ['UNMATCHED_KEYWORD'], probability: 0, content: 'GREEN_CONTENT' },
    { world: 'chat', uid: 1, disable: true, content: 'DISABLED_CONTENT' },
    { world: 'persona', uid: 1, content: 'PERSONA_CONTENT' },
    { world: 'character', uid: 1, content: 'DUPLICATE_CONTENT' },
    { world: 'character-extra', uid: 2, content: longContent },
];
const before = structuredClone(entries);
const worldInfo = await loadBackstageWorldInfo({ loadEntries: async () => entries });
assert.equal(worldInfo, ['BLUE_CONTENT', 'GREEN_CONTENT', 'PERSONA_CONTENT', longContent].join('\n\n'));
assert.deepEqual(entries, before, 'Reading backstage lore must not modify story activation settings');
const request = buildBackstageDiscussionRequest({ working: { messages: [{ role: 'user', text: 'DISCUSS_LORE' }] } }, {
    l2: 'PLUGIN_SUMMARY', raw: 'PLUGIN_RECENT_BODY', worldInfo,
});
assert.ok(request.systemPrompt.includes(worldInfo), 'All enabled content must be passed without truncation');
assert.match(request.systemPrompt, /PLUGIN_SUMMARY[\s\S]*PLUGIN_RECENT_BODY/u);
assert.doesNotMatch(request.systemPrompt, /DISABLED_CONTENT|UNMATCHED_KEYWORD|DUPLICATE_CONTENT/u);
assert.equal(await loadBackstageWorldInfo({ loadEntries: async () => [] }), '');
await assert.rejects(loadBackstageWorldInfo({ loadEntries: async () => { throw new Error('READ_FAILED'); } }), /READ_FAILED/u);
console.log('backstage world info smoke: enabled blue/green lore, no activation gates or truncation, disabled exclusion, and unchanged story settings passed');
