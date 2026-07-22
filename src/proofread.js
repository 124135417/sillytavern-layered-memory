import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { PROOFREAD_SYSTEM } from './prompts.js';
import { renderStateTableCompact } from './merge.js';
import { appendLog, assertChatData, getChatData, saveChatData } from './settings.js';

export async function handleProofreadJob() {
    const data = getChatData();
    const chapters = (data.chapters || [])
        .filter(c => !c.stale)
        .sort((a, b) => b.floor_range[0] - a.floor_range[0])
        .slice(0, 4);

    if (!chapters.length) {
        appendLog('info', '校对跳过：无章节摘要');
        return;
    }

    const userPrompt = [
        '## 状态表\n',
        renderStateTableCompact(data.state_table),
        '\n\n## 最近章节摘要\n',
        chapters.map(c => `### ${c.id}\n${c.summary}`).join('\n\n'),
    ].join('');

    const { text } = await callAuxModel({
        purpose: 'proofread',
        systemPrompt: PROOFREAD_SYSTEM,
        userPrompt,
        temperature: 0,
    });
    assertChatData(data);

    const raw = parseJsonFromModel(text) || { suggestions: [] };
    const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : [];
    for (const s of suggestions) {
        data.review_queue.push({
            id: crypto.randomUUID(),
            kind: 'proofread',
            op: s.op || 'flag',
            slot: s.slot,
            subject: s.subject,
            object: s.object || '',
            value: s.value || '',
            entry_id: s.entry_id || '',
            note: s.note || '',
            createdAt: Date.now(),
        });
    }
    await saveChatData(data);
    appendLog('info', `校对完成，建议 ${suggestions.length} 条进待审`);
}
