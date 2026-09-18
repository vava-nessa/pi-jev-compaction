/**
 * @file pi-messages.ts
 * @description Bridge between Pi's session messages and the host-agnostic
 * "engine" message model used by `src/` (ported from fast-jev-compaction).
 *
 * WHY this file exists: the engine was written for Claude Code, where a session
 * message is a flat `{ role, text, toolUses, toolResults }` record. Pi splits the
 * same information across several message types (`user`, `assistant` with mixed
 * text/thinking/toolCall content blocks, and a separate `toolResult` message) and
 * adds message kinds Claude Code does not have (`bashExecution`, `custom`,
 * `branchSummary`, `compactionSummary`). This module owns the two translation
 * directions plus the renderer, so the engine stays byte-identical to upstream and
 * the Pi specifics live in exactly one testable place.
 *
 * HOW it is used: `buildSpan()` turns the session entries that Pi is about to
 * replace with `mapPiMessageToEngine()` results the engine can score, `collectToolCalls`
 * + `decideCall` (from `src/`) turn those into per-call outcomes, and `renderSpan()`
 * writes the surviving history back out as text, because Pi's custom-compaction API
 * accepts a summary *string* and not messages (see docs/PLAN.md section 2.2).
 *
 * Design rules, all deliberate:
 * - Thinking blocks are never sent to Jev (parity with the Claude Code original,
 *   where the library never sees thinking) but they are preserved in the rendered
 *   history, abridged by default, because they often carry decisions that the
 *   visible text does not restate. The one exception: an assistant message with no
 *   text whose every tool call was dropped disappears entirely, thinking included,
 *   because all it explained were calls Jev judged dead.
 * - Images are replaced by a short marker in the rendered text, since an image
 *   cannot survive a text round-trip.
 * - The rendered format mirrors Pi's own `serializeConversation()` output exactly,
 *   so the model reads the replacement the same way it reads Pi's built-in summary,
 *   and does not treat it as a conversation to continue.
 * - Nothing here mutates a Pi message. The replacement is text, and the kept entries
 *   continue to carry their original structured content.
 *
 * @functions
 * - buildSpan → session entries -> engine messages + per-message anchors
 * - piMessageChars → characters a Pi message occupies in the context (with thinking)
 * - renderSpan → surviving history -> the text Pi stores as the compaction summary
 * - collectOutcomes → engine tool calls + decisions -> per-tool-call drop flags
 * - truncatedResultText → head + note for a tool result Jev no longer needs in full
 * - messageText → all text of a Pi message, whatever its kind (used for accounting)
 * - textOfContent → text blocks of a content array, images as markers
 *
 * @exports Span, SpanEntry, MappedMessage, CallOutcome, SpanStats, RenderOptions,
 * buildSpan, piMessageChars, renderSpan, collectOutcomes, truncatedResultText, messageText, textOfContent
 *
 * @see docs/PLAN.md, extensions/jev-compaction.ts, src/state.ts
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type CallDecision, type Message as EngineMessage, type ToolCall } from "../../src/index.ts";

/** One branch entry selected for replacement, already reduced to what we need. */
export interface SpanEntry {
  /** Session entry id, kept for diagnostics and for mapping decisions back. */
  entryId: string;
  /** The Pi message carried by that entry. */
  message: AgentMessage;
}

/**
 * A Pi message together with the engine's view of it. `engine` is index-aligned
 * with the `messages` array of a {@link Span}, so the engine's `callIndex` /
 * `resultIndex` can be translated straight back to `messages[i]`.
 */
export interface MappedMessage {
  entryId: string;
  /** The original Pi message. Never mutated by this module. */
  message: AgentMessage;
  engine: EngineMessage;
  /** Characters this message contributes, using the engine's accounting. */
  chars: number;
}

export interface Span {
  messages: MappedMessage[];
  /** Engine messages, index-aligned with `messages`. */
  engine: EngineMessage[];
  /** Total characters of `messages`, using the engine's accounting (no thinking). */
  chars: number;
  /**
   * Total characters of the original Pi messages: text, thinking, tool inputs,
   * tool outputs and image markers. This is what Pi would otherwise have to fit
   * into the context window, so it is the honest "before" side of the reduction.
   */
  rawChars: number;
}

