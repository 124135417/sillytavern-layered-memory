import assert from 'node:assert/strict';
import { extractAiBody } from '../src/body.js';
const context = { chatCompletionSettings: {
    prompts: [{identifier:'memory', content:'<memory_context_filter assistant_blocks="本轮提纲,meow_FM" />{{layered_memory_context}}'}],
    prompt_order:[{identifier:'memory',enabled:true}],
} };
globalThis.SillyTavern = { getContext: () => context };
const body = '『2024-11-04 20:35』\n他推开门。<msg>到了吗？</msg>';
const extra = '<本轮提纲>尚未发生的安排</本轮提纲>\n'+body+'\n<meow_FM>重复摘要与旧计划</meow_FM>';
for (const pattern of ['', '<content>([\\s\\S]*?)</content>', '[']) {
    const result = extractAiBody(extra, pattern);
    assert.equal(result.text,body);
    assert(!result.text.includes('旧计划'));
}
assert.equal(extractAiBody('<content>'+extra+'</content>', '<content>([\\s\\S]*?)</content>').text.trim(),body);
assert.equal(extractAiBody('<meow_FM>只有附加信息</meow_FM>').text,'', 'Empty cleaned text must not fall back to excluded blocks');
assert(extractAiBody('<本轮提纲>未闭合，可能混着真实正文').text.includes('真实正文'), 'Incomplete boundaries must not erase the story');
context.chatCompletionSettings.prompt_order[0].enabled=false;
assert(extractAiBody(extra).text.includes('旧计划'), 'Other presets retain their original behavior');
delete globalThis.SillyTavern;
assert(extractAiBody(extra).text.includes('旧计划'));
console.log('Assistant-body boundary passed: full/regex/fallback/invalid rules, empty bodies, phone text and opt-in isolation.');

// Actual narrative ingress must retain the separately parsed clock while
// excluding the footer from both the event text and the model prompt.
const { currentNarrativeSources, buildNarrativeBatchPrompt } = await import('../src/narrative.js');
context.chatCompletionSettings.prompt_order[0].enabled=true;
context.extensionSettings={layered_memory:{bodyExtractionRegex:'<content>([\\s\\S]*?)</content>',sceneContextRegex:'<meow_FM>([\\s\\S]*?)</meow_FM>'}};
context.chatMetadata={};
context.chat=[{is_user:true,mes:'<meow_FM>用户自己的标签原文</meow_FM>',extra:{}},
    {is_user:false,mes:body+'\n<meow_FM>\ntime:2024.11.04.星期一☆20:35-20:36\nscene:房门口\nplot:不能作为正文证据的附加摘录\n</meow_FM>',extra:{}}];
globalThis.SillyTavern={getContext:()=>context};
const sources=currentNarrativeSources({includeTrailingUser:true});
assert(sources[0].narrativeText.includes('用户自己的标签原文'));
assert.equal(sources[1].narrativeText,body);
assert(sources[1].sceneContext.raw.includes('20:35-20:36'));
const prompt=buildNarrativeBatchPrompt([sources[1]]);
assert(prompt.includes('到了吗？')&&prompt.includes('20:35-20:36'));
assert(!prompt.includes('不能作为正文证据的附加摘录'));
assert(context.chat[1].mes.includes('不能作为正文证据的附加摘录'),'Original chat must remain unchanged');
delete globalThis.SillyTavern;
