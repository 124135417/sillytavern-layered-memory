# L1 Current-Memory Lifecycle Audit

## Problem

L1 is a materialized view of facts that are true now, but the old workflow only
offered a user-triggered cleanup suggestion. Completed promises, superseded
relationships, scene-local positions, and contradicted world states could remain
in L1 forever and be injected as if they were still current.

## Required behavior

1. An existing chat receives one complete audit after first loading the new
   schema.
2. Reopening a chat audits changes since the last completed run. A continuously
   open chat audits again at each chapter boundary.
3. Every unprotected L1 entry receives exactly one first-pass verdict. Missing or
   duplicate IDs fail closed as `uncertain`.
4. The first pass reads a bounded global chronology made from frozen chapters and
   uncovered tail floors. It only locates possible retirement evidence.
5. A second evidence pass expands the cited chapter ranges and must return an
   exact continuous quote preserved from story source text.
6. A third independent pass checks entity, attribute, number, time, ownership,
   narrator/character certainty, and whether the quote actually proves that the
   old state is no longer current.
7. Automatic retirement requires all of: unprotected automatic entry, primary
   `retire`, high confidence, exact validated evidence, and independent
   confirmation. Anything less stays active or enters review.
8. Retirement removes the entry only from the current L1 view. The original
   entry, exact evidence, reason, verification, branch anchor, manual event, and
   retirement timestamp remain durable and replayable.
9. Any state-table version change during a run invalidates the entire unapplied
   result. No partial batch deletion is allowed.

## Persistence

`state_lifecycle` stores the active resumable run, last completed state
signature, last reviewed narrative floor, and result counts. `retired_facts`
stores the append-only retirement archive. Branch recovery retains only anchored
retirements within the trusted prefix and resets the lifecycle cursor so the new
branch is audited independently.

## Trigger policy

- `CHAT_CHANGED`: schedule when no prior run exists, the state signature changed,
  or new narrative evidence appeared since the last completed run.
- Live extraction: schedule at a completed chapter boundary.
- UI: “重新整理当前记忆” forces a complete run.

Queue de-duplication treats legacy `state_gc` and current `state_review` as the
same exclusive work so refreshes cannot create concurrent cleanup runs.
