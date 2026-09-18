/**
 * @file jev-compaction.ts
 * @description Pi extension: Jev-guided, verbatim context compaction.
 *
 * WHAT IT DOES
 * Pi's compaction replaces everything before `firstKeptEntryId` with an LLM-written
 * summary, which is lossy: a file path, an exact error, a constraint or a command can
 * disappear even when it still matters. This extension keeps the same compaction
 * mechanics but fills the replacement with the *surviving history verbatim*: for every
 * tool call in the replaced span it asks TypeSafe's Jev two questions (does knowing this
 * call was made still matter, is its full output still needed), deletes the calls and
 * outputs Jev says are dead, truncates the outputs it only half-needs, and leaves user
 * and assistant text untouched and in order. No summary is ever written.
 *
 * WHY the hooks are wired this way
 * - `session_before_compact` is the only place Pi lets an extension supply the replacement
 *   text, so it is the port's core. Returning nothing (or throwing) makes Pi fall back to
 *   its built-in summary, which is the safety net for every failure mode.
 * - The replacement text is built from the *raw branch entries*, not from
 *   `preparation.messagesToSummarize`. Pi hands over `messagesToSummarize` +
 *   `turnPrefixMessages`, but those are already compaction-aware: after a first compaction
 *   the originals are only reachable through `branchEntries`. Rebuilding from the raw path
 *   means every later compaction can re-decide the whole original history (so tool noise
 *   dropped earlier stays dropped and nothing has to be re-summarized), and it avoids the
 *   split-turn trap where everything lands in `turnPrefixMessages`.
 * - `session_compact` / `session_compact_failed` only report outcomes to the user.
 *
 * CONFIGURATION
 * `~/.pi/agent/jev-compaction.json` (see extensions/lib/config.ts), key from the file or
 * `TYPESAFE_API_KEY`. `/jev status` prints the effective configuration and last result.
 *
 * @functions
 * - buildCompaction → the whole decision pipeline, host-free and unit-testable
 * - selectSpan → raw branch entries -> the entries Pi is about to replace
 * - goalFromEntries → default goal (last user prompts) when none is configured
 * - computeFileLists → Pi's cumulative read/modified file lists
 * - createAsker → JevClient with request timeout and abort propagation
 * - withLimit → run batches with bounded concurrency
 * - formatting helpers → decision log, stats line, status report
 *
 * @exports default (ExtensionAPI factory), buildCompaction, selectSpan, RunStats,
 * CompactionAttempt, JevDetails
 *
 * @see extensions/lib/pi-messages.ts, extensions/lib/config.ts, docs/PLAN.md
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  JevClient,
  batchCalls,
  collectToolCalls,
  decideCall,
  fitState,
  truncate,
  type CallAnswer,
  type CallDecision,
  type JevAsker,
  type JevQuestions,
  type ToolCall,
} from "../src/index.ts";
import {
  buildSpan,
  collectOutcomes,
  isExcludedFromContext,
  messageText,
  renderSpan,
  type Span,
  type SpanEntry,
} from "./lib/pi-messages.ts";
import {
  describeConfig,
  getConfigPath,
  getLogPath,
  loadConfig,
  resolveApiKey,
  type JevConfig,
} from "./lib/config.ts";
/** Bump when the shape of `details.jev` changes, so old entries stay readable. */
const DETAILS_VERSION = 1;

export interface RunStats {
  calls: number;
  kept: number;
  resultsDropped: number;
  callsDropped: number;
  pinned: number;
  charsBefore: number;
  charsAfter: number;
  reduction: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
  ms: number;
  usage: { input: number; output: number };
}

export interface JevDetails {
  readFiles: string[];
  modifiedFiles: string[];
  jev: {
    version: number;
    model: string;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    calls: number;
    charsBefore: number;
    charsAfter: number;
    reduction: number;
    stateTokens: number;
    stateStage: string;
    requests: number;
    ms: number;
    usage: { input: number; output: number };
    /** Per-call probabilities, for diagnosing a strange compaction after the fact. */
    decisions: string;
  };
}

