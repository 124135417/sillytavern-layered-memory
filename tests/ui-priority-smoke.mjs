import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const idsSource = await readFile(new URL('../src/ids.js', import.meta.url), 'utf8');
const queueSource = await readFile(new URL('../src/queue.js', import.meta.url), 'utf8');
const auxSource = await readFile(new URL('../src/aux-model.js', import.meta.url), 'utf8');

const sentHandler = indexSource.match(/eventSource\.on\(event_types\.MESSAGE_SENT,[\s\S]*?\n    \}\);/u)?.[0] || '';
assert.match(sentHandler, /MESSAGE_SENT, \(mesId\) =>/u,
    '发送事件必须使用同步监听器，让用户消息立即进入 DOM');
assert.doesNotMatch(sentHandler, /\bawait\b|rebuildAndEnqueuePending|waitForBranchRecovery/u,
    '发送监听器不得等待分支恢复、队列重建或网络保存');

const receivedHandler = indexSource.match(/eventSource\.on\(event_types\.MESSAGE_RECEIVED,[\s\S]*?\n    \}\);/u)?.[0] || '';
assert.match(receivedHandler, /MESSAGE_RECEIVED, \(mesId, type\) =>/u,
    '回复完成事件必须立即返回给 SillyTavern');
assert.doesNotMatch(receivedHandler, /\bawait\b|rebuildAndEnqueuePending|waitForBranchRecovery/u,
    '回复完成监听器不得把后台维护留在前台结束路径');
assert.match(receivedHandler, /queueCompletedMessageMaintenance/u,
    '回复后的记忆维护仍需排入后台');

const startedHandler = indexSource.match(/eventSource\.on\(event_types\.GENERATION_STARTED,[\s\S]*?\n        \}\);/u)?.[0] || '';
assert.match(startedHandler, /GENERATION_STARTED, \(type, _params, isDryRun\) =>/u,
    '生成开始监听器必须同步返回以便立即锁住发送 UI');
assert.doesNotMatch(startedHandler, /\bawait\b|rebuildAndEnqueuePending|waitForGenerationHistory/u);

assert.doesNotMatch(idsSource, /saveChatMessages/u,
    '补充稳定消息 ID 不得再启动第二次整聊保存');
assert.match(queueSource, /MIN_ACTIVE_CHAPTERS_FOR_VOLUME = 8/u);
assert.match(queueSource, /type === 'volume_compress' && !hasAutomaticVolumeInput/u,
    '卷压缩必须在入队前检查是否真的有足够章节');
assert.match(auxSource, /USAGE_SAVE_IDLE_MS = 30_000/u);
assert.match(auxSource, /scheduleUsageHistorySave\(\)/u,
    '辅助模型用量应在静默窗口合并保存');

console.log('ui priority smoke: send/finish handlers return immediately and maintenance stays background');
