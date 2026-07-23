import { handleChapterSummaryJob } from './src/chapter.js';
import { handleExtractJob } from './src/extract.js';
import {
    handleMigrateChapterJob,
    handleMigrateCompleteJob,
    handleMigrateExtractChapterJob,
    handleMigrateFinalizeJob,
} from './src/eval/migrate.js';
import { ensureMessageIds, getPairs } from './src/ids.js';
import { trimChatForGenerate, updateInjection } from './src/inject.js';
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

const MODULE = 'layered-memory';

function ctx() {
    return SillyTavern.getContext();
}

function wireHandlers() {
    registerHandler('extract', handleExtractJob);
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

async function onMessageEvents(mesId) {
    const originMetadata = ctx().chatMetadata;
    await waitForBranchRecovery();
    if (ctx().chatMetadata !== originMetadata) return;
    ensureMessageIds();
    const data = getChatData();
    const pairs = getPairs();
    reconcileCurrentHistory(data, pairs);
    await saveChatData(data);
    if (ctx().chatMetadata !== originMetadata) return;
    appendLog('info', `聊天历史已改变，已按当前分支重新核对记忆${mesId == null ? '' : `（消息 #${mesId}）`}`);
    await rebuildAndEnqueuePending();
    if (ctx().chatMetadata !== originMetadata) return;
    updateInjection();
}

/**
 * Global generate interceptor (manifest.generate_interceptor).
 */
globalThis.layeredMemoryIntercept = async function layeredMemoryIntercept(chat, contextSize, abort, type) {
    try {
        if (!getSettings().enabled) {
            return;
        }
        const originMetadata = ctx().chatMetadata;
        await ensureCurrentBranchRecovery();
        if (ctx().chatMetadata !== originMetadata) return;
        ensureMessageIds();
        void rebuildAndEnqueuePending();
        const handoff = await trimChatForGenerate(chat, type, contextSize);
        if (ctx().chatMetadata !== originMetadata) return;
        updateInjection({ archiveEndPair: handoff?.removedThrough ?? -1 });
    } catch (err) {
        console.error(`[${MODULE}] interceptor error`, err);
    }
};

jQuery(async () => {
    wireHandlers();
    getSettings();
    injectPanel();
    registerMessageMenu();
    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        void onChatChanged();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
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

    const swipeHandler = (mesId) => {
        void onMessageEvents(typeof mesId === 'number' ? mesId : Number(mesId));
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
        eventSource.on(event_types.GENERATION_STARTED, async () => {
            const originMetadata = ctx().chatMetadata;
            await waitForBranchRecovery();
            if (ctx().chatMetadata !== originMetadata) return;
            await rebuildAndEnqueuePending();
            if (ctx().chatMetadata !== originMetadata) return;
            updateInjection();
        });
    }

    await onChatChanged();

    console.log(`[${MODULE}] 已加载 v0.9.0`);
});

export async function onActivate() {
    console.log(`[${MODULE}] activate`);
}
