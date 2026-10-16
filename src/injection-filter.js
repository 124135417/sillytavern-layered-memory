import { inspectPresetAnchor } from './preset-anchor.js';
import { renderRecentRawBlock } from './recent-raw.js';
import { estimateTokens } from './tokens.js';

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
    return { assistantBlocks, hideCardLabel: /\bhide_card_label="true"/u.test(config) };
}

function stripConfiguredBlocks(text, names) {
    let value = String(text ?? '');
    for (const name of names) {
        // Tag names are validated above. Complete blocks only: malformed output
        // must never cause the rest of a real narrative to disappear.
        value = value.replace(new RegExp(`<${name}(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${name}\\s*>\\s*`, 'gu'), '');
    }
    return value.trim();
}

/** Filter only the already-selected injection window; never refill its budget. */
export function filterInjectedMemory(parts, filter) {
    if (!filter) return parts;
    const sources = parts.rawWindow.sources.map(source => source.role === 'assistant'
        ? { ...source, narrativeText: stripConfiguredBlocks(source.narrativeText ?? source.text, filter.assistantBlocks) }
        : source);
    const text = renderRecentRawBlock(sources);
    return {
        ...parts,
        l1: filter.hideCardLabel ? parts.l1.replace(/^- 当前角色卡：[^\n]*(?:\n|$)/mu, '') : parts.l1,
        raw: text,
        rawWindow: { ...parts.rawWindow, sources, text, tokens: estimateTokens(text) },
    };
}
