# 分层长程记忆（layered-memory）— 定稿设计

> 日期：2026-07-21  
> 仓库：`https://github.com/124135417/sillytavern-layered-memory`（public，MIT）  
> 设计源规格：[`docs/memory-plugin-spec.md`](../../memory-plugin-spec.md)（与本仓库同仓；原则与槽位/schema 以该文为准，本文为已确认实现决策及相对规格的修订，避免双仓漂移）  
> 代号：`layered-memory`

---

## 0. 目标与范围

SillyTavern 第三方 **UI Extension**（纯前端、零构建），用 GitHub URL 安装。实现规格书中的完整能力（范围 B），并采用本文对注入、延迟提取、错例库、副模型通道等的修订。

**核心原则**（沿用规格 P1–P6）：分层；摘要写一次冻结（源文本变更除外）；检测题提取；模型写、代码验收；降级不销毁；每层硬预算。

**产品约束（已确认）**

| 项 | 决策 |
|---|---|
| 范围 | 完整规格（含 L4、校对、迁移、评测框架） |
| UI 语言 | 仅中文 |
| 开源协议 | MIT |
| GitHub | 用户 `124135417`，仓库名 `sillytavern-layered-memory` |
| 形态 | 方案 1：纯 UI Extension，无 Server Plugin，无构建步骤 |
| 副模型 | **优先** ST Connection Manager / 后端代发；**fallback** 插件内 Base URL + Key + fetch |
| 评测 | 「错例收集箱」冷启动，不预标注 50–100 楼；不用合成对话 |

---

## 1. 架构与数据模型

### 1.1 形态

- `manifest.json` + `index.js` + ES modules，ST「Install Extension」克隆即用
- **注入双轨**：
  - `setExtensionPrompt`：注入 L1 / L2 / L4 文本块
  - `generate_interceptor`：裁剪 chat，控制进入主生成的原文范围（L3）
- RP 主模型零结构化污染；提取/摘要/校对全部异步、干净上下文

### 1.2 持久化

| 数据 | 位置 |
|---|---|
| 全局设置、副模型连接、**错例库 `eval_cases`** | `extension_settings.layered_memory` |
| 状态表、章节/卷摘要、关键词索引、待审、pending/进度、changelog | `chat_metadata.layered_memory`（按聊隔离） |
| 楼层原文 | ST 聊天记录本身（不另存全文） |

错例是**跨聊天资产**，禁止放 `chat_metadata`。每条错例自带上下文快照，不依赖所在聊天。

### 1.3 楼层定义（全局统一）

**1 楼 = 1 对（user 消息 + 对应 AI 回复）**。  
章节 `floor_range`、稳定键、L3「近 N 楼」、进度计数全部按「对」计量，禁止混用「消息条数」。

### 1.4 稳定消息键

不依赖会因删楼移位的 index。优先在 `message.extra.layered_memory_id` 写入 uuid；否则用 `send_date + swipe_id` 组合。changelog、pending、回滚、对账均认此键。

### 1.5 状态表 / 摘要结构

沿用规格 §2 / §4 JSON 形态：`entries`、`changelog`、`op: add|update|flag_conflict`、章节 `summary/keywords/floor_range`、卷摘要与降级标记、`pinned`、`source: auto|manual|proofread`。

### 1.6 激活基线（baseline_pair）

每个聊天在插件**首次触达**时记录 `progress.baseline_pair` = 当时最大定格 `pairIndex`（无定格则为 `-1`）。

| 路径 | 范围 |
|---|---|
| 实时延迟提取 / 章节补偿 | 仅 `pairIndex > baseline_pair` |
| 存量迁移 | 仅 `pairIndex ≤ baseline_pair` |
| 迁移尾部残章（不足一章） | 收尾时以 `ignoreBaseline` 的 per-floor 补提 |

禁止在旧长聊上启用插件后对全历史自动跑数百次提取。迁移与实时提取互不抢活：实时优先级虽高，但不入队基线前的楼。

---

## 2. 延迟提取与事件

### 2.1 策略：延迟提取（推荐方案，已采纳）

不在 AI 消息落地时提取。在上一楼**定格**后提取：

**触发入队（不阻塞 RP）**

