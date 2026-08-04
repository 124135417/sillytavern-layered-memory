import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { getBaselinePair, getPairTexts, getPairs } from './ids.js';
import { mergeExtractResult, renderStateTableCompact } from './merge.js';
import { EXTRACT_JSON_SCHEMA, EXTRACT_SYSTEM } from './prompts.js';
import { appendLog, assertChatData, getChatData, getSettings, saveChatData } from './settings.js';
import { normalizeExtractOutput } from './validate.js';
import { QUEUE_PRIORITY } from './constants.js';
import { enqueue } from './queue.js';
import { extractAiBody } from './body.js';

const extractCommitStateByChat = new WeakMap();
const EXTRACT_MUTATION_KEYS = [
    'state_table',
    'turn_summaries',
    'review_queue',
    'fact_ledger',
    'floor_events',
    'progress',
    'logs',
];

function reserveExtractCommit(data) {
    let state = extractCommitStateByChat.get(data);
    if (!state) {
        state = { tail: Promise.resolve(), pending: 0 };
        extractCommitStateByChat.set(data, state);
    }
    const previous = state.tail.catch(() => {});
    let resolveCurrent;
    const current = new Promise(resolve => { resolveCurrent = resolve; });
    state.tail = previous.then(() => current);
    state.pending += 1;
    let released = false;
    return {
        previous,
        release() {
            if (released) return;
            released = true;
            resolveCurrent();
            state.pending -= 1;
            if (state.pending === 0) extractCommitStateByChat.delete(data);
        },
    };
}

function captureExtractMutationState(data) {
    return Object.fromEntries(EXTRACT_MUTATION_KEYS.map(key => [key, structuredClone(data[key])]));
}

function restoreExtractMutationState(data, snapshot) {
    for (const key of EXTRACT_MUTATION_KEYS) data[key] = snapshot[key];
}

