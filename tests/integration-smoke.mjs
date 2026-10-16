import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const context = {
    chat: [{ is_user: true, mes: 'NON_CANON_TRANSCRIPT', extra: {
        backstage_message_id: 'stable-before-memory',
        layered_memory_backstage_marker: { sessionId: 's1', revisionId: 'r1' },
    } }, { is_user: false, mes: 'STORY', extra: {} }],
    chatMetadata: {}, extensionSettings: { layered_memory: { enabled: true } },
    saveMetadata: async () => {}, saveSettingsDebounced() {},
    setExtensionPrompt() {},
};
globalThis.SillyTavern = { getContext: () => context };
const { registerMemoryIntegration } = await import('../src/integration.js');
const { renderCoreMemoryPayload } = await import('../src/inject.js');
const { ensureMessageIds, getPairs, getPairTexts } = await import('../src/ids.js');
const { currentNarrativeSources } = await import('../src/narrative.js');
const { renderRecentRawBlock } = await import('../src/recent-raw.js');
const api = registerMemoryIntegration();
ensureMessageIds();
assert.equal(context.chat[0].extra.layered_memory_id, 'stable-before-memory');
assert.equal(getPairTexts(getPairs()[0]).userText, '');
const raw = renderRecentRawBlock(currentNarrativeSources());
assert.match(raw, /幕间控制楼/);
assert.doesNotMatch(raw, /NON_CANON_TRANSCRIPT/);
assert.equal(api.version, 1);
await api.ready();
assert.ok(api.getStoryContext().raw.includes('STORY'));
const remove = api.registerContextProvider('test-independent-owner', () => 'EXTERNAL_AUTHOR_NOTE');
assert.equal(renderCoreMemoryPayload().split('EXTERNAL_AUTHOR_NOTE').length - 1, 1);
remove();
assert.doesNotMatch(renderCoreMemoryPayload(), /EXTERNAL_AUTHOR_NOTE/);
context.extensionSettings.layered_memory.enabled = false;
assert.equal(api.isEnabled(), false);
assert.equal(api.getStoryContext(), null);
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.doesNotMatch(index, /backstage-runtime|ui\/backstage|handleBackstage/);
assert.equal(Object.hasOwn(context.chatMetadata.layered_memory, 'backstage'), false);
console.log('memory integration: optional provider, legacy marker isolation, stable IDs, memory-only startup passed');
