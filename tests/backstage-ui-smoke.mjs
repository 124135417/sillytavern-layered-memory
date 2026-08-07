import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [ui, css, manifest, index] = await Promise.all([
    readFile(new URL('../src/ui/backstage.js', import.meta.url), 'utf8'),
    readFile(new URL('../style-v0.16.1.css', import.meta.url), 'utf8'),
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
assert.match(ui, /回到幕间/u);
assert.match(ui, /syncTranscriptList/u, '新增回复应增量加入，避免整段历史反复动画和播报');
assert.match(ui, /aria-relevant="additions"/u);
assert.doesNotMatch(ui, /data-option|剧情选项|选择一个/u, '幕间不应退化为选项卡交互');
assert.match(ui, /export function openBackstageDialog/u,
    '打开窗口不得成为等待元数据保存的异步链路');
assert.doesNotMatch(ui, /await beginBackstageSession/u,
    '窗口出现不得等待 beginBackstageSession 的后台持久化');

assert.match(css, /\.lm-backstage-frame[\s\S]*transform: translateY\(22px\) scale\(\.975\)/u,
    '桌面窗口需要克制的位移缩放入场');
assert.match(css, /\.lm-backstage-dialog\.is-open \.lm-backstage-frame[^{]*\{[^}]*translateY\(0\) scale\(1\)/u);
assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.lm-backstage-dialog/u,
    '动画必须尊重系统减少动态效果设置');
assert.match(css, /@media \(max-width: 599px\)[\s\S]*\.lm-backstage-dialog\.is-expanded[\s\S]*width: 100vw;[\s\S]*height: 100dvh;/u,
    '手机幕间应使用完整动态视口');
assert.match(css, /env\(safe-area-inset-bottom\)/u);
assert.match(css, /\.lm-backstage-turn p[^{]*\{[^}]*line-height: 1\.75/u, '长对话正文需要可读行高');
assert.match(css, /:focus-visible/u, '键盘焦点必须可见');
assert.match(css, /\.lm-backstage-clear:focus-visible/u);
assert.match(css, /\.lm-backstage-stop\[hidden\] \{ display: none; \}/u,
    '作者按钮样式不得覆盖停止按钮的原生 hidden 状态');
assert.match(css, /\.lm-backstage-compose\[hidden\] \{ display: none; \}/u,
    '归档查看时不得继续显示可编辑输入框');

const parsed = JSON.parse(manifest);
assert.equal(parsed.js, 'index.js');
assert.match(index, /injectBackstageUi\(\)/u);
assert.match(index, /MESSAGE_SENT[\s\S]*handleBackstageMessageSent/u);
assert.match(index, /MESSAGE_RECEIVED[\s\S]*handleBackstageMessageReceived/u);

console.log('backstage UI smoke: dialog semantics, natural chat, motion, retry, focus, and responsive layout passed');
