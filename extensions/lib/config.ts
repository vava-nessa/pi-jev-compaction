/**
 * @file config.ts
 * @description Configuration for the Pi Jev compaction extension.
 *
 * WHY a config file and not extension flags: flags are visible in `ps` output, so an
 * API key passed as `--jev-api-key` would leak to every process listing on the machine.
 * The key is therefore read from the environment (`TYPESAFE_API_KEY`) or from this file,
 * which is documented as needing `chmod 600`.
 *
 * Resolution order, first hit wins for each individual field:
 *   1. `~/.pi/agent/jev-compaction.json` (or `$PI_AGENT_DIR/jev-compaction.json`)
 *   2. built-in defaults
 * The API key additionally falls back to `TYPESAFE_API_KEY`.
 *
 * Every field is validated. A malformed value is ignored and reported as a warning
 * (surfaced by `/jev status`) instead of throwing, because a config typo must never
 * be able to break compaction: the worst case has to be "Pi uses its built-in summary".
 *
 * @functions
 * - defaultConfig → the defaults, in one place
 * - getConfigPath → where the config file lives
 * - getAgentDir → the Pi agent directory that holds it
 * - getLogPath → where the debug log is appended
 * - loadConfig → read + validate + merge, with warnings
 * - resolveApiKey → config value, then `TYPESAFE_API_KEY`
 * - describeConfig → one-line summary for `/jev status` (never prints the key)
 *
 * @exports JevConfig, ConfigLoadResult, defaultConfig, getAgentDir, getConfigPath,
 * getLogPath, loadConfig, resolveApiKey, describeConfig
 *
 * @see extensions/jev-compaction.ts, README.md (Configuration)
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL, SYSTEM_ONE_URL } from "../../src/index.ts";

export interface JevConfig {
  /** Master switch. When false the extension never touches compaction. */
  enabled: boolean;
  /** TypeSafe key. Empty string means "use the environment". */
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Minimum Jev probability for a call or result to stay. */
  keepThreshold: number;
  /**
   * Newest messages of the replaced span that are never candidates.
   *
   * Default 1, NOT the upstream default of 6. Claude Code's plugin replaces the entire
   * transcript, so it has to protect the newest messages itself. In Pi, the kept window
   * (`compaction.keepRecentTokens`, 20k tokens by default) already does exactly that:
   * everything after `firstKeptEntryId` is kept verbatim by Pi. Pinning six extra messages
   * inside the span on top of that makes the extension do nothing on short sessions, so 1
   * only pins the span's first and last message.
   */
  preserveRecentMessages: number;
  /** Estimated token ceiling for the state sent with every request. */
  maxStateTokens: number;
  /** Estimated ceiling for state plus one batch of questions. */
  maxRequestTokens: number;
  /** Characters of a dropped tool result kept before the note. */
  truncateHeadChars: number;
  /** Below this reduction the extension defers to Pi's built-in summary. */
  minReductionRatio: number;
  /** Assistant thinking: `abridge` (default), `drop`, or `keep` verbatim. */
  thinking: "abridge" | "drop" | "keep";
  /** Characters of thinking kept when `thinking` is `abridge`. */
  thinkingHeadChars: number;
  /** Requests in flight at once when the questions need several batches. */
  maxConcurrentRequests: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /**
   * Append a line per compaction step to `jev-compaction.log` next to this config file.
   * Off by default; turn it on when a compaction keeps falling back and the reason is unclear.
   */
  debug: boolean;
  /**
   * Optional early trigger: call `ctx.compact()` when the context reaches this
   * percentage. 0 disables it (default), because Pi's own threshold already triggers
   * compaction and calling `ctx.compact()` mid-run aborts the current operation.
   */
  compactAtPercent: number;
}

export interface ConfigLoadResult {
  config: JevConfig;
  /** Human-readable problems found while reading the file; empty when all good. */
  warnings: string[];
  /** Path that was read, when it exists. */
  path?: string;
}

export function defaultConfig(): JevConfig {
  return {
    enabled: true,
    apiKey: "",
    model: DEFAULT_MODEL,
    baseUrl: SYSTEM_ONE_URL,
    keepThreshold: 0.5,
    preserveRecentMessages: 1,
    maxStateTokens: 25_000,
    maxRequestTokens: 30_000,
    truncateHeadChars: 300,
    minReductionRatio: 0.25,
    thinking: "abridge",
    thinkingHeadChars: 600,
    maxConcurrentRequests: 4,
    timeoutMs: 60_000,
    debug: false,
    compactAtPercent: 0,
  };
}

/** `$PI_AGENT_DIR` when set, otherwise `~/.pi/agent`. */
export function getConfigPath(): string {
  return join(getAgentDir(), "jev-compaction.json");
}

/** Directory the config and the debug log live in. */
export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/** File the debug log is appended to. */
export function getLogPath(): string {
  return join(getAgentDir(), "jev-compaction.log");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(
  raw: Record<string, unknown>,
  key: keyof JevConfig,
  warnings: string[],
  bounds?: { min?: number; max?: number },
): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(`${key}: expected a number, got ${JSON.stringify(value)} (ignored)`);
    return undefined;
  }
  if (bounds?.min !== undefined && value < bounds.min) {
    warnings.push(`${key}: ${value} is below the minimum ${bounds.min} (ignored)`);
    return undefined;
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    warnings.push(`${key}: ${value} is above the maximum ${bounds.max} (ignored)`);
    return undefined;
  }
  return value;
}

function readBoolean(
  raw: Record<string, unknown>,
  key: keyof JevConfig,
  warnings: string[],
): boolean | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    warnings.push(`${key}: expected a boolean, got ${JSON.stringify(value)} (ignored)`);
    return undefined;
  }
  return value;
}

