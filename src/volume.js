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

export function validateVolumeResult(raw, chapters, mustKeep = []) {
    const summary = String(raw?.summary || '').trim();
    const expectedIds = chapters.map(chapter => chapter.id);
    const coveredIds = Array.isArray(raw?.covered_chapter_ids) ? raw.covered_chapter_ids.map(String) : [];
    const missingNames = mustKeep.filter(name => !summary.includes(name));
    const coverageOk = coveredIds.length === expectedIds.length
        && coveredIds.every((id, index) => id === expectedIds[index]);
    const errors = [];
    if (!summary) errors.push('长期摘要为空');
    if (!coverageOk) errors.push(`章节覆盖必须依次包含 ${expectedIds.join('、')}`);
    if (missingNames.length) errors.push(`缺少必须保留的名称：${missingNames.join('、')}`);
    return { ok: errors.length === 0, errors, summary, coveredIds, missingNames };
}

async function createValidatedVolume(chapters, mustKeep, userPrompt, data) {
    let retryNote = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const { text } = await callAuxModel({
            purpose: 'volume_compress',
            systemPrompt: VOLUME_SYSTEM,
            userPrompt: `${userPrompt}${retryNote ? `\n\n上次输出没有通过校验：${retryNote}。请完整修正。` : ''}`,
            temperature: 0.2,
        });
        assertChatData(data);
        const checked = validateVolumeResult(parseJsonFromModel(text), chapters, mustKeep);
        if (checked.ok) return checked.summary;
        retryNote = checked.errors.join('；');
    }
    return null;
}

export async function handleVolumeCompressJob(payload = {}) {
    const settings = getSettings();
    const data = getChatData();
    const useNarrative = Boolean(payload.narrative || (data.narrative_chapters || []).length);
    const chapters = useNarrative ? (data.narrative_chapters || []) : (data.chapters || []);
    const volumes = useNarrative ? (data.narrative_volumes || []) : (data.volumes || []);

    // If forcing stale volume regen
    if (payload.force && payload.staleVolumes?.length) {
        for (const vid of payload.staleVolumes) {
            await recompressVolume(vid, data, useNarrative);
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

    const activeChapters = chapters
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

    const summary = await createValidatedVolume(toCompress, mustKeep, userPrompt, data);
    if (!summary) {
        appendLog('error', '卷压缩覆盖验收失败，已中止');
        data.notices = data.notices || [];
        data.notices.push({
            id: crypto.randomUUID(),
            kind: 'notice',
            note: '精简旧剧情时没有覆盖全部章节或漏掉了重要名称。原摘要已保留，请稍后重试。',
            createdAt: Date.now(),
        });
        await saveChatData(data);
        return;
    }

    const volId = `${useNarrative ? 'nvol' : 'vol'}_${String(volumes.length + 1).padStart(3, '0')}`;
    if (useNarrative) data.narrative_volumes = data.narrative_volumes || [];
    else data.volumes = data.volumes || [];
    const targetVolumes = useNarrative ? data.narrative_volumes : data.volumes;
    targetVolumes.push({
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

async function recompressVolume(volId, data = getChatData(), narrative = String(volId).startsWith('nvol_')) {
    const volumes = narrative ? (data.narrative_volumes || []) : (data.volumes || []);
    const allChapters = narrative ? (data.narrative_chapters || []) : (data.chapters || []);
    const vol = volumes.find(v => v.id === volId);
    if (!vol) {
        return;
    }
    const chapters = allChapters.filter(c => vol.chapter_ids.includes(c.id));
    // Temporarily treat as toCompress set
    const later = allChapters.filter(c => !vol.chapter_ids.includes(c.id) && !c.demoted);
    const mustKeep = buildMustKeepList(chapters, later, data.state_table, getSettings().mentionStatMode);
    const input = chapters.map(c => `### ${c.id}\n${c.summary}`).join('\n\n');
    const summary = await createValidatedVolume(
        chapters,
        mustKeep,
        `必须保留清单：${mustKeep.join('、') || '（无）'}\n\n${input}`,
        data,
    );
    if (!summary) {
        appendLog('error', 'stale 卷重压覆盖验收失败');
        return;
    }
    vol.summary = summary;
    vol.stale = false;
    await saveChatData(data);
}
