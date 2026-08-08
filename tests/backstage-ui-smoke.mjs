import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [ui, css, manifest, index] = await Promise.all([
    readFile(new URL('../src/ui/backstage.js', import.meta.url), 'utf8'),
    readFile(new URL('../style-v0.16.2.css', import.meta.url), 'utf8'),
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
]);

assert.match(ui, /document\.createElement\('dialog'\)/u, '幕间应使用有焦点语义的原生模态窗口');
assert.match(ui, /aria-labelledby[^\n]*lm-backstage-title/u);
assert.match(ui, /compositionstart[\s\S]*compositionend/u, '中文输入法组合期间不得误发消息');
assert.match(ui, /event\.key === 'Enter' && !event\.shiftKey && !isComposing/u);
assert.match(ui, /可以了，继续！/u);
assert.match(ui, /好了，重写这段/u);
assert.match(ui, /重新询问/u, '失败后应提供显式重试而不是要求重新输入');
assert.match(ui, /清空本次幕间/u, '当前工作副本必须提供可发现的清空操作');
assert.match(ui, /clearBackstageSession\(\)/u);
assert.match(ui, /syncTranscriptList/u, '新增回复应增量加入，避免整段历史反复动画和播报');
assert.match(ui, /aria-relevant="additions"/u);
assert.doesNotMatch(ui, /data-option|剧情选项|选择一个/u, '幕间不应退化为选项卡交互');
assert.match(ui, /export async function openBackstageDialog/u);
assert.doesNotMatch(ui, /await beginBackstageSession/u,
    '窗口出现不得等待 beginBackstageSession 的后台持久化');
const shellSource = ui.slice(ui.indexOf('function showDialogShell()'), ui.indexOf('function waitForFirstPaint()'));
assert.match(shellSource, /showModal\(\)[\s\S]*classList\.add\('is-open', 'is-hydrating'\)/u,
    '打开链路必须先显示窗口外壳并进入 busy 状态');
assert.doesNotMatch(shellSource, /getBackstageSnapshot|beginBackstageSession|backstageSessionForMessage|backstageInputTokenEstimate|getContext/u,
    '首帧外壳不得读取、恢复或估算聊天数据');
const openSource = ui.slice(ui.indexOf('export async function openBackstageDialog'), ui.indexOf('function toggleExpanded'));
assert.ok(openSource.indexOf('showDialogShell()') < openSource.indexOf('hydrateDialog('),
    'showModal 外壳必须先于会话 hydration');
assert.match(ui, /requestAnimationFrame\(\(\) => setTimeout\(resolve, 0\)\)/u,
    'hydration 前必须把控制权交还浏览器完成首帧绘制');
assert.match(ui, /aria-busy[\s\S]*正在接上这段剧情/u);
assert.match(ui, /dialogReady = true;[\s\S]*renderTranscript\(getBackstageSnapshot\(\)\)/u,
    '输入就绪状态必须先于正文渲染后的 token 调度');
assert.match(ui, /function scheduleTokenEstimate[\s\S]*requestAnimationFrame[\s\S]*setTimeout/u,
    'token 估算必须延后到内容和输入就绪之后');
assert.doesNotMatch(ui, /MutationObserver/u,
    '幕间不得通过 DOM 观察器监听整个页面');
assert.doesNotMatch(ui, /function decorateBackstageMessages|scheduleDecorate|action\.className[^;]*lm-backstage-reopen|actions\.prepend/u,
    '幕间不得在 DOM 变化后扫描聊天或给 AI 正文追加回看图标');
assert.match(ui, /querySelector\('\.lm-backstage-reopen'\)\?\.remove/u,
    '升级后应在显式刷新时清理旧版本遗留的回看图标');
assert.match(ui, /export function refreshBackstageMarkers[\s\S]*Number\.isInteger\(messageIndex\)/u,
    '控制楼标记只允许在聊天载入或明确消息事件后更新');
assert.match(ui, /linked\.editable[\s\S]*beginBackstageSession\(\{ messageIndex \}\)/u,
    '点击当前最后一段正文前的控制楼必须重新进入可编辑幕间');
assert.match(ui, /scheduleTriggerInjection[\s\S]*attempt >= 30/u,
    '按钮宿主缺失时只能进行有上限的短暂重试');
assert.match(ui, /messageFormatting\(value,[\s\S]*false, false, -1, \{\}, false\)/u,
    '叙述者 Markdown 应复用 SillyTavern 默认净化渲染链');
assert.match(ui, /renderBackstageMessageBody[\s\S]*message\?\.role === 'narrator'[\s\S]*escapeHtml/u,
    '玩家消息必须保持转义纯文本');

assert.match(css, /\.lm-backstage-frame[\s\S]*transform: translateY\(22px\) scale\(\.975\)/u,
    '桌面窗口需要克制的位移缩放入场');
