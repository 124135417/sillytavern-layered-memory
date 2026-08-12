# SillyTavern 聊天滚动行为拆分设计

## 目标

保留打开、刷新或切换聊天时定位到最后一条消息的行为，同时禁止 AI 正文、Swipe 或 Thinking 收尾阶段在输出完成后把当前阅读位置强制拉到末尾。

## 已确认的问题

SillyTavern 原生 `Auto-scroll Chat` 使用同一个 `power_user.auto_scroll_chat_to_bottom` 开关控制聊天载入定位和实时消息滚动。关闭它会同时失去长聊天载入后的末楼定位，无法表达用户需要的两种不同策略。

当前服务器已有定制的聊天载入逻辑：`printMessages()` 渲染历史楼层时不逐楼滚动，渲染完成后由 `scrollChatToMessageStart()` 独立定位最后一楼。流式生成也已取消逐 token 滚动，但 `addOneMessage()` 的通用分支仍可能在新增 AI 消息时调用原生 `scrollChatToBottom()`。

## 设计

- 保持原生 `Auto-scroll Chat` 开关启用，避免破坏其他手动定位功能和旧页面兼容性。
- 聊天首次载入、刷新或切换时，继续由 `printMessages()` 在历史渲染完成后无动画定位最后一楼；这条路径不依赖实时输出滚动。
- `addOneMessage()` 只允许新插入的用户消息触发 `scrollChatToBottom()`，AI、Narrator、Swipe 和其他非用户消息均不得触发。
- 流式生成开始、逐 token 更新及生成结束继续保持无 `scrollChatToBottom()` 调用。
- 不修改预设、聊天记录、记忆插件或 Phone Reader。

## 验收

- `printMessages()` 仍以 `scroll: false` 渲染历史，并在最后调用 `scrollChatToMessageStart(chat.length - 1, { smooth: false, reserveBottomSpace: true })`。
- `addOneMessage()` 的滚到底部条件明确要求 `params.isUser`。
- 流式生成路径不存在开始、逐 token 或结束时的滚到底部调用。
- `power_user.auto_scroll_chat_to_bottom` 线上仍为 `true`。
- 修改后的 `public/script.js` 通过语法检查，服务器实际 HTTP 返回的脚本包含新条件。

## 回滚

部署前保存线上 `public/script.js` 完整快照。回滚只需恢复该文件，不涉及设置、聊天或插件数据。
