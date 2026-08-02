import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [manifestText, indexSource, injectionSource, renderSource, constantsSource, settingsSource, panelSource] = await Promise.all([
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../index.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/inject.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/render.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/constants.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/settings.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/panel.js', import.meta.url), 'utf8'),
]);

const manifest = JSON.parse(manifestText);
assert.equal(Object.hasOwn(manifest, 'generate_interceptor'), false,
    'plugin must not receive or mutate SillyTavern generation chat arrays');

for (const [name, source] of Object.entries({
    'index.js': indexSource,
    'src/inject.js': injectionSource,
    'src/constants.js': constantsSource,
    'src/settings.js': settingsSource,
    'src/ui/panel.js': panelSource,
})) {
    assert.doesNotMatch(source, /historyBudgetMode|historyTokenBudget|minRecentPairs|recentPairs|context_handoff/u,
        `${name} must not retain the removed chat-budget mechanism`);
}

assert.doesNotMatch(indexSource, /layeredMemoryIntercept|trimChatForGenerate/u,
    'runtime must not expose a generation interceptor');
assert.doesNotMatch(injectionSource, /HISTORY_PERCENT|resolveHistoryBudget|chat\.splice/u,
    'injection code must not estimate context percentages or trim request messages');
assert.doesNotMatch(renderSource, /throughPair|removed prefix/u,
    'L2 rendering must not depend on a removed-chat boundary');
assert.doesNotMatch(panelSource, /希望保留多少最近剧情|自定义聊天历史容量|至少保留最近几轮完整对话/u,
    'settings must not expose removed trimming controls');
assert.match(injectionSource, /selectRecentRawWindow\(resolvedNarrativeSources, settings\.recentRawTokens\)/u,
    'the plugin must select a fixed whole-floor raw suffix without reading provider context');
assert.match(injectionSource, /setExtensionPrompt\(PROMPT_KEYS\.L1, usePresetAnchor \? '' : core/u,
    'compatibility injection must preserve core-memory ordering in one prompt');
assert.doesNotMatch(injectionSource, /const l2 = '';/u,
    'L2 must no longer be silently withheld');

console.log('no context trimming smoke: percentage budget and request mutation are absent');
