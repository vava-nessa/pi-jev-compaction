# 0.1.0

First release. Verbatim, Jev-guided context compaction for Pi, ported from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (Claude Code).

## Added

- **Pi extension** (`extensions/jev-compaction.ts`, the only entry point) hooking
  `session_before_compact`:
  every compaction Pi would have summarized is instead scored by Jev, and the replacement
  text is the surviving history verbatim.
- **Pi message bridging** (`extensions/lib/pi-messages.ts`): maps Pi's `AgentMessage` union
  (user / assistant with text + thinking + toolCall blocks / separate toolResult messages /
  bashExecution / custom / branchSummary / compactionSummary) onto the engine's message
  model, and renders the survivors back to text in Pi's own
  `[User]: / [Assistant tool calls]: / [Tool result]` format.
- **Configuration** (`extensions/lib/config.ts`): `~/.pi/agent/jev-compaction.json`, validated
  field by field, with warnings instead of exceptions. Unknown options and wrong types are
  reported by `/jev status` and ignored.
- **Commands**: `/jev` (status), `/jev on|off|reload|reset`, `/jev-compact [instructions]`.
- **Persistent feedback**: footer status (`jev NN% smaller`, or `jev fallback (reason)`),
  notifications on every compaction and every fallback, and an optional debug log
  (`debug: true` → `~/.pi/agent/jev-compaction.log`).
- **Direct API usage** through `examples/demo.ts` for the library part.
- **Tests**: the upstream engine suite (unchanged, as a conformance check), plus adapter
  and extension suites driven by a fake Jev at the `fetch` boundary. 54 tests, no network.

## Changed from upstream

- `preserveRecentMessages` defaults to **1** instead of 6. Pi keeps the newest context
  itself through `compaction.keepRecentTokens`; pinning six extra messages inside the
  replaced span made the extension a no-op on short sessions (observed: 6 messages of span,
  all pinned, fallback).
- The replaced span is rebuilt from the raw `branchEntries` (skipping previous `compaction`
  entries) instead of from `preparation.messagesToSummarize`, so later compactions re-prune
  the original history instead of carrying an ever-growing blob. `preparation.messagesToSummarize`
  is also empty on split turns, where everything lands in `turnPrefixMessages`.
- Pi's cumulative file lists (`readFiles`, `modifiedFiles`) are merged into the compaction
  `details`, because returning custom details otherwise silently drops Pi's file tracking.
- Assistant thinking is abridged (default), droppable, or keepable. It is never sent to Jev.
- Requests honour the host abort signal and a configurable timeout, and run in a bounded
  concurrency pool rather than all at once.

## Removed from upstream

- `hooks/` and `.claude-plugin/` (Claude Code plugin module and marketplace manifests),
  replaced by the `pi` package manifest in `package.json`.
- `types/claude-code.d.ts` (11k lines of generated Claude Code declarations).
- `demo/JevDemo` (SwiftUI animation).
- `tsconfig.hooks.json`, replaced by `tsconfig.extension.json`.

## Fixed before release

- Pi loads every top-level `.ts` file of an `extensions/` directory as an extension, so the
  support modules moved to `extensions/lib/` and the `pi` manifest names the single entry
  point. Before that, installing the package made Pi reject `config.ts` and
  `pi-messages.ts` with "does not export a valid factory function".

## Verified

- `src/` is unchanged: the upstream engine suite passes with only the import path edited.
- End to end in a real Pi session (2026-09-18): 4 tool calls scored, 3 dropped, 97% smaller
  in one request (625 ms); the model was still able to quote its first instruction word for
  word and the exact output of the last test run after compaction. A second compaction
  re-scored the whole original history (9 calls, 8 dropped, 87% smaller) instead of reusing
  the previous replacement.
- Fallback paths observed live: `Nothing to compact (session too small)` surfaced with an
  explanation, and all-pinned spans reported explicitly instead of silently doing nothing.
