import assert from 'node:assert/strict';
import {
    FACT_STATUS_LABELS,
    FACT_VIEW_LABELS,
    factViewMeta,
    injectionPresentation,
    presetAnchorPresentation,
    taskRailPresentation,
    usageSummaryPresentation,
    workflowPresentation,
} from '../src/ui/presentation.js';

assert.deepEqual(FACT_VIEW_LABELS, {
    active: '当前记忆',
    all: '发现历史',
    inactive: '待处理',
});
assert.deepEqual(FACT_STATUS_LABELS, {
    active: '已加入当前记忆',
    unselected: '尚未加入',
    superseded: '已被新事实替代',
    unverified: '需要核对',
    dismissed: '已忽略',
});
assert.doesNotMatch(FACT_STATUS_LABELS.active, /已经发送|正在发送/u);
assert.equal(factViewMeta('active', { active: 3 }).count, 3);
assert.equal(factViewMeta('all', { all: 8 }).label, '发现历史');
assert.equal(factViewMeta('inactive', { inactive: 2 }).label, '待处理');

const idle = workflowPresentation({ status: 'idle', total: 5, completed: 0 });
assert.equal(idle.state, 'idle');
assert.equal(idle.canContinue, true);
const partial = workflowPresentation({ status: 'partial', total: 5, completed: 2 });
assert.equal(partial.state, 'partial');
assert.equal(partial.canContinue, true);
const complete = workflowPresentation({ status: 'complete', total: 5, completed: 5 });
assert.equal(complete.complete, true);
assert.equal(complete.canContinue, false, 'remaining=0 must never expose continue');
const running = workflowPresentation({ status: 'running', total: 5, completed: 2 });
assert.equal(running.state, 'working');
assert.equal(running.canContinue, false);
const paused = workflowPresentation({ status: 'stopped', total: 5, completed: 2 });
assert.equal(paused.state, 'paused');
assert.equal(paused.canContinue, true);
const failed = workflowPresentation({ status: 'error', total: 5, completed: 2, failedCount: 1 });
assert.equal(failed.canRetry, true);

assert.equal(taskRailPresentation({}).expandedByDefault, false);
assert.equal(taskRailPresentation({ running: { id: 'x' } }).expandedByDefault, true);
assert.equal(taskRailPresentation({ running: [{ id: 'x' }], queued: Array.from({ length: 7 }, (_, id) => ({ id })) }).summary,
    '共 8 项：1 项处理中，7 项等待');
assert.equal(taskRailPresentation({ running: [{ id: 'x' }, { id: 'y' }], failed: [{ id: 'z' }] }).summary,
    '共 3 项：2 项处理中，1 项需要处理');
assert.equal(taskRailPresentation({ paused: true }).state, 'paused');
assert.equal(taskRailPresentation({ failed: [{ id: 'x' }] }).state, 'error');
const balancePause = taskRailPresentation({
    paused: true,
    pauseReason: { category: 'balance', message: '记忆模型余额不足，后台整理已暂停。' },
    failed: [{ id: 'old-failure' }],
});
assert.equal(balancePause.state, 'paused');
assert.match(balancePause.summary, /余额不足/u);

const usage = usageSummaryPresentation([
    {
        totalTokens: 3_500,
        promptCacheHitTokens: 1_000,
        promptCacheMissTokens: 2_000,
        reasoningTokens: 300,
        estimatedCostCny: 0.00302,
    },
    { totalTokens: 500, promptCacheHitTokens: 500, promptCacheMissTokens: 0 },
]);
assert.equal(usage.requests, 2);
assert.equal(usage.totalTokens, 4_000);
assert.equal(usage.cacheHitRate, 3 / 7);
assert.equal(usage.reasoningTokens, 300);
assert.equal(usage.pricedRequests, 1);
assert.equal(usage.estimatedCostCny, 0.00302);

assert.equal(injectionPresentation(true).action, '查看上次使用内容');
assert.equal(injectionPresentation(false).action, '预览下次记忆内容');
assert.match(injectionPresentation(true).dialogTitle, /实际/u);
assert.match(injectionPresentation(false).dialogTitle, /预计/u);

const anchorActive = presetAnchorPresentation({
    supported: true,
    registered: true,
    state: 'active',
    hosts: [{ name: '前文回顾开头' }],
});
assert.equal(anchorActive.state, 'active');
assert.match(anchorActive.title, /前文回顾开头/u);
assert.match(presetAnchorPresentation({ supported: true, registered: true, state: 'missing' }).title, /兼容注入/u);
assert.match(presetAnchorPresentation({ supported: true, registered: true, state: 'duplicate', activeCount: 2 }).title, /重复 2 处/u);
assert.equal(presetAnchorPresentation({ supported: false }).state, 'unsupported');

console.log('UI presentation smoke: fact, workflow, task, and injection states passed');
