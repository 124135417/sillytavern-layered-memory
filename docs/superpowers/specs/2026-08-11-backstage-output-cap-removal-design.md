# Backstage output cap removal

## Problem

Backstage narrator requests set `responseLength` to 768 tokens. Recent live replies repeatedly ended around 700 Chinese characters in the middle of a sentence, and the partial text was stored as a complete narrator reply.

## Decision

Remove the backstage-only response length override. `generateRaw()` will inherit the currently selected main model and preset output limit. This is a maximum rather than a requested response size, so short replies may still stop naturally while long replies are no longer silently cut by the plugin.

## Acceptance

Backstage request tests must assert that `responseLength` is absent, the complete plugin suite must pass, and the deployed source must match the pushed commit.
