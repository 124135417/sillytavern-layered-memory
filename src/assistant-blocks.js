import { inspectPresetAnchor } from './preset-anchor.js';

/** Opt-in presentation rules from an enabled memory-anchor prompt only. */
export function readInjectionFilter(context) {
    const anchor = inspectPresetAnchor(context);
    if (anchor.state !== 'active') return null;
    const identifiers = new Set(anchor.hosts.map(host => host.identifier));
    const host = context?.chatCompletionSettings?.prompts?.find(prompt => identifiers.has(prompt.identifier));
    const config = String(host?.content || '').match(/<memory_context_filter\b([^>]*?)\/?\s*>/u)?.[1];
    if (config === undefined) return null;
    const names = config.match(/\bassistant_blocks="([^"]*)"/u)?.[1]?.split(',') || [];
    const assistantBlocks = [...new Set(names.map(name => name.trim()).filter(name => /^[\p{L}\p{N}_-]{1,64}$/u.test(name)))];
    return { assistantBlocks, hideCardLabel: /\bhide_card_label="true"/u.test(config), separateSources: /\bseparate_sources="true"/u.test(config) };
}

export function stripConfiguredBlocks(text, names) {
    let value = String(text ?? '');
    for (const name of names) {
        // Tag names are validated above. Complete blocks only: malformed output
        // must never cause the rest of a real narrative to disappear.
        value = value.replace(new RegExp(`<${name}(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${name}\\s*>\\s*`, 'gu'), '');
    }
    return value.trim();
}

/** Shared input boundary for extraction, history, and auxiliary requests. */
export function filterAssistantBlocks(value, context = globalThis.SillyTavern?.getContext?.()) {
    const filter = readInjectionFilter(context);
    return filter?.assistantBlocks?.length ? stripConfiguredBlocks(value, filter.assistantBlocks) : value;
}
