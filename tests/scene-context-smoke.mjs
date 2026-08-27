import assert from 'node:assert/strict';

const {
    attachSceneContexts,
    extractSceneContext,
    sceneContextRange,
} = await import('../src/scene-context.js');
const { buildNarrativeBatchPrompt } = await import('../src/narrative.js');
const { renderDormantRetrievalBlock } = await import('../src/render.js');
const { dormantRelevance } = await import('../src/lifecycle-policy.js');

const pattern = '<meow_FM>([\\s\\S]*?)</meow_FM>';
const assistantText = `<content>他推门走进石室。</content>
<meow_FM>
serial:No.500
time:2025.07.20.星期日☆11:43-11:48
scene:南面旧矿区·落脚点石室
plot:这一段很长而且不应该进入辅助模型
seeds:同样不应该保存
</meow_FM>`;
const extracted = extractSceneContext(assistantText, pattern);
assert.equal(extracted.status, 'matched');
assert.equal(extracted.time, '2025.07.20.星期日☆11:43-11:48');
assert.equal(extracted.location, '南面旧矿区·落脚点石室');
assert.doesNotMatch(extracted.raw, /plot|seeds|很长/u, 'only parsed time and scene may survive extraction');

const sources = attachSceneContexts([{
    role: 'assistant', text: assistantText, narrativeText: '他推门走进石室。',
    messageKey: 'a1', messageIndex: 10, contentFingerprint: 'fp-a1',
}, {
    role: 'user', text: '我看向他。', narrativeText: '我看向他。',
    messageKey: 'u2', messageIndex: 11, contentFingerprint: 'fp-u2',
}, {
    role: 'assistant', text: '<content>他没有回答。</content>', narrativeText: '他没有回答。',
    messageKey: 'a2', messageIndex: 12, contentFingerprint: 'fp-a2',
}, {
    role: 'user', text: '继续。', narrativeText: '继续。',
    messageKey: 'u3', messageIndex: 13, contentFingerprint: 'fp-u3',
}], pattern);
assert.equal(sources[1].sceneContext.status, 'inherited');
assert.equal(sources[1].sceneContext.sourceMessageIndex, 10);
assert.equal(sources[2].sceneContext.status, 'missing');
assert.equal(sources[3].sceneContext.status, 'missing', 'missing assistant status must break inheritance');

const prompt = buildNarrativeBatchPrompt(sources.slice(0, 2));
assert.match(prompt, /剧情正文[\s\S]*他推门走进石室/u);
assert.match(prompt, /time:2025\.07\.20/u);
assert.match(prompt, /scene:南面旧矿区/u);
assert.doesNotMatch(prompt, /这一段很长|seeds/u, 'auxiliary summary input must not receive the rest of the status block');

const range = sceneContextRange(sources.map(source => ({ scene_context: source.sceneContext })));
assert.equal(range.time.label, '2025.07.20.星期日☆11:43-11:48');
assert.equal(range.location.label, '南面旧矿区·落脚点石室');

const dormantData = {
    dormant_facts: [{
        entry: {
            id: 'e_old', slot: 'possession', topic: '恶魔之书', subject: '阿尔德瑞思', object: '',
            value: '仍保管恶魔之书', established_floor: 1, updated_floor: 1,
        },
    }],
};
assert.match(renderDormantRetrievalBlock(dormantData, '阿尔德瑞思重新拿出了恶魔之书。', 500), /仍保管恶魔之书/u);
assert.equal(renderDormantRetrievalBlock(dormantData, '阿尔德瑞思坐下来吃晚饭。', 500), '',
    'mentioning a subject alone must not recall every dormant fact about them');
assert.equal(renderDormantRetrievalBlock(dormantData, '他们讨论晚饭。', 500), '');
assert.equal(dormantRelevance({
    subject: '伯滔', topic: '第三个持有者', value: '伯滔是恶魔之书的第三个持有者',
}, '矿洞第三组本月产量最高。').matched, false,
    'shared fragments such as “第三” must not refresh an unrelated fact');

console.log('scene context smoke: compact extraction, deterministic inheritance, input isolation, ranges, and dormant retrieval passed');
