import { callAuxModel, parseJsonFromModel } from './aux-model.js';
import { recordManualEvent } from './branch.js';
import { getPairs } from './ids.js';
import {
    STATE_REVIEW_EVIDENCE_JSON_SCHEMA,
    STATE_REVIEW_EVIDENCE_SYSTEM,
    STATE_REVIEW_JSON_SCHEMA,
    STATE_REVIEW_SYSTEM,
    STATE_REVIEW_VERIFY_JSON_SCHEMA,
    STATE_REVIEW_VERIFY_SYSTEM,
} from './prompts.js';
import { usableMemoryEntries } from './quality.js';
import { appendLog, assertChatData, getChatData, saveChatData } from './settings.js';

const REVIEW_KIND = 'state_cleanup';
const AUDIT_BATCH_SIZE = 30;
const CATEGORIES = new Set(['expired', 'superseded', 'redundant', 'scene_local', 'contradicted']);
const CONFIDENCE = new Set(['high', 'medium']);
const VERDICTS = new Set(['keep', 'retire', 'uncertain']);
const VERIFY_VERDICTS = new Set(['confirm', 'reject', 'uncertain']);

function isProtected(entry) {
    return Boolean(entry?.pinned || entry?.source === 'manual' || entry?.manual_override);
}

function cleanText(value, max = 300) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hashText(value) {
    let hash = 0x811c9dc5;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function stateReviewSignature(data = getChatData()) {
    const rows = (data.state_table?.entries || [])
        .map(entry => [
            entry.id,
            entry.slot,
            entry.topic,
            entry.subject,
            entry.object,
            entry.value,
            entry.updated_floor,
            entry.pinned ? 1 : 0,
            entry.source,
            entry.manual_override ? 1 : 0,
        ].join('\u0000'))
        .sort();
    return `v1:${hashText(rows.join('\u0001'))}:${rows.length}`;
}

export function latestNarrativeFloor(data = getChatData()) {
    return Math.max(-1, ...(data.narrative_summaries || [])
        .map(item => Number(item?.messageIndex))
        .filter(Number.isInteger));
}

function lifecycleState(data) {
    if (!data.state_lifecycle || typeof data.state_lifecycle !== 'object') {
        data.state_lifecycle = {
            version: 1,
            status: 'idle',
            active_run: null,
            last_completed_at: null,
            last_state_signature: '',
            last_narrative_floor: -1,
            last_result: null,
        };
    }
    return data.state_lifecycle;
}

/** Decide whether opening or chapter progress requires a durable lifecycle audit. */
export function automaticStateReviewRequest(data = getChatData(), {
    onOpen = false,
    force = false,
    chapterSize = 25,
} = {}) {
    const entries = usableMemoryEntries(data).filter(entry => !isProtected(entry));
    if (!entries.length) return null;
    const lifecycle = lifecycleState(data);
    const signature = stateReviewSignature(data);
    const floor = latestNarrativeFloor(data);
    let reason = '';
    if (force) reason = 'manual_full_audit';
    else if (!lifecycle.last_completed_at) reason = 'initial_full_audit';
    else if (onOpen && lifecycle.last_state_signature !== signature) reason = 'state_changed_before_open';
    else if (onOpen && floor > Number(lifecycle.last_narrative_floor ?? -1)) reason = 'new_evidence_before_open';
    else if (floor - Number(lifecycle.last_narrative_floor ?? -1) >= Math.max(1, Number(chapterSize) || 25)) reason = 'chapter_boundary';
    if (!reason) return null;
    return { automatic: true, reason, requestedAt: Date.now() };
}

function uniquePieces(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const text = cleanText(value, 600);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        result.push(text);
    }
    return result;
}

