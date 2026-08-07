export const BACKSTAGE_MARKER_EXTRA = 'layered_memory_backstage_marker';
export const BACKSTAGE_OUTPUT_EXTRA = 'layered_memory_backstage';
export const BACKSTAGE_RESPONSE_TOKENS = 768;

const BACKSTAGE_STATE_VERSION = 1;

function clone(value) {
    return structuredClone(value);
}

function uuid() {
    return globalThis.crypto?.randomUUID?.()
        || `backstage-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanText(value) {
    return String(value ?? '').trim();
}

function blankState() {
    return {
        version: BACKSTAGE_STATE_VERSION,
        activeSessionId: null,
        pendingGeneration: null,
        sessions: [],
    };
}

function normalizeMessage(message) {
    return {
        id: String(message?.id || uuid()),
        role: message?.role === 'narrator' ? 'narrator' : 'user',
        text: cleanText(message?.text),
        createdAt: Number(message?.createdAt) || Date.now(),
    };
}

function normalizeRevision(revision) {
    return {
        id: String(revision?.id || uuid()),
        messages: Array.isArray(revision?.messages) ? revision.messages.map(normalizeMessage) : [],
        rejectedDraft: cleanText(revision?.rejectedDraft),
        createdAt: Number(revision?.createdAt) || Date.now(),
        markerMessageKey: revision?.markerMessageKey || null,
        targetMessageKey: revision?.targetMessageKey || null,
        status: ['pending', 'generated', 'interrupted'].includes(revision?.status)
            ? revision.status
            : 'pending',
    };
}

function normalizeWorking(working) {
    if (!working) return null;
    return {
        baseRevisionId: working.baseRevisionId || null,
        messages: Array.isArray(working.messages) ? working.messages.map(normalizeMessage) : [],
        rejectedDraft: cleanText(working.rejectedDraft),
        composerDraft: String(working.composerDraft ?? ''),
        updatedAt: Number(working.updatedAt) || Date.now(),
    };
}

function normalizeSession(session) {
    return {
        id: String(session?.id || uuid()),
        anchorMessageKey: session?.anchorMessageKey || null,
        markerMessageKey: session?.markerMessageKey || null,
        createdAt: Number(session?.createdAt) || Date.now(),
        updatedAt: Number(session?.updatedAt) || Date.now(),
        status: ['draft', 'generated', 'closed'].includes(session?.status) ? session.status : 'draft',
        working: normalizeWorking(session?.working),
        revisions: Array.isArray(session?.revisions) ? session.revisions.map(normalizeRevision) : [],
    };
}

export function ensureBackstageState(data) {
    if (!data.backstage || typeof data.backstage !== 'object') {
        data.backstage = blankState();
    }
    const state = data.backstage;
    const needsMigration = Number(state.version) !== BACKSTAGE_STATE_VERSION;
    state.version = BACKSTAGE_STATE_VERSION;
    state.activeSessionId = state.activeSessionId || null;
    state.pendingGeneration = state.pendingGeneration && typeof state.pendingGeneration === 'object'
        ? state.pendingGeneration
        : null;
    state.sessions = Array.isArray(state.sessions)
        ? needsMigration
            ? state.sessions.map(normalizeSession)
            : state.sessions.filter(session => session && typeof session === 'object')
        : [];
    return state;
}

export function isBackstageMarker(message) {
    return Boolean(message?.extra?.[BACKSTAGE_MARKER_EXTRA]?.sessionId);
}

export function backstageMarkerMeta(message) {
    return isBackstageMarker(message) ? message.extra[BACKSTAGE_MARKER_EXTRA] : null;
}

export function backstageOutputMeta(message) {
    const value = message?.extra?.[BACKSTAGE_OUTPUT_EXTRA];
    return value?.sessionId && value?.revisionId ? value : null;
}

export function createBackstageSession(data, { anchorMessageKey = null } = {}) {
    const state = ensureBackstageState(data);
    const now = Date.now();
    const session = normalizeSession({
        id: uuid(),
        anchorMessageKey,
        createdAt: now,
        updatedAt: now,
        status: 'draft',
        working: {
            baseRevisionId: null,
            messages: [],
            rejectedDraft: '',
            composerDraft: '',
            updatedAt: now,
        },
        revisions: [],
    });
    state.sessions.push(session);
    state.activeSessionId = session.id;
    return session;
}

export function getBackstageSession(data, sessionId) {
    if (!sessionId) return null;
    return ensureBackstageState(data).sessions.find(session => session.id === sessionId) || null;
}

export function getBackstageRevision(session, revisionId) {
    if (!session || !revisionId) return null;
    return session.revisions.find(revision => revision.id === revisionId) || null;
}

export function setBackstageWorkingCopy(data, sessionId, {
    baseRevisionId = null,
    messages = [],
    rejectedDraft = '',
    composerDraft = '',
} = {}) {
    const session = getBackstageSession(data, sessionId);
    if (!session) throw new Error('找不到这次幕间讨论');
    session.working = normalizeWorking({ baseRevisionId, messages, rejectedDraft, composerDraft, updatedAt: Date.now() });
    session.status = 'draft';
    session.updatedAt = Date.now();
    ensureBackstageState(data).activeSessionId = session.id;
    return session.working;
}

export function appendBackstageMessage(data, sessionId, role, text) {
    const session = getBackstageSession(data, sessionId);
    if (!session?.working) throw new Error('幕间讨论还没有准备好');
    const value = cleanText(text);
    if (!value) throw new Error('先写下想对叙述者说的话');
    const message = normalizeMessage({ id: uuid(), role, text: value, createdAt: Date.now() });
    session.working.messages.push(message);
    if (role === 'user') session.working.composerDraft = '';
    session.working.updatedAt = Date.now();
    session.updatedAt = Date.now();
    return message;
}

export function setBackstageComposerDraft(data, sessionId, text) {
    const session = getBackstageSession(data, sessionId);
    if (!session?.working) return false;
    session.working.composerDraft = String(text ?? '');
    session.working.updatedAt = Date.now();
    session.updatedAt = Date.now();
    return true;
}

export function clearBackstageWorkingCopy(data, sessionId) {
    const session = getBackstageSession(data, sessionId);
    if (!session?.working) return false;
    const working = session.working;
    const changed = Boolean(
        working.messages.length
        || working.composerDraft
        || working.rejectedDraft,
    );
    working.messages = [];
    working.composerDraft = '';
    working.rejectedDraft = '';
    working.updatedAt = Date.now();
    session.updatedAt = Date.now();
    return changed;
}

export function createBackstageRevision(data, sessionId) {
    const session = getBackstageSession(data, sessionId);
    if (!session?.working?.messages?.length) throw new Error('还没有可以带回剧情的幕间讨论');
    const revision = normalizeRevision({
        id: uuid(),
        messages: clone(session.working.messages),
        rejectedDraft: session.working.rejectedDraft,
        createdAt: Date.now(),
        status: 'pending',
    });
    session.revisions.push(revision);
    session.updatedAt = Date.now();
    return revision;
}

export function markerDisplayText(revision) {
    const count = Array.isArray(revision?.messages) ? revision.messages.length : 0;
    return `幕间讨论 · ${count} 条对话`;
}

function renderTranscript(messages) {
    return messages.map(message => {
        const speaker = message.role === 'narrator' ? '叙述者' : '玩家';
        return `【${speaker}】\n${cleanText(message.text)}`;
    }).join('\n\n');
}

export function formatBackstagePlayerInput(revision) {
    if (!revision) throw new Error('缺少幕间讨论版本');
    const sections = [
        '【幕间交流开始｜以下不是剧情中已经发生的事件】',
        '这是玩家与刚才那位叙述者在剧情暂停期间进行的完整讨论。请理解整段交流，并在接下来的正文中遵守双方最后达成的方向。',
        '较晚的修改、否定和反悔覆盖较早的提议；叙述者提出但玩家没有同意的内容不得擅自采用。不要把讨论当成角色知道的事实，也不要在正文中提及幕间、讨论、约定或“玩家要求”。',
        renderTranscript(revision.messages),
    ];
    if (revision.rejectedDraft) {
        sections.push([
            '【未采用的正文草稿｜不是正史】',
            revision.rejectedDraft,
            '玩家没有采用这版正文。请从后续幕间纠正中理解问题，不要把这份草稿当成已经发生的剧情。',
        ].join('\n'));
    }
    sections.push(
        '【玩家结束幕间】\n可以了，继续！',
        '【幕间交流结束】\n现在立即回到剧情暂停的位置，只输出自然衔接的下一段正文。',
    );
    return sections.filter(Boolean).join('\n\n');
}

export function buildBackstageDiscussionRequest(session, {
    narratorName = '叙述者',
    l2 = '',
    raw = '',
} = {}) {
    const working = session?.working;
    if (!working?.messages?.length) throw new Error('还没有幕间对话');
    const sections = [
        `你是刚才讲述这段故事的同一个叙述者${narratorName ? `（${narratorName}）` : ''}。剧情现在暂停，玩家正在幕间直接和你说话。`,
        '摘下叙事面具，以叙述者本人的口吻坦率交流：可以解释你刚才的叙事意图、承认连续性问题、提出走向，也必须接受玩家的否定和修改。此刻不要续写剧情，不要扮演剧情中的角色，不要替玩家作决定。',
        '只回复玩家能看到的自然纯文本对话。不要输出 JSON、标签、状态说明或正文，也不要使用 Markdown 标题、列表、粗体、引用、行内代码或代码块等格式语法。',
        '你只能依据下面的剧情摘要、最近完整正文和本次幕间对话回答。不要假设你还收到了角色卡、世界书、作者注释、正文预设、事实表、关键词召回或更早的原生聊天记录。',
    ];
    if (l2) sections.push(`【前文剧情摘要】\n${String(l2).trim()}`);
    if (raw) sections.push(`【最近完整正文】\n${String(raw).trim()}`);
    if (!l2 && !raw) sections.push('【剧情资料】\n当前没有可用的前文摘要或最近正文。');
    if (working.rejectedDraft) {
        sections.push([
            '下面是玩家刚刚没有采用的正文草稿。它不是正史；请帮助玩家说清哪里没有对上。',
            '【未采用草稿】',
            working.rejectedDraft,
        ].join('\n'));
    }
    return {
        systemPrompt: sections.join('\n\n'),
        prompt: working.messages.map(message => ({
            role: message.role === 'narrator' ? 'assistant' : 'user',
            content: cleanText(message.text),
        })),
        responseLength: BACKSTAGE_RESPONSE_TOKENS,
        quietToLoud: true,
        trimNames: false,
    };
}

export function markBackstageMarkerMessage(message, session, revision) {
    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    message.extra.isSmallSys = true;
    message.extra.display_text = markerDisplayText(revision);
    message.extra[BACKSTAGE_MARKER_EXTRA] = {
        sessionId: session.id,
        revisionId: revision.id,
    };
    return message;
}

export function markBackstageOutputMessage(message, sessionId, revisionId) {
    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    message.extra[BACKSTAGE_OUTPUT_EXTRA] = { sessionId, revisionId };
    return message;
}

export function closeBackstageSessions(data, { exceptSessionId = null } = {}) {
    const state = ensureBackstageState(data);
    for (const session of state.sessions) {
        if (session.id === exceptSessionId || session.status === 'closed') continue;
        session.status = 'closed';
        session.working = null;
        session.updatedAt = Date.now();
    }
    if (state.activeSessionId !== exceptSessionId) state.activeSessionId = exceptSessionId;
}
