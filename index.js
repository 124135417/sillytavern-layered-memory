import { handleChapterSummaryJob } from './src/chapter.js';
import { handleExtractJob } from './src/extract.js';
import { handleMigrateChapterJob, handleMigrateExtractAllJob } from './src/eval/migrate.js';
import { ensureMessageIds, getPairs } from './src/ids.js';
import { trimChatForGenerate, updateInjection } from './src/inject.js';
import { rollbackFloor } from './src/merge.js';
import { handleProofreadJob } from './src/proofread.js';
import { enqueue, rebuildAndEnqueuePending, registerHandler } from './src/queue.js';
import { QUEUE_PRIORITY } from './src/constants.js';
import { appendLog, getChatData, getSettings, saveChatData } from './src/settings.js';
import { handleStateGcJob } from './src/state-gc.js';
import { injectPanel, registerMessageMenu, renderActiveTab } from './src/ui/panel.js';
import { handleVolumeCompressJob } from './src/volume.js';
import { markChaptersStaleForPair } from './src/chapter.js';

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
    registerHandler('migrate_extract_all', handleMigrateExtractAllJob);
}

async function onChatChanged() {
    ensureMessageIds();
    await rebuildAndEnqueuePending({ forceLastSealed: true });
    updateInjection();
    renderActiveTab();
}

async function onMessageEvents(mesId) {
    ensureMessageIds();
    // If a sealed pair was edited/swiped/deleted, rollback + stale
    const data = getChatData();
    const pairs = getPairs();
    // Heuristic: find pair containing this mes index
    const chat = ctx().chat;
    const mes = chat[mesId];
    if (!mes) {
        await rebuildAndEnqueuePending();
        updateInjection();
        return;
    }
    const pair = pairs.find(p => p.user === mes || p.ai === mes);
    if (pair?.floorKey && (data.extracted_keys || []).includes(pair.floorKey)) {
        await rollbackFloor(pair.floorKey);
        await markChaptersStaleForPair(pair.pairIndex);
        appendLog('info', `已回滚并标记 stale：楼#${pair.pairIndex}`);
    }
    await rebuildAndEnqueuePending();
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
        ensureMessageIds();
        // Enqueue pending extracts without awaiting
        void rebuildAndEnqueuePending();
        updateInjection();
        trimChatForGenerate(chat, type);
    } catch (err) {
        console.error(`[${MODULE}] interceptor error`, err);
    }
};

jQuery(async () => {
    wireHandlers();
    getSettings();
    injectPanel();
    registerMessageMenu();
    updateInjection();

    const { eventSource, event_types } = ctx();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        void onChatChanged();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {
        ensureMessageIds();
        // Delayed extract: when user sends, previous AI pair becomes frozen
        void rebuildAndEnqueuePending();
        updateInjection();
    });

    eventSource.on(event_types.MESSAGE_SENT, () => {
        ensureMessageIds();
        void rebuildAndEnqueuePending();
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
            await onMessageEvents(typeof mesId === 'number' ? mesId : Number(mesId));
            await saveChatData();
        });
    }
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            void rebuildAndEnqueuePending();
            updateInjection();
        });
    }

    console.log(`[${MODULE}] 已加载 v0.1.0`);
});

export async function onActivate() {
    console.log(`[${MODULE}] activate`);
}