/** Complete, stable evidence directory used by both auditors and exact-quote validation. */
export function buildStateEvidenceCatalog(data = getChatData()) {
    const floors = (data.narrative_summaries || [])
        .filter(item => Number.isInteger(item?.messageIndex))
        .slice()
        .sort((a, b) => a.messageIndex - b.messageIndex)
        .map(item => {
            const pieces = [item.summary];
            const verbatim = [];
            for (const segment of Array.isArray(item.segments) ? item.segments : []) {
                pieces.push(segment?.time_change?.label, segment?.time_change?.evidence);
                verbatim.push(segment?.time_change?.evidence);
                for (const event of Array.isArray(segment?.events) ? segment.events : []) {
                    pieces.push(event?.text, event?.evidence);
                    verbatim.push(event?.evidence);
                }
            }
            return {
                source_id: `floor:${item.messageIndex}`,
                order: item.messageIndex,
                text: uniquePieces(pieces).join(' ｜ '),
                verbatim: uniquePieces(verbatim).join(' ｜ '),
            };
        })
        .filter(source => source.text);
    if (floors.length) return floors;

    const turns = (data.turn_summaries || [])
        .filter(item => Number.isInteger(item?.pairIndex) && cleanText(item.summary))
        .slice()
        .sort((a, b) => a.pairIndex - b.pairIndex)
        .map(item => ({
            source_id: `pair:${item.pairIndex}`,
            order: item.pairIndex,
            text: cleanText(item.summary, 600),
            verbatim: '',
        }));
    if (turns.length) return turns;

    return (data.chapters || [])
        .filter(item => cleanText(item.summary))
        .map((item, index) => ({
            source_id: `chapter:${item.id || index}`,
            order: Number(item.floor_range?.[1] ?? index),
            text: cleanText(item.summary, 1200),
            verbatim: '',
        }));
}

function sourceMap(data, catalog) {
    // Narrative summaries help discovery, but only extractor-preserved raw
    // evidence is eligible for automatic retirement citations.
    const map = new Map(catalog.map(source => [source.source_id, cleanText(source.verbatim, 5000)]));
    for (const entry of data.state_table?.entries || []) {
        map.set(`fact:${entry.id}`, cleanText([
            entry.topic,
            entry.subject,
            entry.object,
            entry.value,
            entry.evidence,
        ].filter(Boolean).join(' ｜ '), 1000));
    }
    return map;
}

function discoverySourceMap(data, catalog) {
    const map = new Map(catalog.map(source => [source.source_id, cleanText(source.text, 5000)]));
    for (const entry of data.state_table?.entries || []) {
        map.set(`fact:${entry.id}`, cleanText([
            entry.topic,
            entry.subject,
            entry.object,
            entry.value,
            entry.evidence,
        ].filter(Boolean).join(' ｜ '), 1000));
    }
    return map;
}

function rangeCovered(floor, ranges) {
    return ranges.some(([start, end]) => floor >= start && floor <= end);
}

/** Bounded global chronology for the first-pass audit: frozen chapters + raw tail. */
export function buildStateAuditOverview(data = getChatData()) {
    const overview = [];
    const covered = [];
    for (const chapter of (data.narrative_chapters || [])
        .filter(item => !item.stale && cleanText(item.summary) && Array.isArray(item.floor_range))
        .slice()
        .sort((a, b) => Number(a.floor_range[0]) - Number(b.floor_range[0]))) {
        const start = Number(chapter.floor_range[0]);
        const end = Number(chapter.floor_range[1]);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) continue;
        overview.push({
            source_id: `chapter:${chapter.id || `${start}-${end}`}`,
            order: end,
            range: [start, end],
            text: cleanText(chapter.summary, 2000),
            verbatim: '',
        });
        covered.push([start, end]);
    }
    const uncovered = buildStateEvidenceCatalog(data).filter(floor => !rangeCovered(floor.order, covered));
    if (!overview.length && uncovered.length > 50) {
        for (let index = 0; index < uncovered.length; index += 25) {
            const group = uncovered.slice(index, index + 25);
            const start = group[0].order;
            const end = group.at(-1).order;
            overview.push({
                source_id: `overview:${start}-${end}`,
                order: end,
                range: [start, end],
                text: cleanText(group.map(source => `第${source.order}楼：${source.text}`).join('\n'), 5000),
                verbatim: '',
            });
        }
    } else {
        for (const floor of uncovered) {
            overview.push({
                source_id: floor.source_id,
                order: floor.order,
                range: [floor.order, floor.order],
                text: floor.text,
                verbatim: '',
            });
        }
    }
    return overview.sort((a, b) => a.order - b.order);
}

function renderFactIndex(data) {
    return (data.state_table?.entries || []).map(entry => {
        const object = entry.object ? `↔${entry.object}` : '';
        const protection = isProtected(entry) ? '｜受玩家保护，不得移出' : '';
        return `- [fact:${entry.id}] (${entry.slot}｜${entry.topic || entry.value}${protection}) ${entry.subject}${object}: ${entry.value}`;
    }).join('\n') || '（当前状态表为空）';
}

