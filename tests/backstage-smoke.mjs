import assert from 'node:assert/strict';

const textarea = {
    value: '',
    dispatchEvent() {},
};
globalThis.document = {
    querySelector(selector) {
        return selector === '#send_textarea' ? textarea : null;
    },
};

const chat = [
    { is_user: true, mes: '我推开宗门的山门。', send_date: 'u0', extra: { layered_memory_id: 'u0' } },
    { is_user: false, mes: '山道安静得有些反常。', send_date: 'a0', extra: { layered_memory_id: 'a0' } },
];
let rawRequest = null;
let generatedCount = 0;
let failNextSwipe = false;
let runtime;

const context = {
    chat,
    chatMetadata: {},
    extensionSettings: { layered_memory: { enabled: true, bodyExtractionRegex: '' } },
    saveMetadata: async () => {},
    saveChat: async () => {},
    saveSettingsDebounced: () => {},
    name2: '玄微叙述者',
    eventSource: { emit: async () => {} },
    event_types: { MESSAGE_EDITED: 'message_edited' },
    async generateRaw(options) {
        rawRequest = structuredClone(options);
        return generatedCount === 0
            ? '可以。下一段我会让一群来历不明的人闯入，但先不给出幕后主使。'
            : '明白。闯入者会先用言语施压，不会一上来就替你决定是否动手。';
    },
    async generate(type) {
        assert.ok(['normal', 'swipe'].includes(type), `unexpected generation type: ${type}`);
        if (type === 'normal') {
            const marker = { is_user: true, mes: textarea.value, send_date: 'u1', extra: {} };
            chat.push(marker);
            await runtime.handleBackstageMessageSent(chat.length - 1);
            const output = { is_user: false, mes: '三名陌生修士越过山门，厉声索要掌门现身。', send_date: 'a1', extra: {} };
            chat.push(output);
            await runtime.handleBackstageMessageReceived(chat.length - 1, 'normal');
            output.swipe_id = 0;
            output.swipes = [output.mes];
            output.swipe_info = [{ extra: structuredClone(output.extra) }];
            generatedCount += 1;
            return output.mes;
        }

        const output = chat.at(-1);
        if (failNextSwipe) {
            failNextSwipe = false;
            throw new Error('provider unavailable');
        }
        const nextText = '三名陌生修士在山门外列成一线，为首者只冷声要求面见掌门。';
        output.mes = nextText;
        output.swipes.push(nextText);
        await runtime.handleBackstageMessageReceived(chat.length - 1, 'swipe');
        output.swipe_info[output.swipe_id] = { extra: structuredClone(output.extra) };
        generatedCount += 1;
        return nextText;
    },
    stopGeneration() {},
};
globalThis.SillyTavern = { getContext: () => context };

runtime = await import('../src/backstage-runtime.js');
const {
    BACKSTAGE_MARKER_EXTRA,
    BACKSTAGE_OUTPUT_EXTRA,
    formatBackstagePlayerInput,
} = await import('../src/backstage.js');
const { getPairTexts, getPairs } = await import('../src/ids.js');
const { currentNarrativeSources, fallbackNarrativeSummary } = await import('../src/narrative.js');
const { renderRecentRawBlock } = await import('../src/recent-raw.js');

await runtime.beginBackstageSession();
await runtime.appendBackstageUserMessage('这段太平了。可以来点人闯入宗门找麻烦，但暂时别揭晓幕后主使吗？');
await runtime.requestBackstageNarratorReply();
assert.match(rawRequest.systemPrompt, /同一个叙述者/u);
assert.match(rawRequest.systemPrompt, /最近完整正文/u);
assert.match(JSON.stringify(rawRequest.prompt), /来点人闯入宗门找麻烦/u);
assert.match(rawRequest.systemPrompt, /只回复玩家能看到的自然纯文本对话。不要输出 JSON/u,
    '幕间应要求自然对话而不是结构化选项');
assert.match(rawRequest.systemPrompt, /不要使用 Markdown 标题、列表、粗体、引用、行内代码或代码块/u,
    '模型提示词应主动要求纯文本，Markdown 渲染只作为显示兜底');
assert.equal(rawRequest.responseLength, 768, '幕间回复必须使用独立短输出上限');
assert.deepEqual(rawRequest.prompt.map(message => message.role), ['user'],
    '幕间消息必须以真实角色数组发送，而不是拼进完整正文预设');

const fullText = '很长也不能截断：'.repeat(2_000);
assert.match(formatBackstagePlayerInput({ messages: [{ role: 'user', text: fullText }] }), new RegExp(fullText.slice(-80)),
    '幕间全文不得静默截断');

await runtime.continueBackstageToStory();
assert.equal(chat.length, 4, '第一次继续应新增玩家控制楼和叙述者正文楼');
const marker = chat[2];
const firstOutput = chat[3];
assert.match(marker.mes, /幕间交流开始/u);
assert.match(marker.mes, /来点人闯入宗门找麻烦/u);
assert.match(marker.mes, /可以了，继续/u);
assert.equal(marker.extra.display_text, '幕间讨论 · 2 条对话');
assert.equal(marker.extra.isSmallSys, true);
assert.ok(marker.extra[BACKSTAGE_MARKER_EXTRA]?.revisionId);
assert.ok(firstOutput.extra[BACKSTAGE_OUTPUT_EXTRA]?.revisionId);
const persistedFirstSession = context.chatMetadata.layered_memory.backstage.sessions[0];
assert.equal(persistedFirstSession.revisions[0].markerMessageKey, persistedFirstSession.markerMessageKey,
    '修订与控制楼的关联必须真实持久化，不能只存在于临时对象');