/** What to do with one tool call, derived from Jev's two probabilities. */
export interface CallOutcome {
  /** The call (and therefore its result) disappears from the history. */
  dropCall: boolean;
  /** The call stays, but its result is truncated to a bounded head plus a note. */
  dropResult: boolean;
}

export interface RenderOptions {
  /** Characters of a dropped tool result kept before the note. */
  headChars: number;
  /** How to treat assistant thinking blocks: `abridge` (default), `drop`, `keep`. */
  thinking?: "abridge" | "drop" | "keep";
  /** Characters of thinking kept when abridging. Default 600. */
  thinkingHeadChars?: number;
  /** First line of the replacement: what happened, in one readable sentence. */
  header?: string;
  /** Cumulative file lists, appended as Pi's own summary format does. */
  fileOps?: { readFiles: readonly string[]; modifiedFiles: readonly string[] };
}

const DEFAULT_THINKING_HEAD_CHARS = 600;

/** Same format as Pi's `serializeConversation()`, which the model already knows. */
const SEPARATOR = "\n\n";

function isTextBlock(block: unknown): block is TextContent {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

function isImageBlock(block: unknown): block is ImageContent {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image"
  );
}

function isThinkingBlock(block: unknown): block is ThinkingContent {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "thinking" &&
    typeof (block as { thinking?: unknown }).thinking === "string"
  );
}

function isToolCallBlock(block: unknown): block is PiToolCall {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "toolCall" &&
    typeof (block as { id?: unknown }).id === "string"
  );
}

/** Text of a content array; images and unknown blocks become short markers. */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) parts.push(block.text);
    else if (isImageBlock(block)) parts.push(`[image ${String(block.mimeType ?? "unknown")}]`);
    else if (isThinkingBlock(block)) continue;
    else if (typeof block === "object" && block !== null) {
      const type = (block as { type?: unknown }).type;
      if (typeof type === "string" && type !== "toolCall") parts.push(`[${type}]`);
    }
  }
  return parts.join("\n");
}

/**
 * Text a Pi message contributes to the transcript, whatever its kind. Handles the
 * message types Pi adds on top of the LLM ones so a future Pi release degrades to
 * "include the text we can see" instead of "silently lose the message".
 */
export function messageText(message: AgentMessage): string {
  const role = (message as { role?: unknown }).role;
  if (role === "user" || role === "assistant" || role === "toolResult") {
    return textOfContent((message as { content?: unknown }).content);
  }
  if (role === "bashExecution") {
    const bash = message as unknown as { command?: unknown; output?: unknown };
    const command = typeof bash.command === "string" ? bash.command : "";
    const output = typeof bash.output === "string" ? bash.output : "";
    return [`! ${command}`, output].filter((part) => part.length > 0).join("\n");
  }
  const summary = (message as { summary?: unknown }).summary;
  if (typeof summary === "string") return summary;
  return textOfContent((message as { content?: unknown }).content);
}

/** `bashExecution` messages with the `!!` prefix are excluded from LLM context. */
export function isExcludedFromContext(message: AgentMessage): boolean {
  const role = (message as { role?: unknown }).role;
  if (role !== "bashExecution") return false;
  return (message as { excludeFromContext?: unknown }).excludeFromContext === true;
}

/** Human-readable name of a Pi message kind, used in the rendered transcript. */
function label(message: AgentMessage): string {
  const role = (message as { role?: unknown }).role;
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "toolResult") return "Tool result";
  if (role === "bashExecution") return "User bash";
  if (role === "custom") return String((message as { customType?: unknown }).customType ?? "Custom");
  if (role === "branchSummary") return "Branch summary";
  if (role === "compactionSummary") return "Earlier summary";
  return typeof role === "string" ? role : "Message";
}

/**
 * Engine view of one Pi message. `assistant` keeps text and tool calls but never
 * thinking; `toolResult` becomes a user-role message carrying a `toolResults`
 * entry, which is how the Claude Code original represented the same data.
 */