async function runExtractOnce(pair, { retryNote = '' } = {}) {
    const data = getChatData();
    const { userText, aiText } = getPairTexts(pair);
    const body = extractAiBody(aiText, getSettings().bodyExtractionRegex);
    const sourceText = `${userText}\n${body.text}`;
    const tableRender = renderStateTableCompact(data.state_table);
    const userPrompt = [
        retryNote ? `上次校验失败原因：${retryNote}\n请修正后重新输出。\n` : '',
        '## 当前状态表\n',
        tableRender,
        '\n\n## 本楼用户输入\n',
        userText,
        '\n\n## 本楼 AI 回复\n',
        body.text,
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
    return { raw, sourceText, userText, aiText: body.text, bodyMode: body.mode };
}

async function prepareExtract(pair, payload, retryNote = '') {
    const { raw, sourceText, bodyMode } = await runExtractOnce(pair, { retryNote });
    const normalized = normalizeExtractOutput(raw, 'per_floor');
    if (!normalized.turnSummary) throw new Error('逐轮剧情记录为空或过长');
    if (payload.summaryOnly) {
        normalized.adds = [];
        normalized.updates = [];
        normalized.conflicts = [];
    }
    return { normalized, sourceText, bodyMode };
}

function extractionAlreadyComplete(data, pair, payload) {
    const keys = data.extracted_keys || [];
    const alreadyExtracted = keys.includes(pair.floorKey) || keys.includes(`migrated:${pair.floorKey}`);
    const alreadySummarized = (data.turn_summaries || []).some(item => item.floorKey === pair.floorKey && item.summary);
    return (alreadySummarized && alreadyExtracted)
        || (alreadySummarized && payload.summaryOnly)
        || (alreadyExtracted && !payload.summaryOnly);
}

async function commitPreparedExtract({ prepared, pair, payload, originData, attempt }) {
    const snapshot = captureExtractMutationState(originData);
    try {
        const result = mergeExtractResult(prepared.normalized, {
            pipeline: 'per_floor',
            sourceText: prepared.sourceText,
            stateTable: getChatData().state_table,
            floorKey: pair.floorKey,
            contentFingerprint: pair.contentFingerprint,
            pairIndex: pair.pairIndex,
            floorLabel: pair.pairIndex,
            source: 'auto',
            bodyMode: prepared.bodyMode,
            persist: false,
        });
        assertChatData(originData);
        if (!payload.summaryOnly && result.discarded > 0 && result.applied === 0 && attempt === 0) {
            restoreExtractMutationState(originData, snapshot);
            return {
                retry: true,
                retryNote: `有 ${result.discarded} 条未通过最新事实表校验（evidence/实体/旧值/长度）`,
            };
        }

        if (!payload.summaryOnly) {
            originData.extracted_keys = originData.extracted_keys || [];
            if (!originData.extracted_keys.includes(pair.floorKey)) originData.extracted_keys.push(pair.floorKey);
            originData.pending_floors = (originData.pending_floors || []).filter(x => x.floorKey !== pair.floorKey);
            originData.progress.pairs_since_proofread = (originData.progress.pairs_since_proofread || 0) + 1;
        }
        await saveChatData(originData);
        return { retry: false, result };
    } catch (error) {
        restoreExtractMutationState(originData, snapshot);
        throw error;
    }
}

export async function handleExtractJob(payload) {
    const originData = getChatData();
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

    const baseline = getBaselinePair();
    if (!payload.ignoreBaseline && pair.pairIndex <= baseline) {
        return;
    }

    // Skip if already extracted live, or covered by migration (migrated:<floorKey>).
    if (extractionAlreadyComplete(getChatData(), pair, payload)) return;

    const commit = reserveExtractCommit(originData);
    let prepared = null;
    let preparationError = null;
    try {
        prepared = await prepareExtract(pair, payload);
    } catch (error) {
        preparationError = error;
    }

    await commit.previous;
    try {
        assertChatData(originData);
        if (extractionAlreadyComplete(getChatData(), pair, payload)) return;
        let retryNote = preparationError?.message ?? '';
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                if (attempt === 0 && preparationError) throw preparationError;
                const candidate = attempt === 0 ? prepared : await prepareExtract(pair, payload, retryNote);
                const committed = await commitPreparedExtract({
                    prepared: candidate,
                    pair,
                    payload,
                    originData,
                    attempt,
                });
                if (committed.retry) {
                    retryNote = committed.retryNote;
                    continue;
                }

                if (payload.summaryOnly) {
                    appendLog('info', `逐轮剧情补记完成 楼#${pair.pairIndex}`);
                    return;
                }
                appendLog('info', `提取完成 楼#${pair.pairIndex}: +${committed.result.applied} 丢${committed.result.discarded} 冲突${committed.result.conflicts}`);
                if (!payload.ignoreBaseline) {
                    maybeEnqueueChapter(pair.pairIndex);
                    maybeEnqueueProofread();
                }
                return;
            } catch (err) {
                if (err?.code === 'CHAT_SCOPE_CHANGED') throw err;
                assertChatData(originData);
                if (attempt === 0) {
                    retryNote = err?.message ?? String(err);
                    continue;
                }
                appendLog('error', `提取失败 楼#${pair.pairIndex}: ${err?.message ?? err}`);
                throw err;
            }
        }
    } finally {
        commit.release();
    }
}

/** Live chapters align to baseline+1, every chapterSize pairs. */
function maybeEnqueueChapter(pairIndex) {
    const settings = getSettings();
    const size = settings.chapterSize || 25;
    const data = getChatData();
    const baseline = getBaselinePair();
    if (pairIndex <= baseline) {
        return;
    }
    const liveOrdinal = pairIndex - baseline;
    if (liveOrdinal % size !== 0) {
        return;
    }
    const start = pairIndex - size + 1;
    if (start <= baseline) {
        return;
    }
    const lastEnd = data.progress.last_chapter_end_pair ?? -1;
    if (pairIndex <= lastEnd) {
        return;
    }
    enqueue('chapter_summary', { startPair: start, endPair: pairIndex }, QUEUE_PRIORITY.chapter_summary);
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
    const originData = getChatData();
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
    assertChatData(originData);
    const raw = parseJsonFromModel(text);
    if (!raw) {
        throw new Error('迁移提取 JSON 解析失败');
    }
    const normalized = normalizeExtractOutput(raw, 'chapter');
    const floorLabel = chapter.id || `ch (${chapter.floor_range?.[0]}–${chapter.floor_range?.[1]})`;
    return mergeExtractResult(normalized, {
        pipeline: 'chapter',
        sourceText: summary,
        stateTable: originData.state_table,
        floorKey: `chapter:${chapter.id}`,
        floorLabel,
        source: 'auto',
    });
}
