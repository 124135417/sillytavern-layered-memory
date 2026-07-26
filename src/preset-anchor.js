export const MEMORY_ANCHOR_MACRO = 'layered_memory_context';
export const MEMORY_ANCHOR_TOKEN = `{{${MEMORY_ANCHOR_MACRO}}}`;

function countExactToken(content, token) {
    const text = String(content ?? '');
    let count = 0;
    let offset = 0;
    while (offset < text.length) {
        const index = text.indexOf(token, offset);
        if (index === -1) {
            break;
        }
        count += 1;
        offset = index + token.length;
    }
    return count;
}

function activePromptOrder(settings, context) {
    const configured = settings?.prompt_order;
    if (!Array.isArray(configured) || !configured.length) {
        return null;
    }
    if (configured.every(item => item && typeof item.identifier === 'string')) {
        return configured;
    }
    const lists = configured.filter(item => Array.isArray(item?.order));
    if (!lists.length) {
        return null;
    }
    if (lists.length === 1) {
        return lists[0].order;
    }
    // Chat Completion Prompt Manager currently uses one global dummy id. Keep
    // character/group ids as compatibility candidates for older/custom builds.
    const candidateIds = [100001, context?.groupId, context?.characterId, context?.this_chid]
        .filter(value => value !== null && value !== undefined)
        .map(String);
    return lists.find(list => candidateIds.includes(String(list.character_id)))?.order ?? null;
}

export function inspectPresetAnchor(context = null) {
    const settings = context?.chatCompletionSettings;
    const prompts = Array.isArray(settings?.prompts) ? settings.prompts : [];
    const order = activePromptOrder(settings, context);
    const enabled = order
        ? new Map(order.map(item => [String(item?.identifier ?? ''), item?.enabled === true]))
        : null;
    const hosts = [];
    for (const prompt of prompts) {
        const count = countExactToken(prompt?.content, MEMORY_ANCHOR_TOKEN);
        if (!count) {
            continue;
        }
        const identifier = String(prompt?.identifier ?? '');
        const isEnabled = enabled ? enabled.get(identifier) === true : true;
        if (!isEnabled) {
            continue;
        }
        hosts.push({
            identifier,
            name: String(prompt?.name || identifier || '未命名提示词'),
            role: String(prompt?.role || 'system'),
            count,
        });
    }
    const activeCount = hosts.reduce((total, host) => total + host.count, 0);
    return {
        state: activeCount === 1 ? 'active' : activeCount > 1 ? 'duplicate' : 'missing',
        activeCount,
        hosts,
        token: MEMORY_ANCHOR_TOKEN,
    };
}
