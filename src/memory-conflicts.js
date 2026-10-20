import { evidenceInSource } from './tokens.js';

/** Only structured conflicts about targets the extraction saw can block writes. */
export function memoryConflictGuard(commands, { entries = [], drives = [], sourceText = '' } = {}) {
    const targets = new Map([...entries, ...drives].map(item => [item.id, item]));
    const conflicts = [];
    const ids = new Set();
    for (const command of commands || []) {
        const target = targets.get(command?.entry_id);
        if (!target || ids.has(target.id)) continue;
        const quote = typeof command.evidence === 'string' ? command.evidence.trim() : '';
        const evidence = quote.length >= 4 && quote.length <= 500 && evidenceInSource(quote, sourceText) ? quote : '';
        ids.add(target.id);
        conflicts.push({ entry_id: target.id, action: 'review',
            note: String(command.note || '本楼与已有记录冲突，尚不能确认实际变化').slice(0, 300), evidence,
        });
    }
    const blocksEvidence = evidence => Boolean(evidence) && conflicts.some(conflict => conflict.evidence
        && (evidenceInSource(evidence, conflict.evidence) || evidenceInSource(conflict.evidence, evidence)));
    return { ids, conflicts, blocksEvidence };
}

export function narrativeConflictNotes(conflicts, sourceText) {
    return (conflicts || []).filter(conflict => conflict.evidence
        && evidenceInSource(conflict.evidence, sourceText || ''));
}

export function renderNarrativeConflicts(conflicts) {
    if (!conflicts?.length) return '';
    return `【本楼存在未确认矛盾，不据此改变已有状态：${conflicts.map(item => item.note).join('；')}】`;
}
