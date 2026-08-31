import { handleChapterSummaryJob } from './src/chapter.js';
import { handleExtractJob } from './src/extract.js';
import {
    handleMigrateChapterJob,
    handleMigrateCompleteJob,
    handleMigrateExtractChapterJob,
    handleMigrateFinalizeJob,
} from './src/eval/migrate.js';
import { ensureMessageIds, getPairs, isPendingSwipeMessage } from './src/ids.js';
import { handOffManagedHistory, requestExcludesTrailingAssistant } from './src/history-handoff.js';
import { createHistoryMutationCoordinator } from './src/history-mutation.js';
import { clearActiveGenerationType, registerPresetMemoryMacro, setActiveGenerationType, updateInjection } from './src/inject.js';
import { handleProofreadJob } from './src/proofread.js';
import { enqueue, rebuildAndEnqueuePending, registerHandler, releaseInactiveQueueScopes } from './src/queue.js';
import { appendLog, getChatData, getSettings } from './src/settings.js';
import { handleStateGcJob } from './src/state-gc.js';
import { automaticStateReviewRequest, handleStateReviewJob } from './src/state-review.js';
import { injectPanel, registerMessageMenu, renderActiveTab } from './src/ui/panel.js';
import { handleVolumeCompressJob } from './src/volume.js';
import {
    handleHistoryRebuildChapter,
    handleHistoryRebuildCommit,
    handleHistoryRebuildSegment,
} from './src/rebuild.js';
import { beginBranchRecovery, ensureBranchCheckpoint, ensureCurrentBranchRecovery, reconcileCurrentHistory, waitForBranchRecovery } from './src/branch.js';
import {
    ensureStyleResetNarrativeCoverage,
    handleNarrativeChapterJob,
    handleNarrativeSummaryJob,
} from './src/narrative.js';
import {
    handleBackstageChatChanged,
    handleBackstageGenerationStarted,
    handleBackstageGenerationStopped,
    handleBackstageMessageReceived,
    handleBackstageMessageSent,
} from './src/backstage-runtime.js';
import {
    injectBackstageUi,
    refreshBackstageMarkers,
    refreshBackstageTriggerState,
    scheduleBackstageMarkerRefresh,
    scheduleBackstageMarkerRefreshes,
} from './src/ui/backstage.js';

const MODULE = 'layered-memory';

let injectionRefreshScheduled = false;

function ctx() {
    return SillyTavern.getContext();
}

function reportBackgroundError(label, error) {
    if (error?.code === 'CHAT_SCOPE_CHANGED') return;
    console.error(`[${MODULE}] ${label}`, error);
}

function scheduleInjectionRefresh() {
    if (injectionRefreshScheduled) return;
    injectionRefreshScheduled = true;
    setTimeout(() => {
        injectionRefreshScheduled = false;
        try {
            updateInjection();
        } catch (error) {
            reportBackgroundError('后台更新记忆注入失败', error);
        }
    }, 0);
}

function wireHandlers() {
    registerHandler('extract', handleExtractJob);
    registerHandler('narrative_summary', handleNarrativeSummaryJob);
    registerHandler('narrative_chapter', handleNarrativeChapterJob);
    registerHandler('chapter_summary', handleChapterSummaryJob);
    registerHandler('volume_compress', handleVolumeCompressJob);
    registerHandler('proofread', handleProofreadJob);
    registerHandler('state_review', handleStateReviewJob);
    registerHandler('state_gc', handleStateGcJob);
    registerHandler('migrate_chapter', handleMigrateChapterJob);
    registerHandler('migrate_extract_chapter', handleMigrateExtractChapterJob);
    registerHandler('migrate_extract_floor', handleExtractJob);
    registerHandler('migrate_finalize', handleMigrateFinalizeJob);
    registerHandler('migrate_complete', handleMigrateCompleteJob);
    registerHandler('history_rebuild_segment', handleHistoryRebuildSegment);
    registerHandler('history_rebuild_chapter', handleHistoryRebuildChapter);
    registerHandler('history_rebuild_commit', handleHistoryRebuildCommit);
}

function maybeEnqueueAutomaticStateReview({ onOpen = false, force = false } = {}) {
    const data = getChatData();
    const settings = getSettings();
    const payload = automaticStateReviewRequest(data, {
        onOpen,
        force,
        chapterSize: settings.chapterSize || 25,
    });
    if (!payload) return null;
    return enqueue('state_review', payload);
}

