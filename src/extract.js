import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { getPairTexts, getPairs } from './ids.js';
import { mergeExtractResult, renderStateTableCompact } from './merge.js';
import { EXTRACT_JSON_SCHEMA, EXTRACT_SYSTEM } from './prompts.js';
import { appendLog, getChatData, getSettings, saveChatData } from './settings.js';
import { normalizeExtractOutput } from './validate.js';
import { QUEUE_PRIORITY } from './constants.js';
import { enqueue } from './queue.js';

async function runExtractOnce(pair, { retryNote = '' } = {}) {
    const data = getChatData();
    const { userText, aiText } = getPairTexts(pair);
    const sourceText = `${userText}\n${aiText}`;
    const tableRender = renderStateTableCompact(data.state_table);
    const userPrompt = [
        retryNote ? `上次校验失败原因：${retryNote}\n请修正后重新输出。\n` : '',
        '## 当前状态表\n',
        tableRender,
        '\n\n## 本楼用户输入\n',
        userText,
        '\n\n## 本楼 AI 回复\n',
        aiText,
    ].join('');

    const { text } = await callAuxModel({
        purpose: 'extract',
        systemPrompt: EXTRACT_SYSTEM,
        userPrompt,
        jsonSchema: EXTRACT_JSON_SCHEMA,
        temperature: 0,
    });

    const raw = parseJsonFromModel(text);
    if (!raw) {
        throw new Error('提取结果不是合法 JSON');
    }
    return { raw, sourceText, userText, aiText };
}

export async function handleExtractJob(payload) {
    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }

    const pairs = getPairs();
    const pair = pairs.find(p => p.floorKey === payload.floorKey)
        || pairs.find(p => p.pairIndex === payload.pairIndex);

    if (!pair?.sealed) {
        appendLog('warn', '提取跳过：找不到定格楼', payload);
        return;
    }

    const data = getChatData();
    if ((data.extracted_keys || []).includes(pair.floorKey)) {
        return;
    }

    let retryNote = '';
    let lastDiscarded = 0;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { raw, sourceText } = await runExtractOnce(pair, { retryNote });
            const normalized = normalizeExtractOutput(raw, 'per_floor');
            const result = await mergeExtractResult(normalized, {
                pipeline: 'per_floor',
                sourceText,
                stateTable: getChatData().state_table,
                floorKey: pair.floorKey,
                pairIndex: pair.pairIndex,
                floorLabel: pair.pairIndex,
                source: 'auto',
            });
            lastDiscarded = result.discarded;

            if (result.discarded > 0 && result.applied === 0 && attempt === 0) {
                retryNote = `有 ${result.discarded} 条未通过校验（evidence/实体/长度）`;
                continue;
            }

            const d = getChatData();
            d.extracted_keys = d.extracted_keys || [];
            if (!d.extracted_keys.includes(pair.floorKey)) {
                d.extracted_keys.push(pair.floorKey);
            }
            d.pending_floors = (d.pending_floors || []).filter(x => x.floorKey !== pair.floorKey);
            d.progress.pairs_since_proofread = (d.progress.pairs_since_proofread || 0) + 1;
            await saveChatData();

            appendLog('info', `提取完成 楼#${pair.pairIndex}: +${result.applied} 丢${result.discarded} 冲突${result.conflicts}`);

            maybeEnqueueChapter(pair.pairIndex);
            maybeEnqueueProofread();
            return;
        } catch (err) {
            if (attempt === 0) {
                retryNote = err?.message ?? String(err);
                continue;
            }
            appendLog('error', `提取失败 楼#${pair.pairIndex}: ${err?.message ?? err}`);
        }
    }
}

function maybeEnqueueChapter(pairIndex) {
    const settings = getSettings();
    const size = settings.chapterSize || 25;
    const data = getChatData();
    const lastEnd = data.progress.last_chapter_end_pair ?? -1;
    if ((pairIndex + 1) % size === 0 && pairIndex > lastEnd) {
        const start = pairIndex - size + 1;
        enqueue('chapter_summary', { startPair: start, endPair: pairIndex }, QUEUE_PRIORITY.chapter_summary);
    }
}

function maybeEnqueueProofread() {
    const settings = getSettings();
    const data = getChatData();
    const every = settings.proofreadEvery || 75;
    if ((data.progress.pairs_since_proofread || 0) >= every) {
        enqueue('proofread', {}, QUEUE_PRIORITY.proofread);
        data.progress.pairs_since_proofread = 0;
    }
}

export async function extractFromChapterSummary({ chapter, stateTableSnapshot }) {
    const summary = chapter.summary || '';
    const tableRender = renderStateTableCompact(stateTableSnapshot || getChatData().state_table);
    const userPrompt = [
        '## 当前状态表\n',
        tableRender,
        '\n\n## 章节摘要（迁移提取，evidence 须引自摘要）\n',
        summary,
        `\n\n楼层区间：${chapter.floor_range?.[0]}–${chapter.floor_range?.[1]}`,
    ].join('');

    const { text } = await callAuxModel({
        purpose: 'extract',
        systemPrompt: EXTRACT_SYSTEM + '\n\n注意：当前输入是章节摘要而非楼层原文，evidence 必须是摘要中的子串。',
        userPrompt,
        jsonSchema: EXTRACT_JSON_SCHEMA,
        temperature: 0,
    });
    const raw = parseJsonFromModel(text);
    if (!raw) {
        throw new Error('迁移提取 JSON 解析失败');
    }
    const normalized = normalizeExtractOutput(raw, 'chapter');
    const floorLabel = chapter.id || `ch (${chapter.floor_range?.[0]}–${chapter.floor_range?.[1]})`;
    return mergeExtractResult(normalized, {
        pipeline: 'chapter',
        sourceText: summary,
        stateTable: getChatData().state_table,
        floorKey: `chapter:${chapter.id}`,
        floorLabel,
        source: 'auto',
    });
}