export type CompactionAttempt =
  | {
      status: "compacted";
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details: JevDetails;
      stats: RunStats;
    }
  | { status: "fallback"; reason: string };

const DECISION_LOG_MAX_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Selects the entries Pi is about to drop, from the raw branch.
 *
 * Entries before `firstKeptEntryId` are the ones being replaced. `compaction` entries are
 * skipped on purpose: their content is already present earlier in the same path, and
 * re-rendering the originals is what lets a second compaction re-prune history instead of
 * carrying an ever-growing blob. `branch_summary` entries are kept, because the branch they
 * summarize is not on this path and their text is the only remaining trace of it.
 */
export function selectSpan(
  branchEntries: readonly SessionEntry[],
  firstKeptEntryId: string,
): SpanEntry[] | undefined {
  const boundary = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (boundary <= 0) return undefined;
  const entries: SpanEntry[] = [];
  for (const entry of branchEntries.slice(0, boundary)) {
    if (entry.type === "compaction") continue;
    for (const message of sessionEntryToContextMessages(entry)) {
      if (isExcludedFromContext(message)) continue;
      entries.push({ entryId: entry.id, message });
    }
  }
  return entries;
}

/** Last few user prompts, used as Jev's `goal`. Custom instructions win when present. */
export function goalFromEntries(entries: readonly SpanEntry[], customInstructions?: string): string {
  const prompts = entries
    .filter((entry) => (entry.message as { role?: unknown }).role === "user")
    .map((entry) => messageText(entry.message))
    .filter((text) => text.trim().length > 0)
    .slice(-3)
    .map((text) => truncate(text, 500));
  const parts = [
    customInstructions && customInstructions.trim().length > 0
      ? `Focus requested by the user: ${truncate(customInstructions.trim(), 500)}`
      : "",
    ...prompts,
  ].filter((part) => part.length > 0);
  return parts.join("\n");
}

/** Pi's own cumulative file lists, recomputed from the preparation's operation sets. */
export function computeFileLists(fileOps: unknown): { readFiles: string[]; modifiedFiles: string[] } {
  const empty = { readFiles: [] as string[], modifiedFiles: [] as string[] };
  if (!isRecord(fileOps)) return empty;
  const asSet = (value: unknown): Set<string> =>
    value instanceof Set ? new Set([...value].filter((item): item is string => typeof item === "string")) : new Set<string>();
  const read = asSet(fileOps["read"]);
  const written = asSet(fileOps["written"]);
  const edited = asSet(fileOps["edited"]);
  const modified = new Set([...edited, ...written]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

/**
 * Builds a combined abort signal: the host's compaction signal plus a hard timeout, so a
 * hung Jev request can never block compaction forever.
 */
function combineSignals(signals: readonly (AbortSignal | null | undefined)[], ms: number): AbortSignal {
  const controller = new AbortController();
  const timeout = new Error(`Jev request timed out after ${ms}ms`);
  const timer = setTimeout(() => controller.abort(timeout), ms);
  // Do not keep the process alive for the timer once the request settles.
  timer.unref?.();
  const cleanups: (() => void)[] = [() => clearTimeout(timer)];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      for (const cleanup of cleanups) cleanup();
    },
    { once: true },
  );
  return controller.signal;
}

/**
 * A `JevAsker` over the platform `fetch`, honouring the host abort signal and a timeout.
 * Built per compaction because it is bound to that event's signal.
 */
export function createAsker(
  config: JevConfig,
  apiKey: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): JevAsker {
  const fetcher: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: combineSignals([init?.signal, signal], config.timeoutMs) });
  return new JevClient({
    apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    fetch: fetcher,
  });
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order. */
async function withLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed && failed.status === "rejected") throw failed.reason;
  return results;
}

