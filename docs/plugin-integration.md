# 可选插件集成接口 v1

`globalThis.SillyTavernLayeredMemory` 在扩展初始化时公开，发布 `sillytavern:memory-ready` 事件。调用者先检查 `version === 1`，不导入记忆内部文件、不读写记忆的存档。

- `isEnabled()`：用户是否启用记忆。
- `await ready()`：等待记忆分支恢复。
- `getStoryContext()`：返回 `{ l2, raw }`；禁用时返回 null。只读，不触发模型调用。
- `registerContextProvider(id, render)`：注册同步返回非剧情创作约定字符串的函数，返回取消注册函数。每次组装正文时读取，保持预设锚点与兼容注入一致；不能反过来调用上下文构建。
- `refreshContext()`：刷新注入，不运行模型。

记忆启用时由记忆的预设锚点或兼容注入承载外部约定，幕间清空自己的扩展提示词。记忆缺席或禁用时，幕间用自己的扩展提示词承载。每轮发送前重新确定唯一承载者。

保留的消息格式兼容：`extra.layered_memory_backstage_marker.sessionId` 标识非剧情控制楼。记忆仅识别此格式以排除讨论证据，不依赖幕间插件运行。稳定 ID 优先沿用已有 `layered_memory_id`；幕间独立运行生成的 `backstage_message_id` 会被记忆采用，避免后安装记忆造成关联失效。

旧存档仅作为不透明恢复副本保留；新幕间数据由 `chatMetadata.sillytavern_backstage` 独立管理。分支恢复、幕间模型请求、UI、持续约定均归幕间所有。
