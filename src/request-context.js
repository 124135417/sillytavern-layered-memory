/** Optional final-context service. Reserved tags fail closed if the service is unavailable. */
export async function protectModelContext(value, purpose = 'auxiliary', generationType = null) {
    const service = globalThis.SillyTavernSecretSwitches;
    if (!service || service.version !== 1) {
        if (/<\/?secret(?=[\s/>]|$)/iu.test(JSON.stringify(value))) {
            throw new Error('此请求包含秘密标签，但秘密开关插件未就绪；请求未发送');
        }
        return value;
    }
    const scope = globalThis.SillyTavern?.getContext?.().chatMetadata;
    await service.ready(value);
    if (scope !== globalThis.SillyTavern?.getContext?.().chatMetadata) {
        throw new Error('聊天已切换，已取消旧聊天的模型请求');
    }
    return service.protect(value, { purpose, generationType });
}

/** Select before regex extraction / JSON serialization can remove the tag boundaries. */
export function filterModelSource(value) {
    if (!/<\/?secret(?=[\s/>]|$)/iu.test(String(value ?? ''))) return value;
    const service = globalThis.SillyTavernSecretSwitches;
    if (!service || service.version !== 1) throw new Error('秘密开关插件未就绪，已停止处理带标签的原文');
    return service.filter(value);
}
