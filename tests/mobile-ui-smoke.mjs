import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panel, css] = await Promise.all([
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
    readFile(new URL('../style-v0.11.0.css', import.meta.url), 'utf8'),
]);

assert.match(panel, /id="lm-tab-turns"[^>]*data-tab="turns"[^>]*>对话记录</u);
assert.match(panel, /id="lm-tab-chapters"[^>]*data-tab="chapters"[^>]*>章节</u);
assert.match(panel, /id="lm-tab-review"[^>]*data-tab="review"[^>]*>待处理/u);
assert.match(panel, /class="lm-task-disclosure" aria-expanded="\$\{expanded \? 'true' : 'false'\}"/u,
    'task status needs a real accessible disclosure state');
assert.match(panel, /setHostInert\(true\)/u, 'opening must make the host page inert');
assert.match(panel, /setHostInert\(false\)/u, 'closing must restore the host page');
assert.match(panel, /element\.setAttribute\('inert', ''\)/u,
    'host isolation must use the inert attribute even when the host browser lacks a reflected property');
assert.match(panel, /trapPanelFocus\(event, panel\)/u, 'the main panel must trap Tab focus');
assert.match(panel, /lastDrawerTrigger\.focus/u, 'focus must return to the original launcher');
assert.match(panel, /const closedLabel = `查看 \$\{subject\}`;[\s\S]*const openLabel = `收起 \$\{subject\}`;/u,
    'record disclosures must update real visible text in both states');
assert.match(panel, /document\.body\.appendChild\(panel\)/u,
    'the panel must be portaled outside responsive host menus');
assert.match(panel, /GEOMETRY_STYLE_ID = 'layered-memory-viewport-geometry'/u,
    'critical viewport geometry needs a cache-safe runtime fallback');
assert.match(panel, /id="lm-proof-now"[^>]*>[\s\S]{0,160}检查记忆<\/span>/u,
    'the mobile proofread action must retain visible text');
assert.match(panel, /id="lm-add-entry"[^>]*>[\s\S]{0,160}添加记忆<\/button>/u,
    'the mobile add action must retain visible text');

assert.match(css, /--lm-space-1: 4px;[\s\S]*--lm-space-8: 32px;/u,
    'the shared 4/8/12/16/24/32 spacing scale must exist');
assert.match(css, /--lm-page-gutter: 24px/u, 'desktop page gutters must be 24px');
assert.match(css, /@media \(max-width: 599px\)[\s\S]*--lm-page-gutter: 16px/u,
    'phone page gutters must be 16px');
assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/u,
    'five phone navigation items must share equal width');
assert.match(css, /\.lm-tabs \{[^}]*overflow: hidden;/u,
    'phone navigation must not create horizontal scrolling');
assert.match(css, /\.lm-memory-toolbar \.lm-search,[\s\S]*grid-column: 1 \/ -1/u,
    'phone search must own a full row');
assert.match(css, /\.lm-card-actions \{[^}]*opacity: 1/u,
    'card actions must remain discoverable');
assert.match(css, /\.lm-task-rail:not\(\.lm-task-expanded\) \.lm-task-list/u,
    'collapsed task status must be compact');
assert.match(css, /\.lm-dashboard:has\(\.lm-task-rail:not\(\.lm-task-expanded\)\)/u,
    'collapsed desktop task status must use a single row');
assert.match(css, /\.lm-budget-chips \{ display: none; \}/u,
    'phone injection details must move into the preview');
assert.match(css, /@media \(max-width: 360px\) and \(max-height: 650px\)[\s\S]*\.lm-notice-strip,[\s\S]*\.lm-memory-toolbar select \{ display: none; \}/u,
    'very short phones must preserve the primary actions above low-priority detail');
assert.match(css, /\.lm-page-heading \{ display: grid; grid-template-columns: minmax\(0, 1fr\)/u,
    'phone page headings must use one column');
assert.match(css, /\.lm-button-danger/u, 'dangerous actions need a distinct button style');
assert.doesNotMatch(css, /lm-disclosure-label::before/u,
    'disclosure text must be real DOM text rather than generated CSS content');
assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[0-3])px/u,
    'visible text must not use fixed pixel sizes below 14px');

console.log('mobile UI smoke: spacing, responsive layout, and focus isolation passed');
