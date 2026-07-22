import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { STATE_GC_SYSTEM } from './prompts.js';
import { appendLog, assertChatData, getChatData, saveChatData } from './settings.js';

export async function handleStateGcJob() {
    const data = getChatData();
    const entries = data.state_table?.entries || [];
    if (entries.length < 8) {
        return;
    }

    const pinnedIds = new Set(entries.filter(e => e.pinned).map(e => e.id));
    const blob = entries.map(e => ({
        id: e.id,
        slot: e.slot,
        subject: e.subject,
        object: e.object,
        value: e.value,
        pinned: e.pinned,
    }));

    const { text } = await callAuxModel({
        purpose: 'state_gc',
        systemPrompt: STATE_GC_SYSTEM,
        userPrompt: JSON.stringify(blob, null, 2),
        temperature: 0,
    });
    assertChatData(data);

    const raw = parseJsonFromModel(text);
    if (!raw) {
        appendLog('warn', '状态表整理：JSON 解析失败');
        return;
    }

    const dropIds = new Set((raw.drop_ids || []).filter(id => !pinnedIds.has(id)));
    const before = entries.length;

    // Validate merges: subjects must come from merged entries
    for (const m of raw.merged || []) {
        const from = (m.from_ids || []).map(id => entries.find(e => e.id === id)).filter(Boolean);
        if (from.length < 2 || from.some(e => e.pinned)) {
            continue;
        }
        const entry = m.entry || {};
        const subjects = new Set(from.flatMap(e => [e.subject, e.object].filter(Boolean)));
        if (entry.subject && !subjects.has(entry.subject) && !from.some(e => e.subject === entry.subject)) {
            continue; // reject new facts
        }
        const keep = from[0];
        data.state_table.changelog.push({
            op: 'gc_merge',
            id: keep.id,
            from_ids: from.map(e => e.id),
            before: from.map(e => ({ id: e.id, value: e.value })),
            after: entry,
            at: Date.now(),
        });
        keep.value = entry.value || keep.value;
        keep.slot = entry.slot || keep.slot;
        keep.subject = entry.subject || keep.subject;
        keep.object = entry.object ?? keep.object;
        for (const e of from.slice(1)) {
            dropIds.add(e.id);
        }
    }

    data.state_table.entries = entries.filter(e => !dropIds.has(e.id));
    data.state_table.version += 1;
    await saveChatData(data);
    appendLog('info', `状态表整理：${before} → ${data.state_table.entries.length}`);
}
