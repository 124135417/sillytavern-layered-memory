# Fact Continuity and Prose Execution Repair

## Problem

The live 500-floor chat exposed two independent continuity failures:

1. A stored per-floor summary can contain the decisive correction while L2 injection drops it whenever any structured segment exists. The incomplete segment then replaces the more complete summary.
2. The prose model can identify the correct numeric mapping in visible Thinking and still bind a nearby number to the wrong attribute in the final scene.

The current chat also contains an ambiguous state-table entry that attributes southern territory results to Alderis even though the user later clarified that the user fought the mine and salt-marsh battles and Alderis mainly extended that foundation afterward.

## Approved Scope

- Keep the full stored per-floor summary in L2 even when structured events exist.
- Keep structured events as supplemental detail and time-boundary evidence.
- Repair the two affected live state entries using the user's explicit correction, mark them as manual overrides, and preserve an immutable before/after audit record.
- Add a reusable V3.35 visible Thinking step that anchors exact numbers, durations, ownership, causal attribution, and chronology before prose.
- Add a final silent prose check to the existing output lock so a correct plan cannot become an incorrect sentence.
- Do not change Chat History, its enabled state, prompt-order placement, or the `{{layered_memory_context}}` anchor.

## L2 Rendering

For every uncovered per-floor record, rendering becomes:

1. the complete one-line `summary`;
2. any structured time changes and atomic events as supplemental detail;
3. the existing explicit floor boundary.

Chapter and volume summaries remain unchanged. A floor without structured events renders exactly as before. This deliberately accepts bounded redundancy in the uncompressed tail because the user's priority is continuity and the tail is later replaced by a chapter summary.

## Live Fact Repair

The existing entries `e_0104` and `e_0110` are updated in place rather than adding competing facts. The replacement text preserves current world results while making combat ownership explicit:

- the user personally fought the mine and salt-marsh battles;
- Alderis was mainly behind the user during those battles;
- during the following half-year, Alderis expanded and cleared a smaller amount on the established foundation.

Both entries become pinned manual overrides. The repair records the old and new forms in `manual_events` and the state-table changelog, increments the state-table version, and is applied only after a non-rotating backup and source-hash check.

## V3.35 Fact Check

Add one enabled system prompt near the end of the Step checklist:

- construct exact mappings only for facts the scene may mention;
- separate attributes that share nearby numbers, such as age versus reign duration;
- treat the latest explicit user correction as stronger than earlier assistant prose or compressed wording;
- avoid guessing when no source confirms a value.

The output lock then requires a silent final scan of the generated scene for exact numbers, ownership, identities, locations, and chronology. Any mismatch must be corrected before the response is emitted. The check must not add another visible postscript or expose hidden reasoning.

## Failure Safety

- Preset and runtime settings receive paired timestamped snapshots and must be updated semantically together.
- The chat repair aborts if the source file hash or first-line state version changes after inspection.
- No chat generation, swipe, refresh, or UI save is performed during repair.
- If any validation fails, retain the snapshots and do not partially report success.

## Acceptance

- A regression fixture proves both the full correction summary and its shorter structured event appear in L2.
- Existing time-segment, hierarchy, swipe, and handoff tests remain green.
- The repaired live L1 selection contains the explicit ownership mapping and the correct 1,600-year age fact.
- Saved V3.35 and runtime settings contain the same fact-check prompt and unchanged enabled Chat History/anchor state.
- The extension version, Git commit, installed server commit, HTTP manifest, and clean worktrees are verified.
