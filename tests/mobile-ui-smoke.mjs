import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panel, css] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../style.css', import.meta.url), 'utf8'),
]);

assert.match(panel, /value="cancel" formnovalidate[^>]*aria-label="关闭"/u,
    'the entry dialog close button must bypass required-field validation');
assert.match(panel, /value="cancel" formnovalidate[^>]*>取消</u,
    'the entry dialog cancel button must bypass required-field validation');
assert.match(panel, /class="lm-task-disclosure" aria-expanded="false"/u,
    'mobile task status must expose an accessible disclosure control');
assert.match(panel, /body\.classList\.toggle\('lm-state-body', tab === 'state'\)/u,
    'the state page must opt into the mobile fixed-rail layout');

assert.match(css, /\.lm-task-rail:not\(\.lm-mobile-expanded\) \.lm-task-list \{ display: none; \}/u,
    'mobile tasks should default to a compact status bar');
assert.match(css, /@media \(max-height: 520px\) and \(max-width: 899px\)/u,
    'short landscape viewports need a dedicated layout');
assert.match(css, /\.lm-header-metrics \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u,
    'phone metrics should reflow instead of relying on horizontal scrolling');
assert.match(css, /\.lm-icon-button \{ width: 44px !important; height: 44px !important;/u,
    'coarse pointers must override the host-enforced icon button size');

console.log('mobile UI smoke: 8/8 passed');
