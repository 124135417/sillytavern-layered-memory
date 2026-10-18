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
    return { assistantBlocks, hideCardLabel: /\bhide_card_label="true"/u.test(config), separateSources: /\bseparate_sources="true"/u.test(config) };
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
        separateSources: filter.separateSources,
        l1: filter.hideCardLabel ? parts.l1.replace(/^- 当前角色卡：[^\n]*(?:\n|$)/mu, '') : parts.l1,
        raw: text,
        rawWindow: { ...parts.rawWindow, sources, text, tokens: estimateTokens(text) },
    };
}

/** Same composition for preset macro, preview and compatibility injection. */
export function composeInjectedMemory(parts) {
    const { l1, l2, authorNotes, raw, temporal } = parts;
    if (!parts.separateSources) return [temporal, l1, l2, authorNotes, raw].filter(Boolean).join('\n\n');
    const history = [l1, l2].filter(Boolean).join('\n\n');
    return [
        temporal,
        history && `<历史记录>\n历史压缩与承接记录；人物分别知道什么、读者可获知什么，仍按启用的边界规则判断。\n${history}\n</历史记录>`,
        authorNotes && `<创作约定>\n以下是作者讨论与规划，不等于剧情已经发生，也不构成揭露秘密的许可。\n${authorNotes}\n</创作约定>`,
        raw && `<近期正文>\n续接实际言行；历史误泄露不自动成为人物知识或后续揭露许可。\n${raw}\n</近期正文>`,
    ].filter(Boolean).join('\n\n');
}
