export const FACT_VIEW_LABELS = Object.freeze({
    active: '当前记忆',
    all: '发现历史',
    inactive: '待处理',
});

export const FACT_STATUS_LABELS = Object.freeze({
    active: '已加入当前记忆',
    unselected: '尚未加入',
    superseded: '已被新事实替代',
    unverified: '需要核对',
    dismissed: '已忽略',
});

export function factViewMeta(view, counts = {}) {
    const active = Number(counts.active) || 0;
    const all = Number(counts.all) || 0;
    const inactive = Number(counts.inactive) || 0;
    if (view === 'all') {
        return { label: '发现历史', description: '模型发现过的全部事实', count: all };
    }
    if (view === 'inactive') {
        return { label: '待处理', description: '尚未加入当前记忆的事实', count: inactive };
    }
    return { label: '当前记忆', description: '现在会用于后续聊天的事实', count: active };
}

export function workflowPresentation({ status = 'idle', completed = 0, total = 0, remaining = null, failedCount = 0 } = {}) {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCompleted = Math.max(0, Number(completed) || 0);
    const safeRemaining = remaining == null
        ? Math.max(0, safeTotal - safeCompleted)
        : Math.max(0, Number(remaining) || 0);
    const failed = Math.max(0, Number(failedCount) || 0);
    const active = ['running', 'stopping'].includes(status);
    const paused = status === 'stopped';
    const complete = safeTotal > 0 && safeRemaining === 0 && failed === 0 && !active && status !== 'error';
    const error = failed > 0 || status === 'error';
    const state = complete ? 'complete'
        : error ? 'error'
            : active ? 'working'
                : paused ? 'paused'
                    : safeCompleted > 0 ? 'partial' : 'idle';
    return {
        state,
        complete,
        error,
        active,
        paused,
        remaining: safeRemaining,
        canContinue: !complete && !active && safeRemaining > 0,
        canRetry: !complete && !active && error,
    };
}

export function taskRailPresentation({ paused = false, queued = [], running = null, failed = [] } = {}) {
    const queuedCount = Array.isArray(queued) ? queued.length : Number(queued) || 0;
    const runningCount = Array.isArray(running) ? running.length : Number(Boolean(running));
    const failedCount = Array.isArray(failed) ? failed.length : Number(failed) || 0;
    const working = runningCount > 0 || queuedCount > 0;
    const state = failedCount > 0 ? 'error' : paused ? 'paused' : working ? 'working' : 'idle';
    const total = queuedCount + runningCount + failedCount;
    const counts = [
        runningCount ? `${runningCount} 项处理中` : '',
        queuedCount ? `${queuedCount} 项等待` : '',
        failedCount ? `${failedCount} 项需要处理` : '',
    ].filter(Boolean).join('，');
    const summary = failedCount > 0 ? `共 ${total} 项：${counts}`
        : paused ? `已暂停领取新任务${counts ? ` · ${counts}` : ''}`
            : working ? `共 ${total} 项：${counts}`
                : '后台整理已完成';
    return { state, summary, expandedByDefault: state !== 'idle' };
}

export function injectionPresentation(isActual) {
    return isActual
        ? {
            kicker: '上次聊天',
            title: '实际使用的记忆范围',
            dialogTitle: '上次聊天实际使用的记忆',
            action: '查看上次使用内容',
        }
        : {
            kicker: '下次聊天预计',
            title: '预计使用的记忆范围',
            dialogTitle: '下次聊天预计使用的记忆',
            action: '预览下次记忆内容',
        };
}

export function presetAnchorPresentation(status = {}) {
    if (!status.supported || !status.registered) {
        return {
            state: 'unsupported',
            title: '预设锚点不可用，正在使用兼容注入',
            detail: '当前 SillyTavern 没有可用的宏注册接口，核心记忆仍会通过原有方式发送。',
        };
    }
    if (status.state === 'active') {
        const host = status.hosts?.[0]?.name || '未命名提示词';
        return {
            state: 'active',
            title: `预设锚点已连接：${host}`,
            detail: '核心记忆会在这条预设提示中原地展开，旧式 L1/L2 注入已自动停用。',
        };
    }
    if (status.state === 'duplicate') {
        return {
            state: 'duplicate',
            title: `预设锚点重复 ${status.activeCount || 0} 处，正在使用兼容注入`,
            detail: '重复锚点会展开为空，核心记忆只通过兼容路径发送一次。请在当前启用的预设提示中只保留一个锚点。',
        };
    }
    return {
        state: 'missing',
        title: '预设锚点未添加，正在使用兼容注入',
        detail: `若预设提供“前文回顾”，可在目标位置加入 ${status.token || '{{layered_memory_context}}'}。`,
    };
}