1. 用户发出新一楼消息时 → 对上一对定格楼入队提取  
2. 切换聊天时 → 补跑本聊 pending  
3. 打开插件面板时 → 同上  
4. **生成开始前**（interceptor / 生成开始事件）→ 已定格未提取楼入队（保证积压不超过「正在生成这一轮」，仍不等待提取完成）

提取执行时才读当前 `mes` 的 **active swipe** 正文；落地时**不缓存**原文（避免 swipe 后用旧文本）。

### 2.2 必须监听的事件

`MESSAGE_SWIPED` / `MESSAGE_EDITED` / `MESSAGE_DELETED`（及 ST 等价事件）：

- 尚未提取：无表可回滚；下次提取读新正文即可  
- 已合并：按 changelog 中该楼稳定键回滚全部 op，再标 pending 或重提取  
- 落入某章 `floor_range` 的删改 → 章标 `stale`（见 §3 级联）

### 2.3 Pending 持久化

pending 落在 `chat_metadata`。浏览器刷新后须能从 metadata **重建**：对比「已提取稳定键集合」与「当前定格楼列表」算出 pending，禁止只活在内存。

### 2.4 队列

- 同聊串行，避免状态表竞态  
- 入队时按优先级排序：实时提取 > 章节摘要 > 卷压缩 / 校对 > **迁移（最低）**  
- **不取消 in-flight** 调用；只排序出队，跑完再取下一个  
- 迁移不得饿死实时提取

---

## 3. 提取管线、校验、副模型

### 3.1 调用输入（每楼路径）

干净上下文：system = 任务指令 + schema + few-shot×4（≥2 个全「无变化」）；user = 当前状态表紧凑渲染 + 该对用户原文 + AI 原文。  
`temperature=0`；能 structured output 则开。  
禁止：角色卡、越狱、文风、历史楼层。

### 3.2 合并

输出按规格 §3.2；转 `add` / `update` / `flag_conflict`。  
查重：同 `slot+subject+object` 的 add → update。  
`pinned` 拒绝自动改；conflict 进待审。  
成功 op 写 changelog，带稳定消息键。

### 3.3 校验（逐条失败丢条）

**每楼路径（对照本楼原文）**

1. `evidence` 必须是本楼原文子串（空白归一化）  
2. `subject`/`object` 出现在本楼原文或当前表  
3. slot/op 合法 enum  
4. `value` ≤80 字  
5. `update` 的目标 `id` 必须存在于表中，否则丢弃  
6. `old_value`（如 relationship）对照**当前状态表现值**：应相等；不匹配时**不丢弃**，降级为 `flag_conflict` 进待审  
7. 失败可重试 1 次（附原因）；再失败丢弃并记日志  

**禁止**把「引用表内容」的字段也拿原文子串规则误杀。

**迁移路径（对照章摘要）**：`evidence` 匹配章摘要文本；其余规则同构。校验函数按 `pipeline` / 输入源切换，不得无脑复用「只对原文」版本。

### 3.4 副模型封装

`callAuxModel({ purpose, messages, jsonSchema? })`  
`purpose`: `extract` | `chapter_summary` | `volume_compress` | `proofread` | `state_gc`  

优先 ST Connection profile / 后端代发；未配置或失败再 fallback 自配 URL。  
设置页对 fallback Key 注明：将写入 ST 服务器 `settings.json`，共享/备份时注意。

---

## 4. L2 / 卷压缩 / L1 整理 / 预算

### 4.1 章节摘要

- 默认每 25 对；该章定格且相关提取完成后入队  
- 输入：章内全文 + 上一章摘要末两句；输出 summary / keywords / floor_range  
- 写完冻结；用户手改后同样冻结  
- 源文本变更 → `stale`（见级联）  
- 超长输入保护：章对数 N 可配；输入超上限则拆半各摘再合并，或报警请用户调小 N  

### 4.2 stale 级联（必须）

章 `stale` 且已入卷 → 所属卷也标 `stale` → 空闲时：先重生成章摘要，再用各章摘要重跑卷压缩（仍走清单+验收）。避免章对、卷旧。

冻结原则：不因「压缩」重写；**不豁免**「源文本变了」。

### 4.3 卷压缩

触发：L2 渲染 > 预算（默认 5000 token）。  

1. 代码生成「必须保留清单」（最老 8–10 章）：  
   - **默认**在后续**章节摘要 + 状态表**中计提及（≥3 入清单）；全文原文统计为可选配置  
   - 与状态表关联：**不强制**进清单，**不是**从摘要硬剔除  
   - `pinned` 章整章排除压缩  
