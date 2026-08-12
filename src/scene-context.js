function cleanValue(value, limit = 160) {
    return [...String(value ?? '')
        .replace(/<br\s*\/?\s*>/giu, '')
        .replace(/<[^>]+>/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()].slice(0, limit).join('');
}

function configuredPattern(pattern) {
    const rule = String(pattern ?? '').trim();
    if (!rule) return { regex: null, error: '' };
    try {
        return { regex: new RegExp(rule, 'iu'), error: '' };
    } catch (error) {
        return { regex: null, error: `invalid_regex:${error?.message ?? error}` };
    }
}

function fieldFromRegion(region, keys) {
    const alternatives = keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
    const match = new RegExp(`^(?:${alternatives})\\s*[:：]\\s*(.+)$`, 'imu').exec(String(region ?? ''));
    return cleanValue(match?.[1]);
}

/** Extract only compact time/location fields from a configured assistant status region. */
export function extractSceneContext(text, pattern = '') {
    const configured = configuredPattern(pattern);
    if (!String(pattern ?? '').trim()) {
        return { status: 'unconfigured', time: '', location: '', raw: '', error: '' };
    }
    if (!configured.regex) {
        return { status: 'invalid', time: '', location: '', raw: '', error: configured.error };
    }
    const match = configured.regex.exec(String(text ?? ''));
    if (!match) {
        return { status: 'missing', time: '', location: '', raw: '', error: 'no_match' };
    }
    const region = String(match.length > 1 ? match[1] : match[0]);
    const time = fieldFromRegion(region, ['time', '时间']);
    const location = fieldFromRegion(region, ['scene', 'location', '地点', '场景']);
    if (!time && !location) {
        return { status: 'missing_fields', time: '', location: '', raw: '', error: 'missing_time_and_location' };
    }
    return {
        status: 'matched',
        time,
        location,
        raw: [time ? `time:${time}` : '', location ? `scene:${location}` : ''].filter(Boolean).join('\n'),
        error: '',
    };
}

/** Attach exact assistant snapshots and inherited user-floor snapshots in visible-floor order. */
export function attachSceneContexts(sources = [], pattern = '') {
    let previousExact = null;
    return sources.map(source => {
        if (source.role === 'assistant') {
            const extracted = extractSceneContext(source.text, pattern);
            const sceneContext = {
                ...extracted,
                sourceMessageKey: extracted.status === 'matched' ? source.messageKey : null,
                sourceMessageIndex: extracted.status === 'matched' ? source.messageIndex : null,
                sourceFingerprint: extracted.status === 'matched' ? source.contentFingerprint : null,
            };
            previousExact = extracted.status === 'matched' ? sceneContext : null;
            return { ...source, sceneContext };
        }
        if (previousExact) {
            return {
                ...source,
                sceneContext: {
                    status: 'inherited',
                    time: previousExact.time,
                    location: previousExact.location,
                    raw: previousExact.raw,
                    error: '',
                    sourceMessageKey: previousExact.sourceMessageKey,
                    sourceMessageIndex: previousExact.sourceMessageIndex,
                    sourceFingerprint: previousExact.sourceFingerprint,
                },
            };
        }
        return {
            ...source,
            sceneContext: {
                status: String(pattern ?? '').trim() ? 'missing' : 'unconfigured',
                time: '',
                location: '',
                raw: '',
                error: '',
                sourceMessageKey: null,
                sourceMessageIndex: null,
                sourceFingerprint: null,
            },
        };
    });
}

export function sameSceneContext(a, b) {
    return ['status', 'time', 'location', 'raw', 'error', 'sourceMessageKey', 'sourceMessageIndex', 'sourceFingerprint']
        .every(key => (a?.[key] ?? null) === (b?.[key] ?? null));
}

function distinctSceneValues(records, key) {
    const values = [];
    for (const record of records || []) {
        const value = cleanValue(record?.scene_context?.[key]);
        if (value && values.at(-1) !== value) values.push(value);
    }
    return values;
}

export function sceneContextRange(records = []) {
    const times = distinctSceneValues(records, 'time');
    const locations = distinctSceneValues(records, 'location');
    return {
        time: times.length ? {
            start: times[0],
            end: times.at(-1),
            label: times.length === 1 ? times[0] : `${times[0]} → ${times.at(-1)}`,
        } : null,
        location: locations.length ? {
            start: locations[0],
            end: locations.at(-1),
            label: locations.length === 1 ? locations[0] : `${locations[0]} → ${locations.at(-1)}`,
        } : null,
    };
}

export function latestExactScene(records = []) {
    return [...(records || [])].reverse().find(record => record?.scene_context?.status === 'matched')?.scene_context || null;
}
