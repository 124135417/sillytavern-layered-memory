# Preset-scoped memory presentation

An enabled prompt containing the unique `{{layered_memory_context}}` anchor may opt into local injection cleanup:

```text
<memory_context_filter assistant_blocks="本轮提纲,meow_FM" hide_card_label="true" separate_sources="true" />
{{layered_memory_context}}
```

This removes only the configured complete tagged blocks from assistant text in the already-selected recent-raw injection window. User messages, actual narrative, original chats, Swipes, saved facts, summaries, extraction rules, and fingerprints are unchanged. Removing auxiliary blocks does not refill the context budget with older floors. Malformed/unclosed blocks remain intact to avoid accidentally deleting narrative. `hide_card_label` suppresses the rendered card-document title in the L1 metadata header; it does not remove character names or story facts.

The option is read only from the enabled unique anchor host. Other presets keep their original behavior. Disabling the host disables its filter. The transformation runs synchronously in existing memory assembly, with no generation hook, network request, background job, output buffering, or semantic spoiler classifier. It cannot identify or repair a secret already stated inside ordinary prose or summarized as a factual sentence.

Run `node tests/injection-filter-smoke.mjs` and `npm test`.

`separate_sources` labels historical records, author planning agreements, and recent narrative separately, in the same original order. Planning is not a completed event or reveal authorization. This adds only static source labels to the existing request; no data is classified by secret keywords or removed. Macro, preview and compatibility injection use the same composition. Historical prose can still contain earlier model errors; the labels are guidance, not a hard disclosure guarantee.