export function buildStateReviewPrompt(data = getChatData(), {
    entries = null,
    evidenceCatalog = null,
    retryNote = '',
} = {}) {
    const requested = Array.isArray(entries) ? entries : (data.state_table?.entries || []);
    const catalog = evidenceCatalog || buildStateAuditOverview(data);
    return [
        '## 完整当前事实索引（可用于 keep_id 和 fact:ID 引用）',
        renderFactIndex(data),
        '',
        '## 本批待审 ID（必须逐条且只返回这些 ID）',
        requested.map(entry => {
            const object = entry.object ? `↔${entry.object}` : '';
            const protection = isProtected(entry) ? '｜受玩家保护，不得移出，只能 keep' : '';
            const floor = entry.updated_floor ?? entry.established_floor ?? '未知';
            return `- [${entry.id}] (${entry.slot}｜事项：${entry.topic || entry.value}｜更新：${floor}${protection}) ${entry.subject}${object}: ${entry.value}`;
        }).join('\n') || '（本批为空）',
        retryNote ? `\n## 上次输出问题\n${retryNote}` : '',
        '',
        '## 全局剧情目录（第一轮只用于定位，后续会展开对应范围的逐字原文）',
        catalog.map(source => `### [${source.source_id}]${source.range ? `（第 ${source.range[0]}–${source.range[1]} 楼）` : ''}\n${source.text}`).join('\n\n') || '（还没有可供核对的剧情记录）',
    ].filter(Boolean).join('\n');
}

function normalizedEvidence(rawEvidence, sources) {
    const accepted = [];
    for (const item of Array.isArray(rawEvidence) ? rawEvidence : []) {
        const sourceId = String(item?.source_id || '').trim();
        const quote = cleanText(item?.quote, 300);
        const source = sources.get(sourceId);
        if (!sourceId || !quote || !source || !source.includes(quote)) continue;
        accepted.push({ source_id: sourceId, quote });
    }
    return accepted;
}

/** Fail-closed primary model normalization with exact ID coverage and quote checks. */
export function normalizeLifecycleAudit(raw, data = getChatData(), entries = null, evidenceCatalog = null) {
    const requested = Array.isArray(entries) ? entries : usableMemoryEntries(data);
    const byId = new Map(requested.map(entry => [entry.id, entry]));
    const catalog = evidenceCatalog || buildStateAuditOverview(data);
    const sources = discoverySourceMap(data, catalog);
    const exactSources = sourceMap(data, catalog);
    const rawById = new Map();
    const duplicates = new Set();
    for (const item of Array.isArray(raw?.decisions) ? raw.decisions : []) {
        const id = String(item?.entry_id || '').trim();
        if (!byId.has(id)) continue;
        if (rawById.has(id)) {
            duplicates.add(id);
            continue;
        }
        rawById.set(id, item);
    }
    const missingIds = [];
    const decisions = requested.map(entry => {
        const item = rawById.get(entry.id);
        if (!item || duplicates.has(entry.id)) {
            missingIds.push(entry.id);
            return {
                entry_id: entry.id,
                verdict: 'uncertain',
                category: '',
                keep_id: '',
                reason: item ? '模型重复返回该 ID，未通过完整性检查。' : '模型遗漏该 ID，未通过完整性检查。',
                confidence: 'medium',
                evidence: [],
                evidence_valid: false,
                missing: true,
            };
        }
        let verdict = VERDICTS.has(item.verdict) ? item.verdict : 'uncertain';
        if (isProtected(entry)) verdict = 'keep';
        const category = verdict === 'retire' && CATEGORIES.has(item.category) ? item.category : '';
        const keepId = String(item.keep_id || '').trim();
        const keepValid = !keepId || (data.state_table?.entries || []).some(candidate => candidate.id === keepId && candidate.id !== entry.id);
        const evidence = normalizedEvidence(item.evidence, sources);
        const evidenceValid = verdict !== 'retire' || (category && keepValid && evidence.length > 0);
        if (verdict === 'retire' && !evidenceValid) verdict = 'uncertain';
        return {
            entry_id: entry.id,
            verdict,
            category,
            keep_id: keepValid ? keepId : '',
            reason: cleanText(item.reason || (verdict === 'keep' ? '没有可靠证据表明该状态已经失效。' : '证据不足。')),
            confidence: CONFIDENCE.has(item.confidence) ? item.confidence : 'medium',
            evidence,
            evidence_valid: evidenceValid,
            evidence_exact: evidence.length > 0 && evidence.every(item => exactSources.get(item.source_id)?.includes(item.quote)),
            missing: false,
        };
    });
    return { decisions, missingIds, complete: missingIds.length === 0 };
}

