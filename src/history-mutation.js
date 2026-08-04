function createState() {
    return {
        running: null,
        runningKey: null,
        pending: null,
        completedKey: null,
        failure: null,
        revision: 0,
    };
}

/**
 * Serialize history reconciliation per chat while coalescing rapid UI events.
 * The scope is the chatMetadata object, whose identity already defines a chat
 * throughout the plugin.
 */
export function createHistoryMutationCoordinator(runMutation) {
    if (typeof runMutation !== 'function') {
        throw new TypeError('runMutation must be a function');
    }

    const states = new WeakMap();

    function getState(scope) {
        if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) {
            throw new TypeError('history mutation scope must be an object');
        }
        let state = states.get(scope);
        if (!state) {
            state = createState();
            states.set(scope, state);
        }
        return state;
    }

    function start(scope, state) {
        if (state.running || !state.pending) return state.running;

        const running = (async () => {
            // Let synchronous edit/swipe event bursts collapse before doing I/O.
            await Promise.resolve();
            while (state.pending) {
                const work = state.pending;
                state.pending = null;
                state.runningKey = work.key;
                try {
                    await runMutation(work.value, scope);
                    state.completedKey = work.key;
                    state.failure = null;
                } catch (error) {
                    state.failure = { error, revision: work.revision };
                    if (!state.pending) throw error;
                } finally {
                    state.runningKey = null;
                }
            }
        })();

        state.running = running;
        void running.catch(() => {}).finally(() => {
            if (state.running !== running) return;
            state.running = null;
            state.runningKey = null;
            if (state.pending) start(scope, state);
        });
        return running;
    }

    function schedule(scope, value, key) {
        const state = getState(scope);
        const normalizedKey = String(key ?? '');

        if (normalizedKey && state.runningKey === normalizedKey) {
            return state.running;
        }
        if (normalizedKey && state.pending?.key === normalizedKey) {
            state.pending.value = value;
            return state.running || start(scope, state);
        }
        if (normalizedKey && !state.running && !state.pending
            && state.completedKey === normalizedKey && !state.failure) {
            return Promise.resolve({ status: 'unchanged' });
        }

        state.revision += 1;
        state.failure = null;
        state.pending = {
            key: normalizedKey,
            revision: state.revision,
            value,
        };
        return state.running || start(scope, state);
    }

    async function wait(scope) {
        const state = getState(scope);
        while (state.running) {
            const running = state.running;
            try {
                await running;
            } catch (error) {
                if (!state.pending) throw error;
            }
            // Let the coordinator's own finally handler expose a follow-up run.
            await Promise.resolve();
        }
        if (state.failure) throw state.failure.error;
    }

    function snapshot(scope) {
        const state = getState(scope);
        return {
            running: Boolean(state.running),
            pending: Boolean(state.pending),
            runningKey: state.runningKey,
            pendingKey: state.pending?.key ?? null,
            completedKey: state.completedKey,
            failed: Boolean(state.failure),
        };
    }

    return { schedule, snapshot, wait };
}
