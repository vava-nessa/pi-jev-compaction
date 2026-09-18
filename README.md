# pi-jev-compaction

**Verbatim context compaction for [Pi](https://pi.dev), decided by [Jev](https://typesafe.ai).**
Pi's built-in compaction asks a model to *summarize* old turns, and a summary is lossy: a
file path, an exact error message, a constraint or a command can disappear even when it
still matters later. This extension never summarizes. It asks Jev, for every tool call in
the part of the session Pi is about to replace, whether the call and its output still need
to be there, then deletes what it says is dead and keeps everything else **byte for byte**.

```
without pi-jev-compaction          with pi-jev-compaction
────────────────────────           ──────────────────────────────────────────────
[User]:     replaced by a          [User]:     kept verbatim
[Assistant] short LLM summary      [Assistant] kept verbatim, thinking abridged
[Tool: read 51 KB of legacy]  ──►  [Tool: read 51 KB of legacy]  → deleted by Jev
[Bash: failed test]                [Bash: failed test]          → head + note
[Edit: the fix]                    [Edit: the fix]              kept verbatim
```

Measured on the validation session described in [docs/PLAN.md](docs/PLAN.md):
**97% smaller**, 4 tool calls scored, 3 dropped, in one Jev request, 625 ms.

---

## Table of contents

- [Install](#install)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Commands](#commands)
- [Fallback behaviour](#fallback-behaviour)
- [What is preserved, what can disappear](#what-is-preserved-what-can-disappear)
- [Library usage](#library-usage)
- [Development](#development)
- [Origin, scope and limitations](#origin-scope-and-limitations)

---

## Install

Two ways. Global, in one command:

```sh
pi install git:github.com/vava-nessa/pi-jev-compaction
export TYPESAFE_API_KEY="<your TypeSafe key>"
```

Or try it in a single run without installing (point at the extension file: `-e` loads a
single module, and a directory path is not a module):

```sh
TYPESAFE_API_KEY="<key>" pi -e /path/to/pi-jev-compaction/extensions/jev-compaction.ts
```

Then compact as usual: `/compact`, or let Pi's own context threshold trigger it. The
extension hooks `session_before_compact`, so **there is nothing else to enable** and no
separate mode: every compaction that Pi would have summarized is scored by Jev instead.

Requirements: Pi 0.84 or newer, Node 18 or newer, a TypeSafe API key. Keys are read from
`TYPESAFE_API_KEY` first, or from the `apiKey` field of the config file.

## How it works

1. **Pi picks the cut.** Compaction happens when the context passes
   `contextWindow - compaction.reserveTokens`, or on `/compact`. Pi decides which entries
   to keep (`compaction.keepRecentTokens`) and which to replace. This extension does not
   change that, it only decides *what the replacement says*.
2. **The replaced span becomes Jev's state.** Every message before the kept boundary is
   mapped onto the engine's message model, with each tool output replaced by a one-line
   note (`ok, 4213 chars (omitted)`). Tool inputs, user text and assistant text are all
   included. Thinking blocks are not sent (see below).
3. **The state is fitted into `maxStateTokens` (25k)** in ordered stages: tool inputs
   truncated to 1000 → 200 → 60 characters, then long texts abridged to head + tail
   (oldest first), then old messages collapsed to a `[… N chars omitted …]` note, then old
   tool calls reduced to one line each, then call-less messages left out, then runs of
   call-only messages folded together. If it still does not fit, compaction falls back to
   Pi's summary rather than silently truncating what the model sees.
4. **Two questions per tool call.** `call_tN`: does knowing this call was made, with its
   input, still matter for what the assistant does next? `result_tN`: is the full output
   still needed verbatim, given that re-running the tool is always possible? Both are
   `noul` (probability) questions. Questions are split into as many requests as needed so
   that state plus questions stays under `maxRequestTokens`; the same full state is resent
   with every request, and the requests run concurrently with a bounded pool.
5. **Decisions.** `keepResult ≥ keepThreshold` → keep the call and its output;
   otherwise `keepCall ≥ keepThreshold` → keep the call, truncate its output to
   `truncateHeadChars` plus a one-line note; otherwise → drop the call and its output.
   A call with no result, or one whose result is outside the replaced span, is never a
   candidate.
6. **The survivors are rendered verbatim** into the text Pi stores as the compaction
   result, in the same `[User]: / [Assistant]: / [Assistant tool calls]: / [Tool result]`
   format Pi's own summarizer uses, so the model reads it the same way. If the result is
   not at least `minReductionRatio` (25%) smaller than what it replaces, the extension
   gives up and lets Pi write its normal summary: paying verbatim token cost for a 5%
   saving would be a bad trade.

### Why the replacement is rebuilt from the raw branch every time

Pi's `session_before_compact` event hands over `preparation.messagesToSummarize` and
`turnPrefixMessages`, which are *compaction-aware*: after a first compaction, the original
entries are only reachable through `event.branchEntries`. This extension walks the raw
branch instead, skipping previous `compaction` entries, so that every later compaction
re-evaluates the **original** history. Two consequences: tool noise dropped once stays
dropped, and nothing has to be re-summarized to keep it. It also sidesteps the split-turn
trap where everything Pi wants to replace lands in `turnPrefixMessages` and
`messagesToSummarize` is empty.

## Configuration

Optional. The file lives next to the rest of the agent state:

```jsonc
// ~/.pi/agent/jev-compaction.json
{
  "apiKey": "",                    // empty = read TYPESAFE_API_KEY
  "model": "jev-latest",
  "baseUrl": "https://api.typesafe.ai/v1/systemone",
  "enabled": true,
  "keepThreshold": 0.5,            // minimum Jev probability for a call or output to stay
  "preserveRecentMessages": 1,     // see below
  "maxStateTokens": 25000,
  "maxRequestTokens": 30000,       // Jev's request limit is 32k
  "truncateHeadChars": 300,
  "minReductionRatio": 0.25,
  "thinking": "abridge",           // abridge | drop | keep
  "thinkingHeadChars": 600,
  "maxConcurrentRequests": 4,
  "timeoutMs": 60000,
  "compactAtPercent": 0,           // 0 = rely on Pi's own threshold
  "debug": false                   // one line per step in ~/.pi/agent/jev-compaction.log
}
```

Anything malformed is ignored with a warning shown by `/jev status`; a bad config file can
never break compaction, the worst case is Pi's built-in summary. `chmod 600` the file if you
put a key in it.

**`preserveRecentMessages` defaults to 1, not to the upstream default of 6.** The Claude
Code plugin this is ported from replaces the *entire* transcript, so it has to protect the
newest messages itself. In Pi, `compaction.keepRecentTokens` (20k tokens by default) already
keeps everything after the boundary verbatim, so pinning six more messages inside the span
just makes the extension do nothing on short sessions. With 1, only the span's first and
last message are protected.

## Commands

| Command | Effect |
| --- | --- |
| `/jev` | Status: effective config, last compaction (calls kept/dropped, reduction, state stage, requests, latency) and session totals. |
| `/jev on` / `/jev off` | Enable or disable for this session. |
| `/jev reload` | Re-read the config file without restarting Pi. |
| `/jev reset` | Clear the session counters. |
| `/jev-compact [instructions]` | Compact now. The instructions become part of the goal sent to Jev. |

The footer shows `jev NN% smaller` after a successful compaction, or
`jev fallback (reason)` when Pi's summary had to be used, so a silent fallback is
impossible. `/compact` still works exactly as before.

## Fallback behaviour

Every failure is a fallback to Pi's built-in summary, never a failed compaction, and every
fallback is announced in the UI and in the footer:

| Situation | Result |
| --- | --- |
| No TypeSafe key | Built-in summary, warning at session start |
| No tool call in the replaced span | Built-in summary |
| Every tool call is pinned by `preserveRecentMessages` | Built-in summary |
| Reduction under `minReductionRatio` | Built-in summary |
| State cannot be fitted into `maxStateTokens` | Built-in summary |
| Jev HTTP error, malformed answer, timeout | Built-in summary |
| `/compact` while the session is smaller than the kept window | Pi's own `Nothing to compact (session too small)`, explained in a notification |

## What is preserved, what can disappear

| Content | Fate |
| --- | --- |
| User messages | Verbatim, always |
| Assistant text | Verbatim, always |
| Assistant thinking | Abridged to `thinkingHeadChars` by default (`drop` / `keep` available) |
| Tool calls Jev keeps | Verbatim, input included |
| Tool calls Jev drops | Call and output both disappear |
| Tool outputs Jev keeps | Verbatim |
| Tool outputs Jev half-needs | First `truncateHeadChars` characters plus a note saying how much was cut and that the tool can be re-run |
| Images | `[image mime/type]` markers in the replacement, untouched in kept entries |
| `bashExecution`, `custom`, `branchSummary` | Included as text; `!!`-prefixed bash is excluded, as Pi does |

A call and its output are always removed together, so the message list the model sees stays
valid. Thinking never goes to Jev, matching the Claude Code original where the library never
sees it. An assistant message with no text whose every call was dropped disappears
entirely, thinking included: all it explained were calls Jev judged dead.

## Library usage

`src/` is the host-agnostic engine, usable on its own and unchanged from upstream (the
ported test suite is part of this repo as a conformance check):

```ts
import { compactMessages, reductionRatio, type Message } from 'pi-jev-compaction';

const result = await compactMessages(transcript, { preserveRecentMessages: 2 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

Bring your own transport by implementing `JevAsker` (a single `ask(state, questions)`
method) and calling `compact(messages, asker, options)`. `buildJevRequest` and
`parseJevResponse` give you the HTTP body and response validation. The building blocks
(`collectToolCalls`, `fitState`, `batchCalls`, `decideCall`, `applyDecisions`) are exported
too.

```sh
npm install pi-jev-compaction
TYPESAFE_API_KEY="<key>" npm run demo   # live check against the real API
```

## Development

```sh
npm install
npm run typecheck   # library (src/) and extension + tests
npm test            # vitest, fake Jev over fetch, no network
npm run build       # dist/ for library consumers
npm run demo        # live network check (needs TYPESAFE_API_KEY)
```

To run the working tree inside Pi without installing:

```sh
pi -e "$PWD/extensions/jev-compaction.ts"
```

Layout: `src/` engine, `extensions/jev-compaction.ts` the Pi adapter (the only extension
entry point), `extensions/lib/pi-messages.ts` mapping and renderer, `extensions/lib/config.ts`
configuration, `tests/engine.test.ts` the upstream engine suite, plus adapter tests.

Everything that is not an extension lives in `extensions/lib/`, and that is not cosmetic:
Pi loads every top-level `.ts` file of `extensions/` as an extension, so a support module
sitting next to the entry point is loaded as one too and fails with "does not export a
valid factory function". Subdirectories are only loaded when they contain an `index.ts` or
their own `package.json`, and the package manifest names the single entry point explicitly.

Architecture notes, the porting decisions and the pitfalls each one avoids are in
[docs/PLAN.md](docs/PLAN.md) and [docs/architecture.md](docs/architecture.md).

## Origin, scope and limitations

A port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(MIT), which does the same for Claude Code. The engine is the upstream engine; what is new
here is the Pi adapter, the renderer, this configuration surface and the commands. The
upstream Claude Code plugin manifests, the generated Claude Code type declarations and the
SwiftUI demo are not part of this port. Upstream history is preserved in this repository.

Honest limitations:

- Token sizes are estimated from character counts, not a tokenizer (calibrated to land
  2-18% above what Jev reports).
- A probability is not proof that an output is safe to delete. The safety net is that the
  assistant can always re-run a tool, which is why the questions are phrased around
  "re-running would not do".
- Only tool calls and outputs are candidates. Long user or assistant prose is kept
  verbatim, so a session dominated by prose will not shrink much and will fall back to
  Pi's summary instead.
- The full state is resent with every batch, so a history near the state ceiling costs
  roughly one Jev request per handful of questions.
- The replacement lives in the compaction summary, which is a text field, so the
  transcript view shows the verbatim history where you would expect a short summary. The
  first line is a one-line report of what happened.
- Compaction reduces the context, so prompt caching is rebuilt after one. That is true of
  Pi's built-in compaction as well.

## License

MIT. Original work Copyright (c) 2025 tamaratran; Pi port in this repository under the same
license.