function lexicalHints(entry, decision) {
    const values = [entry?.subject, entry?.object, entry?.topic, entry?.value, decision?.reason]
        .map(value => cleanText(value, 160))
        .filter(Boolean);
    const hints = new Set();
    for (const value of values) {
        for (const part of value.split(/[\s，。；：、！？（）“”‘’—…]+/u)) {
            if (part.length >= 2) hints.add(part);
        }
    }
    return [...hints].slice(0, 20);
}

function evidenceCandidatesForDecision(data, decision, overview, rawCatalog) {
    const overviewById = new Map(overview.map(source => [source.source_id, source]));
    const ranges = [];
    for (const citation of decision.evidence || []) {
        const source = overviewById.get(citation.source_id);
        if (Array.isArray(source?.range)) ranges.push(source.range);
        else if (/^floor:\d+$/u.test(citation.source_id)) {
            const floor = Number(citation.source_id.slice('floor:'.length));
            ranges.push([floor, floor]);
        }
    }
    let candidates = rawCatalog.filter(source => ranges.some(([start, end]) => source.order >= start && source.order <= end));
    if (!candidates.length) {
        const entry = (data.state_table?.entries || []).find(item => item.id === decision.entry_id);
        const hints = lexicalHints(entry, decision);
        candidates = rawCatalog
            .map(source => ({
                source,
                score: hints.reduce((total, hint) => total + (source.text.includes(hint) ? Math.max(2, hint.length) : 0), 0),
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || b.source.order - a.source.order)
            .slice(0, 25)
            .map(item => item.source);
    }
    return candidates.filter(source => cleanText(source.verbatim));
}

function buildEvidenceResolutionBatches(data, decisions, overview, rawCatalog, maxChars = 45_000) {
    const batches = [];
    let current = { decisions: [], sources: new Map(), chars: 0 };
    const flush = () => {
        if (current.decisions.length) batches.push({ decisions: current.decisions, sources: [...current.sources.values()] });
        current = { decisions: [], sources: new Map(), chars: 0 };
    };
    for (const decision of decisions) {
        const sources = evidenceCandidatesForDecision(data, decision, overview, rawCatalog);
        const newChars = sources.reduce((total, source) => current.sources.has(source.source_id)
            ? total
            : total + source.text.length + source.verbatim.length, 0);
        if (current.decisions.length && current.chars + newChars > maxChars) flush();
        current.decisions.push(decision);
        for (const source of sources) {
            if (!current.sources.has(source.source_id)) {
                current.sources.set(source.source_id, source);
                current.chars += source.text.length + source.verbatim.length;
            }
        }
    }
    flush();
    return batches;
}

function buildEvidenceResolutionPrompt(data, batch) {
    const byId = new Map((data.state_table?.entries || []).map(entry => [entry.id, entry]));
    return [
        '## 第一轮提出的退役项',
        batch.decisions.map(decision => {
            const entry = byId.get(decision.entry_id);
            return `### [${decision.entry_id}]\n当前事实：${entry?.subject || ''}: ${entry?.value || ''}\n类别：${decision.category}\n理由：${decision.reason}`;
        }).join('\n\n'),
        '',
        '## 对应范围的逐楼材料',
        batch.sources.map(source => `### [${source.source_id}]\n摘要与事件索引：${source.text}\n可引用原文：${source.verbatim}`).join('\n\n') || '（没有找到带逐字原文的候选来源；必须返回 uncertain）',
    ].join('\n');
}

function normalizeEvidenceResolution(raw, data, decisions, rawCatalog) {
    const expected = new Set(decisions.map(item => item.entry_id));
    const rawById = new Map();
    for (const item of Array.isArray(raw?.resolutions) ? raw.resolutions : []) {
        const id = String(item?.entry_id || '').trim();
        if (expected.has(id) && !rawById.has(id)) rawById.set(id, item);
    }
    const sources = sourceMap(data, rawCatalog);
    return decisions.map(decision => {
        const item = rawById.get(decision.entry_id);
        const verdict = ['supported', 'unsupported', 'uncertain'].includes(item?.verdict) ? item.verdict : 'uncertain';
        const evidence = normalizedEvidence(item?.evidence, sources);
        return {
            entry_id: decision.entry_id,
            verdict: verdict === 'supported' && !evidence.length ? 'uncertain' : verdict,
            reason: cleanText(item?.reason || '没有取得可逐字核验的原文依据。'),
            evidence,
        };
    });
}

async function resolveExactRetirementEvidence(data, decisions, overview, rawCatalog) {
    const direct = new Map();
    const needsRaw = [];
    for (const decision of decisions) {
        if (decision.evidence_exact) {
            direct.set(decision.entry_id, {
                entry_id: decision.entry_id,
                verdict: 'supported',
                reason: '第一轮引用的是事实条目自身，可直接逐字核验。',
                evidence: decision.evidence,
            });
        } else {
            needsRaw.push(decision);
        }
    }
    for (const batch of buildEvidenceResolutionBatches(data, needsRaw, overview, rawCatalog)) {
        const response = await callAuxModel({
            purpose: 'state_review_evidence',
            systemPrompt: STATE_REVIEW_EVIDENCE_SYSTEM,
            userPrompt: buildEvidenceResolutionPrompt(data, batch),
            jsonSchema: STATE_REVIEW_EVIDENCE_JSON_SCHEMA,
            temperature: 0,
        });
        assertChatData(data);
        for (const resolution of normalizeEvidenceResolution(parseJsonFromModel(response.text), data, batch.decisions, batch.sources)) {
            direct.set(resolution.entry_id, resolution);
        }
    }
    return decisions.map(decision => {
        const resolution = direct.get(decision.entry_id) || {
            verdict: 'uncertain', reason: '没有取得逐字原文依据。', evidence: [],
        };
        if (resolution.verdict !== 'supported') {
            return {
                ...decision,
                verdict: 'uncertain',
                evidence: [],
                evidence_valid: false,
                evidence_exact: false,
                evidence_resolution: resolution,
            };
        }
        return {
            ...decision,
            evidence: resolution.evidence,
            evidence_valid: true,
            evidence_exact: true,
            evidence_resolution: resolution,
        };
    });
}

function buildVerificationPrompt(data, decisions, catalog) {
    const entries = new Map((data.state_table?.entries || []).map(entry => [entry.id, entry]));
    const sources = sourceMap(data, catalog);
    return [
        '## 待独立核验的退役判断',
        decisions.map(decision => {
            const entry = entries.get(decision.entry_id);
            const evidence = decision.evidence.map(item => `  - [${item.source_id}] “${item.quote}”`).join('\n');
            const keep = decision.keep_id ? `；拟保留 ${decision.keep_id}: ${entries.get(decision.keep_id)?.value || '未知'}` : '';
            return `### [${decision.entry_id}]\n当前事实：${entry?.subject || ''}: ${entry?.value || ''}\n第一轮：${decision.category}${keep}；${decision.reason}\n引用：\n${evidence}`;
        }).join('\n\n'),
        '',
        '## 引用来源全文（用于检查断章取义）',
        [...new Set(decisions.flatMap(decision => decision.evidence.map(item => item.source_id)))]
            .map(id => `### [${id}]\n${sources.get(id) || '（来源缺失）'}`).join('\n\n'),
    ].join('\n');
}

export function normalizeLifecycleVerification(raw, decisions) {
    const expected = new Set(decisions.map(item => item.entry_id));
    const checks = new Map();
    for (const item of Array.isArray(raw?.checks) ? raw.checks : []) {
        const id = String(item?.entry_id || '').trim();
        if (!expected.has(id) || checks.has(id)) continue;
        checks.set(id, {
            verdict: VERIFY_VERDICTS.has(item.verdict) ? item.verdict : 'uncertain',
            reason: cleanText(item.reason || '第二轮没有给出可靠结论。'),
        });
    }
    return decisions.map(decision => ({
        ...decision,
        verification: checks.get(decision.entry_id) || {
            verdict: 'uncertain',
            reason: '第二轮遗漏该 ID，自动退役已关闭。',
        },
    }));
}

function archiveRetirement(data, entry, decision, event, runId, retiredAt) {
    data.retired_facts = Array.isArray(data.retired_facts) ? data.retired_facts : [];
    data.retired_facts.push({
        id: crypto.randomUUID(),
        entry: structuredClone(entry),
        entry_id: entry.id,
        category: decision.category,
        reason: decision.reason,
        evidence: structuredClone(decision.evidence),
        verification: structuredClone(decision.verification),
        automatic: true,
        run_id: runId,
        anchorFloorKey: event?.anchorFloorKey || null,
        anchorPairIndex: Number.isFinite(Number(event?.anchorPairIndex)) ? Number(event.anchorPairIndex) : null,
        anchorFingerprint: event?.anchorFingerprint || null,
        retiredAt,
    });
}

/** Apply only independently-confirmed high-confidence retirements; queue the rest. */
export function applyLifecycleAudit(data, audit, { recordEvent = recordManualEvent } = {}) {
    if (Number(audit?.base_version) !== Number(data.state_table?.version || 0)) {
        return { error: 'stale', removed: 0, pending: 0 };
    }
    const byId = new Map((data.state_table?.entries || []).map(entry => [entry.id, entry]));
    const automatic = [];
    const pending = [];
    for (const decision of audit?.decisions || []) {
        const entry = byId.get(decision.entry_id);
        if (!entry || isProtected(entry) || decision.verdict !== 'retire' || !decision.evidence_valid || !decision.evidence_exact) continue;
        if (decision.confidence === 'high' && decision.verification?.verdict === 'confirm') automatic.push({ entry, decision });
        else if (decision.verification?.verdict !== 'reject') pending.push({ entry, decision });
    }

    const removedIds = new Set();
    const retiredAt = Date.now();
    for (const { entry, decision } of automatic) {
        const event = recordEvent(data, {
            op: 'delete',
            before: entry,
            after: null,
            reason: 'state_lifecycle_auto_retire',
        });
        archiveRetirement(data, entry, decision, event, audit.run_id, retiredAt);
        removedIds.add(entry.id);
    }
    if (removedIds.size) {
        data.state_table.entries = (data.state_table.entries || []).filter(entry => !removedIds.has(entry.id));
        data.state_table.version = Number(data.state_table.version || 0) + 1;
    }

    data.review_queue = (data.review_queue || []).filter(item => item.kind !== REVIEW_KIND);
    if (pending.length) {
        data.review_queue.push({
            id: crypto.randomUUID(),
            kind: REVIEW_KIND,
            base_version: Number(data.state_table?.version || 0),
            proposals: pending.map(({ entry, decision }) => ({
                retire_ids: [entry.id],
                keep_id: decision.keep_id,
                category: decision.category,
                reason: `${decision.reason}（二次核验：${decision.verification?.reason || '不确定'}）`,
                confidence: decision.confidence,
                evidence: structuredClone(decision.evidence),
            })),
            retire_count: pending.length,
            floorKey: audit.floorKey || null,
            anchor_pair: audit.anchor_pair ?? null,
            anchor_fingerprint: audit.anchor_fingerprint || null,
            createdAt: retiredAt,
        });
    }
    return {
        error: null,
        removed: removedIds.size,
        removedIds: [...removedIds],
        pending: pending.length,
        reviewed: (audit?.decisions || []).length,
    };
}

// Backward-compatible proposal normalizer used by existing pending batches and UI tests.
export function normalizeStateReview(raw, data = getChatData(), {
    now = Date.now(),
    id = crypto.randomUUID(),
    anchor = null,
} = {}) {
    const entries = usableMemoryEntries(data);
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const claimed = new Set();
    const proposals = [];
    for (const change of Array.isArray(raw?.changes) ? raw.changes : []) {
        const retireIds = [];
        for (const candidate of Array.isArray(change?.retire_ids) ? change.retire_ids : []) {
            const entryId = String(candidate || '').trim();
            const entry = byId.get(entryId);
            if (!entry || isProtected(entry) || claimed.has(entryId)) continue;
            claimed.add(entryId);
            retireIds.push(entryId);
        }
        if (!retireIds.length) continue;
        const requestedKeepId = String(change?.keep_id || '').trim();
        const keepId = requestedKeepId && byId.has(requestedKeepId) && !retireIds.includes(requestedKeepId)
            ? requestedKeepId
            : '';
        proposals.push({
            retire_ids: retireIds,
            keep_id: keepId,
            category: CATEGORIES.has(change?.category) ? change.category : 'superseded',
            reason: cleanText(change?.reason || '后文已有更新状态，这条旧记忆不再描述现在。'),
            confidence: CONFIDENCE.has(change?.confidence) ? change.confidence : 'medium',
        });
    }
    return {
        id,
        kind: REVIEW_KIND,
        base_version: Number(data.state_table?.version || 0),
        proposals,
        retire_count: proposals.reduce((total, proposal) => total + proposal.retire_ids.length, 0),
        floorKey: anchor?.floorKey || null,
        anchor_pair: Number.isFinite(Number(anchor?.pairIndex)) ? Number(anchor.pairIndex) : null,
        anchor_fingerprint: anchor?.contentFingerprint || null,
        createdAt: now,
    };
}

export function stateReviewEntries(data, batch) {
    const byId = new Map((data.state_table?.entries || []).map(entry => [entry.id, entry]));
    const retired = [];
    const kept = [];
    for (const proposal of batch?.proposals || []) {
        for (const entryId of proposal.retire_ids || []) {
            const entry = byId.get(entryId);
            if (entry) retired.push({ entry, proposal });
        }
        if (proposal.keep_id) {
            const entry = byId.get(proposal.keep_id);
            if (entry) kept.push({ entry, proposal });
        }
    }
    return { retired, kept };
}

export function applyStateReviewBatch(data, batch, { recordEvent = recordManualEvent } = {}) {
    if (!batch || batch.kind !== REVIEW_KIND) return { error: 'invalid_batch', removed: 0 };
    if (Number(batch.base_version) !== Number(data.state_table?.version || 0)) {
        return { error: 'stale', removed: 0 };
    }
    const entries = data.state_table?.entries || [];
    const requested = new Set((batch.proposals || []).flatMap(proposal => proposal.retire_ids || []));
    const removable = entries.filter(entry => requested.has(entry.id) && !isProtected(entry));
    if (!removable.length) return { error: 'nothing_to_remove', removed: 0 };
    const removedIds = new Set(removable.map(entry => entry.id));
    for (const entry of removable) {
        recordEvent(data, { op: 'delete', before: entry, after: null, reason: 'state_review_approval' });
    }
    data.state_table.entries = entries.filter(entry => !removedIds.has(entry.id));
    data.state_table.version = Number(data.state_table.version || 0) + 1;
    data.review_queue = (data.review_queue || []).filter(item => item.id !== batch.id);
    return {
        error: null,
        removed: removable.length,
        removedIds: [...removedIds],
        skipped: Math.max(0, requested.size - removable.length),
    };
}

async function auditChunk(data, entries, overview, rawCatalog) {
    const first = await callAuxModel({
        purpose: 'state_review',
        systemPrompt: STATE_REVIEW_SYSTEM,
        userPrompt: buildStateReviewPrompt(data, { entries, evidenceCatalog: overview }),
        jsonSchema: STATE_REVIEW_JSON_SCHEMA,
        temperature: 0,
    });
    assertChatData(data);
    let normalized = normalizeLifecycleAudit(parseJsonFromModel(first.text), data, entries, overview);
    if (normalized.missingIds.length) {
        const missing = entries.filter(entry => normalized.missingIds.includes(entry.id));
        const retry = await callAuxModel({
            purpose: 'state_review_coverage_retry',
            systemPrompt: STATE_REVIEW_SYSTEM,
            userPrompt: buildStateReviewPrompt(data, {
                entries: missing,
                evidenceCatalog: overview,
                retryNote: `上次遗漏或重复了这些 ID：${normalized.missingIds.join(', ')}。本次必须各返回一次。`,
            }),
            jsonSchema: STATE_REVIEW_JSON_SCHEMA,
            temperature: 0,
        });
        assertChatData(data);
        const repaired = normalizeLifecycleAudit(parseJsonFromModel(retry.text), data, missing, overview);
        const replacements = new Map(repaired.decisions.filter(item => !item.missing).map(item => [item.entry_id, item]));
        normalized = {
            decisions: normalized.decisions.map(item => replacements.get(item.entry_id) || item),
            missingIds: normalized.missingIds.filter(id => !replacements.has(id)),
        };
    }

    const proposed = normalized.decisions.filter(item => item.verdict === 'retire' && item.evidence_valid);
    if (!proposed.length) return normalized.decisions;
    const resolved = await resolveExactRetirementEvidence(data, proposed, overview, rawCatalog);
    const resolvedById = new Map(resolved.map(item => [item.entry_id, item]));
    normalized.decisions = normalized.decisions.map(item => resolvedById.get(item.entry_id) || item);
    const exact = normalized.decisions.filter(item => item.verdict === 'retire' && item.evidence_valid && item.evidence_exact);
    if (!exact.length) return normalized.decisions;
    const verified = await callAuxModel({
        purpose: 'state_review_verify',
        systemPrompt: STATE_REVIEW_VERIFY_SYSTEM,
        userPrompt: buildVerificationPrompt(data, exact, rawCatalog),
        jsonSchema: STATE_REVIEW_VERIFY_JSON_SCHEMA,
        temperature: 0,
    });
    assertChatData(data);
    const verification = new Map(normalizeLifecycleVerification(parseJsonFromModel(verified.text), exact)
        .map(item => [item.entry_id, item.verification]));
    return normalized.decisions.map(item => ({
        ...item,
        verification: verification.get(item.entry_id) || {
            verdict: item.verdict === 'retire' ? 'uncertain' : 'not_required',
            reason: item.verdict === 'retire' ? '第二轮没有确认该退役判断。' : '',
        },
    }));
}

export async function handleStateReviewJob(payload = {}) {
    const data = getChatData();
    const candidates = usableMemoryEntries(data).filter(entry => !isProtected(entry));
    const lifecycle = lifecycleState(data);
    if (!candidates.length) {
        lifecycle.status = 'complete';
        lifecycle.active_run = null;
        lifecycle.last_completed_at = Date.now();
        lifecycle.last_state_signature = stateReviewSignature(data);
        lifecycle.last_narrative_floor = latestNarrativeFloor(data);
        lifecycle.last_result = { reviewed: 0, removed: 0, pending: 0, reason: payload.reason || 'empty' };
        await saveChatData(data);
        appendLog('info', '当前记忆生命周期审计跳过：没有可自动整理的条目');
        return;
    }

    const baseVersion = Number(data.state_table?.version || 0);
    const signature = stateReviewSignature(data);
    const rawCatalog = buildStateEvidenceCatalog(data);
    const overview = buildStateAuditOverview(data);
    const candidateIds = candidates.map(entry => entry.id);
    const reusable = lifecycle.active_run
        && Number(lifecycle.active_run.base_version) === baseVersion
        && lifecycle.active_run.state_signature === signature
        && JSON.stringify(lifecycle.active_run.candidate_ids) === JSON.stringify(candidateIds);
    const run = reusable ? lifecycle.active_run : {
        id: crypto.randomUUID(),
        base_version: baseVersion,
        state_signature: signature,
        candidate_ids: candidateIds,
        cursor: 0,
        decisions: [],
        reason: payload.reason || 'automatic',
        startedAt: Date.now(),
    };
    lifecycle.status = 'running';
    lifecycle.active_run = run;
    await saveChatData(data);

    while (run.cursor < candidates.length) {
        assertChatData(data);
        if (Number(data.state_table?.version || 0) !== baseVersion || stateReviewSignature(data) !== signature) {
            lifecycle.status = 'dirty';
            lifecycle.active_run = null;
            await saveChatData(data);
            throw new Error('当前事实在审计期间发生变化，已作废旧结论并等待重跑');
        }
        const chunk = candidates.slice(run.cursor, run.cursor + AUDIT_BATCH_SIZE);
        const decisions = await auditChunk(data, chunk, overview, rawCatalog);
        run.decisions.push(...decisions);
        run.cursor += chunk.length;
        run.updatedAt = Date.now();
        await saveChatData(data);
    }

    assertChatData(data);
    const head = getPairs().filter(pair => pair.sealed).at(-1);
    const result = applyLifecycleAudit(data, {
        run_id: run.id,
        base_version: baseVersion,
        decisions: run.decisions,
        floorKey: head?.floorKey || null,
        anchor_pair: head?.pairIndex ?? null,
        anchor_fingerprint: head?.contentFingerprint || null,
    });
    if (result.error) {
        lifecycle.status = 'dirty';
        lifecycle.active_run = null;
        await saveChatData(data);
        throw new Error('当前事实版本已变化，生命周期审计未应用任何删除');
    }
    lifecycle.status = 'complete';
    lifecycle.active_run = null;
    lifecycle.last_completed_at = Date.now();
    lifecycle.last_state_signature = stateReviewSignature(data);
    lifecycle.last_narrative_floor = latestNarrativeFloor(data);
    lifecycle.last_result = { ...result, reason: run.reason, run_id: run.id };
    data.notices = Array.isArray(data.notices) ? data.notices : [];
    data.notices.push({
        id: crypto.randomUUID(),
        kind: 'notice',
        note: `当前记忆大整理完成：逐条审计 ${result.reviewed} 条，自动移出 ${result.removed} 条，${result.pending} 条不确定项等待确认。`,
        createdAt: Date.now(),
    });
    await saveChatData(data);
    appendLog('info', `当前记忆大整理完成：审计 ${result.reviewed} 条，自动移出 ${result.removed} 条，待确认 ${result.pending} 条`);
}

export const STATE_REVIEW_KIND = REVIEW_KIND;
