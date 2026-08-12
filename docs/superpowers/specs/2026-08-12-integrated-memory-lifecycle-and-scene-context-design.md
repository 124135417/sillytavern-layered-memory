# Integrated Memory Lifecycle and Scene Context

## Goal

Make the memory plugin preserve complete history while keeping the provider-facing current state small, current, grounded, and reversible. The existing per-floor summaries remain authoritative records; this change adds deterministic scene metadata, stable fact coordinates, a staged current-memory organizer, and safe incremental maintenance.

## Non-negotiable boundaries

- Do not alter SillyTavern Chat History, the user's enabled preset order, story messages, swipes, or existing per-floor summary prose.
- Do not send a complete assistant reply to the auxiliary model merely to discover time or location.
- Do not automatically run a first full-table retirement audit when an old chat is opened.
- No full organization result changes active memory until the player previews and adopts it.
- Pinned, manual, and manual-override facts cannot be moved automatically.
- Every automatic retirement must cite exact evidence that occurs after the fact's stable source coordinate and pass independent verification.
- All applied organization batches have a branch-anchored snapshot and one-step rollback.
- Facts that remain plausible but are not useful now become dormant, not false or deleted.

## Scene context and L2

Settings gain a `sceneContextRegex` alongside the existing body regex. Capture group 1 identifies a compact status region. The parser recognizes line-based time keys (`time`, `时间`) and location keys (`scene`, `location`, `地点`, `场景`). The configured region is interpreted as the state at the end of the assistant floor.

For every visible message floor, the plugin derives a scene snapshot without a model call:

- assistant floor: exact time and location parsed from its configured status region;
- user floor: inherited from the latest preceding assistant snapshot;
- unmatched assistant floor: explicitly marked missing rather than guessed.

The stored record contains `scene_time`, `scene_location`, a compact raw pair of matched fields, match status, source message key, real floor, and fingerprint. Existing `narrative_summaries` are enriched in place; their summary and events are not regenerated. Chapter time and location ranges are recomputed deterministically from member records.

The narrative-summary model receives only the extracted narrative body plus the compact parsed scene fields. The old full-reply time-only input is removed. In-prose time changes may still be represented in event segments, but the end-of-floor scene snapshot is not delegated to the model.

L2 injection continues to retain the complete per-floor summary plus validated structured events. It adds deduplicated scene time/location transitions. History remains historical even when a state is no longer current.

## L2 user interface

The ordinary `对话记录` view reads `narrative_summaries`, one visible SillyTavern message per record, and shows real floors, role, scene time, scene location, and extraction status. The ordinary `章节摘要` view reads `narrative_chapters` and shows deterministic time/location ranges.

Legacy pair-based `turn_summaries` and `chapters` remain available only inside the advanced rebuild workflow and backward-compatible fallback paths. The current scene summary at the top of the timeline comes from the latest exact assistant snapshot.

## Stable fact coordinates and state chains

Every new L1 entry stores `established_source` and `updated_source` containing:

- pair key and pair index;
- message key, message floor, role, and message fingerprint;
- exact evidence;
- scene time and location at that floor.

Updates preserve the original establishment coordinate and replace the update coordinate. Existing facts receive a deterministic best-effort backfill from pair index, evidence, message keys, and current narrative records. If no trustworthy coordinate can be recovered, the source remains unresolved and the fact cannot be automatically retired.

The state identity remains `slot + subject + object + topic`. A new value for the same identity updates the same active fact instead of accumulating a parallel current state. The immutable ledger and L2 retain older values.

## Current, dormant, retired, and historical facts

The materialized current-memory product has four destinations:

- **current**: true now and useful for the next generation; included in L1;
- **dormant**: still plausible but not currently useful; excluded from L1 and retrievable when its subject/topic reappears;
- **retired**: explicitly ended, replaced, contradicted, fulfilled, or transferred; archived with later evidence;
- **historical**: a scene action, temporary emotion/position, completed one-floor beat, or other material that belongs only in L2.

Dormant and historical archives preserve the complete entry, reason, evidence, source coordinate, branch anchor, and transition time. Matching a dormant subject/topic in the active raw tail temporarily retrieves the dormant fact; a later persistent extraction may reactivate it as a normal current-state update.

## Full organization workflow

Opening an unorganized old chat never starts a full audit. The main button `整理当前记忆` creates a staged batch:

1. deterministic source-coordinate backfill;
2. complete per-entry first-pass classification against the bounded chronology;
3. exact raw-evidence resolution for retired/historical candidates;
4. independent semantic verification;
5. a saved preview with counts and itemized decisions.

The player can keep the current table, adopt the complete staged batch, or rerun it if the table changed. Adoption first saves a branch-anchored snapshot, then moves entries atomically. Uncertain entries remain current. Protected facts remain current. `撤销上次整理` restores current, dormant, retired, historical, lifecycle, and review state from the snapshot.

## Incremental maintenance

After a full organization has been adopted, chapter boundaries and chat reopen only inspect narrative evidence newer than `last_applied_floor`. Candidate facts are selected by changed identity, explicit extraction conflicts, and lexical subject/topic overlap. Evidence older than a fact's update source is ineligible.

High-confidence, exact, independently verified transitions may apply automatically with a rollback snapshot. Uncertain results enter review. Reopening a chat resumes the persisted cursor; it does not repeat the full audit. Fork recovery retains only archives and snapshots whose anchors remain in the trusted prefix, then resets the incremental cursor for the branch.

## Current live preset and chat repair

Deployment includes paired snapshots of saved `V3.35.json`, runtime `settings.json`, and the current Branch #349 JSONL. The active runtime and saved preset must contain the same enabled fact-anchor prompt, final prose verification, and exactly one `{{layered_memory_context}}` anchor. The live scene rule is initialized for the observed `<meow_FM>` block.

The two known ownership facts are repaired as pinned manual overrides against the latest chat hash. No story message changes. The repair aborts if the JSONL changes between inspection and write.

The live recent-raw allowance becomes 32,000 tokens, matching the user's long-form floors. This does not change L2 capacity.

## Failure handling

- Invalid or unmatched scene regex: preserve summaries, store explicit `missing`, and show the error in the test control.
- Changed message fingerprint: discard the old scene snapshot with the old narrative record and rebuild only that floor.
- Changed state-table version during organization: keep the staged result unapplied and require rerun.
- Missing or pre-establishment retirement evidence: force `uncertain`.
- Model/network/balance failure: preserve all current facts and the last applied snapshot.
- Stale browser overwrite: compare hashes after a delay; never report preset or chat repair stable while an old page is still writing.

## Acceptance

- Tests prove the summary model never receives full assistant output outside the body and compact scene fields.
- Existing summaries are enriched without changing summary/event text.
- Time/location snapshots, inheritance, missing state, chapter ranges, and L2 transitions are deterministic.
- L2 UI reads narrative records and narrative chapters.
- New facts and backfilled facts carry stable source coordinates.
- Full organization is staged; adoption and rollback are atomic.
- Automatic review cannot run before a baseline adoption or use evidence at/before a fact source.
- Dormant facts do not consume L1 and are retrievable by current subject/topic.
- Full local suite, server suite, installed commit/version, HTTP manifest, live preset/runtime parity, live JSONL hash, and final L1/L2 injection are verified.
