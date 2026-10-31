import assert from 'node:assert/strict';
import { assertChatData } from '../src/settings.js';

const data = { sentinel: { keep: true } };
const metadata = { layered_memory: data };
const context = { chatMetadata: metadata };
globalThis.SillyTavern = { getContext: () => context };
const before = structuredClone(metadata);
assert.doesNotThrow(() => assertChatData(data));
assert.deepEqual(metadata, before, 'Identity checks must not initialize or migrate stored memory');
context.chatMetadata = {};
assert.throws(() => assertChatData(data), { code: 'CHAT_SCOPE_CHANGED' });
assert.deepEqual(context.chatMetadata, {}, 'An old async callback must not create data in the new chat');
assert.throws(() => assertChatData(undefined), { code: 'CHAT_SCOPE_CHANGED' });
context.chatMetadata = metadata;
assert.throws(() => assertChatData({ ...data }), { code: 'CHAT_SCOPE_CHANGED' });
assert.doesNotThrow(() => assertChatData(data));
console.log('Chat identity guard: preserves data and rejects switched/replaced scopes without reconciliation');
