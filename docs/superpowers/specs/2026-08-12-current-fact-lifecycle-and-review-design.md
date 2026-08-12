# Current Fact Lifecycle and Review Design

## Problem

The current-fact layer (L1) is meant to describe what is true now, but long chats can leave resolved promises, healed injuries, superseded relationship states, and scene-local details in the active state table. The renderer then walks entries by slot and hard-truncates the complete string. In the observed 500-floor chat, 121 usable entries produced only 32 injected lines, ended halfway through one fact, and omitted the later possession and world-state sections.

This change must not alter SillyTavern Chat History or edit preset anchors. SillyTavern runs the plugin generation interceptor before converting ignored history into OpenAI messages and before Prompt Manager fills the real token budget. Old native history therefore does not consume the actual provider-facing Chat History budget after a successful handoff, although dry-run Prompt Manager views skip interceptors and can display the untrimmed theoretical history.

## Chosen approach

Use three cooperating safeguards rather than relying on one prompt:

1. Tighten per-floor extraction so L1 is explicitly a current-state materialized view, not a second archive.
2. Select complete L1 entries deterministically within budget, with category coverage and recency, never by truncating prose in the middle.
3. Add a review-first “reorganize current memory” workflow. The auxiliary model may propose retiring obsolete or redundant active entries, but code validates every referenced entry and nothing changes until the player confirms the batch.

Alternatives rejected:

- Prompt-only cleanup: cheap to implement, but cannot prevent malformed IDs, mid-line truncation, or destructive model mistakes.
- Automatic model deletion: convenient, but unsafe for user-authored canon and difficult to undo across forks.
- Full fact rebuild on every cleanup: expensive and risks replacing satisfactory per-floor and chapter material unnecessarily.

## Current-state extraction

The extraction prompt will distinguish history from current state:

- `turn_summary` continues to record everything that happened.
- L1 facts are emitted only when they remain true after the current floor.
- A promise fulfilled or cancelled in the same floor is history only.
- Temporary emotion, pose, location, conversational beat, or ordinary action is history only.
- When a new floor supersedes an existing entry, the model must reuse the existing topic when possible and identify the obsolete entry ID in `conflicts`.
- `conflicts` gains an explicit `action` of `replace`, `retire`, or `review`; all such actions remain review-first unless the normal exact-topic updater safely handles the replacement.

No generated cleanup proposal may invent a new fact. Missing current facts remain editable through the existing current-memory UI and normal grounded extraction.

## Budget-safe L1 selection

`renderL1Block` will format facts atomically and select them before rendering:

- Pinned facts take first priority.
- Manual facts take priority over automatic facts.
- Every non-empty slot gets a chance to contribute its most recently updated fact before extra capacity is assigned.
- Remaining capacity is filled by recency, with deterministic ties.
- Headers are emitted only for selected facts.
- A fact is either included whole or omitted whole; the renderer never calls prose truncation on the finished block.
- The result exposes selection metadata so the UI can show injected versus active counts.

This does not claim omitted active facts are false. It only prevents a large, imperfect table from allowing ancient entries in early slots to crowd all other categories out of the model input.

## Review-first reorganization

The Current Memory toolbar gains “重新整理当前记忆”. The flow is:

1. The player confirms that an auxiliary-model audit will run and that no memory will be changed yet.
2. A `state_review` background job receives the active entries plus complete hierarchical narrative memory through the latest completed floor.
3. The model returns groups of existing entry IDs that are expired, superseded, redundant, or scene-local. A group may name one existing entry to keep. It may not add or rewrite facts.
4. Code discards unknown IDs, pinned/manual retire targets, duplicated targets, and malformed groups. The resulting batch is saved to `review_queue` with the state-table version used by the audit.
5. The Pending Review page shows the proposed removals, retained entries, reasons, and confidence. Adopting the batch opens a final confirmation listing every fact that will leave Current Memory.
6. Approval applies only if the state-table version still matches. Every removal is recorded as a manual branch event, the immutable discovery ledger remains intact, and injection refreshes immediately. Rejection only removes the proposal.

Only one unresolved state-review batch is kept per chat. Rerunning the audit replaces the older unapplied batch after confirmation rather than accumulating duplicate suggestions.

## Error handling

- Empty or unparsable model output produces no review batch and leaves active memory unchanged.
- If all proposed changes fail validation, the UI reports that no safe cleanup was found.
- A changed state-table version blocks approval and asks the player to rerun the audit.
- Model, balance, queue, and chat-switch failures use the existing retry and fail-closed behavior.
- Pinned and manually authored entries are never retired by a generated batch.

## Tests and acceptance

Automated coverage will verify:

- whole-entry L1 rendering stays within budget;
- every populated slot receives fair consideration;
- pinned/manual and recent facts outrank old automatic facts;
- old promise/relationship entries cannot monopolize the block;
- cleanup output cannot target unknown, pinned, or manual entries;
- applying a current batch removes only validated entries and records branch-safe manual events;
- stale batches cannot be applied;
- the Current Memory and Pending Review UI expose the new workflow and confirmation language;
- the existing full test suite continues to pass.

Live acceptance will deploy the updated extension, refresh SillyTavern, run the audit against the 500-floor chat, inspect the proposal without applying it automatically, and inspect the plugin injection preview. Chat History and the preset anchor remain user-controlled.