assert.match(css, /\.lm-backstage-dialog\.is-open \.lm-backstage-frame[^{]*\{[^}]*translateY\(0\) scale\(1\)/u);
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.lm-backstage-dialog/u,
    '动画必须尊重系统减少动态效果设置');
assert.match(css, /@media \(max-width: 599px\)[\s\S]*\.lm-backstage-dialog\.is-expanded[\s\S]*width: 100vw;[\s\S]*height: 100dvh;/u,
    '手机幕间应使用完整动态视口');
assert.match(css, /env\(safe-area-inset-bottom\)/u);
assert.match(css, /grid-template-columns: minmax\(52px, 1fr\) minmax\(0, 58ch\) minmax\(52px, 1fr\)/u,
    '桌面消息必须使用等宽左右平衡列和居中正文列');
assert.doesNotMatch(css, /\.lm-backstage-turn\.is-player\s*\{[^}]*margin-left/u,
    '玩家消息不得再把整条正文向右推');
assert.match(css, /@media \(max-width: 599px\)[\s\S]*\.lm-backstage-turn \{ grid-template-columns: minmax\(0, 1fr\);[\s\S]*\.lm-backstage-speaker \{ grid-column: 1;[^}]*text-align: left/u,
    '手机姓名必须位于同宽正文上方');
assert.match(css, /\.lm-backstage-content \{[\s\S]*line-height: 1\.75/u, '长对话正文需要可读行高');
assert.match(css, /\.lm-backstage-content blockquote[\s\S]*\.lm-backstage-content pre[\s\S]*\.lm-backstage-content h1/u,
    '幕间需要克制且防溢出的 Markdown 排版');
assert.match(css, /:focus-visible/u, '键盘焦点必须可见');
assert.match(css, /\.lm-backstage-clear:focus-visible/u);
assert.match(css, /\.lm-backstage-stop\[hidden\] \{ display: none; \}/u,
    '作者按钮样式不得覆盖停止按钮的原生 hidden 状态');
assert.match(css, /\.lm-backstage-compose\[hidden\] \{ display: none; \}/u,
    '归档查看时不得继续显示可编辑输入框');

const parsed = JSON.parse(manifest);
assert.equal(parsed.js, 'index.js');
assert.equal(parsed.css, 'style-v0.16.2.css');
assert.equal(parsed.version, '0.16.6');
assert.match(index, /injectBackstageUi\(\)/u);
assert.match(index, /MESSAGE_SENT[\s\S]*handleBackstageMessageSent/u);
assert.match(index, /MESSAGE_RECEIVED[\s\S]*handleBackstageMessageReceived/u);
assert.match(index, /async function onChatChanged[\s\S]*refreshBackstageMarkers/u,
    '聊天切换后应通过显式事件恢复控制楼标记');

let formatterCall = null;
const formatterContext = {
    name2: '玄微',
    messageFormatting(...args) {
        formatterCall = args;
        return '<h3>走向</h3><p><strong>加一点压力</strong></p><ul><li>先敲门</li></ul><blockquote>不给玩家做决定</blockquote><p><code>边界</code></p><pre><code>安全文本</code></pre>';
    },
};
globalThis.SillyTavern = { getContext: () => formatterContext };
const { renderBackstageMessageBody } = await import('../src/ui/backstage.js');
const narratorHtml = renderBackstageMessageBody({ role: 'narrator', text: '# 走向\n\n**加一点压力**' });
assert.match(narratorHtml, /<h3>走向<\/h3>[\s\S]*<strong>加一点压力<\/strong>[\s\S]*<ul>[\s\S]*<blockquote>[\s\S]*<code>[\s\S]*<pre>/u,
    '叙述者应使用宿主 Markdown HTML，而不是显示原始标记');
assert.deepEqual(formatterCall.slice(1), ['玄微', false, false, -1, {}, false],
    '宿主 formatter 必须使用默认 sanitizer overrides');
formatterCall = null;
const playerHtml = renderBackstageMessageBody({ role: 'user', text: '<script>坏</script> **按字面显示**' });
assert.equal(playerHtml, '&lt;script&gt;坏&lt;/script&gt; **按字面显示**');
assert.equal(formatterCall, null, '玩家消息绝不能进入 Markdown/HTML 渲染器');
delete formatterContext.messageFormatting;
const fallbackHtml = renderBackstageMessageBody({ role: 'narrator', text: '<img src=x onerror=alert(1)>\n下一行' });
assert.match(fallbackHtml, /lm-backstage-plain-fallback/u);
assert.doesNotMatch(fallbackHtml, /<img/u, '宿主 formatter 缺失时必须转义为纯文本');

console.log('backstage UI smoke: dialog semantics, natural chat, motion, retry, focus, and responsive layout passed');
