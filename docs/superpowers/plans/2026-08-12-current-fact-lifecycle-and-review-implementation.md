# Current Fact Lifecycle and Review Implementation Plan

1. Add an atomic L1 selector to `src/render.js` that ranks pinned/manual facts, gives each populated slot one fair pass, fills remaining capacity by recency, and never truncates a rendered fact.
2. Tighten `EXTRACT_SYSTEM` and conflict normalization so resolved or superseded current-state entries become review suggestions instead of silently coexisting with their replacements.
3. Add `src/state-review.js` for model-assisted, remove-only cleanup proposals; validate entry IDs and protect pinned/manual facts.
4. Register `state_review` in the queue and persist one versioned cleanup batch in `review_queue`.
5. Add Current Memory and Pending Review UI actions that run the audit, preview every proposed removal, reject it harmlessly, or apply it only after a final confirmation and state-version check.
6. Record approved removals as manual branch events, refresh injection, and preserve the immutable fact ledger.
7. Add focused renderer, state-review, queue, and UI smoke coverage, then run the full suite.
8. Deploy the built source to the installed extension, refresh its version, inspect the live 500-floor proposal without auto-applying it, and verify the injection preview.
