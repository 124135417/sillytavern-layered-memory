# Phone Reader 桌面端完全禁用设计

## 目标

Phone Reader 只服务手机竖屏。视口宽度大于 600px 时，桌面和平板横屏不得显示、打开或通过键盘聚焦 Phone Reader 的菜单、`Aa` 阅读按钮和阅读设置面板。

## 已确认根因

线上 Phone Reader v0.3.8 会在所有视口执行 `injectHamburger()`、`injectReaderSettingsPanel()` 和 `watchReaderMenuButton()`。`style-v24.css` 只在 `@media screen and (max-width: 600px)` 中定义 `#pr-reader-settings` 的隐藏与打开状态；桌面端没有基础隐藏规则。因此设置面板虽然带有 `aria-hidden="true"`，仍会作为普通 DOM 显示，关闭函数只移除手机状态类，无法在桌面端把面板隐藏。

## 行为边界

- 手机竖屏：`window.matchMedia('(max-width: 600px)')` 匹配时，Phone Reader 保持现有功能。
- 桌面、平板和手机横屏：断点不匹配时，Phone Reader 的三个入口节点均不存在，相关 body 状态类均被清理。
- 窄屏变宽：立即关闭阅读设置与顶部菜单，清理消息操作展开态，并移除 Phone Reader UI 节点。
- 宽屏变窄：重新注入三个入口，恢复当前已保存的字号、行距、段距、页边、字重和字体设置。
- 断点只控制 UI 生命周期，不删除 `localStorage` 中的阅读偏好。
- 不修改分层记忆插件、SillyTavern 核心或其它扩展。

## 实现设计

### JavaScript 生命周期

增加一个以现有 `mq` 为唯一依据的同步函数：

1. `mq.matches === true` 时，安装手机 UI、绑定现有手机交互并刷新阅读设置控件。
2. `mq.matches === false` 时，执行统一清理：关闭菜单与设置面板、移除消息的 `pr-show-actions`、删除 `#pr-hamburger`、`#pr-reader-menu-button` 和 `#pr-reader-settings`。
3. `init()` 不再无条件注入三个 UI 节点，而是调用该同步函数。
4. `mq` 的 `change` 事件调用同一个同步函数，避免初始化和旋转/缩放路径产生不同状态。
5. `openReaderSettings()` 增加宽屏保护；即使其它代码误调用，桌面端也不会重新打开或注入设置面板。

`#chat` 的委托监听可以保留一次绑定，因为处理函数已经用 `mq.matches` 在桌面端立即返回；重复进入手机态不得重复绑定。

### CSS 兜底

在媒体查询之外为 `#pr-reader-settings` 增加 `display: none !important`。在手机媒体查询内显式恢复 `display: flex !important`。现有 `#pr-hamburger` 和 `#pr-reader-menu-button` 的基础隐藏规则继续保留。

这层兜底保证脚本异常、旧 DOM 残留或加载时序变化时，桌面端也不会显示面板或留下可聚焦控件。

## 验收

### 桌面

- 1440px 宽度加载页面后，三个 Phone Reader UI 节点均不存在。
- body 不包含 `pr-menu-open`、`pr-reader-settings-open` 或消息 `pr-show-actions` 残留。
- 连续按 Tab 不会聚焦 Phone Reader 控件。
- SillyTavern 原生聊天、输入框和分层记忆“幕间”按钮仍可用。

### 手机

- 390px 宽度显示汉堡菜单和 `Aa` 阅读入口。
- 设置面板可以打开、关闭、重置并调整所有阅读参数。
- 已保存的阅读偏好在刷新和重新进入窄屏后恢复。

### 断点切换

- 390px 打开阅读设置后切到 1440px：面板和入口立即消失，Tab 顺序无残留。
- 1440px 再切回 390px：手机入口重新出现且只出现一份，设置仍可操作。
- 重复切换三次不产生重复 DOM、重复事件或遗留 body class。

## 发布

Phone Reader 版本升至 v0.3.9，并更换 JS/CSS 文件名或缓存版本，确保浏览器不会继续使用 v0.3.8 资源。部署后同时验证源站文件、线上 manifest 和真实 Chrome 桌面/手机视口。