assert.equal(runtime.getBackstageSnapshot().session, null, '正文生成完成后不应留下活动幕间');

const backstagePair = getPairs().at(-1);
const pairTexts = getPairTexts(backstagePair);
assert.equal(pairTexts.userText, '', '幕间全文不得作为事实提取证据');
assert.equal(pairTexts.aiText, firstOutput.mes, '幕间之后生成的正文仍应成为剧情事实证据');
const markerSource = currentNarrativeSources().find(source => source.messageIndex === 2);
assert.equal(markerSource.narrativeText, '', '幕间全文不得进入逐楼剧情正文');
assert.equal(markerSource.timeSourceText, '', '幕间全文不得成为剧情时间证据');
assert.match(fallbackNarrativeSummary(markerSource), /不属于剧情事件/u);
const recentRawAfterBackstage = renderRecentRawBlock(currentNarrativeSources());
assert.match(recentRawAfterBackstage, /角色正文原文[\s\S]*幕间控制楼[\s\S]*角色正文原文/u,
    '后续最近原文必须保留正文、幕间、正文的角色边界');
assert.doesNotMatch(recentRawAfterBackstage, /来点人闯入宗门找麻烦/u,
    '幕间全文只能影响紧随其后的一轮，不能长期重复注入');

const firstMeta = structuredClone(firstOutput.extra[BACKSTAGE_OUTPUT_EXTRA]);
assert.equal(runtime.backstageSessionForMessage(2).editable, true,
    '当前最后一段正文之前的幕间控制楼必须提供可编辑入口');
await runtime.beginBackstageSession({ messageIndex: 2 });
let snapshot = runtime.getBackstageSnapshot();
assert.equal(snapshot.session.working.rejectedDraft, firstOutput.mes,
    '从控制楼回到幕间时必须把当前正文作为待重写草稿');
assert.equal(snapshot.session.working.messages.length, 2, '回到幕间必须带回原讨论全文');
await runtime.appendBackstageUserMessage('还是太突然了。让他们先在门外施压，不要直接替我决定开打。');
await runtime.requestBackstageNarratorReply();
await runtime.continueBackstageToStory();

assert.equal(chat.length, 4, '重写必须留在同一个叙述者楼层');
assert.equal(firstOutput.swipe_id, 1);
assert.equal(firstOutput.swipes.length, 2, '重写必须创建新的原生 swipe 候选');
assert.equal(firstOutput.swipe_info[0].extra[BACKSTAGE_OUTPUT_EXTRA].revisionId, firstMeta.revisionId,
    '旧候选必须保留自己的幕间版本');
assert.notEqual(firstOutput.swipe_info[1].extra[BACKSTAGE_OUTPUT_EXTRA].revisionId, firstMeta.revisionId,
    '新候选必须绑定修订后的幕间版本');
assert.match(marker.mes, /不要直接替我决定开打/u, '玩家输入控制楼应更新为这次完整修订');
assert.match(marker.mes, /未采用的正文草稿/u);
assert.match(marker.mes, /三名陌生修士越过山门/u);

const acceptedRevisionId = firstOutput.extra[BACKSTAGE_OUTPUT_EXTRA].revisionId;
await runtime.beginBackstageSession({ messageIndex: 3 });
await runtime.appendBackstageUserMessage('再收一点，不要让这次修订失败后破坏已经选中的版本。');
await runtime.requestBackstageNarratorReply();
failNextSwipe = true;
await assert.rejects(runtime.continueBackstageToStory(), /provider unavailable/u);
assert.equal(firstOutput.swipe_id, 1, '重写失败必须回到上一条真实候选，不能留下伪 swipe 空槽');
assert.equal(firstOutput.swipes.length, 2);
assert.equal(firstOutput.extra[BACKSTAGE_OUTPUT_EXTRA].revisionId, acceptedRevisionId,
    '重写失败必须恢复上一候选自己的幕间关联');
assert.ok(runtime.getBackstageSnapshot().session?.working, '失败后讨论与输入必须留在幕间供重试');

await runtime.handleBackstageGenerationStarted('swipe');
snapshot = runtime.getBackstageSnapshot();
assert.ok(snapshot.pendingGeneration?.nativeSwipe, '原生继续右滑应继承当前候选的幕间版本');
await runtime.handleBackstageGenerationStopped({ includeDiscussion: false });
assert.equal(runtime.getBackstageSnapshot().pendingGeneration, null);

chat.push({ is_user: true, mes: '剧情已经继续。', send_date: 'u2', extra: { layered_memory_id: 'u2' } });
assert.equal(runtime.backstageSessionForMessage(2).editable, false,
    '控制楼关联的正文不再是最后一条后必须退回只读模式');
assert.throws(() => runtime.beginBackstageSession({ messageIndex: 2 }), /剧情已经继续/u,
    '旧控制楼不得重写已经继续之后的历史');

console.log('backstage smoke: narrator chat, full-input send, non-canon isolation, rewrite swipe, and native swipe passed');