async function askBatch(
  asker: JevAsker,
  state: object,
  batch: readonly ToolCall[],
): Promise<{ answers: Map<string, CallAnswer>; usage: { input: number; output: number } }> {
  const questions = Object.assign(
    {},
    ...batch.map((call) => ({
      [`call_${call.id}`]: {
        type: "noul" as const,
        instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
      },
      [`result_${call.id}`]: {
        type: "noul" as const,
        instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
      },
    })),
  ) as JevQuestions;
  const response = await asker.ask(state, questions);
  const answers = response.answers;
  const parsed = new Map<string, CallAnswer>();
  for (const call of batch) {
    const callAnswer = answers[`call_${call.id}`];
    const resultAnswer = answers[`result_${call.id}`];
    const keepCall = isRecord(callAnswer) ? callAnswer["noul"] : undefined;
    const keepResult = isRecord(resultAnswer) ? resultAnswer["noul"] : undefined;
    if (typeof keepCall !== "number" || !Number.isFinite(keepCall)) {
      throw new Error(`Invalid Jev answer for call_${call.id}`);
    }
    if (typeof keepResult !== "number" || !Number.isFinite(keepResult)) {
      throw new Error(`Invalid Jev answer for result_${call.id}`);
    }
    parsed.set(call.id, { keepCall, keepResult });
  }
  const reported = isRecord(response.usage) ? response.usage : {};
  const tokenCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    answers: parsed,
    usage: {
      input: tokenCount(reported["input_tokens"]),
      output: tokenCount(reported["output_tokens"]),
    },
  };
}

function count(decisions: readonly CallDecision[], reason: CallDecision["reason"]): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

