import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { VOLUME_SYSTEM } from './prompts.js';
import { appendLog, assertChatData, getChatData, getSettings, saveChatData } from './settings.js';
import { renderL2Block } from './render.js';
import { estimateTokens } from './tokens.js';

function countMentionsInText(text, name) {
    if (!text || !name) {
        return 0;
    }
    let count = 0;
    let idx = 0;
    const n = String(name);
    const hay = String(text);
    while ((idx = hay.indexOf(n, idx)) !== -1) {
        count += 1;
        idx += n.length;
    }
    return count;
}

function buildMustKeepList(chaptersToCompress, laterChapters, stateTable, mode) {
    const names = new Map();
    const laterBlob = laterChapters.map(c => c.summary || '').join('\n');
    const tableBlob = (stateTable.entries || []).map(e => `${e.subject} ${e.object || ''} ${e.value}`).join('\n');

    const consider = (name) => {
        if (!name || name.length < 2) {
            return;
        }
        const inLater = countMentionsInText(laterBlob, name) + countMentionsInText(tableBlob, name);
        names.set(name, (names.get(name) || 0) + inLater);
    };

    for (const ch of chaptersToCompress) {
        for (const kw of ch.keywords || []) {
            consider(kw);
        }
        // crude entity pull from summary: skip
    }

    const must = [];
    for (const [name, cnt] of names.entries()) {
        if (cnt >= 3) {
            must.push(name);
        }
    }

    // Associated with state table: do NOT hard-exclude from summary; just don't force into list.
    // (already not forcing those that only appear in table)

    if (mode === 'full_text') {
        // Optional heavier path left as same list for now; caller may expand later
    }

    return [...new Set(must)].slice(0, 30);
}

export async function handleVolumeCompressJob(payload = {}) {
    const settings = getSettings();
    const data = getChatData();

    // If forcing stale volume regen
    if (payload.force && payload.staleVolumes?.length) {
        for (const vid of payload.staleVolumes) {
            await recompressVolume(vid, data);
            assertChatData(data);
        }
        return;
    }

    const l2 = renderL2Block(data, { forBudget: true });
    if (estimateTokens(l2) <= (settings.budgetL2 || 5000) && !payload.force) {
        return;
    }

    if (settings.volumeCompressConfirm && !payload.confirmed) {
        const already = (data.review_queue || []).some(x => x.kind === 'volume_compress_ask');
        if (!already) {
            data.review_queue.push({
                id: crypto.randomUUID(),
                kind: 'volume_compress_ask',
                note: '较早的剧情摘要已经接近容量上限。是否把最早的几章精简成一份长期摘要？',
                createdAt: Date.now(),
            });
            await saveChatData(data);
            appendLog('info', '卷压缩等待用户确认');
        }
        return;
    }

    const activeChapters = (data.chapters || [])
        .filter(c => !c.demoted && !c.pinned)
        .sort((a, b) => a.floor_range[0] - b.floor_range[0]);

    if (activeChapters.length < 8) {
        appendLog('info', '章数不足，跳过卷压缩');
        return;
    }

    const toCompress = activeChapters.slice(0, Math.min(10, activeChapters.length - 2));
    const later = activeChapters.slice(toCompress.length);
    const mustKeep = buildMustKeepList(toCompress, later, data.state_table, settings.mentionStatMode);

    const input = toCompress.map(c => `### ${c.id} [${c.floor_range[0]}-${c.floor_range[1]}]\n${c.summary}`).join('\n\n');
    const userPrompt = `必须保留清单（下列名称必须出现在卷摘要中）：\n${mustKeep.join('、') || '（无）'}\n\n章节摘要：\n${input}`;

    let summary = '';
    let missing = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        const missingNote = attempt === 0 ? '' : `\n上次缺失：${missing.join('、')}。请全部写入。`;
        const { text } = await callAuxModel({
            purpose: 'volume_compress',
            systemPrompt: VOLUME_SYSTEM,
            userPrompt: userPrompt + missingNote,
            temperature: 0.2,
        });
        assertChatData(data);
        const raw = parseJsonFromModel(text) || { summary: text };
        summary = String(raw.summary || '');
        missing = mustKeep.filter(n => !summary.includes(n));
        if (!missing.length) {
            break;
        }
        if (attempt === 1) {
            appendLog('error', '卷压缩验收失败，已中止', { missing });
            data.review_queue.push({
                id: crypto.randomUUID(),
                kind: 'alert',
                note: `精简旧剧情时漏掉了这些重要名称：${missing.join('、')}。原摘要已保留，请稍后重新处理。`,
                createdAt: Date.now(),
            });
            await saveChatData(data);
            return;
        }
    }

    const volId = `vol_${String((data.volumes?.length || 0) + 1).padStart(3, '0')}`;
    data.volumes = data.volumes || [];
    data.volumes.push({
        id: volId,
        summary,
        chapter_ids: toCompress.map(c => c.id),
        stale: false,
        pinned: false,
    });
    for (const c of toCompress) {
        c.demoted = true;
        c.volume_id = volId;
    }
    await saveChatData(data);
    appendLog('info', `卷压缩完成 ${volId}`);
}

async function recompressVolume(volId, data = getChatData()) {
    const vol = (data.volumes || []).find(v => v.id === volId);
    if (!vol) {
        return;
    }
    const chapters = (data.chapters || []).filter(c => vol.chapter_ids.includes(c.id));
    // Temporarily treat as toCompress set
    const later = (data.chapters || []).filter(c => !vol.chapter_ids.includes(c.id) && !c.demoted);
    const mustKeep = buildMustKeepList(chapters, later, data.state_table, getSettings().mentionStatMode);
    const input = chapters.map(c => `### ${c.id}\n${c.summary}`).join('\n\n');
    const { text } = await callAuxModel({
        purpose: 'volume_compress',
        systemPrompt: VOLUME_SYSTEM,
        userPrompt: `必须保留清单：${mustKeep.join('、') || '（无）'}\n\n${input}`,
        temperature: 0.2,
    });
    assertChatData(data);
    const raw = parseJsonFromModel(text) || { summary: text };
    const summary = String(raw.summary || '');
    const missing = mustKeep.filter(n => !summary.includes(n));
    if (missing.length) {
        appendLog('error', 'stale 卷重压验收失败', { missing });
        return;
    }
    vol.summary = summary;
    vol.stale = false;
    await saveChatData(data);
}
