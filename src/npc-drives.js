import { estimateTokens, evidenceInSource } from './tokens.js';

const clean = value => String(value ?? '').trim();
export const npcDriveId = name => `npc:${clean(name).normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ')}`;
export function npcDriveScope(context = {}) {
    if (context.groupId != null) return `group:${context.groupId}`;
    const avatar = context.characters?.[context.characterId]?.avatar;
    return avatar ? `card:${avatar}` : '';
}
export function authorNpcDrives(settings = {}, context = {}) {
    const rows = settings.npcAuthorDrives?.[npcDriveScope(context)];
    return Array.isArray(rows) ? rows : [];
}
export function setAuthorNpcDrive(settings, context, input) {
    const scope = npcDriveScope(context), character = clean(input.character), drive = clean(input.drive);
    if (!scope) throw new Error('请先打开一个角色或群聊');
    if (!character || character.length > 60 || !drive || drive.length > 200) throw new Error('请填写角色名（最多60字）和持续驱动力（最多200字）');
    settings.npcAuthorDrives ||= {};
    if (!Array.isArray(settings.npcAuthorDrives[scope])) settings.npcAuthorDrives[scope] = [];
    const rows = settings.npcAuthorDrives[scope], id = npcDriveId(character);
    const index = rows.findIndex(row => row.id === id);
    const row = { ...(index >= 0 ? rows[index] : {}), ...input, id, character, drive, source: 'author' };
    if (index >= 0) rows[index] = row; else rows.push(row);
    return row;
}
export function removeAuthorNpcDrive(settings, context, id) {
    const scope = npcDriveScope(context);
    if (settings.npcAuthorDrives?.[scope]) settings.npcAuthorDrives[scope] = settings.npcAuthorDrives[scope].filter(row => row.id !== id);
}
function matchingFact(data, reference) {
    return (data.state_table?.entries || []).find(entry => entry.id === reference.id
        && entry.subject === reference.subject && entry.value === reference.value);
}
export function effectiveNpcDrives(data = {}, settings = {}, context = {}, { includeHidden = false, generationType = null } = {}) {
    const rows = new Map((data.npc_drives || []).map(row => [row.id, { ...row, source: row.source || 'auto' }]));
    for (const author of authorNpcDrives(settings, context)) {
        const local = rows.get(author.id);
        const fallback = (author.progress_facts || []).map(ref => matchingFact(data, ref)).find(Boolean);
        rows.set(author.id, { ...local, ...author, progress: local ? local.progress || '' : fallback?.value || '',
            progressEvidence: local?.evidence || fallback?.evidence || '',
            progressFloor: local?.pairIndex ?? fallback?.updated_floor ?? null, source: 'author' });
    }
    return [...rows.values()].filter(row => row.drive).map(row => ({ ...row,
        visible: !(row.requires_secrets || []).some(id => globalThis.SillyTavernSecretSwitches?.isOpen?.(id, { generationType }) !== true),
    })).filter(row => includeHidden || row.visible)
        .sort((a, b) => (a.source === 'author' ? 0 : 1) - (b.source === 'author' ? 0 : 1) || a.character.localeCompare(b.character));
}
export function renderNpcDriveRows(rows) {
    if (!rows.length) return '';
    return ['## 角色持续驱动力',
        '驱动力影响角色在合适机会下的主动选择与反应，不要求每轮出场或重复索求，不替用户决定行动。一次实现可改变进展，长期渴望继续承接；较新剧情更新当前进展。',
        ...rows.map(row => `- ${row.character}${row.source === 'author' ? '（作者指定）' : ''}：${row.drive}${row.progress ? `\n  当前进展：${row.progress}` : ''}`),
    ].join('\n');
}
export function selectNpcDriveRows(data, settings, context, budget, options = {}) {
    const all = effectiveNpcDrives(data, settings, context, options), selected = [];
    for (const row of all) if (estimateTokens(renderNpcDriveRows([...selected, row])) <= budget) selected.push(row);
    const covered = new Set();
    for (const row of selected) for (const ref of [...(row.covered_facts || []), ...(row.progress_facts || [])]) {
        if (matchingFact(data, ref)) covered.add(ref.id);
    }
    return { rows: selected, text: renderNpcDriveRows(selected), total: all.length, covered };
}
export function renderNpcDriveReview(data, settings, context) {
    const rows = effectiveNpcDrives(data, settings, context);
    return ['## 已有角色驱动力（作者方向受保护，当前进展随分支）',
        rows.length ? rows.map(row => JSON.stringify({ character: row.character, drive: row.drive, progress: row.progress, author_fixed: row.source === 'author' })).join('\n') : '暂无；只在本次正文明确形成持续目的时建立，不要求每个出场人物都建一条。',
    ].join('\n');
}
export function snapshotNpcDriveTargets(data) {
    return Object.fromEntries((data.npc_drives || []).map(row => [row.id, structuredClone(row)]));
}
export function applyNpcDriveChanges(data, changes = []) {
    data.npc_drives ||= [];
    for (const change of changes) {
        data.npc_drives = data.npc_drives.filter(row => row.id !== change.id);
        if (change.after) data.npc_drives.push(structuredClone(change.after));
    }
}
export function applyNpcDriveUpdates(data, commands, ctx) {
    const changes = [], seen = new Set(), authors = ctx.authorDrives || [];
    for (const command of Array.isArray(commands) ? commands : []) {
        const character = clean(command?.character), id = npcDriveId(character), evidence = clean(command?.evidence);
        if (seen.has(id)) continue;
        seen.add(id);
        const before = data.npc_drives?.find(row => row.id === id) || null;
        const shown = ctx.npcDriveTargets?.[id] || null;
        const author = authors.find(row => row.id === id);
        if (!character || character.length > 60 || !evidence || evidence.length > 120
            || !evidenceInSource(evidence, ctx.sourceText || '') || !ctx.floorKey || !ctx.contentFingerprint
            || JSON.stringify(before) !== JSON.stringify(shown)) continue;
        if (!before && !author && !(ctx.sourceText || '').includes(character)) continue;
        if (command.op === 'remove') {
            if (author || !before) continue;
            changes.push({ id, before: structuredClone(before), after: null });
        } else {
            const drive = author?.drive || clean(command.drive) || before?.drive || '';
            const progress = clean(command.progress ?? before?.progress);
            if (!drive || drive.length > 200 || progress.length > 160) continue;
            const after = { id, character: author?.character || before?.character || character,
                drive: author ? '' : drive, progress, evidence, source: 'auto',
                floorKey: ctx.floorKey, pairIndex: ctx.pairIndex, contentFingerprint: ctx.contentFingerprint };
            changes.push({ id, before: before ? structuredClone(before) : null, after });
        }
        applyNpcDriveChanges(data, changes.slice(-1));
    }
    return changes;
}
