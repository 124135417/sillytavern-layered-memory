import { buildCoreMemoryParts, updateInjection } from './inject.js';
import { selectNpcDriveRows } from './npc-drives.js';
import { getChatData, getContext, getSettings } from './settings.js';
import { registerContextProvider } from './context-contributions.js';
import { ensureCurrentBranchRecovery, waitForBranchRecovery } from './branch.js';

/** Public optional integration. Consumers must not import memory internals. */
export function registerMemoryIntegration() {
    const api = Object.freeze({
        version: 1,
        isEnabled: () => Boolean(getSettings().enabled),
        async ready() {
            await ensureCurrentBranchRecovery();
            await waitForBranchRecovery();
        },
        getStoryContext() {
            if (!getSettings().enabled) return null;
            const { l2, raw, temporal } = buildCoreMemoryParts({ generationType: null, excludeTrailingAssistant: false });
            const drives = selectNpcDriveRows(getChatData(), getSettings(), getContext(), Number(getSettings().budgetL1 || 2000)).text;
            return { l2: [drives, temporal, l2].filter(Boolean).join('\n\n'), raw };
        },
        registerContextProvider,
        refreshContext: () => updateInjection(),
    });
    globalThis.SillyTavernLayeredMemory = api;
    globalThis.dispatchEvent?.(new Event('sillytavern:memory-ready'));
    return api;
}