function decisionLog(decisions: readonly CallDecision[]): string {
  const text = decisions
    .filter((decision) => decision.reason !== "pinned")
    .map(
      (decision) =>
        `${decision.id}:${decision.tool}:${decision.action}/call=${decision.keepCall.toFixed(2)}/result=${decision.keepResult.toFixed(2)}`,
    )
    .join(" ");
  if (text.length <= DECISION_LOG_MAX_CHARS) return text;
  return `${text.slice(0, DECISION_LOG_MAX_CHARS)}… (truncated)`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface BuildCompactionInput {
  branchEntries: readonly SessionEntry[];
  firstKeptEntryId: string;
  tokensBefore: number;
  fileOps: unknown;
  customInstructions?: string;
  signal?: AbortSignal;
  config: JevConfig;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * The whole pipeline: select the span, score it with Jev, render the survivors.
 *
 * Never throws. Every failure comes back as `{ status: "fallback", reason }` so the caller
 * can tell the user and let Pi use its built-in summary: a Jev outage must never turn into
 * a failed compaction.
 */
export async function buildCompaction(input: BuildCompactionInput): Promise<CompactionAttempt> {
  const started = Date.now();
  const { config } = input;
  if (input.branchEntries.length === 0) return { status: "fallback", reason: "empty session" };

  const entries = selectSpan(input.branchEntries, input.firstKeptEntryId);
  if (!entries || entries.length === 0) {
    return { status: "fallback", reason: "nothing before the kept boundary" };
  }

  const span: Span = buildSpan(entries);
  const goal = goalFromEntries(entries, input.customInstructions);
  const calls = collectToolCalls(span.engine, config.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);

  const answers = new Map<string, CallAnswer>();
  let stateTokens = 0;
  let stateStage = "";
  let requests = 0;
  const usage = { input: 0, output: 0 };

  if (candidates.length > 0) {
    let fitted;
    try {
      fitted = fitState(span.engine, calls, {
        maxStateTokens: config.maxStateTokens,
        preserveRecentMessages: config.preserveRecentMessages,
        goal,
      });
    } catch (error) {
      return { status: "fallback", reason: `state too large for Jev (${errorMessage(error)})` };
    }
    stateTokens = fitted.tokens;
    stateStage = fitted.stage;

    let batches: ToolCall[][];
    try {
      batches = batchCalls(candidates, fitted.tokens, { maxRequestTokens: config.maxRequestTokens });
    } catch (error) {
      return { status: "fallback", reason: `questions do not fit (${errorMessage(error)})` };
    }
    requests = batches.length;

    const asker = createAsker(config, input.apiKey, input.signal, input.fetchImpl ?? fetch);
    try {
      const answered = await withLimit(batches, config.maxConcurrentRequests, (batch) =>
        askBatch(asker, fitted.state, batch),
      );
      for (const result of answered) {
        for (const [id, answer] of result.answers) answers.set(id, answer);
        usage.input += result.usage.input;
        usage.output += result.usage.output;
      }
    } catch (error) {
      if (input.signal?.aborted) return { status: "fallback", reason: "compaction cancelled" };
      return { status: "fallback", reason: `Jev failed (${errorMessage(error)})` };
    }
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, config),
  );
  const fileOps = computeFileLists(input.fileOps);
  const outcomes = collectOutcomes(calls, decisions);
  const keptCalls = calls.length - count(decisions, "call_dropped");
  const summary = renderSpan(span, outcomes, {
    headChars: config.truncateHeadChars,
    thinking: config.thinking,
    thinkingHeadChars: config.thinkingHeadChars,
    header: `Jev kept ${keptCalls}/${calls.length} tool calls verbatim (no summary).`,
    fileOps,
  });

  const charsBefore = span.rawChars;
  const charsAfter = summary.length;
  const reduction = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
  if (candidates.length === 0 && reduction <= 0) {
    return {
      status: "fallback",
      reason:
        calls.length === 0
          ? "no tool call in the replaced span"
          : `all ${calls.length} tool calls in the span are pinned by preserveRecentMessages`,
    };
  }
  if (reduction < config.minReductionRatio) {
    return {
      status: "fallback",
      reason: `only ${percent(Math.max(0, reduction))} smaller, under the ${percent(config.minReductionRatio)} minimum`,
    };
  }

  const stats: RunStats = {
    calls: calls.length,
    kept: count(decisions, "kept"),
    resultsDropped: count(decisions, "result_dropped"),
    callsDropped: count(decisions, "call_dropped"),
    pinned: count(decisions, "pinned"),
    charsBefore,
    charsAfter,
    reduction,
    stateTokens,
    stateStage,
    requests,
    ms: Date.now() - started,
    usage,
  };
  return {
    status: "compacted",
    summary,
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    stats,
    details: {
      readFiles: fileOps.readFiles,
      modifiedFiles: fileOps.modifiedFiles,
      jev: {
        version: DETAILS_VERSION,
        model: config.model,
        kept: stats.kept,
        resultsDropped: stats.resultsDropped,
        callsDropped: stats.callsDropped,
        pinned: stats.pinned,
        calls: stats.calls,
        charsBefore,
        charsAfter,
        reduction,
        stateTokens,
        stateStage,
        requests,
        ms: stats.ms,
        usage,
        decisions: decisionLog(decisions),
      },
    },
  };
}

function statsLine(stats: RunStats): string {
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : "",
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : "",
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : "",
    stats.pinned > 0 ? `${stats.pinned} pinned` : "",
  ].filter((part) => part.length > 0);
  return `${percent(Math.max(0, stats.reduction))} smaller; ${parts.join(", ") || "no tool calls"}; state ~${stats.stateTokens} tokens (${stats.stateStage || "none"}) in ${stats.requests} request(s), ${stats.ms}ms`;
}

interface Runtime {
  config: JevConfig;
  log: (message: string) => void;
  warnings: string[];
  path?: string;
  runs: number;
  fallbacks: number;
  failures: number;
  charsSaved: number;
  callsDropped: number;
  resultsDropped: number;
  lastStats?: RunStats;
  lastReason?: string;
  compacting: boolean;
}

function notify(ctx: { ui: { notify: (text: string, type?: "info" | "warning" | "error") => void } }, text: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(text, type);
  } catch {
    // A UI that is not ready must never break compaction.
  }
}

