# 分层长程记忆（layered-memory）

SillyTavern 第三方扩展：用分层记忆编译固定大小的 RP context，缓解长聊爆窗与滚动摘要崩坏。

- 仓库：https://github.com/124135417/sillytavern-layered-memory
- 协议：MIT
- 界面语言：中文

## 安装

1. 打开 SillyTavern → **Extensions** → **Install Extension**
2. 粘贴：

```text
https://github.com/124135417/sillytavern-layered-memory
```

3. 安装后在扩展设置中找到 **分层长程记忆**，配置副模型连接

本地开发也可将本仓库克隆到：

`SillyTavern/public/scripts/extensions/third-party/sillytavern-layered-memory`

## 副模型配置

提取 / 摘要 / 校对使用**干净上下文**，与 RP 主模型分离：

1. **优先**：在设置里选择 ST **Connection Profile**（经 `generateRaw` / Connection Manager 后端代发）
2. **Fallback**：勾选后填写 Base URL + API Key + 模型名（可能遇 CORS；Key 会写入 ST `settings.json`）

## 五层结构（简表）

| 层 | 作用 |
|---|---|
| L1 状态表 | 持久事实当前真值，常驻注入 |
| L2 摘要 | 章节摘要冻结；触顶卷压缩 |
| L3 近楼原文 | 近 N 对 + 章后缝隙，不裁成黑洞 |
| L4 检索 | 可选，默认关，词法命中 |
| 磁盘 | 聊天记录本身 + metadata 归档 |

## 使用要点

- **激活基线**：在某个聊天首次启用时记录当时最大楼层；**此前历史不会自动提取**，请用「存量迁移」；基线之后才走实时延迟提取
- **延迟提取**：上一楼在下一楼用户发言时（或切聊 / 开面板 / 生成前入队）才提取，避免 swipe 脏表
- **全自动**：可不打开面板；面板用于钉住、待审、报错、迁移
- **报错**：Alt+右键消息，或面板「报错」；漏记必须指定来源楼；错例进**全局**库并可重跑
- **存量迁移**：设置页一键回填基线前历史；完成后请人工校对（迁移校对模式下改表会自动记错例）

请从 RP 预设中自行移除「每轮顺带生成摘要」类指令。

## 文档

- 定稿设计：`docs/superpowers/specs/2026-07-21-layered-memory-design.md`
- 设计源规格：`docs/memory-plugin-spec.md`
- 实现计划：`docs/superpowers/plans/2026-07-21-layered-memory-implementation.md`

## 已知限制

- L4 抓不到「隐性回调」（情境相关但无关键词）
- Fallback 浏览器直连可能 CORS
- Token 预算为启发式估算，与各 API 计数器略有差异
- `continue` / `regenerate` / `impersonate` 不做 chat 裁剪，以免破坏原生行为
