import { handleChapterSummaryJob } from './src/chapter.js';
import { handleExtractJob } from './src/extract.js';
import {
    handleMigrateChapterJob,
    handleMigrateCompleteJob,
    handleMigrateExtractChapterJob,
    handleMigrateFinalizeJob,
} from './src/eval/migrate.js';
import { ensureMessageIds, getPairs, isPendingSwipeMessage } from './src/ids.js';
import { clearActiveGenerationType, registerPresetMemoryMacro, setActiveGenerationType, updateInjection } from './src/inject.js';
import { handleProofreadJob } from './src/proofread.js';
import { rebuildAndEnqueuePending, registerHandler } from './src/queue.js';
import { appendLog, getChatData, getSettings, saveChatData } from './src/settings.js';
import { handleStateGcJob } from './src/state-gc.js';
import { injectPanel, registerMessageMenu, renderActiveTab } from './src/ui/panel.js';
import { handleVolumeCompressJob } from './src/volume.js';
import {
    handleHistoryRebuildChapter,
    handleHistoryRebuildCommit,
    handleHistoryRebuildSegment,
} from './src/rebuild.js';
import { beginBranchRecovery, ensureBranchCheckpoint, ensureCurrentBranchRecovery, reconcileCurrentHistory, waitForBranchRecovery } from './src/branch.js';
import { handleNarrativeChapterJob, handleNarrativeSummaryJob } from './src/narrative.js';

const MODULE = 'layered-memory';

function ctx() {
    return SillyTavern.getContext();
}

function wireHandlers() {
    registerHandler('extract', handleExtractJob);
    registerHandler('narrative_summary', handleNarrativeSummaryJob);
    registerHandler('narrative_chapter', handleNarrativeChapterJob);
    registerHandler('chapter_summary', handleChapterSummaryJob);
    registerHandler('volume_compress', handleVolumeCompressJob);
    registerHandler('proofread', handleProofreadJob);
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

async function onChatChanged() {
    const originMetadata = ctx().chatMetadata;
    const recovery = await beginBranchRecovery();
    if (ctx().chatMetadata !== originMetadata) return;
    ensureMessageIds();
    await rebuildAndEnqueuePending({ forceLastSealed: true });
    if (ctx().chatMetadata !== originMetadata) return;
    if (recovery.status !== 'failed') await ensureBranchCheckpoint();
    if (ctx().chatMetadata !== originMetadata) return;
    updateInjection();
    renderActiveTab();
}

async function onMessageEvents(mesId, { excludeTrailingAssistant = false } = {}) {
    const originMetadata = ctx().chatMetadata;
    await waitForBranchRecovery();
    if (ctx().chatMetadata !== originMetadata) return;
    ensureMessageIds();
    const data = getChatData();
    const pairs = getPairs({ excludeTrailingAssistant });
    const reconciled = reconcileCurrentHistory(data, pairs);
    await saveChatData(reconciled);
    if (ctx().chatMetadata !== originMetadata) return;
    appendLog('info', `聊天历史已改变，已按当前分支重新核对记忆${mesId == null ? '' : `（消息 #${mesId}）`}`);
    await rebuildAndEnqueuePending({ excludeTrailingAssistant });
    if (ctx().chatMetadata !== originMetadata) return;
    updateInjection(excludeTrailingAssistant ? { generationType: 'swipe' } : undefined);
}

jQuery(async () => {
    wireHandlers();
    getSettings();
    registerPresetMemoryMacro();
    injectPanel();
    registerMessageMenu();
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        clearActiveGenerationType();
        void onChatChanged();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async (mesId, type) => {
        if (type === 'swipe') {
            await onMessageEvents(typeof mesId === 'number' ? mesId : Number(mesId));
            return;
        }
        const originMetadata = ctx().chatMetadata;
        await waitForBranchRecovery();
        if (ctx().chatMetadata !== originMetadata) return;
        ensureMessageIds();
        await rebuildAndEnqueuePending();
        if (ctx().chatMetadata !== originMetadata) return;
        updateInjection();
    });

    eventSource.on(event_types.MESSAGE_SENT, async () => {
        const originMetadata = ctx().chatMetadata;
        await waitForBranchRecovery();
        if (ctx().chatMetadata !== originMetadata) return;
        ensureMessageIds();
        await rebuildAndEnqueuePending();
        if (ctx().chatMetadata !== originMetadata) return;
        updateInjection();
    });

    const swipeHandler = async (mesId) => {
        const normalizedId = typeof mesId === 'number' ? mesId : Number(mesId);
        const chat = ctx().chat || [];
        const pendingNewSwipe = normalizedId === chat.length - 1 && isPendingSwipeMessage(chat[normalizedId]);
        await onMessageEvents(normalizedId, { excludeTrailingAssistant: pendingNewSwipe });
    };

    if (event_types.MESSAGE_SWIPED) {
        eventSource.on(event_types.MESSAGE_SWIPED, swipeHandler);
    }
    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, swipeHandler);
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, async (mesId) => {
            const originMetadata = ctx().chatMetadata;
            await onMessageEvents(typeof mesId === 'number' ? mesId : Number(mesId));
            if (ctx().chatMetadata !== originMetadata) return;
            await saveChatData(getChatData());
        });
    }
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, async (type, _params, isDryRun) => {
            setActiveGenerationType(type);
            const originMetadata = ctx().chatMetadata;
            await ensureCurrentBranchRecovery();
            await waitForBranchRecovery();
            if (ctx().chatMetadata !== originMetadata) return;
            if (isDryRun) {
                updateInjection({ generationType: type });
                return;
            }
            const swipeGeneration = type === 'swipe';
            if (swipeGeneration) {
                ensureMessageIds();
                const data = getChatData();
                const reconciled = reconcileCurrentHistory(data, getPairs({ excludeTrailingAssistant: true }));
                await saveChatData(reconciled);
                if (ctx().chatMetadata !== originMetadata) return;
            }
            await rebuildAndEnqueuePending({ excludeTrailingAssistant: swipeGeneration });
            if (ctx().chatMetadata !== originMetadata) return;
            updateInjection({ generationType: type });
        });
    }
    const clearGenerationState = () => {
        clearActiveGenerationType();
        updateInjection();
    };
    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, clearGenerationState);
    }
    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, clearGenerationState);
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

    console.log(`[${MODULE}] 已加载 v0.13.4`);
});

export async function onActivate() {
    console.log(`[${MODULE}] activate`);
}
