/** Read linked lore as reference material, without story activation or token budgets. */
export async function loadBackstageWorldInfo({
    loadEntries = async () => {
        const { getSortedEntries } = await import('../../../../world-info.js');
        return getSortedEntries();
    },
} = {}) {
    const entries = await loadEntries();
    if (!Array.isArray(entries)) throw new Error('无法读取幕间世界书');
    const seen = new Set();
    return entries.filter(entry => {
        if (!entry || entry.disable == true || !String(entry.content ?? '').trim()) return false;
        const key = JSON.stringify([entry.world, entry.uid]);
        if (entry.world != null && entry.uid != null) {
            if (seen.has(key)) return false;
            seen.add(key);
        }
        return true;
    }).map(entry => String(entry.content)).join('\n\n');
}
