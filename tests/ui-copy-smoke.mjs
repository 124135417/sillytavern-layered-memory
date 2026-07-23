import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panel, auxiliaryModel, renderedMemory] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/aux-model.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/render.js', import.meta.url), 'utf8'),
]);

const requiredCopy = [
    '用哪个模型整理记忆？',
    '希望保留多少最近剧情？',
    '节省上下文',
    '平衡（推荐）',
    '尽量完整',
    '保留最近几轮完整对话',
    '每多少轮整理一次剧情摘要',
    '每多少轮自动检查一次记忆',
    '需要时找回相关的旧记忆',
    '补记以前的聊天',
    '高级设置',
    '开发者工具',
    '查看发送给模型的内容',
    '这次出了什么问题？',
];
for (const copy of requiredCopy) {
    assert.ok(panel.includes(copy), `missing plain-language UI copy: ${copy}`);
}

const retiredCopy = [
    'Connection Profile（优先）',
    '启用 Fallback API',
    'L1 事实预算',
    'L2 摘要预算',
    'L4 检索预算',
    'L1 depth',
    'L2 depth',
    'L4 depth',
    '近楼原文（对）',
    '诊断与错例',
    'CONTROL ROOM',
    'HUMAN REVIEW',
    'NEXT GENERATION',
    '推荐 3。',
];
for (const copy of retiredCopy) {
    assert.ok(!panel.includes(copy), `retired technical UI copy returned: ${copy}`);
}

assert.ok(!renderedMemory.includes('卷摘要'), 'model preview should not expose the old volume-summary term');
assert.ok(!renderedMemory.includes('第${c.floor_range[0]}–${c.floor_range[1]}对'),
    'model preview should describe ranges as conversation rounds');
assert.ok(auxiliaryModel.includes('没有找到可用的记忆模型'),
    'connection errors should identify the user-facing memory model');
assert.ok(!auxiliaryModel.includes('请配置 Connection Profile'),
    'connection errors should not require SillyTavern connection-manager jargon');

console.log('UI copy smoke: 32/32 passed');