2. 副模型 → ~400 字卷摘要  
3. 清单实体须出现在输出；缺则重试 1 次；再失败 → 中止、可暂超预算、面板报警  
4. 成功：章摘要降级出常驻 L2，metadata 与检索索引仍保留  
5. 原文 → 章 → 卷；极端「卷的卷」同样清单+验收  

### 4.4 L1 预算整理

超 2000：整理调用（合并同类、清冗余）→ 仍超则最旧低频降级归档。  
权限与提取一致：`pinned` 不动；合并结果机械校验（subject 须来自被合并条目、不得新增事实）；变更写 changelog；prompt 禁止「顺便改措辞」。

### 4.5 预算与生成

触顶只入队压缩/整理，**不阻塞**本轮生成（可暂超，下轮再生效）。L4 默认关闭；开启时 1500 token / top-k=3 / 零命中零注入。

---

## 5. Context 注入与 L4

### 5.1 同步组装顺序

L0（ST 原生）→ L1 → L2 → L4（可选）→ L3 保留原文 → 用户本轮输入。

### 5.2 setExtensionPrompt 默认

| 块 | role | depth 默认 | 说明 |
|---|---|---|---|
| L1 | system | 100 | 可配置 |
| L2 | system | 100 | 同 depth 时保证 L1 在 L2 前（key 顺序 / priority） |
| L4 | system | 4 | 更近对话；「无关则忽略」尾注必留 |

命名空间：`layered_memory_l1` / `_l2` / `_l4`。禁用时置空。

### 5.3 generate_interceptor 裁剪线（关键）

**不是**固定「只留近 N 对」。

保留从以下起点起到末尾的全部对（起点取**更小**值 = 保留**更多**楼）：

```text
start = min(
  last_completed_chapter_end_pair + 1,   // 章后缝隙必须保留
  total_pairs - N + 1                    // 且至少近 N 对
)
```

即保留量 = 两者中较大的一个：「近 N 对」与「最后一章边界之后的全部楼」。缝隙楼（未成章）既无摘要也绝不能被裁掉，否则出现黑洞。

裁剪边界与章进度同一进度字段。

**仅对普通 generate 裁剪**；`continue` / `regenerate` / `impersonate` 等 type 单独确认，避免破坏续写与 WI 扫描深度依赖。

### 5.4 L4

- 词法倒排；不用 embedding  
- 触发扫描：本轮用户输入 + 上一对楼  
- 索引来源：章 `keywords` + 状态表 `subject`/`object`（挂到确立/更新关联章）  
- top-k=3；1500 截断；零命中零注入  
- 隐性回调不承诺  

---

## 6. UI、校对、报错

### 6.1 四区（中文 Drawer）

1. **状态表**：分节、高亮、编辑/删/钉、手动添加；报错入口  
2. **章节列表**：区间、摘要、编辑冻结、钉住、stale/降级标记  
3. **待审**：conflict + 校对建议；批准才生效  
4. **设置**：副模型 profile / fallback、预算、N、章大小、校对周期、depth、卷压缩确认、L4、提及统计口径、错例查看/导出/重跑、存量工具  

全自动可不打开面板。打开面板 → 补跑 pending。失败用 toast / 横幅报警。

### 6.2 校对 pass

每 K 对异步；另提供 **「立即校对」** 按钮。  
建议全部进待审，不自动改旧账。

### 6.3 报错与错例楼层定位

| 类型 | 楼层如何定 |
|---|---|
| 乱填 / 填错 | 默认挂 entry 的 `established_floor` / `updated_floor`，允许改 |
| **漏了** | **必须用户指定来源楼** |

入口：

1. 报错弹窗：最近楼列表 + 输入楼号 + 关键词搜聊天跳转  
2. 消息扩展菜单：「这楼有漏记的事实」——上下文自动正确  

**表快照**：错例创建时**固化**「该楼原文 + 当时状态表 + 期望」进错例本身（推荐），不依赖日后 changelog 回放。  
changelog 仍保留用于回滚；若做折叠，被错例引用的区段可不折叠（次要，有固化快照即可）。

---

## 7. 存量迁移与错例收集箱

### 7.1 迁移步骤

