#!/usr/bin/env node
/**
 * @file last-compaction.mjs
 * @description Shows what the last compaction did, for one project directory.
 *
 * WHY: the compaction result is persisted in the session file (`details.jev`), which is the
 * only place the per-call decisions and probabilities survive. Reading it by hand means
 * finding the session JSONL, decoding the directory name and picking the right line, so
 * this prints the interesting part directly.
 *
 * Usage:
 *   node scripts/last-compaction.mjs [cwd] [--summary]
 *
 *   cwd        project directory to inspect, default is the current directory
 *   --summary  also print the replacement text Pi stored (the verbatim history)
 *
 * @see docs/TESTING.md, extensions/jev-compaction.ts
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const showSummary = args.includes("--summary");
const requested = resolve(args.find((arg) => !arg.startsWith("--")) ?? process.cwd());
// Pi stores sessions under the canonical path, and on macOS /tmp is a symlink to
// /private/tmp, so the raw argument would look up the wrong directory.
const cwd = existsSync(requested) ? realpathSync(requested) : requested;

/** Pi encodes the session directory as `--<cwd with / and : replaced>--`. */
function sessionDir(agentDir, directory) {
  const encoded = directory.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
  return join(agentDir, "sessions", `--${encoded}--`);
}

const agentDir = process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const dir = sessionDir(agentDir, cwd);

if (!existsSync(dir)) {
  console.error(`No sessions yet for ${cwd} (looked in ${dir}).`);
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => join(dir, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

if (files.length === 0) {
  console.error(`No sessions yet for ${cwd}.`);
  process.exit(1);
}

let found = 0;
for (const file of files) {
  const entries = readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const compactions = entries.filter((entry) => entry.type === "compaction");
  if (compactions.length === 0) continue;

  console.log(`session: ${file.split("/").pop()}`);
  console.log(`compactions: ${compactions.length}`);
  compactions.forEach((entry, index) => {
    const jev = entry.details?.jev;
    console.log(`\n[${index + 1}/${compactions.length}] ${entry.timestamp}`);
    console.log(`  from:          ${entry.fromHook ? "pi-jev-compaction" : "pi built-in summary"}`);
    console.log(`  tokens before: ${entry.tokensBefore}`);
    console.log(`  kept entries:  from ${entry.firstKeptEntryId}`);
    if (!jev) {
      console.log(`  details:       ${JSON.stringify(entry.details ?? {})}`);
      console.log(`  summary size:  ${entry.summary?.length ?? 0} chars`);
      return;
    }
    console.log(
      `  tool calls:    ${jev.calls} total, ${jev.callsDropped} dropped, ${jev.resultsDropped} truncated, ${jev.pinned} pinned, ${jev.kept} kept`,
    );
    console.log(
      `  size:          ${jev.charsBefore} -> ${jev.charsAfter} chars (${(jev.reduction * 100).toFixed(1)}% smaller)`,
    );
    console.log(
      `  jev:           state ~${jev.stateTokens} tokens (${jev.stateStage}), ${jev.requests} request(s), ${jev.ms}ms, usage ${JSON.stringify(jev.usage)}`,
    );
    if (jev.decisions) console.log(`  decisions:     ${jev.decisions}`);
    if (showSummary) {
      console.log(`  --- replacement text (${entry.summary?.length ?? 0} chars) ---`);
      console.log(entry.summary);
    }
  });
  found += 1;
  // Only the newest session: the point of the script is "the last compaction".
  break;
}

if (found === 0) {
  console.error(`No compaction in any session of ${cwd}. Run /compact first.`);
  process.exit(1);
}
