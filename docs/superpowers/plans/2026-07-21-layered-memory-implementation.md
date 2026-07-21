# 分层长程记忆 — 实现计划

> 依据：`docs/superpowers/specs/2026-07-21-layered-memory-design.md`  
> 设计源：`docs/memory-plugin-spec.md`  
> 形态：SillyTavern 第三方 UI Extension，零构建，ES modules

---

## 里程碑总览

| 阶段 | 目标 | 可演示结果 |
|---|---|---|
| M0 | 骨架可安装 | `manifest.json` + 空 Drawer，Git URL 能装上 |
| M1 | 存储 + 稳定键 + 队列 | 刷新后 pending 可重建；同聊串行 |
| M2 | 副模型 + 延迟提取 + 校验合并 | 打几楼后状态表有条目；swipe 不脏表 |
| M3 | Context 双轨注入 | L1/L2 进 prompt；裁剪线含章后缝隙 |
| M4 | 章节 / 卷 / L1 整理 | 满章出摘要；触顶压缩；stale 级联 |
| M5 | UI 四区 + 校对 + 报错 | 中文面板可用；错例固化快照 |
| M6 | L4 + 迁移 + eval 重跑 | L4 可关；迁移分流；跑分 pass/fail |
| M7 | 文档与发布 | README + 公开 GitHub repo |

按序交付；每阶段结束做一次烟测再进下一阶段。

---

## M0 — 仓库骨架与可安装扩展

**文件**

- `manifest.json`：`display_name`「分层长程记忆」，`js`/`css`，`author`（124135417），`version` `0.1.0`，`homePage`，`generate_interceptor` 名
- `index.js`：注册 Drawer、读 settings、挂事件占位
- `style.css`：最小样式
- `LICENSE`（MIT）、`README.md`（安装步骤占位）
- `src/` 目录占位模块（可先 export 空函数）

**验收**：本地把仓库放到 ST `public/scripts/extensions/third-party/` 或 Install Extension 能加载且无控制台报错。

---

## M1 — 存储、ID、队列

**模块**

- `src/settings.js`：默认设置（预算、N=3、章=25、depth、L4 关、profile/fallback 字段）
- `src/storage.js`：读写 `extension_settings.layered_memory` 与 `chat_metadata.layered_memory`；`saveSettingsDebounced` / chat 保存
- `src/ids.js`：为消息写入 `extra.layered_memory_id`；解析稳定键；「对」索引遍历（user+AI）
- `src/queue.js`：优先级队列；持久化 job 描述；刷新后重建 pending；不取消 in-flight

**数据形状（chat_metadata）** 最小字段：`state_table`、`chapters`、`volumes`、`pending_floors`、`extracted_keys`、`review_queue`、`progress`（最后完成章边界等）

**验收**：刷新页面后 pending 与 extracted 集合仍正确；入队顺序提取 > 摘要 > 压缩/校对 > 迁移。

---

## M2 — 副模型、延迟提取、校验、合并

**模块**

- `src/aux-model.js`：`callAuxModel`；优先 ST 当前/指定 Connection 经 `generateRaw`（干净 prompt、无 chat）；fallback `fetch`；structured output 可选
- `src/prompts/extract.txt`（或 `.js` 导出字符串）：指令 + schema 说明 + few-shot×4
- `src/extract.js`：组消息、调模型、解析 JSON
- `src/validate.js`：`validatePerFloor` / `validateChapter`（evidence 源切换；old_value → conflict；缺 id 丢弃）
- `src/merge.js`：add/update/flag_conflict、查重、pinned、changelog（含稳定键）

**事件**

- 用户新消息 / `CHAT_CHANGED` / 面板打开 / interceptor 开头：`enqueuePendingExtracts()`
- `MESSAGE_SWIPED|EDITED|DELETED`：回滚或标 stale；提取时读 active swipe

**验收**：闲聊楼多为「无变化」；有持久事实时入表且 evidence 过校验；swipe 后再提取不基于旧文本；生成不被提取阻塞。

---

## M3 — Context 注入与裁剪

**模块**

