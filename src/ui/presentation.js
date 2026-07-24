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
    const failedCount = Array.isArray(failed) ? failed.length : Number(failed) || 0;
    const working = Boolean(running) || queuedCount > 0;
    const state = failedCount > 0 ? 'error' : paused ? 'paused' : working ? 'working' : 'idle';
    const summary = failedCount > 0 ? `${failedCount} 个任务需要处理`
        : paused ? '后台整理已暂停'
            : working ? `${queuedCount + (running ? 1 : 0)} 个任务正在处理`
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
