# pi-jev-compaction - Build Plan

Port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(Claude Code plugin + npm library) to **Pi**.

Scope decided with vava:

| Decision | Choice |
| --- | --- |
| Shape | Faithful port: core library (`src/`) + Pi extension adapter + tests |
| Trigger | Compaction only (`/compact`, Pi auto-threshold, optional percent bootstrap). The `context` hot path is **not** used in v1. |
| Delivery | Local repo, pushed to GitHub (public), installed globally as a Pi package. No SwiftUI demo. |

---

## 1. What upstream actually is

One sentence: instead of asking an LLM to **summarize** old turns, ask TypeSafe's
**Jev** (a System One model) whether each tool call and each tool output is still
needed, then **delete what it says is dead and keep everything else byte for byte**.
No text is ever rewritten.

### 1.1 Module map (2121 lines of TS, excluding the generated type dump)

| File | Lines | Responsibility |
| --- | --- | --- |
| `src/types.ts` | 202 | Neutral data model: `Message` (subset of Claude Code's `SessionMessage`), `ToolCall`, `CallDecision`, `JevQuestion`/`JevAnswer`, `JevAsker` port, `CompactOptions`/`CompactResult`. |
| `src/request.ts` | 80 | The Jev HTTP contract: `buildJevRequest`, `parseJevResponse` (strict validation), `noulAnswer`. `https://api.typesafe.ai/v1/systemone`, model `jev-latest`. |
| `src/client.ts` | 43 | `JevClient implements JevAsker` over `fetch`, key from `TYPESAFE_API_KEY`. |
| `src/state.ts` | 304 | The hard part: pair calls with results, **token estimator without a tokenizer**, staged state fitting (6 stages), `goalFromMessages`. |
| `src/compact.ts` | 309 | Orchestration: option resolution, question building, request batching, decision rules, transcript rebuild, stats. |
| `src/messages.ts` | 13 | `compactMessages()` convenience = `compact()` + `JevClient`. |
| `hooks/fast-jev.ts` | 310 | Claude Code adapter: `session.compact` + `turn.complete` hooks, identity-preserving map back to `SessionMessage`, fallback to the built-in summary. |
| `types/claude-code.d.ts` | 11267 | Generated Claude Code declarations. **Not ported.** |
| `demo/JevDemo` | Swift | Scripted SwiftUI animation for screen recording. **Not ported** (decision). |
| `tests/` | 582 | Vitest, fake Jev, zero network. |

### 1.2 The algorithm, exactly

1. **Pairing.** Every `tool_use` is matched to its `tool_result` by `tool_use_id`.
   A call with no result is never a candidate. Calls in the first message and in the
   newest `preserveRecentMessages` messages are **pinned** and never touched.
2. **State.** The state sent to Jev is the **whole conversation**, oldest first, with
   each tool result replaced by a one-line note (`ok, 4213 chars (omitted)`). Tool
   inputs and all text are included. Nothing is summarized.
3. **Fitting.** The state is shrunk in ordered stages until it fits `maxStateTokens`
   (25k): inputs truncated to 1000 → 200 → 60 chars; long texts abridged to head+tail
   (oldest non-pinned first); old messages collapsed to `[… N chars omitted …]`; old
   calls reduced to one line (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less
   messages dropped; runs of old call-only messages folded. If it still does not fit,
   **throw** (never silently truncate the model's view).
4. **Token estimate.** No tokenizer: one token per six letters, half a token per
   digit, 0.9 per other symbol. Calibrated to sit 2-18% **above** what Jev reports.
5. **Two questions per call.** `call_tN` (does knowing this call was made and its
   input still matter) and `result_tN` (is the full output still needed verbatim,
   given re-running the tool is possible). Both are `noul` (probability) questions.
6. **Batching.** Questions are split into as many requests as needed so that
   state + questions stays under `maxRequestTokens` (30k, under Jev's 32k cap).
   **The same full state is resent with every request**; requests run concurrently;
   answers are merged.
7. **Decision.** `keepResult >= keepThreshold` (0.5) → keep call + result;
   else `keepCall >= keepThreshold` → keep the call, truncate the result to
   `truncateHeadChars` (300) + a note; else → drop the call and its result.
8. **Rebuild.** Dropped calls vanish with their results. Messages that lose all
   content are removed. Untouched messages are returned as the **same objects**
   (that is how the Claude Code adapter preserves the engine's internal handles).
9. **Fallback is the caller's job.** Any Jev failure, malformed answer, missing key,
   unfittable state, or reduction below `minReductionRatio` (0.25) → the host falls
   back to its own summary.

### 1.3 Things worth keeping honest about

- Only tool calls/results are candidates. Text is never shortened *in the output*
  (it is only abridged in the state Jev sees).
- Calibration is a heuristic at the request level. A probability is not proof.
  The assistant can always re-run a tool, which is the design's safety net.
- The full state is resent per batch, so a history near the ceiling costs roughly
  one request per handful of questions.

---

## 2. Pi host: what is actually available (verified, not assumed)

### 2.1 Extension surfaces

| Surface | Where | Use for us |
| --- | --- | --- |
| `pi.on("session_before_compact", handler)` | before `/compact`, auto-threshold, overflow recovery | **The port's core.** Return `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }`. Returning `undefined`/nothing = fall back to Pi's built-in summary. `{ cancel: true }` = cancel compaction. |
| `pi.on("session_compact", ...)` / `session_compact_failed` | after success/failure | Telemetry, notifications, stats. |
| `pi.on("turn_end", ...)` + `ctx.getContextUsage()` + `ctx.compact()` | mirror of upstream's `turn.complete` + `compactAtPercent` | Optional early trigger. Pi already triggers compaction on its own threshold, so this is a bootstrap, not a requirement. |
| `extension.branchEntries` | on the compact event | **Full branch**, including entries before a previous compaction entry, each with `id`, `type`, `message`. This is what lets us re-prune from the original history instead of carrying a growing blob. |
| `ctx.sessionManager` | everywhere | read-only session access. |
| `pi.appendEntry` / `pi.registerCommand` / `ctx.ui.notify` / `ctx.ui.setStatus` | everywhere | `/jev` status command and TUI feedback. |
| `pi.on("context", ...)` | before **every** provider request, can return `{ messages }` | **Validated working, deliberately unused in v1.** This is the Pi-only "continuous compaction" upgrade path (see §7). |

### 2.2 Pi's compaction model, and the one real mismatch

Pi's compaction = *"replace everything before `firstKeptEntryId` with `summary`"*:

- The summary is stored in the `CompactionEntry` (`summary` field) and injected into
  context as a `compactionSummary` message wrapped by Pi in
  `The conversation history before this point was compacted into the following summary:\n\n<summary>…</summary>`.
- Entries `>= firstKeptEntryId` (and everything after the compaction entry) are kept
  as-is and sent to the model verbatim.
- `details` is free-form JSON and **is persisted to the session JSONL**, and is also
  fed into Pi's cumulative file tracking (`readFiles`/`modifiedFiles`) on the next
  compaction.

Mismatch with upstream: Claude Code's plugin can return **real messages**, so the
transcript keeps the original turns. Pi only accepts a **string**. Therefore the port
must render the surviving prefix as text (a "verbatim transcript" that is technically
stored in the summary field). Everything else in the algorithm survives untouched,
and the invariant that matters - *no information is summarized, only tool noise is
deleted* - holds exactly.

### 2.3 Verified behaviour (live spikes run in a Herdr workspace)

**A. The `context` hook exists and pruning is accepted by the provider.** Log from a
real run with a `context` handler dropping one `toolCall` block plus its `toolResult`
message:

```json
{"pruned":true,"before":3,"after":2,"dropped":["call_00_oBdd3AC61LsUDeS0GTH10291"]}
```

**B. `session_before_compact` fires and our own summary replaces the built-in one.**
Log from a real `/compact` in an interactive Pi (temporary test extension):

```json
{"before_compact":true,"reason":"manual","toSummarize":0,"turnPrefix":4,
 "firstKeptEntryId":"6f617b1e","tokensBefore":1791,"branchEntries":7,"roles":[]}
{"compact_done":true,"fromExtension":true}
```

Session JSONL afterwards:

```json
{"type":"compaction","id":"5efec728","parentId":"6f617b1e",
 "firstKeptEntryId":"6f617b1e","tokensBefore":1791,
 "details":{"jev":true,"chars":0},"fromHook":true,
 "summary":"VERBATIM_PREFIX_BEGIN\n\nVERBATIM_PREFIX_END"}
```

**C. Proof that the summary is what the model actually sees.** After that compaction,
asked to quote its first user message, the model answered: *"The earlier conversation
was compacted into a summary, and the verbatim prefix region in that summary is
empty… so I don't have access to your original first message."* The mechanism is real
and lossless **only if we fill the summary with the surviving content**.

**D. Split turns are the normal case, not an edge case.** In spike B,
`messagesToSummarize` was **empty** and `turnPrefixMessages` held everything, because
the whole session was a single turn. Any implementation that only reads
`messagesToSummarize` loses the entire history.

**E. `Nothing to compact (session too small)`** is raised by Pi *before* the hook when
`keepRecentTokens` already covers the session, and it surfaces as
`session_compact_failed` with `fromExtension:false`. On repeated compactions this
happens easily. It must be surfaced in the UI, never as a silent no-op.

**F. Calling `ctx.compact()` mid-run aborts the current operation** (observed in
print mode: `This operation was aborted`, and the hook never fired). Pi's own
threshold trigger is therefore the reliable path; a `turn_end` bootstrap must be
guarded by `ctx.isIdle()` and an in-flight flag, and must be disable-able.

**G. Jev is fast enough for this design.** Measured against the live API with a
36 KB state and 120 questions (60 tool calls x 2): **~1.0 s**, `input_tokens: 10952`,
`output_tokens: 2266`, model `jev-1.13.0`. No rate-limit or size error at that size.

---

## 3. Target architecture

```
pi-jev-compaction/
├── src/                     # engine, ported from upstream, host-agnostic
│   ├── types.ts             # + a `Pinned reason` and `RenderOptions` extension
│   ├── request.ts           # unchanged
│   ├── client.ts            # unchanged
│   ├── state.ts             # unchanged algorithm
│   ├── compact.ts           # unchanged algorithm
│   ├── messages.ts          # unchanged
│   └── index.ts             # unchanged barrel
├── extensions/
│   ├── jev-compaction.ts    # Pi adapter: event wiring, config, fallbacks, commands
│   └── pi-messages.ts       # pure, unit-testable: AgentMessage <-> Message, renderer
├── tests/
│   ├── engine.test.ts       # upstream suite, adapted imports only
│   ├── pi-messages.test.ts  # mapping + rendering, fake Jev, no network
│   └── extension.test.ts    # handler behaviour with a fake api/ctx
├── docs/
│   ├── PLAN.md              # this file
│   └── architecture.md      # deep module notes after implementation
├── .changelog/CHANGELOG_0.1.0.md
├── README.md
├── package.json             # npm exports + `pi` manifest
├── tsconfig.json            # library -> dist (no .ts specifiers)
└── tsconfig.extension.json  # typecheck the extension (allowImportingTsExtensions, noEmit)
```

### 3.1 Engine port: keep it byte-identical where possible

Port `src/` unchanged except for two additive changes, so upstream diffs stay
readable and the ported test suite can be used as a **conformance check**:

1. `ToolCall` gains `kind: "call" | "result"`-free metadata? **No.** Keep the shape.
2. Add `renderTranscript()`-adjacent helpers? **No.** Rendering is a Pi concern and
   belongs in `extensions/pi-messages.ts`.

Additive change actually needed: export a `pinnedByBoundary` helper so the adapter can
mark calls whose result lies outside the replaced span as pinned, reusing the core's
`isPinned` semantics rather than duplicating them.

**Conformance gate:** `tests/engine.test.ts` must be the upstream suite with only the
import path changed, and green. If a test needs editing, the port drifted.

### 3.2 The adapter (the only genuinely new code)

**Mapping Pi → library.** Pi's `AgentMessage` union is
`user | assistant | toolResult | bashExecution | custom | branchSummary | compactionSummary`.

```ts
// extensions/pi-messages.ts (shape, not final code)
export interface Span {
  messages: Message[];          // library model, one per Pi message
  anchors: SpanAnchor[];        // pi index <-> library index, toolCallId -> block index
  opaque: unknown[];            // thinking/images/custom kept by reference, never rebuilt
}
```

Rules:

- `user` → `{ role: "user", text: textBlocks.join("\n"), toolUses: [] }`.
- `assistant` → `{ role: "assistant", text: textBlocks.join("\n"), toolUses: [{ tool_use_id: call.id, tool: call.name, input: call.arguments }] }`.
  **Thinking blocks are never mapped, never truncated, never dropped by the library
  path**; they are carried through untouched by the renderer.
- `toolResult` → `{ role: "user", text: blocksToText(content), toolResults: [{ tool_use_id: toolCallId, text, isError }] }`
  attached to its own library message, exactly like upstream's Claude Code mapping.
- `bashExecution`, `custom`, `compactionSummary`, `branchSummary` → **not candidates**,
  rendered as-is (see 3.4).

**Choosing the span.** Do **not** use `preparation.messagesToSummarize` as the source
of truth (finding D). Walk `event.branchEntries`:

1. Keep only entries of `type === "message"` (plus `custom_message`), in branch order.
2. Find the index of `preparation.firstKeptEntryId`; everything **before** it is the
   span to replace. Entries at/after it are kept by Pi.
3. A tool call inside the span whose result is *not* in the span (defensive: the cut
   rules forbid it, but a malformed session must not corrupt the request) is pinned.
4. The first message and the newest `preserveRecentMessages` (6) messages of the span
   are pinned by the core, matching upstream.

**Rendering the replacement text.** `renderSpan()` produces the string that goes into
`summary`:

- A one-line, human-first header, so the collapsed TUI row and the model both get the
  point: `Jev compaction: kept 41/58 tool calls, 63% smaller, no summary (verbatim history follows)`.
- Then the surviving history as a plain `### user` / `### assistant` / `### tool <name>`
  transcript (same information shape as Pi's own `serializeConversation`, so the model
  is not confused into continuing it).
- Dropped result → first `truncateHeadChars` chars + `[jev: 1700 of 2000 chars dropped; re-run the tool if needed]`.
- Dropped call → call line and result both vanish. If the call belonged to an
  assistant message that carried **thinking** blocks, the whole assistant message is
  dropped instead of surgery inside a thinking+tool_use message (§6, risk R2).

**Return value.**

```ts
return {
  compaction: {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens, cost } // summed Jev usage
    details: {
      readFiles: preparation.fileOps.readFiles,      // keep Pi's file tracking working
      modifiedFiles: preparation.fileOps.modifiedFiles,
      jev: { version, decisions, stateTokens, stateStage, requests, ms, kept, dropped, truncated }
    }
  }
};
```

**Fallback ladder** (must mirror upstream's "never lose context" stance):

| Condition | Action |
| --- | --- |
| No `TYPESAFE_API_KEY` and no configured key | notify + return nothing (Pi's summary) |
| No candidate tool calls (nothing to prune) | compute the reduction; if below the minimum, fall back |
| State cannot be fitted into `maxStateTokens` | notify + fall back |
| Jev HTTP error / malformed answer / missing `noul` | notify + fall back |
| Reduction < `minReductionRatio` (0.25) | notify + fall back (do not pay the verbatim cost for nothing) |
| Success | notify with kept/total, reduction, state stage, request count |

### 3.3 Configuration

Read in this order, first hit wins: extension flags (`--jev-*`, for explicit runs) →
`~/.pi/agent/jev-compaction.json` → defaults. **Not** the API key on the command line
(flags are visible in `ps`); the key comes from `TYPESAFE_API_KEY` or the config file,
and is never logged.

Same option surface as upstream, with Pi-side additions:

| Option | Default | Note |
| --- | --- | --- |
| `keepThreshold` | 0.5 | unchanged |
| `preserveRecentMessages` | 6 | pins the newest 6 messages of the replaced span |
| `maxStateTokens` | 25000 | unchanged |
| `maxRequestTokens` | 30000 | unchanged (Jev cap 32k) |
| `truncateHeadChars` | 300 | unchanged |
| `minReductionRatio` | 0.25 | fall back below this |
| `compactAtPercent` | 0 (off) | optional `turn_end` bootstrap, guarded by `ctx.isIdle()` |
| `model` | `jev-latest` | unchanged |
| `enabled` | true | kill switch |

### 3.4 UX in Pi

- `/jev` → status: last compaction (kept N/M calls, % smaller, state stage, requests,
  ms), cumulative savings (characters and estimated tokens), Jev key presence,
  fallback count.
- `/jev-compact [instructions]` → `ctx.compact({ customInstructions })`.
- Notifications on every compaction outcome (`ctx.ui.notify`) and a footer status while
  Jev is deciding (`ctx.ui.setStatus("jev", "Jev deciding…")`).
- `session_compact_failed` with `fromExtension:false` after our handler ran →
  surface "Pi could not compact (session too small)" instead of a silent no-op.
- Note that the compaction row in the TUI will contain the verbatim transcript. That is
  expected: the first line is the human-readable header.

---

## 4. Build phases

| Phase | Deliverable | Est. |
| --- | --- | --- |
| **0. Skeleton + seam smoke test** | repo, `package.json` with the `pi` manifest, extension loaded via `pi -e`, `session_before_compact` + `session_compact` logging. Prove jiti resolves `../src/index.ts` from the extension. | 30 min |
| **1. Engine port** | `src/` + upstream test suite green (`npm test`, `npm run typecheck`). Verify Jev accepts a ~30k-token state (the `maxRequestTokens` assumption) with a live call. | 1 h |
| **2. Adapter + renderer** | `extensions/pi-messages.ts` + unit tests: mapping, rendering, thinking-safe drop, fileOps merge, span selection from `branchEntries`. | 3 h |
| **3. Extension wiring** | `session_before_compact` handler, fallback ladder, config, `/jev`, notifications, `compactAtPercent` bootstrap. | 2 h |
| **4. End-to-end validation in Herdr** | long session (>20k tokens, multi-turn, multi-tool) in a Herdr workspace: `/compact`, then ask the model to quote its first instruction and the last error message. Repeat compaction twice. Force each fallback. | 1.5 h |
| **5. Docs + publish** | README, `.changelog/CHANGELOG_0.1.0.md`, `docs/architecture.md`, GitHub push, `pi install`, re-verify the installed copy. | 1 h |

Total: about **1.5 days**, with phase 0 and 1 done back to back.

### Definition of done

- [ ] `npm test` green, including the untouched upstream engine suite.
- [ ] `npm run typecheck` green for the library **and** the extension.
- [ ] A real `/compact` in a real long session produces `fromExtension: true` and a
      session entry whose `details.jev` carries the decision log.
- [ ] After compaction, the model can still quote its first user instruction and the
      most recent tool error verbatim (the whole point of the port).
- [ ] Every fallback path is exercised once and observed as a Pi built-in summary.
- [ ] Reduction measured on a real session: report the % (upstream's README advertises
      what it gets; we should state ours honestly).
- [ ] Installed globally, works from a fresh directory with no local checkout.

---

## 5. What is deliberately not ported

- `types/claude-code.d.ts` (11k lines of generated Claude Code declarations).
- The Claude Code marketplace/plugin manifests, replaced by the Pi `pi` manifest:
  `{"pi": {"extensions": ["./extensions"]}}` + `pi-package` keyword.
- `demo/JevDemo` (SwiftUI animation).
- The `context` hot path (validated, documented in §7, off in v1).

---

## 6. Risks, each with a mitigation and a test

| # | Risk | Mitigation | Verified by |
| --- | --- | --- | --- |
| R1 | jiti cannot resolve `../src/index.ts` from an extension in an npm/git-installed package. | Phase 0 smoke test. Fallback: `npm run build` and import `../dist/index.js`, keeping the extension out of the library tsconfig. | Phase 0, then again after `pi install` in phase 5. |
| R2 | Dropping a `toolCall` block out of an assistant message that also carries a **thinking** block can produce a malformed provider request (Anthropic's thinking+tool_use ordering rules). | Never do per-block surgery on a thinking+tool_use assistant message: drop the whole message when its text is empty and every one of its calls is dropped; otherwise keep the call and truncate only the result. | Phase 2 unit test + phase 4 real run on Anthropic extended thinking, then again on an OpenAI-compatible provider. |
| R3 | A kept tool result without its call (or the reverse) breaks the provider contract. | The renderer only ever drops call+result pairs; the core already guarantees a result is never kept without its call. Calls whose result falls outside the replaced span are force-pinned. | Phase 2 unit test with a cut in the middle of a call/result pair. |
| R4 | Pi's `Nothing to compact (session too small)` looks like a silent failure. | Detect `session_compact_failed` with `fromExtension:false` and notify with the real reason; document the `keepRecentTokens` interaction in the README. | Phase 4. |
| R5 | `ctx.compact()` from `turn_end` aborts the running operation (observed). | Default `compactAtPercent` to **off**; when enabled, require `ctx.isIdle()` + in-flight flag; rely on Pi's own threshold as the primary trigger. | Phase 3 + 4. |
| R6 | Repeated compaction carries a growing verbatim blob that can never be re-pruned. | Rebuild the span from the **original** `branchEntries` every time (ignoring `previousSummary`), so tool noise is re-evaluated and can be dropped later. | Phase 2 unit test with a previous compaction entry present in `branchEntries`. |
| R7 | Loss of Pi's cumulative file tracking (`readFiles`/`modifiedFiles`) when we return custom details. | Always merge `preparation.fileOps` into `details` under the same keys. | Phase 2/4: after two compactions, the summary must still list files read long before. |
| R8 | The verbatim replacement is too big to be useful (context saved < 25%). | `minReductionRatio` fallback, exactly like upstream; report the real number in the README instead of overselling. | Phase 4 measurement. |
| R9 | Jev state/request ceiling is exceeded by a very long session. | The staged fitting plus the explicit `throw` are already in the engine; the adapter turns that throw into a fallback, never into silent truncation. | Phase 1 live 30k-token check + phase 4 long session. |
| R10 | Secret leakage: key in flags, logs, or `details`. | Key only from env/config file; never echoed, never written into `details`; decisions log contains only ids, tools and probabilities. | Phase 3 code review + grep before publish. |

---

## 7. Upgrade path (not in v1)

The `context` hook is validated and is the Pi-only feature Claude Code cannot have:
prune **before every provider request** once usage crosses a threshold, so a session
can run for days without ever hitting a lossy summary. The design that would be used:

- Decisions are computed once per call and **frozen** (never re-decided), so the pruned
  prefix stays byte-stable across turns and prompt caching keeps working.
- Only calls outside the last `preserveRecentMessages` are candidates, and Jev is asked
  only when new tool results arrived since the last pass.
- Decisions and stats are persisted with `pi.appendEntry`, so a resumed session does not
  re-ask Jev.
- `/jev-mode continuous|compaction` toggles. Compaction remains the safety net.

Estimated: +1 day once the port is green.
