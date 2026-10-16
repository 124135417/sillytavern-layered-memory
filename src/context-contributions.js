// Synchronous renderers run at request construction, so preset anchors and
// fallback injection always see the same current external context.
const providers = new Map();

export function registerContextProvider(id, render) {
    if (!id || typeof render !== 'function') throw new TypeError('Invalid context provider');
    providers.set(id, render);
    return () => { if (providers.get(id) === render) providers.delete(id); };
}

export function renderContextContributions() {
    const parts = [];
    for (const [id, render] of providers) {
        try {
            const text = String(render() || '').trim();
            if (text) parts.push(text);
        } catch (error) {
            console.error(`[layered-memory] 外部上下文 ${id} 读取失败`, error);
        }
    }
    return parts.join('\n\n');
}
