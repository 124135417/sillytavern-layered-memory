# Fixed Raw Continuity and Story-Time Design

## Goal

Prevent recent plot details from disappearing while keeping the plugin independent of the provider's unknown context limit. Reuse the existing asynchronous per-floor model call to preserve fine-grained events and story-time changes, including multiple time periods inside one floor.

## Context ownership

- The plugin owns a fixed recent-raw allowance. The default is 16,000 estimated tokens; settings offer 8,000, 16,000, and 32,000.
- SillyTavern continues to own its normal chat context. The plugin neither inspects a claimed provider limit nor mutates SillyTavern's request chat.
- During generation, the trailing user floor remains outside plugin memory because SillyTavern sends it as the current request.
- Starting with the newest completed floor, the plugin selects the largest continuous suffix of whole floors that fits its allowance. It never cuts a floor. If the newest completed floor alone exceeds the allowance, the raw window is empty and summary coverage remains in place.

## One-call floor record

The existing `narrative_summary` auxiliary call returns one record per requested visible floor:

```json
{
  "floor": 38,
  "summary": "他提出寻找可以坐下或取得食物的地方。",
  "segments": [
    {
      "time_change": null,
      "events": [
        {"text": "他希望找一个可以坐下的地方。", "evidence": "随便找个能坐的地方"},
        {"text": "他也接受去能够取得食物的地方。", "evidence": "或者能弄到食物的地方"}
      ]
    }
  ]
}
```

Events are an open-ended, ordered list of independently meaningful additions. They are not classified as intentions, plans, questions, or any other finite ontology. Every event must quote evidence from the floor's narrative text.

Each segment may introduce a `time_change`. A floor may have zero, one, or many changes. Time labels and evidence must be verbatim substrings of the complete floor source, so preset-provided story-time fields may be read even when they are outside the extracted narrative body. Events must still be grounded in the narrative body, not preset summaries or state panels.

The validator rejects missing floors, duplicate floors, invalid summaries, ungrounded events, ungrounded time changes, or time evidence returned out of source order. The job retains its existing bounded retry. Saved records keep `summary`, `segments`, and a derived final `story_time` for compatibility with chapter and UI code.

## Rendering and chronology

The core payload is one ordered block:

1. currently valid facts;
2. narrative summaries ending immediately before the raw window;
3. the selected recent raw floors in visible-floor order;
4. SillyTavern's current/trailing user floor outside the plugin payload.

Summary rendering accepts an inclusive upper floor boundary. A chapter or volume is used only when wholly older than that boundary. If a compressed range crosses the raw cutoff, older uncovered floors fall back to their per-floor summaries. This prevents overlap and gaps.

Raw rendering labels every complete floor and declares the exact covered range. The summary/raw handoff declares that the ranges are continuous and that later raw text wins if it differs from an older summary.

Story time is rendered sparsely in per-floor summaries: the first available time is shown once and a new marker is shown only when the label changes. Multiple changes within one floor remain attached to their corresponding event groups. Repeated preset labels do not create repeated markers.

## Compatibility and failure behavior

- Existing summary-only records continue to render. They acquire structured events the next time their source changes or the record is regenerated; no destructive migration is required.
- If structured validation fails twice, the current job fails through the existing queue and the raw source/fallback summary continue to provide coverage.
- Keyword retrieval remains optional and unchanged; it is not part of continuity correctness.
- The preset macro and compatibility fallback render the same combined core payload, so ordering does not depend on separate extension-prompt keys.

## Verification

- Unit coverage for whole-floor raw selection at 8k/16k/32k boundaries and an oversized newest floor.
- Injection coverage proving facts -> old summary -> recent raw, with no summary/raw overlap or gap.
- A cutoff through the middle of a chapter falls back to only the older per-floor records.
- Structured floor validation covers multiple events, multiple ordered time changes, repeated times, invented evidence, and current-user exclusion.
- Existing smoke suite remains green, including no request-chat mutation and preset-anchor fallback behavior.