export function mapPiMessageToEngine(message: AgentMessage): EngineMessage {
  const role = (message as { role?: unknown }).role;
  if (role === "assistant") {
    const assistant = message as AssistantMessage;
    const content = Array.isArray(assistant.content) ? assistant.content : [];
    return {
      role: "assistant",
      text: content.filter(isTextBlock).map((block) => block.text).join("\n"),
      toolUses: content.filter(isToolCallBlock).map((block) => ({
        tool_use_id: block.id,
        tool: block.name,
        input: (block.arguments ?? {}) as Record<string, unknown>,
      })),
    };
  }
  if (role === "toolResult") {
    const result = message as ToolResultMessage;
    const text = textOfContent(result.content);
    return {
      role: "user",
      text: "",
      toolUses: [],
      toolResults: [
        {
          tool_use_id: result.toolCallId,
          text,
          isError: result.isError === true,
        },
      ],
    };
  }
  const text = messageText(message);
  return {
    role: role === "assistant" ? "assistant" : "user",
    text: role === "toolResult" ? "" : text,
    toolUses: [],
  };
}

/**
 * Builds the engine's view of a span of session entries. Entries are kept 1:1 so
 * the engine's message indices stay usable; entries that cannot contribute anything
 * map to an empty message rather than being dropped, because pinning depends on the
 * position of a message relative to the end of the span.
 */
export function buildSpan(entries: readonly SpanEntry[]): Span {
  const messages: MappedMessage[] = [];
  let chars = 0;
  let rawChars = 0;
  for (const entry of entries) {
    const engine = mapPiMessageToEngine(entry.message);
    const charCount = messageCharsOf(engine);
    chars += charCount;
    rawChars += piMessageChars(entry.message);
    messages.push({ entryId: entry.entryId, message: entry.message, engine, chars: charCount });
  }
  return { messages, engine: messages.map((mapped) => mapped.engine), chars, rawChars };
}

/**
 * Characters a Pi message really occupies in the context: everything Pi would send,
 * including thinking blocks and image payload markers. Used for the reduction ratio, so
 * the number we report matches what the user sees in the context gauge.
 */
export function piMessageChars(message: AgentMessage): number {
  const role = (message as { role?: unknown }).role;
  if (role === "assistant") {
    const content = (message as AssistantMessage).content;
    if (!Array.isArray(content)) return 0;
    let total = 0;
    for (const block of content) {
      if (isTextBlock(block)) total += block.text.length;
      else if (isThinkingBlock(block)) total += block.thinking.length;
      else if (isImageBlock(block)) total += 20;
      else if (isToolCallBlock(block)) {
        try {
          total += JSON.stringify(block.arguments ?? {}).length;
        } catch {
          total += 20;
        }
      }
    }
    return total;
  }
  return messageText(message).length;
}

/** Characters of an engine message: text, tool inputs and tool results. */
function messageCharsOf(message: EngineMessage): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

/**
 * Turns the engine's per-call decisions into a lookup the renderer can use.
 *
 * Calls that are not candidates (pinned by the first/recent rules, or with no
 * result in the span) have no decision and are therefore kept: absence of a
 * decision must never mean "delete".
 */
export function collectOutcomes(
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  forcedDropCallIds: Iterable<string> = [],
): Map<string, CallOutcome> {
  const byEngineId = new Map(calls.map((call) => [call.id, call.tool_use_id]));
  const forced = new Set(forcedDropCallIds);
  const outcomes = new Map<string, CallOutcome>();
  for (const id of forced) outcomes.set(id, { dropCall: true, dropResult: true });
  for (const decision of decisions) {
    const toolUseId = byEngineId.get(decision.id);
    if (!toolUseId || forced.has(toolUseId)) continue;
    outcomes.set(toolUseId, {
      dropCall: decision.action === "drop_call",
      dropResult: decision.action === "drop_call" || decision.action === "drop_result",
    });
  }
  return outcomes;
}

/**
 * Head of a tool result plus a one-line note. Short results are returned untouched,
 * matching the engine's behaviour for kept-but-truncated results.
 */
export function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  const dropped = text.length - headChars;
  return `${head}[pi-jev-compaction truncated ${dropped} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`;
}

function abridgeThinking(text: string, headChars: number): string {
  if (text.length <= headChars + 40) return text;
  const omitted = text.length - headChars;
  return `${text.slice(0, headChars)}\n[… ${omitted} chars of thinking omitted …]`;
}

function toolCallLine(block: PiToolCall): string {
  const args = (block.arguments ?? {}) as Record<string, unknown>;
  let rendered: string;
  try {
    rendered = Object.entries(args)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
  } catch {
    rendered = "[unserializable arguments]";
  }
  return `${block.name}(${rendered})`;
}

