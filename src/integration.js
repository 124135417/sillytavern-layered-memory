import { buildCoreMemoryParts, updateInjection } from './inject.js';
import { getSettings } from './settings.js';
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
        getStoryContext({ separateDirectives = false } = {}) {
            if (!getSettings().enabled) return null;
            const { l2, raw, temporal, drives } = buildCoreMemoryParts({ generationType: null, excludeTrailingAssistant: false });
            if (separateDirectives) return { l2: [temporal, l2].filter(Boolean).join('\n\n'), raw, directives: drives };
            return { l2: [drives, temporal, l2].filter(Boolean).join('\n\n'), raw };
        },
        registerContextProvider,
        refreshContext: () => updateInjection(),
    });
    globalThis.SillyTavernLayeredMemory = api;
    globalThis.dispatchEvent?.(new Event('sillytavern:memory-ready'));
    return api;
}
