# Architecture

How the Pi port is put together, and why each piece exists in that shape. The porting
decisions and the evidence behind them (live spikes, measured numbers) are in
[PLAN.md](PLAN.md); this file describes the code as it is.

## Two layers

```
extensions/jev-compaction.ts   the Pi adapter: events, config, decisions, reporting
extensions/pi-messages.ts      Pi messages <-> engine messages, and the renderer
extensions/config.ts           configuration file, validation, key resolution
src/                           the host-agnostic engine (session-in, session-out)
tests/                         engine conformance + adapter and pipeline tests
```

`src/` never imports anything from Pi. That is why the upstream engine suite passes here
with only its import path edited, and why the adapter is the only place that knows about
`AgentMessage`, `SessionEntry` or `ExtensionContext`.

## Data flow of one compaction

```
Pi fires session_before_compact
  -> selectSpan(branchEntries, firstKeptEntryId)      raw branch, previous compactions skipped
  -> buildSpan(spanEntries)                           Pi messages -> engine messages, 1:1
  -> collectToolCalls(...)  -> fitState(...)  -> batchCalls(...)
  -> JevClient.ask()  per batch, bounded concurrency, host signal + timeout
  -> decideCall(...)                                  keep | drop_result | drop_call
  -> collectOutcomes(...)                             keyed by tool call id
  -> renderSpan(span, outcomes, options)              the replacement text
  -> reduction gate (minReductionRatio)
  -> { compaction: { summary, firstKeptEntryId, tokensBefore, details } }
```

Everything between `selectSpan` and the gate lives in `buildCompaction()`, which is
exported and takes a `fetch`-like function. That is what makes the whole pipeline testable
without Pi and without the network: the tests drive it with fake session entries and a fake
Jev at the HTTP boundary.

`buildCompaction` never throws. Every failure comes back as `{ status: "fallback", reason }`,
because a Jev outage must degrade to Pi's built-in summary and never into a failed
compaction. Reasons are phrased for a human reading a notification, which is why there are
several distinct ones instead of a generic "failed".

## The three mapping rules that matter

1. **One engine message per Pi message, always.** The engine pins calls by *position*
   (first message, and the newest `preserveRecentMessages`), so dropping an unmappable
   message from the array would shift every pin. Messages that carry nothing useful map to
   an empty engine message instead.
2. **Tool results become user-role messages carrying `toolResults`.** That is how the
   Claude Code original represented them, and it lets the engine pair a call with its output
   by id without knowing either host's schema.
3. **Thinking never reaches the engine.** Parity with upstream, where the library never sees
   thinking, and it keeps Jev's state (and bill) down. Thinking is still rendered into the
   replacement, abridged by default.

## Rendering

The replacement is text because Pi accepts only a string, while upstream's host accepted
whole messages. The renderer therefore becomes the place where "never rewrite anything"
has to be re-established, and it does that with three rules:

- Content that is not a tool call or a tool output is printed as-is, in order.
- A dropped call takes its output with it, so the history the model reads stays coherent
  (never an output without its call, never a call whose output vanished).
- A message with no text whose every call was dropped is removed as a whole, thinking
  included. It has nothing left to say: it only explained calls Jev judged dead.

The format mirrors Pi's own `serializeConversation()` output, which the model has already
seen during any earlier compaction, so nothing here reads like a conversation to continue.

The reduction is computed against `span.rawChars`, the size of the Pi messages including
thinking and tool inputs, so the number reported to the user matches the context gauge
rather than flattering itself by ignoring content the renderer happens to drop.

## Configuration and secrets

The key comes from `TYPESAFE_API_KEY` or from `apiKey` in the config file, never from a
command-line flag: flags are visible in process listings. The status command reduces the key
to a boolean, and the debug log never contains it. The Jev state and the decision log in
`details` carry ids, tool names and probabilities only.

## Diagnostics

Compaction failures are the hardest thing to debug in a host extension, because the host
quietly writes its own summary. Hence three layers:

- `details.jev` is persisted inside the compaction entry, so the decisions of any past
  compaction can be read back from the session file weeks later.
- The footer keeps the fallback reason visible until the next successful compaction.
- `debug: true` appends one line per step (span size, boundary, outcome, reason, timings) to
  `~/.pi/agent/jev-compaction.log`.

## Known trade-offs

- The replacement lives in the compaction `summary` field, so the transcript view shows the
  verbatim history where a short summary would normally be. Only the first line is a report.
- The `context` hook (prune before every provider request) was validated and deliberately
  left out: it would break prompt caching whenever it rewrites the middle of the history.
  PLAN.md section 7 describes the design that would make it safe.
