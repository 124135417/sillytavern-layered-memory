import { PROMPT_KEYS, QUEUE_PRIORITY } from './constants.js';
import { retrieveHits } from './retrieve.js';
import { renderL1Block, renderL2Block, renderL4Block } from './render.js';
import { enqueue } from './queue.js';
import { getChatData, getSettings } from './settings.js';
import { estimateTokens } from './tokens.js';

function extensionPromptApi() {
    const ctx = SillyTavern.getContext();
    return {
        setExtensionPrompt: ctx.setExtensionPrompt,
        extension_prompt_types: ctx.extension_prompt_types || { IN_PROMPT: 0, IN_CHAT: 1, NONE: -1 },
        extension_prompt_roles: ctx.extension_prompt_roles || { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    };
}

export function clearInjection() {
    const { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } = extensionPromptApi();
    if (!setExtensionPrompt) {
        return;
    }
    for (const key of Object.values(PROMPT_KEYS)) {
        setExtensionPrompt(key, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    }
}

export function updateInjection() {
    const settings = getSettings();
    const { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } = extensionPromptApi();
    if (!setExtensionPrompt) {
        console.warn('[layered-memory] setExtensionPrompt 不可用');
        return;
    }
    if (!settings.enabled) {
        clearInjection();
        return;
    }

    const data = getChatData();
    const l1 = renderL1Block(data, settings.budgetL1, SillyTavern.getContext());
    // L2 remains stored but unsent until an explicit user-controlled injection
    // policy replaces the removed context-percentage trimming mechanism.
    const l2 = '';

    if (estimateTokens(renderL2Block(data, { forBudget: true })) > (settings.budgetL2 || 5000)) {
        enqueue('volume_compress', { reason: 'budget' }, QUEUE_PRIORITY.volume_compress);
    }
    if (estimateTokens(l1) > (settings.budgetL1 || 2000) * 0.95) {
        enqueue('state_gc', {}, QUEUE_PRIORITY.state_gc);
    }

    let l4 = '';
    if (settings.l4Enabled) {
        const hits = retrieveHits(data, settings.budgetL4);
        l4 = renderL4Block(hits, settings.budgetL4);
    }

    const IN_PROMPT = extension_prompt_types.IN_PROMPT;
    const IN_CHAT = extension_prompt_types.IN_CHAT;
    const SYSTEM = extension_prompt_roles.SYSTEM;

    // Core memory must consume mandatory prompt budget before SillyTavern fills
    // chat history. The depth argument is ignored for IN_PROMPT prompts.
    setExtensionPrompt(PROMPT_KEYS.L1, l1, IN_PROMPT, 0, false, SYSTEM);
    setExtensionPrompt(PROMPT_KEYS.L2, l2, IN_PROMPT, 0, false, SYSTEM);
    setExtensionPrompt(PROMPT_KEYS.L4, l4, IN_CHAT, settings.depthL4 ?? 4, false, SYSTEM);
}
