import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panel, dialogs, presentation, facts, auxiliaryModel, renderedMemory] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/dialogs.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/presentation.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/facts.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/aux-model.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/render.js', import.meta.url), 'utf8'),
]);

const requiredCopy = [
    '当前记忆',
    '发现历史',
    '待处理',
    '已加入当前记忆',
    '尚未加入',
    '已被新事实替代',
    '需要核对',
    '已忽略',
    '当前记忆每轮发送；休眠记忆只在最近正文重新提到对应实体或事项时临时找回；退役与历史只用于追溯。',
    '加入当前记忆',
    '核对并加入',
    '检查记忆',
    '重新整理当前记忆',
    '生成一份完整整理预览',
    '生成完只显示预览，不会自动移动任何正式记忆',
    '采用整理结果',
    '回到整理前',
    '查看全部整理建议',
    '应用这些修改',
    '添加记忆',
    '批量管理',
    '全选当前筛选结果',
    '移出当前记忆',
    '永久删除',
    '恢复到当前记忆',
    '正在保存',
    '对话记录',
    '一条记录对应酒馆里的一楼',
    '章节',
    '查看完整摘要',
    '模型连接待检查',
    '测试连接',
    '记忆模型连接',
    '最近记忆模型用量',
    '自动整理',
    '相关旧记忆',
    '兼容性',
    '时间地点信息提取规则',
    '历史与恢复',
    '高级设置',
    '开发者工具',
    '恢复重建前结果',
    '重建工具',
    '查看上次使用内容',
    '预览下次记忆内容',
    '预设锚点已连接',
    '预设锚点未添加',
    '正在使用兼容注入',
];
for (const copy of requiredCopy) {
    assert.ok(panel.includes(copy) || dialogs.includes(copy) || presentation.includes(copy), `missing UI copy: ${copy}`);
}

const retiredCopy = [
    '这条内容已经发送给模型',
    '正在作为当前事实发送给模型',
    '保存并检查模型连接',
    '待你确认',
    '需要你决定',
    '逐条记录',
    'Connection Profile（优先）',
    '启用 Fallback API',
    'CONTROL ROOM',
    'HUMAN REVIEW',
    '当前事实的发送位置',
    '剧情摘要的发送位置',
    '希望保留多少最近剧情',
    '至少保留最近几轮完整对话',
    '自定义聊天历史容量',
    '剧情摘要 当前不发送',
];
for (const copy of retiredCopy) {
    assert.ok(!panel.includes(copy) && !facts.includes(copy), `retired or misleading UI copy returned: ${copy}`);
}

assert.doesNotMatch(panel, /\b(?:prompt|alert|confirm)\s*\(/u,
    'panel.js must not use browser-native blocking dialogs');
for (const button of panel.matchAll(/<button\b[^>]*class="[^"]*lm-icon-button[^"]*"[^>]*>/gu)) {
    assert.match(button[0], /aria-label="[^"]+"/u, `icon button needs an accessible name: ${button[0]}`);
}
assert.ok(!renderedMemory.includes('卷摘要'), 'model preview should not expose the old volume-summary term');
assert.ok(auxiliaryModel.includes('A failure never silently switches models'),
    'the selected memory-model source must remain exclusive');
assert.ok(auxiliaryModel.includes('settings: settingsOverride = null'),
    'connection tests must accept temporary form settings');
assert.ok(panel.includes('testAuxModelConnection({ settings: readFormDraft() })'),
    'connection testing must use the unsaved form draft');
assert.ok(panel.includes("jobType.startsWith('history_rebuild_')") && panel.includes('await retryHistoryRebuildJob(jobId)'),
    'retrying a failed rebuild task must requeue only that exact task');
assert.ok(!panel.includes("jobType.startsWith('history_rebuild_')) {\n                    await startHistoryRebuild()"),
    'retrying one failed rebuild task must never restart the whole rebuild');
assert.ok(!panel.includes('第 ${item.pairIndex} 轮'),
    'zero-based pair indexes must never be exposed');
assert.ok(panel.includes('pairFloorRangeLabel(item.pairIndex)'),
    'each generated record must display its real SillyTavern floor range');
assert.ok(panel.includes("stagedOrganization && !panel.querySelector('.lm-organization-preview')")
    && panel.includes('revealOrganizationPreview(panel)')
    && panel.includes('整理预览已生成，已显示在当前记忆顶部'),
    'a completed organization preview must replace the stale running UI and announce where the result is');
assert.ok(panel.includes('if (data.memory_organization?.staged)')
    && panel.includes('请先采用或放弃，再重新生成'),
    'a stale organization button must not enqueue and charge for the same full preview again');
assert.ok(!panel.includes('id="lm-d1"') && !panel.includes('id="lm-d2"'),
    'mandatory L1/L2 prompts must not expose ineffective depth controls');
assert.ok(panel.includes('id="lm-d4"'),
    'optional L4 retrieval must keep its in-chat depth control');

console.log('UI copy smoke: status semantics, dialogs, and accessible actions passed');
