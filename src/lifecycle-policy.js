const GENERIC_TERMS = new Set([
    '当前', '现在', '情况', '状态', '内容', '事项', '安排', '计划', '结果', '程度',
    '方式', '相关', '双方', '关系', '承诺', '认知', '问题', '时间', '位置', '数量',
    '现状', '信息', '东西', '物品', '领地', 'user',
]);

const TOPIC_SUFFIXES = [
    '的承诺', '承诺', '情况', '状态', '内容', '事项', '安排', '计划', '结果', '程度',
    '方式', '认知', '问题', '时间', '位置', '数量', '现状', '信息', '责任', '分工',
    '存量', '产量', '动向', '进展', '用途', '特性', '配方', '归属', '距离', '时长',
];

const DYNAMIC_HINT = /当前|现在|今日|今天|明天|后天|本月|下月|月底|上个月|再过|已经|正在|暂时|现有|存量|产量|人数|人口|数量|长势|收获|施工|调配|安排|计划|缺口|伤势|未愈|返回|到达|经过|现场|可随时卖|价格面谈/u;
const TEMPORAL_PROMISE_HINT = /今天|今日|明天|后天|一个时辰|一小时|三天内|七日内|月底|下月|改日|现在就|回去后|回来前|收工后/u;
const CRITICAL_WORLD_HINT = /契约|协议|条款|规则|身份|秘密|死亡|领地归属|所有权|税率|永久|不可恢复|互不侵犯/u;
const CRITICAL_OTHER_HINT = /身份|秘密|永久|不可恢复|核心动机|自愈能力|造物主/u;
const CRITICAL_POSSESSION_HINT = /恶魔之书|契约石|钥匙|神器|唯一|核心/u;
const LONG_PROMISE_HINT = /永远|以后|不再|不会再|任何地方|跟随|离开|相信|信任|保密|领地归属/u;

