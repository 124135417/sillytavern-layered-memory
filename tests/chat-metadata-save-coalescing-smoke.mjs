import assert from 'node:assert/strict';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const chats = {
    first: {},
    second: {},
};
let active = 'first';
const saveGates = [];
let saveCalls = 0;
const context = {
    extensionSettings: {},
    get chatMetadata() { return chats[active]; },
    saveMetadata: async () => {
        saveCalls += 1;
        const gate = deferred();
        saveGates.push(gate);
        await gate.promise;
    },
};
globalThis.SillyTavern = { getContext: () => context };

const { getChatData, saveChatData } = await import('../src/settings.js');
const firstData = getChatData();

const firstSave = saveChatData(firstData);
const duplicateSave = saveChatData(firstData);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(saveCalls, 1, 'same-tick saves for one chat must share one metadata upload');

const trailingSave = saveChatData(firstData);
const trailingDuplicate = saveChatData(firstData);
saveGates[0].resolve();
await firstSave;
await duplicateSave;
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(saveCalls, 2, 'changes arriving during an upload must create one trailing upload');
saveGates[1].resolve();
await Promise.all([trailingSave, trailingDuplicate]);
assert.equal(saveCalls, 2, 'the trailing batch must still be coalesced');

const staleSave = saveChatData(firstData);
active = 'second';
const secondData = getChatData();
const currentSave = saveChatData(secondData);
await assert.rejects(staleSave, error => error?.code === 'CHAT_SCOPE_CHANGED',
    'a queued save must never persist metadata into a newly opened chat');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(saveCalls, 3, 'the new active chat must still be persisted after rejecting the stale batch');
saveGates[2].resolve();
await currentSave;

console.log('chat metadata save coalescing smoke: duplicate saves merge, trailing state persists, chat scopes stay isolated');