- `src/inject.js`：渲染 L1/L2/L4；`setExtensionPrompt`；depth 默认 L1/L2=100、L4=4；同 depth L1 先于 L2
- `src/trim.js`：按设计裁剪线计算 `start`；仅 `type` 为普通 generate 时改 chat 数组；其它 type 跳过或单独测

**验收**：注入块可见于 prompt 预览（若 ST 有）；故意制造「章后缝隙」确认未被裁掉；continue/regenerate 行为已手动确认记录在 README 或注释。

---

## M4 — 章节、卷压缩、L1 整理、stale 级联

**模块**

- `src/chapter.js`：边界触发、摘要调用、keywords 索引、冻结、stale 重生成、超长输入保护
- `src/volume.js`：预算检测、提及清单（默认章摘要+表）、验收、降级、卷 stale 重压
- `src/state-gc.js`：L1 整理调用 + 校验边界 + changelog

**验收**：满 25 对出一章；人为超 L2 预算触发压缩；改已入卷章的源文本 → 章与卷均 stale 并重压；pinned 章不进压缩。

---

## M5 — UI、校对、报错

**模块** `src/ui/`

- drawer 壳 + 状态表 / 章节 / 待审 / 设置四区（中文）
- 报错弹窗（楼层选择 + 三种类型）；消息菜单「这楼有漏记」
- 校对：`src/proofread.js` +「立即校对」；建议进待审
- 设置：profile 选择、fallback Key 警示文案、depth/预算等

**验收**：手改表、钉住、待审批准；漏报错必须选楼；错例写入全局且含固化快照。

---

## M6 — L4、迁移、eval

**模块**

- `src/retrieve.js`：倒排（keywords + 表实体）；扫描；top-k/预算；默认关
- `src/ui/migrate.js` + 迁移任务：章摘要回填 → 章级提取（validateChapter）→ 楼号章级精度 → 低优先级入队
- `src/eval/cases.js`：CRUD、导出 JSON、`pipeline` 字段
- `src/eval/rerun.js`：按 pipeline 分流重跑，报 pass/fail

**验收**：L4 开关有效；短历史迁移跑通；migration 错例重跑走 chapter 管线，不污染 per_floor。

---

## M7 — 文档与 GitHub 发布

- 完善 `README.md`：安装 URL、副模型配置、原则摘要、已知限制（隐性回调、CORS fallback）
- `gh repo create 124135417/sillytavern-layered-memory --public`（或 Web 创建后 `git remote add` + push）
- 标签 `v0.1.0`（可选）

**验收**：另一台/干净 ST 仅用 GitHub URL 安装成功。

---

## 建议实现顺序（文件级）

1. manifest + index 壳 + settings/storage/ids/queue  
2. aux-model + prompts + validate + merge + extract + 事件钩子  
3. inject + trim + interceptor  
4. chapter + volume + state-gc  
5. ui 四区 + proofread + 报错  
6. retrieve + migrate + eval  
7. README + push 公开仓库  

---

## 风险与尖刺（先做）

| 风险 | 尖刺 |
|---|---|
| ST Connection profile 能否给 `generateRaw` 换连接 | 读 ST 源码/文档，确认 API；不行则第一版 fallback fetch + 文档说明 |
| `setExtensionPrompt` 的 depth/position 参数名 | 对照当前 ST 版本 API 写适配层 |
| swipe/删除事件确切名字 | 在目标 ST 版本打印 `event_types` 对齐 |
| token 计数 | 先用字符启发式（中文≈1–2 token）或 ST 已有计数器，预算用同一函数 |

---

## 非目标（本计划不做）

- Server Plugin / 独立磁盘文件树  
- TypeScript 构建链  
- Embedding 检索  
- 预标注 50–100 楼 golden set / 合成对话评测数据  
- 自动修改用户 RP 预设  

---

## 完成后的烟测清单

1. URL 安装扩展  
2. 配置副模型（profile 或 fallback）  
3. 新开聊打 ≥3 对：见延迟提取与 L1 注入  
4. Swipe 上一楼再发下一楼：表不错乱  
5. 打满一章：出章节摘要  
6. 报一条「漏了」错例并重跑  
7.（可选）短历史迁移 + 改表产生 `pipeline:chapter` 错例  