function clean(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function normalized(value) {
    return clean(value)
        .toLowerCase()
        .replace(/<user>/gu, 'user')
        .replace(/个(?=[人头颗块枚间筐])/gu, '')
        .replace(/[\s，。；：、！？（）()“”‘’—…·~～_\-]/gu, '');
}

function isProtected(entry) {
    return Boolean(entry?.pinned || entry?.source === 'manual' || entry?.manual_override);
}

function meaningfulTerm(value, subject = '') {
    const term = normalized(value);
    const normalizedSubject = normalized(subject);
    if ([...term].length < 2 || [...term].length > 40) return '';
    if (GENERIC_TERMS.has(term) || term === normalizedSubject || normalizedSubject.includes(term)) return '';
    return term;
}

function topicCores(entry) {
    const topic = clean(entry?.topic);
    const subject = clean(entry?.subject);
    const values = [topic];
    let stripped = topic;
    for (const suffix of TOPIC_SUFFIXES) {
        if (stripped.endsWith(suffix) && stripped.length > suffix.length + 1) {
            stripped = stripped.slice(0, -suffix.length);
            values.push(stripped);
        }
    }
    values.push(...topic.split(/的|与|和|及|对|由|在|为|被/gu));
    const compact = normalized(topic).replace(normalized(subject), '');
    if (compact) {
        values.push(compact);
        // Preserve whole item phrases. Sliding two-character fragments caused
        // unrelated lines such as “第三组产量” to refresh “第三个持有者”.
        values.push(compact.replace(/^[零一二三四五六七八九十百千万两\d]+(?:个|头|颗|块|枚|间|筐|克)?/u, ''));
    }
    return [...new Set(values.map(value => meaningfulTerm(value, subject)).filter(Boolean))]
        .sort((a, b) => [...b].length - [...a].length)
        .slice(0, 24);
}

function valueCores(entry) {
    const value = normalized(entry?.value);
    const terms = value.match(/[零一二三四五六七八九十百千万两\d]+(?:人|头|颗|块|枚|间|筐|克|年|月|天|小时|时辰|成)/gu) || [];
    return [...new Set(terms.map(term => meaningfulTerm(term, entry?.subject)).filter(Boolean))];
}

/** Subject names provide context but can never recall every fact about that subject by themselves. */
export function dormantRelevance(entry, narrativeText) {
    const haystack = normalized(narrativeText);
    if (!haystack) return { matched: false, score: 0, terms: [] };
    const subject = normalized(entry?.subject);
    const subjectMatched = Boolean(subject && haystack.includes(subject));
    const directObject = meaningfulTerm(entry?.object, entry?.subject);
    const matchedTerms = [];
    let score = subjectMatched ? 1 : 0;
    if (directObject && haystack.includes(directObject)) {
        matchedTerms.push(directObject);
        score += 12;
    }
    let topicMatched = false;
    for (const term of topicCores(entry)) {
        if (!haystack.includes(term)) continue;
        const length = [...term].length;
        // A short noun is only item-specific when the subject is present too.
        // Four-character phrases may stand on their own.
        if (length < 4 && !subjectMatched) continue;
        matchedTerms.push(term);
        score += Math.min(10, length + (subjectMatched ? 2 : 0));
        topicMatched = true;
    }
    for (const term of valueCores(entry)) {
        if (!haystack.includes(term)) continue;
        const length = [...term].length;
        // Short quantities such as “一天” and “两人” are not unique
        // enough unless another part of this same fact also matched.
        if (length < 4 && !subjectMatched && !topicMatched) continue;
        matchedTerms.push(term);
        score += Math.min(10, length + (topicMatched ? 2 : 0));
    }
    return {
        matched: matchedTerms.length > 0,
        score,
        terms: [...new Set(matchedTerms)].slice(0, 6),
    };
}

export function lifecycleClass(entry) {
    if (isProtected(entry)) return 'protected';
    const slot = String(entry?.slot || 'other');
    const text = `${clean(entry?.topic)} ${clean(entry?.value)}`;
    if (slot === 'identity' || slot === 'body' || slot === 'relationship') return 'critical';
    if (slot === 'promise') {
        if (TEMPORAL_PROMISE_HINT.test(text)) return 'dynamic';
        return LONG_PROMISE_HINT.test(text) ? 'critical' : 'ongoing';
    }
    if (slot === 'possession') return CRITICAL_POSSESSION_HINT.test(text) ? 'critical' : 'reference';
    if (slot === 'world') {
        if (CRITICAL_WORLD_HINT.test(text)) return 'critical';
        return DYNAMIC_HINT.test(text) ? 'dynamic' : 'reference';
    }
    if (CRITICAL_OTHER_HINT.test(text)) return 'critical';
    return DYNAMIC_HINT.test(text) ? 'dynamic' : 'reference';
}

function entrySourceOrder(entry) {
    const sourceOrder = Number(entry?.updated_source?.messageIndex ?? entry?.established_source?.messageIndex);
    if (Number.isInteger(sourceOrder)) return sourceOrder;
    const pairIndex = Number(entry?.updated_floor ?? entry?.established_floor);
    return Number.isInteger(pairIndex) ? pairIndex * 2 + 1 : -1;
}

function narrativeText(item) {
    const parts = [item?.summary];
    for (const segment of Array.isArray(item?.segments) ? item.segments : []) {
        parts.push(segment?.time_change?.label, segment?.time_change?.evidence);
        for (const event of Array.isArray(segment?.events) ? segment.events : []) {
            parts.push(event?.text, event?.evidence);
        }
    }
    return parts.map(clean).filter(Boolean).join('\n');
}

function latestNarrativeOrder(data) {
    return Math.max(-1, ...(data?.narrative_summaries || [])
        .map(item => Number(item?.messageIndex))
        .filter(Number.isInteger));
}

function dormancyWindow(lifecycle) {
    if (lifecycle === 'dynamic') return 200; // four 25-pair chapters
    if (lifecycle === 'ongoing') return 600; // twelve chapters for non-critical open items
    if (lifecycle === 'reference') return 400; // eight chapters
    return Number.POSITIVE_INFINITY;
}

export function dormancyAssessment(data, entry) {
    const classification = lifecycleClass(entry);
    const window = dormancyWindow(classification);
    const latest = latestNarrativeOrder(data);
    const established = entrySourceOrder(entry);
    if (!Number.isFinite(window) || latest < 0 || established < 0) {
        return { eligible: false, classification, age: null, recentlyRelevant: false, terms: [] };
    }
    const age = latest - established;
    if (age < window) return { eligible: false, classification, age, recentlyRelevant: false, terms: [] };
    const recent = (data?.narrative_summaries || [])
        .filter(item => Number(item?.messageIndex) > latest - window)
        .map(narrativeText)
        .join('\n');
    const relevance = dormantRelevance(entry, recent);
    return {
        eligible: !relevance.matched,
        classification,
        age,
        recentlyRelevant: relevance.matched,
        terms: relevance.terms,
    };
}

/** Convert cold keep/uncertain results to reversible dormancy; never override a proven removal. */
export function applyDormancyPolicy(data, decisions = []) {
    const entries = new Map((data?.state_table?.entries || []).map(entry => [entry.id, entry]));
    return decisions.map(decision => {
        const entry = entries.get(decision?.entry_id);
        if (!entry || ['retire', 'history'].includes(decision?.verdict)) return decision;
        if (isProtected(entry)) {
            return decision?.verdict === 'dormant' ? {
                ...decision,
                verdict: 'keep',
                reason: '该记忆已被玩家保护，不会自动休眠。',
            } : decision;
        }
        const assessment = dormancyAssessment(data, entry);
        if (!assessment.eligible) {
            return decision?.verdict === 'dormant' ? {
                ...decision,
                verdict: 'keep',
                reason: assessment.classification === 'critical'
                    ? '核心身份、身体、关系或长期约定不会仅因时间流逝而休眠。'
                    : '近期仍在相关窗口内，继续保留为当前记忆。',
            } : decision;
        }
        const chapters = Math.max(1, Math.floor(assessment.age / 50));
        return {
            ...decision,
            verdict: 'dormant',
            category: '',
            keep_id: '',
            confidence: 'high',
            evidence: [],
            evidence_valid: true,
            evidence_exact: true,
            verification: { verdict: 'not_required', reason: '休眠是可逆操作，不需要退役证据。' },
            lifecycle_class: assessment.classification,
            reason: `连续约 ${chapters} 个章节未发现具体事项再次相关，先转入可自动召回的休眠区。`,
        };
    });
}