async function onChatChanged() {
    handleBackstageChatChanged();
    scheduleBackstageMarkerRefreshes();
    releaseInactiveQueueScopes();
    const originMetadata = ctx().chatMetadata;
    const recovery = await beginBranchRecovery();
    if (ctx().chatMetadata !== originMetadata) return;
    ensureMessageIds();
    await rebuildAndEnqueuePending({ forceLastSealed: true });
    if (ctx().chatMetadata !== originMetadata) return;
    if (recovery.status !== 'failed') await ensureBranchCheckpoint();
    if (ctx().chatMetadata !== originMetadata) return;
    maybeEnqueueAutomaticStateReview({ onOpen: true });
    updateInjection();
    renderActiveTab();
    refreshBackstageMarkers();
    refreshBackstageTriggerState();
}

async function onMessageEvents(mesId, { excludeTrailingAssistant = false } = {}, originMetadata = ctx().chatMetadata) {
    await waitForBranchRecovery();
    if (ctx().chatMetadata !== originMetadata) return;
    ensureMessageIds();
    const data = getChatData();
    const pairs = getPairs({ excludeTrailingAssistant });
    reconcileCurrentHistory(data, pairs);
    appendLog('info', `聊天历史已改变，已按当前分支重新核对记忆${mesId == null ? '' : `（消息 #${mesId}）`}`);
    await rebuildAndEnqueuePending({ excludeTrailingAssistant, forcePersist: true });
    if (ctx().chatMetadata !== originMetadata) return;
    updateInjection(excludeTrailingAssistant ? { generationType: 'swipe' } : undefined);
}

const historyMutations = createHistoryMutationCoordinator((work, originMetadata) => (
    onMessageEvents(work.mesId, work, originMetadata)
));

async function maintainCompletedMessage(_work, originMetadata) {
    await waitForBranchRecovery();
    if (ctx().chatMetadata !== originMetadata) return;
    ensureMessageIds();
    await rebuildAndEnqueuePending();
    if (ctx().chatMetadata !== originMetadata) return;
    updateInjection();
}

const completedMessageMaintenance = createHistoryMutationCoordinator(maintainCompletedMessage);

function historyMutationKey({ excludeTrailingAssistant = false } = {}) {
    ensureMessageIds();
    const pairs = getPairs({ excludeTrailingAssistant });
    const projection = pairs.map(pair => [
        pair.pairIndex,
        pair.floorKey,
        pair.contentFingerprint,
        pair.sealed ? 1 : 0,
    ].join(':')).join('|');
    return `${excludeTrailingAssistant ? 'without-trailing-assistant' : 'current'}|${projection}`;
}

function queueHistoryMutation(mesId, { excludeTrailingAssistant = false } = {}) {
    const originMetadata = ctx().chatMetadata;
    const work = { mesId, excludeTrailingAssistant };
    const pending = historyMutations.schedule(originMetadata, work, historyMutationKey(work));
    void pending.catch(error => {
        if (error?.code === 'CHAT_SCOPE_CHANGED') return;
        console.error(`[${MODULE}] 聊天历史后台同步失败`, error);
        globalThis.toastr?.error?.(`聊天历史同步失败：${error?.message ?? error}`);
    });
    return pending;
}

function queueCompletedMessageMaintenance(mesId) {
    const originMetadata = ctx().chatMetadata;
    const work = { mesId };
    // MESSAGE_RECEIVED is awaited by SillyTavern's stream finalizer. Cross a
    // macrotask boundary so the reply paints and the native save gets priority
    // before memory maintenance starts.
    setTimeout(() => {
        if (ctx().chatMetadata !== originMetadata) return;
        const pending = completedMessageMaintenance.schedule(
            originMetadata,
            work,
            historyMutationKey(),
        );
        void pending.catch(error => reportBackgroundError('回复后的记忆维护失败', error));
    }, 0);
}

async function waitForGenerationHistory(chat, type) {
    const originMetadata = ctx().chatMetadata;
    const excludeTrailingAssistant = requestExcludesTrailingAssistant(chat, type);
    const state = historyMutations.snapshot(originMetadata);
    if (type === 'swipe') {
        await queueHistoryMutation(null, { excludeTrailingAssistant: true });
    } else if (state.failed) {
        await queueHistoryMutation(null);
    } else {
        await historyMutations.wait(originMetadata);
    }
    if (ctx().chatMetadata !== originMetadata) {
        const error = new Error('聊天已切换，已中止旧聊天的生成');
        error.code = 'CHAT_SCOPE_CHANGED';
        throw error;
    }
    return { excludeTrailingAssistant };
}

/**
 * SillyTavern generate_interceptor: keep old request messages available to
 * world-info/depth preprocessing, but mark the plugin-managed prefix so the
 * Chat Completion formatter does not send it to the provider.
 */
globalThis.layeredMemoryIntercept = async function layeredMemoryIntercept(chat, _contextSize, _abort, type) {
    let excludeTrailingAssistant;
    try {
        await ensureCurrentBranchRecovery();
        await waitForBranchRecovery();
        ({ excludeTrailingAssistant } = await waitForGenerationHistory(chat, type));
    } catch (err) {
        console.error(`[${MODULE}] 聊天历史尚未安全同步，已中止本次生成`, err);
        globalThis.toastr?.error?.(`生成前历史同步失败：${err?.message ?? err}`);
        throw err;
    }
    try {
        await ensureStyleResetNarrativeCoverage({ excludeTrailingAssistant });
    } catch (err) {
        console.error(`[${MODULE}] 文风重置未能安全接管旧原文，已中止本次生成`, err);
        globalThis.toastr?.error?.(`文风重置失败：${err?.message ?? err}`);
        throw err;
    }
    try {
        setActiveGenerationType(type, { excludeTrailingAssistant });
        updateInjection({ generationType: type, excludeTrailingAssistant });
        const result = handOffManagedHistory(chat, type);
        if (result.status === 'skipped' && !['plugin_disabled', 'unsupported_backend'].includes(result.reason)) {
            console.warn(`[${MODULE}] 历史交接已安全跳过：${result.reason}`);
        } else if (result.status === 'handed_off') {
            console.debug(`[${MODULE}] 已由插件接管 ${result.ignoredMessages} 条旧 Chat History 消息`);
        }
    } catch (err) {
        console.error(`[${MODULE}] 历史交接失败，已保留原生 Chat History`, err);
    }
};

jQuery(async () => {
    wireHandlers();
    getSettings();
    registerPresetMemoryMacro();
    injectPanel();
    registerMessageMenu();
    injectBackstageUi();
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearActiveGenerationType();
        void onChatChanged();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (mesId, type) => {
        const normalizedId = typeof mesId === 'number' ? mesId : Number(mesId);
        ensureMessageIds();
        handleBackstageMessageReceived(normalizedId, type);
        scheduleBackstageMarkerRefresh(normalizedId - 1);
        refreshBackstageTriggerState();
        if (type === 'swipe') {
            queueHistoryMutation(normalizedId);
            return;
        }
        queueCompletedMessageMaintenance(normalizedId);
    });

    eventSource.on(event_types.MESSAGE_SENT, (mesId) => {
        const normalizedId = typeof mesId === 'number' ? mesId : Number(mesId);
        ensureMessageIds();
        const createdBackstageMarker = handleBackstageMessageSent(normalizedId);
        if (createdBackstageMarker) scheduleBackstageMarkerRefresh(normalizedId);
        refreshBackstageTriggerState();
    });

    const historyMutationHandler = (mesId) => {
        const normalizedId = typeof mesId === 'number' ? mesId : Number(mesId);
        const chat = ctx().chat || [];
        const pendingNewSwipe = normalizedId === chat.length - 1 && isPendingSwipeMessage(chat[normalizedId]);
        refreshBackstageMarkers(normalizedId);
        refreshBackstageTriggerState();
        queueHistoryMutation(normalizedId, { excludeTrailingAssistant: pendingNewSwipe });
    };

    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, historyMutationHandler);
    }
    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, historyMutationHandler);
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, (mesId) => {
            refreshBackstageTriggerState();
            queueHistoryMutation(typeof mesId === 'number' ? mesId : Number(mesId));
        });
    }
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, (type, _params, isDryRun) => {
            handleBackstageGenerationStarted(type, isDryRun);
            refreshBackstageTriggerState();
            setActiveGenerationType(type);
            if (isDryRun) scheduleInjectionRefresh();
        });
    }
    const clearGenerationState = () => {
        clearActiveGenerationType();
        refreshBackstageTriggerState();
        scheduleInjectionRefresh();
    };
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, () => {
            clearGenerationState();
            handleBackstageGenerationStopped({ includeDiscussion: false });
        });
    }
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            clearGenerationState();
            handleBackstageGenerationStopped();
        });
    }
    if (event_types.GENERATE_AFTER_DATA) {
        eventSource.on(event_types.GENERATE_AFTER_DATA, (_data, isDryRun) => {
            if (isDryRun) clearGenerationState();
        });
    }

    const presetChangedEvent = event_types.OAI_PRESET_CHANGED_AFTER || event_types.PRESET_CHANGED;
    if (presetChangedEvent) {
        eventSource.on(presetChangedEvent, () => {
            updateInjection();
            renderActiveTab();
        });
    }

    await onChatChanged();

    console.log(`[${MODULE}] 已加载 v0.22.1`);
});

export async function onActivate() {
    console.log(`[${MODULE}] activate`);
}
