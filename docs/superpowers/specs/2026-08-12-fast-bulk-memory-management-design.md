# Fast bulk memory management

## Goal

Make current-memory cleanup feel immediate even when the chat JSONL is large,
and let the player remove many facts with one review and one metadata save.
The UI must never claim a fact was permanently deleted if the immutable fact
ledger can silently reactivate the same discovery later.

## Interaction

The Current Memory toolbar gains a `批量管理` toggle. In bulk mode every visible
current-memory card has a checkbox and a sticky action bar shows the selected
count. `全选当前筛选结果` selects only cards currently visible after search and
type filters; it never selects hidden facts.

The action bar provides:

- `移出当前记忆` as the primary action. Selected facts move to Retired, retain
  their source and reason, and can be restored from the Retired view.
- `永久删除` as a danger action. It removes the selected current facts, records
  manual deletion tombstones for matching discoveries, and prevents an old
  ledger candidate from silently reactivating the same fact. New evidence after
  the deletion may still create a genuinely new fact.

Both actions use one confirmation dialog describing the exact count. Archived
facts gain `恢复到当前记忆`; restoration is explicit and creates a manual fact.

## Immediate feedback and persistence

After confirmation, the mutation is applied to the in-memory chat metadata and
the affected cards disappear immediately. The memory panel displays a compact
`正在保存` state while one `saveChatData` call writes the whole batch.

Before mutation the plugin keeps an exact in-memory snapshot of the affected
state table, lifecycle archives, manual events, fact decisions, and organization
state. If persistence fails, it restores that snapshot, rerenders the cards, and
shows a specific failure message. The user never has to guess whether a slow
save has accepted the click.

While the batch save is pending, another bulk commit is disabled. Search,
inspection, and closing the panel remain available.

## Relationship to organization previews

Any single or bulk edit changes the state-table version. If an organization
preview is staged, the plugin discards it immediately and explains that the old
preview no longer matches current facts. It never leaves an apparently usable
preview that will fail only after the player clicks Adopt.

`移出当前记忆` and permanent deletion each create one logical manual event per
fact, all anchored to the same current floor. Fork replay therefore preserves
the player's choices. The entire UI batch still performs only one metadata save.

## Validation

Tests cover:

- immediate optimistic removal before a delayed save resolves;
- exact rollback after a rejected save;
- visible-filter selection semantics;
- one persistence call for a multi-fact batch;
- Retired restoration;
- permanent-deletion tombstones blocking legacy candidate reactivation;
- staged-preview invalidation;
- branch replay of every fact in a batch;
- keyboard labels, focus behavior, and mobile action-bar layout.