/** Renders one assistant message, honouring the per-call outcomes. */
function renderAssistant(
  message: AssistantMessage,
  outcomes: ReadonlyMap<string, CallOutcome>,
  options: Required<Pick<RenderOptions, "headChars" | "thinking" | "thinkingHeadChars">>,
): string {
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: string[] = [];
  const text = content.filter(isTextBlock).map((block) => block.text).join("\n");
  const callBlocks = content.filter(isToolCallBlock);
  const keptCalls = callBlocks
    .filter((block) => outcomes.get(block.id)?.dropCall !== true)
    .map(toolCallLine);

  // A message whose whole substance was calls that are now gone is removed as a whole:
  // the thinking explained those calls and nothing else survives to refer to it.
  if (callBlocks.length > 0 && keptCalls.length === 0 && text.length === 0) return "";

  const thinkingParts = content.filter(isThinkingBlock).map((block) => block.thinking);
  for (const thinking of thinkingParts) {
    if (options.thinking === "drop") continue;
    const rendered =
      options.thinking === "abridge" ? abridgeThinking(thinking, options.thinkingHeadChars) : thinking;
    if (rendered.length > 0) parts.push(`[Assistant thinking]: ${rendered}`);
  }
  if (options.thinking === "drop" && thinkingParts.some((value) => value.length > 0)) {
    parts.push("[Assistant thinking omitted by pi-jev-compaction]");
  }

  if (text.length > 0) parts.push(`[Assistant]: ${text}`);
  if (keptCalls.length > 0) parts.push(`[Assistant tool calls]: ${keptCalls.join("; ")}`);

  return parts.join(SEPARATOR);
}

/** Renders one tool result message, truncating results Jev let go. */
function renderToolResult(
  message: ToolResultMessage,
  outcomes: ReadonlyMap<string, CallOutcome>,
  options: Required<Pick<RenderOptions, "headChars">>,
): string {
  const outcome = outcomes.get(message.toolCallId);
  if (outcome?.dropCall === true) return "";
  const text = textOfContent(message.content);
  const body = outcome?.dropResult === true ? truncatedResultText(text, message.isError === true, options.headChars) : text;
  const status = message.isError === true ? "error" : "ok";
  const tool = message.toolName.length > 0 ? ` ${message.toolName}` : "";
  if (body.length === 0) return "";
  return `[Tool result${tool} (${status})]: ${body}`;
}

/** Renders anything that is not an assistant message or a tool result. */
function renderPlain(message: AgentMessage): string {
  const text = messageText(message);
  if (text.length === 0) return "";
  return `[${label(message)}]: ${text}`;
}

/**
 * Writes the surviving history as text: the replacement for everything Pi would
 * have summarized. A message that loses its entire content (every call dropped,
 * no text, no thinking) disappears; everything else is kept in order and verbatim,
 * except dropped tool results, which keep a bounded head plus a note.
 */
export function renderSpan(
  span: Span,
  outcomes: ReadonlyMap<string, CallOutcome>,
  options: RenderOptions,
): string {
  const resolved: Required<Pick<RenderOptions, "headChars" | "thinking" | "thinkingHeadChars">> = {
    headChars: options.headChars,
    thinking: options.thinking ?? "abridge",
    thinkingHeadChars: options.thinkingHeadChars ?? DEFAULT_THINKING_HEAD_CHARS,
  };
  const parts: string[] = [];
  for (const mapped of span.messages) {
    const message = mapped.message;
    const role = (message as { role?: unknown }).role;
    const rendered =
      role === "assistant"
        ? renderAssistant(message as AssistantMessage, outcomes, resolved)
        : role === "toolResult"
          ? renderToolResult(message as ToolResultMessage, outcomes, resolved)
          : renderPlain(message);
    if (rendered.length > 0) parts.push(rendered);
  }
  const body = parts.join(SEPARATOR);
  const sections = [options.header ?? "", body, formatFileOps(options.fileOps)].filter(
    (section) => section.length > 0,
  );
  return sections.join(SEPARATOR);
}

/** Pi's own summary format for cumulative file tracking. */
function formatFileOps(
  fileOps: RenderOptions["fileOps"],
): string {
  if (!fileOps) return "";
  const sections: string[] = [];
  if (fileOps.readFiles.length > 0) {
    sections.push(`<read-files>\n${fileOps.readFiles.join("\n")}\n</read-files>`);
  }
  if (fileOps.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${fileOps.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  return sections.join("\n\n");
}