1. 按 N 对回填章节摘要（异步、可暂停）  
2. 按时间顺序对每章摘要跑提取，累积状态表  
3. 强制人工过目；改表钩子自动生成错例  
4. 文案提示从预设移除「每轮摘要」指令（不自动改预设）  

### 7.2 迁移与正常路径的差异（必须）

1. **校验变体**：迁移 `evidence` 对照**章摘要**，非楼原文  
2. **楼号精度**：`established_floor` 等允许章级精度（区间或章 id，如 `ch_5 (126–150)`）；UI 显示「约第 X 章」；禁止假装精确到对  
3. **错例字段 `pipeline`**：`per_floor` | `chapter`  
   - `migration_edit` → 通常 `chapter`（累积表 + 章摘要路径）  
   - `panel_report` / 消息菜单 → `per_floor`  
   - 重跑按 `pipeline` **分流**，禁止混灌  

### 7.3 错例格式（全局）

```jsonc
{
  "id": "...",
  "pipeline": "per_floor" | "chapter",
  "type": "miss" | "spurious" | "wrong",
  "source": "migration_edit" | "panel_report" | "message_menu" | "seed",
  "floor_key": "...",
  "user_mes": "...",
  "ai_mes": "...",           // 或 chapter_summary 文本（chapter 管线）
  "state_table_snapshot": { },
  "expected": { },
  "created_at": "..."
}
```

- 起步可空；可选 10 条用户自选种子（5 该记 + 5 该空）冒烟  
- **不做**：预标注 50–100；合成对话；用被测模型自标  
- **用途**：回归跑分与诊断；**永不**进模型 context（人工拷 few-shot 除外）  
- 支持导出 JSON；面板内重跑报 pass/fail  

---

## 8. 仓库结构与发布

```text
sillytavern-layered-memory/
  manifest.json
  index.js
  style.css
  LICENSE                 # MIT
  README.md               # 中文安装与说明
  docs/
    memory-plugin-spec.md              # 设计源规格
    superpowers/specs/
      2026-07-21-layered-memory-design.md   # 本文
  src/
    settings.js / storage.js / ids.js
    aux-model.js / queue.js
    extract.js / validate.js / merge.js
    chapter.js / volume.js / proofread.js
    inject.js / trim.js / retrieve.js
    ui/
    eval/
  prompts/
```

`manifest.json`：`display_name`「分层长程记忆」、`author`、`version`、`js`/`css`、`homePage` 指向上述 GitHub。

安装：ST → Extensions → Install Extension → 贴 repo URL。

---

## 9. 实施注意事项清单（分散约束汇总）

- [ ] 延迟提取收尾：切聊 / 开面板 / 生成前入队  
- [ ] 提取时读 active swipe，不提前缓存原文  
- [ ] interceptor 按 generate type 分支；裁剪线含章后缝隙  
- [ ] L1/L2 depth=100，L4 depth=4，可配；L1 先于 L2  
- [ ] L4 索引含状态表实体  
- [ ] 报错「漏了」必选楼；错例固化表快照  
- [ ] fallback Key 存储警示文案  
- [ ] 「立即校对」按钮  
- [ ] 迁移校验 / 楼号精度 / `pipeline` 分流  
- [ ] 迁移队列低优先级  
- [ ] L1 整理：校验 + changelog + 禁止改措辞  
- [ ] 章摘要超长输入保护  
- [ ] stale → 卷 stale 级联重压  

---

## 10. 相对 `memory-plugin-spec.md` 的明确修订摘要

| 主题 | 规格原文 | 定稿 |
|---|---|---|
| 副模型 | 独立配置（未细说通道） | ST profile 优先，自配 fetch 为 fallback |
| 提取时机 | 回复落地后异步 | 延迟提取 + 多触发入队 |
| 注入 | 未细说 ST API | 双轨：setExtensionPrompt + interceptor 裁剪 |
| 裁剪 | 近 N 楼 | max(近 N, 章后全部缝隙) |
| 评测 | 预标注 golden set | 错例收集箱 + pipeline 分流 |
| 错例位置 | （未写） | 全局 extension_settings |
| stale/卷 | （未写级联） | 章 stale 且已入卷 → 卷 stale → 重压 |

槽位定义、五层预算默认值、P1–P6、输出 schema 等仍以设计源规格为准。
