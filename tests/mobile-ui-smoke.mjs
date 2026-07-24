import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panel, css] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../style-v0.10.2.css', import.meta.url), 'utf8'),
]);

assert.match(panel, /value="cancel" formnovalidate[^>]*aria-label="关闭"/u,
    'the entry dialog close button must bypass required-field validation');
assert.match(panel, /value="cancel" formnovalidate[^>]*>不保存</u,
    'the entry dialog cancel button must bypass required-field validation');
assert.match(panel, /class="lm-task-disclosure" aria-expanded="false"/u,
    'mobile task status must expose an accessible disclosure control');
assert.match(panel, /body\.classList\.toggle\('lm-state-body', tab === 'state'\)/u,
    'the state page must opt into the mobile fixed-rail layout');
assert.match(panel, /id="lm-tab-turns"[^>]*data-tab="turns"[^>]*>逐条记录</u,
    'per-turn records need their own permanent navigation destination');
assert.match(panel, /id="lm-tab-chapters"[^>]*data-tab="chapters"[^>]*>章节摘要</u,
    'chapter summaries need a separate navigation destination');
assert.match(panel, /document\.body\.appendChild\(panel\)/u,
    'the fixed panel must be portaled outside SillyTavern responsive menu hosts');
assert.match(panel, /GEOMETRY_STYLE_ID = 'layered-memory-viewport-geometry'/u,
    'critical viewport positioning must have a JavaScript-delivered cache fallback');
assert.match(panel, /#\$\{ROOT_ID\}[\s\S]*right: 0 !important;[\s\S]*left: 0 !important;[\s\S]*margin-inline: auto !important;/u,
    'the runtime cache fallback must force true viewport centering on desktop');
assert.match(panel, /panel\?\.querySelectorAll\('\.lm-tab'\)/u,
    'tab listeners must bind to the portaled panel rather than the launcher host');
assert.match(panel, /document\.getElementById\(ROOT_ID\)[\s\S]*openMemoryCenter\(memoryPanel\?\.hasAttribute\('hidden'\)\)/u,
    'the launcher must resolve the portaled panel by id');
assert.match(panel, /phoneLauncherQuery\?\.matches[\s\S]*document\.body\.appendChild\(drawer\)/u,
    'the launcher must leave SillyTavern hidden phone hosts and remain reachable');
assert.match(panel, /backdrop\.removeAttribute\('hidden'\)[\s\S]*document\.body\.classList\.add\('lm-memory-center-open'\)/u,
    'opening the memory center must activate a viewport-blocking modal layer');
assert.match(panel, /backdrop\.setAttribute\('hidden', ''\)[\s\S]*document\.body\.classList\.remove\('lm-memory-center-open'\)/u,
    'closing the memory center must restore the host page');

assert.match(css, /\.lm-task-rail:not\(\.lm-mobile-expanded\) \.lm-task-list \{ display: none; \}/u,
    'mobile tasks should default to a compact status bar');
assert.match(css, /@media \(max-height: 520px\) and \(max-width: 899px\)/u,
    'short landscape viewports need a dedicated layout');
assert.match(css, /@media \(max-width: 360px\) and \(max-height: 650px\)/u,
    'very small portrait phones need a compact footer and tab layout');
assert.match(css, /\.lm-header-metrics \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u,
    'phone metrics should reserve a readable full row for the connection status');
assert.match(css, /\.lm-icon-button \{ width: 44px !important; height: 44px !important;/u,
    'coarse pointers must override the host-enforced icon button size');
assert.match(css, /\.lm-button-primary \{ color: var\(--lm-on-accent\)/u,
    'primary actions must use the audited high-contrast foreground');
assert.doesNotMatch(css, /color: inherit;\s*font: inherit/u,
    'host button normalization must not override component contrast and type sizes');
assert.match(css, /\.lm-dialog input,[\s\S]*\.lm-dialog textarea \{/u,
    'body-level dialogs must own their form foreground and background styles');
assert.match(css, /height: calc\(100dvh - 58px\)/u,
    'tablet and narrow desktop panels need a definite height, not only a max-height');
assert.match(css, /\.layered-memory-root \{[\s\S]*right: 0;[\s\S]*left: 0;[\s\S]*margin-inline: auto;/u,
    'the desktop memory center must be centered instead of anchored to the right edge');
assert.match(css, /@media \(max-width: 899px\)[\s\S]*\.layered-memory-root \{[^}]*margin-inline: 0;/u,
    'narrow layouts must reset desktop centering margins and continue filling the viewport');
assert.match(css, /\.lm-body \{[\s\S]*scroll-padding-bottom: 92px/u,
    'focused phone settings must scroll clear of the sticky save bar');
assert.match(css, /\.lm-memory-backdrop \{[\s\S]*z-index: 2147483000/u,
    'the modal backdrop must sit above hostile host controls');
assert.match(css, /\.layered-memory-root \{[\s\S]*z-index: 2147483001/u,
    'the memory center must sit above its modal backdrop');
assert.match(css, /--lm-type-caption: 0\.875rem/u,
    'the smallest visible text token must remain readable');
assert.match(css, /\.lm-backfill-heading b,[\s\S]*font-weight: 700/u,
    'history backfill progress must use readable body-sized bold text');
assert.match(css, /\.lm-metric b \{[^}]*font-size: var\(--lm-type-body\)/u,
    'header metric numbers must use the full body size');
assert.match(css, /\.lm-turn-records > summary \{[^}]*min-height: 44px[^}]*font-size: var\(--lm-type-small\)[^}]*font-weight: 700/u,
    'per-turn disclosures must remain readable and touch-friendly');
assert.match(css, /\.lm-turn-records li \{ grid-template-columns: 1fr; gap: 2px; \}/u,
    'per-turn records must collapse to one column on phones');
assert.match(css, /@media \(max-width: 899px\)[\s\S]*\.lm-rebuild-workflows \{ grid-template-columns: 1fr; \}/u,
    'the two independent workflow cards must stack on narrow screens');
assert.match(css, /@media \(max-width: 599px\)[\s\S]*\.lm-fact-overview button \{ min-height: 58px/u,
    'fact ledger filters must stay touch-friendly on phones');
assert.match(css, /\.lm-injection-footer \{ grid-template-columns: minmax\(0, 1fr\)/u,
    'phone injection preview must not overflow beside a second fixed-width column');
assert.match(panel, /data-candidate-action="activate">加入生效事实/u,
    'inactive discoveries must expose a direct activation action');
assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-3])px/u,
    'visible text must not use fixed pixel sizes below 14px');

console.log('mobile UI smoke: responsive and readable timeline passed');
