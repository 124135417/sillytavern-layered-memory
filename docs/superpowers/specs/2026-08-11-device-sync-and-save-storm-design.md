# Device sync and save storm repair

## Problem

The live SillyTavern instance repeatedly returns client-aborted `499` requests for settings saves, chat saves, and generation. The active settings and chat payloads are multi-megabyte, while a custom five-second cross-device poll can reload the current chat after another device writes it. The reload can abort an in-flight save or generation. The layered-memory plugin also serializes every metadata persistence request, so bursts upload the complete chat once per caller.

## Decisions

Cross-device sync becomes opt-in: only `localStorage.st_device_sync === '1'` enables it. When enabled, an explicit remote location change may still navigate to that chat, but a revision of the already-open chat no longer calls `reloadCurrentChat()`. The next ordinary navigation or manual refresh will read the remote content without interrupting local work.

Plugin metadata persistence batches calls by the captured active chat data object. Calls queued before a save share one upload. Calls arriving while that upload is running form at most one trailing upload, so mutations that happen mid-save are not lost. Every caller still waits for the upload covering its mutation, and both pre-save and post-save scope checks reject stale work after a chat switch.

## Rollback and acceptance

The server keeps a timestamped copy of `public/script.js` and the deployed plugin `src/settings.js`. Acceptance requires JavaScript syntax validation for the SillyTavern patch, a plugin smoke test proving initial coalescing, trailing persistence, and cross-chat rejection, the full plugin suite, and live deployed hashes matching the pushed commit.
