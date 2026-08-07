import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const textarea = { value: '', dispatchEvent() {} };
globalThis.document = {
    body: { dataset: {} },
    querySelector(selector) {
        return selector === '#send_textarea' ? textarea : null;
    },
};

let releaseMetadataSave;
const metadataSaveGate = new Promise(resolve => { releaseMetadataSave = resolve; });
let metadataSaveCalls = 0;
let generateRawCalls = 0;
let rawRequest = null;
let resolveNarrator;
const narratorGate = new Promise(resolve => { resolveNarrator = resolve; });
let stopCalls = 0;

const context = {
    chat: [
        { is_user: true, mes: 'RAW_STORY_PLAYER', send_date: 'u0', extra: { layered_memory_id: 'u0' } },
        { is_user: false, mes: 'RAW_STORY_NARRATOR', send_date: 'a0', extra: { layered_memory_id: 'a0' } },
    ],
    chatMetadata: {},
    extensionSettings: {
        layered_memory: { enabled: true, bodyExtractionRegex: '', recentRawTokens: 8000 },
        unrelatedPresetFingerprint: 'PRESET_MUST_NOT_APPEAR',
        unrelatedCharacterFingerprint: 'CHARACTER_CARD_MUST_NOT_APPEAR',
        unrelatedWorldInfoFingerprint: 'WORLD_INFO_MUST_NOT_APPEAR',
    },
    saveMetadata: async () => {
        metadataSaveCalls += 1;
        await metadataSaveGate;
    },
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    name2: '可靠性测试叙述者',
    async generateRaw(options) {
        generateRawCalls += 1;
        rawRequest = structuredClone(options);
        return narratorGate;
    },
    stopGeneration() {
        stopCalls += 1;
    },
};
globalThis.SillyTavern = { getContext: () => context };

const runtime = await import('../src/backstage-runtime.js');
const { buildBackstageDiscussionRequest } = await import('../src/backstage.js');

const isolatedRequest = buildBackstageDiscussionRequest({
    working: {
        messages: [
            { role: 'user', text: 'BACKSTAGE_PLAYER_MESSAGE' },
            { role: 'narrator', text: 'BACKSTAGE_NARRATOR_MESSAGE' },
        ],
        rejectedDraft: '',
    },
}, {
    l2: 'L2_PLOT_SUMMARY',
    raw: 'RAW_RECENT_STORY',
});
const isolatedPayload = JSON.stringify(isolatedRequest);
assert.match(isolatedPayload, /L2_PLOT_SUMMARY/);
assert.match(isolatedPayload, /RAW_RECENT_STORY/);
assert.match(isolatedPayload, /BACKSTAGE_PLAYER_MESSAGE/);
assert.match(isolatedPayload, /BACKSTAGE_NARRATOR_MESSAGE/);
assert.deepEqual(isolatedRequest.prompt.map(message => message.role), ['user', 'assistant']);
assert.deepEqual(Object.keys(isolatedRequest).sort(), [
    'prompt',
    'quietToLoud',
    'responseLength',
    'systemPrompt',
    'trimNames',
]);

const opened = runtime.beginBackstageSession();
assert.equal(opened instanceof Promise, false,
    '打开幕间必须同步建立会话，不能等待 saveMetadata');
assert.ok(runtime.getBackstageSnapshot().session?.working,
    '即使元数据保存尚未返回，窗口也应已有可渲染会话');

const requests = Array.from({ length: 10 }, () => (
    runtime.submitBackstageUserMessage('只应该发送一次')
));
assert.ok(requests.every(request => request === requests[0]),
    '连点必须复用同一个活动请求');
assert.equal(runtime.getBackstageSnapshot().session.working.messages.length, 1,
    '连点十次也只能同步追加一条玩家消息');

await Promise.resolve();
assert.equal(generateRawCalls, 1, '连点十次只能调用一次模型');
await Promise.resolve();
assert.equal(metadataSaveCalls, 1, '阻塞的元数据保存不能阻止模型请求立即开始');
assert.equal(rawRequest.responseLength, 768);
assert.deepEqual(rawRequest.prompt.map(message => message.role), ['user']);
const payload = JSON.stringify(rawRequest);
assert.match(payload, /RAW_STORY_PLAYER[\s\S]*RAW_STORY_NARRATOR/u,
    '幕间请求必须带插件最近正文');
assert.doesNotMatch(payload, /PRESET_MUST_NOT_APPEAR|CHARACTER_CARD_MUST_NOT_APPEAR|WORLD_INFO_MUST_NOT_APPEAR/u,
    '幕间请求不得继承预设、角色卡或世界书内容');

runtime.saveBackstageComposerDraft('也要一起清掉的输入草稿');
context.chatMetadata.layered_memory.backstage.sessions[0].working.rejectedDraft = '也要清掉的未采用正文';
assert.equal(runtime.clearBackstageSession(), true);
let snapshot = runtime.getBackstageSnapshot();
assert.equal(snapshot.discussionInFlight, false);
assert.deepEqual(snapshot.session.working.messages, []);
assert.equal(snapshot.session.working.composerDraft, '');
assert.equal(snapshot.session.working.rejectedDraft, '');
assert.equal(stopCalls, 1, '清空必须停止仍在运行的幕间请求');

runtime.beginBackstageSession();
snapshot = runtime.getBackstageSnapshot();
assert.deepEqual(snapshot.session.working.messages, [], '清空后关闭再打开仍应为空');

resolveNarrator('这是已经迟到、绝不能复活的旧回复');
await Promise.all(requests);
snapshot = runtime.getBackstageSnapshot();
assert.deepEqual(snapshot.session.working.messages, [], '迟到回复不得在清空后重新写回');

releaseMetadataSave();
await Promise.resolve();

const runtimeSource = await readFile(new URL('../src/backstage-runtime.js', import.meta.url), 'utf8');
assert.doesNotMatch(runtimeSource, /generateQuietPrompt/u,
    '幕间讨论不得再走会拼装完整正文上下文的 quiet 生成');
assert.match(runtimeSource, /buildCoreMemoryParts\(\{ data, context \}\)/u);
assert.match(runtimeSource, /generateRaw\(generation\)/u);

console.log('backstage reliability smoke: immediate open, exact-once send, plot-only raw request, clear, and stale-result isolation passed');
