import assert from 'node:assert/strict';
import { readInjectionFilter, filterInjectedMemory, composeInjectedMemory } from '../src/injection-filter.js';
import { selectRecentRawWindow } from '../src/recent-raw.js';
import { performance } from 'node:perf_hooks';

const context = { chatCompletionSettings: {
    prompts: [{ identifier: 'memory', content: '<memory_context_filter assistant_blocks="本轮提纲,meow_FM" hide_card_label="true" />\n{{layered_memory_context}}' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'memory', enabled: true }] }],
} };
const source = [
    { messageIndex: 5, role: 'user', narrativeText: '“等一下。”\n<本轮提纲>这是用户给的文本</本轮提纲>' },
    { messageIndex: 6, role: 'assistant', narrativeText: '<本轮提纲>旧模式指令</本轮提纲>\n真正的正文与心理、谜团、秘密线索全部保留。\n<meow_FM>附加摘要</meow_FM>' },
    { messageIndex: 7, role: 'assistant', narrativeText: '<本轮提纲>断开的标签不能把后续真实正文删掉。' },
];
const parts = {
    l1: '## 当前对话身份\n- <user>：当前显示名为用户\n- 当前角色卡：可能含剧透的文档标题\n\n既有事实。',
    l2: '原有历史摘要，不能在这里猜测哪些事实需要删除。',
    authorNotes: '既有幕间约定，不在这里凭关键词删改。',
    rawWindow: selectRecentRawWindow(source, 16000),
};
parts.raw = parts.rawWindow.text;
const before = structuredClone(parts);
const originalSources = structuredClone(source);
const filter = readInjectionFilter(context);
assert.deepEqual(filter, { assistantBlocks: ['本轮提纲', 'meow_FM'], hideCardLabel: true, separateSources: false });
const after = filterInjectedMemory(parts, filter);
assert.equal(after.l1.includes('当前角色卡'), false);
assert(after.l1.includes('当前显示名为用户') && after.l1.includes('既有事实'));
assert(!after.raw.includes('旧模式指令') && !after.raw.includes('附加摘要'));
assert(after.raw.includes('真正的正文与心理、谜团、秘密线索全部保留'));
assert(after.raw.includes('这是用户给的文本'), 'User input must remain untouched');
assert(after.raw.includes('断开的标签不能把后续真实正文删掉'));
assert.equal(after.l2, before.l2);
assert.equal(after.authorNotes, before.authorNotes);
assert.equal(after.rawWindow.startFloor, before.rawWindow.startFloor);
assert.equal(after.rawWindow.endFloor, before.rawWindow.endFloor);
assert.deepEqual(parts, before, 'Stored input objects must not be mutated');
assert.deepEqual(source, originalSources);
assert.equal(filterInjectedMemory(parts, null), parts);
context.chatCompletionSettings.prompt_order[0].order[0].enabled = false;
assert.equal(readInjectionFilter(context), null, 'Disabled anchor disables the filter');
context.chatCompletionSettings.prompt_order[0].order[0].enabled = true;
context.chatCompletionSettings.prompts[0].content = '{{layered_memory_context}}';
assert.equal(readInjectionFilter(context), null, 'Other presets keep their original behavior');
context.chatCompletionSettings.prompts[0].content = '<memory_context_filter assistant_blocks="x.*,[bad],中文" />{{layered_memory_context}}';
assert.deepEqual(readInjectionFilter(context).assistantBlocks, ['中文']);
const started = performance.now();
for (let i = 0; i < 1000; i++) filterInjectedMemory(parts, filter);
console.log(`Injection filter passed: scoped, source-preserving, no budget refill; ${(performance.now() - started).toFixed(1)} ms / 1000 local passes.`);

assert.equal(composeInjectedMemory(before), [before.l1, before.l2, before.authorNotes, before.raw].join('\n\n'));
context.chatCompletionSettings.prompts[0].content = '<memory_context_filter separate_sources="true" />{{layered_memory_context}}';
const separated = filterInjectedMemory(parts, readInjectionFilter(context));
const composed = composeInjectedMemory(separated);
assert(composed.indexOf('<历史记录>') < composed.indexOf('<创作约定>'));
assert(composed.indexOf('<创作约定>') < composed.indexOf('<近期正文>'));
for (const content of [parts.l1, parts.l2, parts.authorNotes, parts.raw]) assert(composed.includes(content));
assert.equal((composed.match(/<创作约定>/gu) || []).length, 1);
assert.equal(composeInjectedMemory({ separateSources: true }), '', 'Empty sources do not produce instructions');
assert.deepEqual(parts, before);