export default function jevCompaction(pi: ExtensionAPI): void {
  const loaded = loadConfig();
  const runtime: Runtime = {
    config: loaded.config,
    log: () => {},
    warnings: loaded.warnings,
    path: loaded.path,
    runs: 0,
    fallbacks: 0,
    failures: 0,
    charsSaved: 0,
    callsDropped: 0,
    resultsDropped: 0,
    compacting: false,
  };

  // Debug logging is a first-class feature, not scaffolding: a silent fallback is the
  // hardest thing to diagnose in a compaction extension, because the host shows the
  // built-in summary and nothing else. `debug: true` in the config writes one line per step.
  runtime.log = (message: string): void => {
    if (!runtime.config.debug) return;
    try {
      appendFileSync(getLogPath(), `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
    } catch {
      // A read-only agent directory must never break compaction.
    }
  };
  const apiKey = (): string => resolveApiKey(runtime.config);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    runtime.log(`session start; ${describeConfig(runtime.config, apiKey())}`);
    ctx.ui.setStatus("jev", undefined);
    for (const warning of runtime.warnings) {
      notify(ctx, `pi-jev-compaction: ${warning}`, "warning");
    }
    if (runtime.config.enabled && apiKey().length === 0) {
      notify(
        ctx,
        `pi-jev-compaction: no TypeSafe key. Set TYPESAFE_API_KEY or "apiKey" in ${getConfigPath()}. Pi will use its built-in summary.`,
        "warning",
      );
    }
  });

  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    if (!runtime.config.enabled) {
      runtime.log("skip: disabled");
      return;
    }
    const key = apiKey();
    if (key.length === 0) {
      runtime.log("skip: no TypeSafe key");
      return;
    }
    runtime.log(
      `compact requested (${event.reason}); entries=${event.branchEntries.length} boundary=${event.preparation.firstKeptEntryId} tokensBefore=${event.preparation.tokensBefore}`,
    );

    let attempt;
    try {
      attempt = await buildCompaction({
      branchEntries: event.branchEntries,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      fileOps: event.preparation.fileOps,
      customInstructions: event.customInstructions,
      signal: event.signal,
        config: runtime.config,
        apiKey: key,
      });
    } catch (error) {
      // Pi swallows handler errors: an unexpected throw would silently become the
      // built-in summary. Surface it instead.
      runtime.log(`handler threw: ${errorMessage(error)}`);
      notify(ctx, `pi-jev-compaction: internal error, built-in summary used (${errorMessage(error)})`, "error");
      return;
    }

    if (attempt.status === "fallback") {
      runtime.log(`fallback: ${attempt.reason}`);
      runtime.fallbacks += 1;
      runtime.lastReason = attempt.reason;
      if (!event.signal.aborted) {
        // The toast is transient, so the footer keeps the reason visible until the next
        // successful compaction: a silent fallback is the worst outcome for trust.
        try {
          ctx.ui.setStatus("jev", `jev fallback (${truncate(attempt.reason, 60)})`);
        } catch {
          // ignore
        }
        notify(
          ctx,
          `pi-jev-compaction: built-in summary used (${attempt.reason})`,
          "warning",
        );
      }
      return;
    }

    runtime.log(
      `compacted: ${attempt.stats.calls} calls, ${attempt.stats.callsDropped} dropped, ${attempt.stats.resultsDropped} truncated, ${Math.round(attempt.stats.reduction * 100)}% smaller, state ${attempt.stats.stateTokens} (${attempt.stats.stateStage}) in ${attempt.stats.requests} request(s), ${attempt.stats.ms}ms`,
    );
    runtime.runs += 1;
    runtime.lastStats = attempt.stats;
    runtime.lastReason = undefined;
    runtime.charsSaved += Math.max(0, attempt.stats.charsBefore - attempt.stats.charsAfter);
    runtime.callsDropped += attempt.stats.callsDropped;
    runtime.resultsDropped += attempt.stats.resultsDropped;
    return { compaction: attempt };
  });

  pi.on("session_compact", async (event: SessionCompactEvent, ctx: ExtensionContext) => {
    if (!event.fromExtension) return;
    const stats = runtime.lastStats;
    if (!stats) return;
    ctx.ui.setStatus("jev", `jev ${percent(Math.max(0, stats.reduction))} smaller`);
    notify(ctx, `pi-jev-compaction: ${statsLine(stats)}`);
  });

  pi.on("session_compact_failed", async (event, ctx: ExtensionContext) => {
    if (event.aborted) return;
    if (!event.fromExtension) {
      // Pi declined to compact before our handler could even run, or the built-in
      // summarizer failed. This is exactly what happens when the kept recent window
      // already covers the whole session, and it deserves a real explanation.
      if (event.errorMessage?.includes("Nothing to compact")) {
        notify(
          ctx,
          "pi-jev-compaction: nothing to compact yet - the session is smaller than the kept-recent window (compaction.keepRecentTokens). Pi shrinks that window as the session grows.",
          "info",
        );
        return;
      }
      if (event.errorMessage) {
        notify(ctx, `pi-jev-compaction: compaction failed (${event.errorMessage})`, "error");
      }
      return;
    }
    runtime.failures += 1;
    runtime.log(`compaction failed: ${event.errorMessage ?? "unknown"}`);
    notify(ctx, `pi-jev-compaction: compaction failed (${event.errorMessage ?? "unknown"})`, "error");
  });

  // Optional early trigger. Off by default: Pi already triggers compaction on its own
  // threshold, and calling ctx.compact() while the agent is mid-run aborts that run.
  pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
    if (runtime.config.compactAtPercent <= 0 || !runtime.config.enabled) return;
    if (runtime.compacting || !ctx.isIdle()) return;
    const usage = ctx.getContextUsage();
    if (!usage || (usage.percent ?? 0) < runtime.config.compactAtPercent) return;
    runtime.compacting = true;
    try {
      ctx.compact({
        onComplete: () => {
          runtime.compacting = false;
        },
        onError: () => {
          runtime.compacting = false;
        },
      });
    } catch {
      runtime.compacting = false;
    }
  });

  const statusReport = (): string => {
    const lines = [
      `pi-jev-compaction v${DETAILS_VERSION} - ${runtime.config.enabled ? "on" : "OFF"}`,
      `config: ${describeConfig(runtime.config, apiKey())}`,
      `config file: ${runtime.path ?? `${getConfigPath()} (absent, defaults in use)`}`,
      runtime.lastStats
        ? `last: ${statsLine(runtime.lastStats)}`
        : `last: ${runtime.lastReason ? `built-in summary (${runtime.lastReason})` : "no compaction yet"}`,
      `totals: ${runtime.runs} Jev compaction(s), ${runtime.fallbacks} fallback(s), ${runtime.failures} failed, ${runtime.callsDropped} calls + ${runtime.resultsDropped} results dropped, ${runtime.charsSaved} chars saved`,
      runtime.warnings.length > 0 ? `warnings: ${runtime.warnings.join(" | ")}` : "",
    ].filter((line) => line.length > 0);
    return lines.join("\n");
  };

  pi.registerCommand("jev", {
    description: "Jev compaction status. Usage: /jev [status|on|off|reset]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const action = args.trim().toLowerCase();
      if (action === "on" || action === "off") {
        runtime.config.enabled = action === "on";
        notify(ctx, `pi-jev-compaction: ${action === "on" ? "enabled" : "disabled"} for this session`);
        return;
      }
      if (action === "reload") {
        const reloaded = loadConfig();
        runtime.config = reloaded.config;
        runtime.warnings = reloaded.warnings;
        runtime.path = reloaded.path;
        notify(ctx, `pi-jev-compaction: config reloaded\n${statusReport()}`);
        return;
      }
      if (action === "reset") {
        runtime.runs = 0;
        runtime.fallbacks = 0;
        runtime.failures = 0;
        runtime.charsSaved = 0;
        runtime.callsDropped = 0;
        runtime.resultsDropped = 0;
        runtime.lastStats = undefined;
        runtime.lastReason = undefined;
        notify(ctx, "pi-jev-compaction: session stats reset");
        return;
      }
      notify(ctx, statusReport());
    },
  });

  pi.registerCommand("jev-compact", {
    description: "Compact now, letting Jev decide what to drop. Usage: /jev-compact [instructions]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const instructions = args.trim();
      if (apiKey().length === 0) {
        notify(
          ctx,
          `pi-jev-compaction: no TypeSafe key, Pi will write a normal summary. Set TYPESAFE_API_KEY or "apiKey" in ${getConfigPath()}.`,
          "warning",
        );
      }
      ctx.compact(instructions.length > 0 ? { customInstructions: instructions } : {});
    },
  });
}
