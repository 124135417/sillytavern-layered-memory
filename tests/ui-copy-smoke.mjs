import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panel, auxiliaryModel, renderedMemory] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/aux-model.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/render.js', import.meta.url), 'utf8'),
]);

const requiredCopy = [
    '记忆模型从哪里连接？',
    '自己填写 API、密钥和模型',
    '使用 SillyTavern 已保存的连接',
    '跟随当前聊天模型',
    '临时改用另一个模型（可选）',
    '获取模型列表',
    '希望保留多少最近剧情？',
    'AI 正文提取规则',
    '用最近一条回复测试',
    '节省上下文',
    '平衡（推荐）',
    '尽量完整',
    '保留最近几轮完整对话',
    '每多少轮整理一次剧情摘要',
    '每多少轮自动检查一次记忆',
    '需要时找回相关的旧记忆',
    '安全重建以前的聊天',
    '已整理',
    '上一次真实请求使用的记忆',
    '下一次请求的预计记忆',
    '已隔离',
    '高级设置',
    '开发者工具',
    '查看发送给模型的内容',
    '这次出了什么问题？',
    '查看本章',
    '条逐轮记录',
    '逐轮记录已经齐全',
    '重新生成全部逐轮记录',
    '补齐缺少的逐轮记录',
    '放弃旧结果，全部重新生成',
    '查看逐轮记录',
    '章节摘要等待逐轮记录',
    '继续生成章节摘要',
    '查看章节摘要',
    '不足一章，仅保留逐轮记录',
    '完成章节后仍可查看和编辑每一轮',
    '这里的 1 轮 = 你的 1 条消息 + 角色紧接着的 1 条回复',
    '编辑这里只改变剧情记录',
    '根据修改后的记录重新生成本章',
    '准备检查逐轮记录',
    '当前显示旧正式事实',
    '轮待重新整理',
    '条仍可查看',
    '轮未整理',
    '尚未凑满一章',
    '不会因为不足一章而丢失',
    '概述较精简 · 已完整覆盖',
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
assert.ok(auxiliaryModel.includes('A failure never silently switches models'),
    'the selected memory-model source must be exclusive');
assert.ok(auxiliaryModel.includes('listDirectModels'),
    'direct API users should be able to fetch a provider model list');
assert.ok(panel.includes("jobType.startsWith('history_rebuild_')") && panel.includes('await startHistoryRebuild'),
    'retrying a failed rebuild task must resume rebuild state instead of only requeueing a no-op job');
assert.ok(!auxiliaryModel.includes('请配置 Connection Profile'),
    'connection errors should not require SillyTavern connection-manager jargon');

console.log('UI copy smoke: plain-language timeline and settings copy passed');