function readString(
  raw: Record<string, unknown>,
  key: keyof JevConfig,
  warnings: string[],
  allowed?: readonly string[],
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    warnings.push(`${key}: expected a string, got ${JSON.stringify(value)} (ignored)`);
    return undefined;
  }
  if (allowed && !allowed.includes(value)) {
    warnings.push(`${key}: expected one of ${allowed.join(", ")} (ignored)`);
    return undefined;
  }
  return value;
}

/**
 * Reads and validates the config file. Never throws: an unreadable or malformed file
 * produces warnings and the defaults, so compaction always has a working configuration.
 */
export function loadConfig(path: string = getConfigPath()): ConfigLoadResult {
  const config = defaultConfig();
  const warnings: string[] = [];
  if (!existsSync(path)) return { config, warnings };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    warnings.push(
      `could not read ${path} (${error instanceof Error ? error.message : String(error)}); using defaults`,
    );
    return { config, warnings, path };
  }
  if (!isRecord(raw)) {
    warnings.push(`${path} must contain a JSON object; using defaults`);
    return { config, warnings, path };
  }

  const known = new Set<string>(Object.keys(defaultConfig()));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) warnings.push(`${key}: unknown option (ignored)`);
  }

  const enabled = readBoolean(raw, "enabled", warnings);
  if (enabled !== undefined) config.enabled = enabled;
  const apiKey = readString(raw, "apiKey", warnings);
  if (apiKey !== undefined) config.apiKey = apiKey.trim();
  const model = readString(raw, "model", warnings);
  if (model !== undefined && model.trim().length > 0) config.model = model.trim();
  const baseUrl = readString(raw, "baseUrl", warnings);
  if (baseUrl !== undefined && baseUrl.trim().length > 0) config.baseUrl = baseUrl.trim();

  const keepThreshold = readNumber(raw, "keepThreshold", warnings, { min: 0, max: 1 });
  if (keepThreshold !== undefined) config.keepThreshold = keepThreshold;
  const preserveRecentMessages = readNumber(raw, "preserveRecentMessages", warnings, { min: 0 });
  if (preserveRecentMessages !== undefined) {
    config.preserveRecentMessages = Math.floor(preserveRecentMessages);
  }
  const maxStateTokens = readNumber(raw, "maxStateTokens", warnings, { min: 1 });
  if (maxStateTokens !== undefined) config.maxStateTokens = Math.floor(maxStateTokens);
  const maxRequestTokens = readNumber(raw, "maxRequestTokens", warnings, { min: 1 });
  if (maxRequestTokens !== undefined) config.maxRequestTokens = Math.floor(maxRequestTokens);
  const truncateHeadChars = readNumber(raw, "truncateHeadChars", warnings, { min: 0 });
  if (truncateHeadChars !== undefined) config.truncateHeadChars = Math.floor(truncateHeadChars);
  const minReductionRatio = readNumber(raw, "minReductionRatio", warnings, { min: 0, max: 1 });
  if (minReductionRatio !== undefined) config.minReductionRatio = minReductionRatio;
  const thinking = readString(raw, "thinking", warnings, ["abridge", "drop", "keep"]);
  if (thinking !== undefined) config.thinking = thinking as JevConfig["thinking"];
  const thinkingHeadChars = readNumber(raw, "thinkingHeadChars", warnings, { min: 0 });
  if (thinkingHeadChars !== undefined) config.thinkingHeadChars = Math.floor(thinkingHeadChars);
  const maxConcurrentRequests = readNumber(raw, "maxConcurrentRequests", warnings, { min: 1 });
  if (maxConcurrentRequests !== undefined) {
    config.maxConcurrentRequests = Math.floor(maxConcurrentRequests);
  }
  const timeoutMs = readNumber(raw, "timeoutMs", warnings, { min: 1 });
  if (timeoutMs !== undefined) config.timeoutMs = Math.floor(timeoutMs);
  const compactAtPercent = readNumber(raw, "compactAtPercent", warnings, { min: 0, max: 100 });
  if (compactAtPercent !== undefined) config.compactAtPercent = compactAtPercent;
  const debug = readBoolean(raw, "debug", warnings);
  if (debug !== undefined) config.debug = debug;

  if (config.maxRequestTokens <= config.maxStateTokens) {
    warnings.push(
      "maxRequestTokens must stay above maxStateTokens, otherwise no question ever fits (defaults kept)",
    );
    const defaults = defaultConfig();
    config.maxStateTokens = defaults.maxStateTokens;
    config.maxRequestTokens = defaults.maxRequestTokens;
  }
  return { config, warnings, path };
}

/** Config value first, environment second. Empty string means "not configured". */
export function resolveApiKey(config: JevConfig, env: NodeJS.ProcessEnv = process.env): string {
  const fromConfig = config.apiKey.trim();
  if (fromConfig.length > 0) return fromConfig;
  return (env["TYPESAFE_API_KEY"] ?? "").trim();
}

/** One-line summary for `/jev status`. The key is reduced to a boolean. */
export function describeConfig(config: JevConfig, apiKey: string): string {
  return [
    `enabled=${config.enabled}`,
    `key=${apiKey.length > 0 ? "set" : "MISSING"}`,
    `model=${config.model}`,
    `threshold=${config.keepThreshold}`,
    `keepRecent=${config.preserveRecentMessages}`,
    `state=${config.maxStateTokens}`,
    `request=${config.maxRequestTokens}`,
    `head=${config.truncateHeadChars}`,
    `minReduction=${config.minReductionRatio}`,
    `thinking=${config.thinking}`,
    `compactAt=${config.compactAtPercent === 0 ? "off" : `${config.compactAtPercent}%`}`,
    `debug=${config.debug}`,
  ].join(" ");
}
