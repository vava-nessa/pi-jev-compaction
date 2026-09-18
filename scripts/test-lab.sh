#!/usr/bin/env bash
#
# Creates a self-contained Pi playground for trying pi-jev-compaction by hand.
#
# WHAT IT BUILDS
#   $TARGET/                      (default ~/jev-test)
#     .pi/settings.json           small reserved window, so /compact has something to do
#     legacy/parser.mjs           a big, noisy file the task says never to edit
#     src/parser.mjs              a parser with a real bug
#     test.mjs                    a test that fails until the bug is fixed
#     RESET.sh                    puts the buggy parser back and starts a fresh session
#
# WHY a small keepRecentTokens: Pi refuses to compact when the kept-recent window already
# covers the whole session ("Nothing to compact (session too small)"). The default is 20k
# tokens, which a hand-made test session never reaches in a few minutes.
#
# Usage: scripts/test-lab.sh [target-dir]

set -euo pipefail

TARGET="${1:-$HOME/jev-test}"

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "Refusing to overwrite non-empty $TARGET. Move it away first, or pass another path." >&2
  exit 1
fi

mkdir -p "$TARGET/.pi" "$TARGET/legacy" "$TARGET/src"

cat > "$TARGET/.pi/settings.json" <<'JSON'
{
  "compaction": {
    "keepRecentTokens": 1500
  }
}
JSON

# A large, irrelevant file. The task explicitly says not to touch it, so a good compaction
# proves it kept the instruction while dropping the 50 KB of legacy noise it caused.
{
  echo "// legacy parser - DO NOT EDIT, kept only for the migration history"
  echo "export const LEGACY_VERSION = '0.4.2';"
  echo "// TODO(2007): remove after the v0.5 migration, see ticket LP-4821"
  echo ""
  for i in $(seq 1 220); do
    echo "export function legacyHelper$i(value) {"
    echo "  // ########## section $i of the legacy tokenizer, retained for reference ############"
    echo "  const intermediate$i = String(value ?? '').split(',').map((part) => part.trim());"
    echo "  return intermediate$i.filter((part) => part.length > 0).join(' | ');"
    echo "}"
    echo ""
  done
} > "$TARGET/legacy/parser.mjs"

cat > "$TARGET/src/parser.mjs" <<'JAVASCRIPT'
/**
 * Parse a comma separated list into tokens.
 * A trailing comma must be ignored, like every other parser does.
 */
export function parse(input) {
  const tokens = [];
  let current = "";
  for (const char of input) {
    if (char === ",") {
      tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  return tokens;
}
JAVASCRIPT

cat > "$TARGET/test.mjs" <<'JAVASCRIPT'
import { parse } from "./src/parser.mjs";

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  received: ${JSON.stringify(actual)}`);
  }
  return ok;
}

const results = [
  check("accepts a trailing comma", parse("a,b,"), ["a", "b"]),
  check("keeps empty middle tokens", parse("a,,b"), ["a", "", "b"]),
];

if (!results.every(Boolean)) {
  console.log("TESTS FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED");
JAVASCRIPT

cat > "$TARGET/RESET.sh" <<'SHELL'
#!/usr/bin/env bash
# Puts the buggy parser back so the test scenario can be replayed from scratch.
set -euo pipefail
cd "$(dirname "$0")"
cat > src/parser.mjs <<'JAVASCRIPT'
/**
 * Parse a comma separated list into tokens.
 * A trailing comma must be ignored, like every other parser does.
 */
export function parse(input) {
  const tokens = [];
  let current = "";
  for (const char of input) {
    if (char === ",") {
      tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  return tokens;
}
JAVASCRIPT
echo "parser reset. Start a fresh Pi session with: cd $(pwd) && pi"
SHELL
chmod +x "$TARGET/RESET.sh"

echo "Test lab ready in $TARGET"
echo
echo "Next:"
echo "  cd $TARGET && pi"
echo "  then type: /jev        (status: key, config, counters)"
echo "  then follow docs/TESTING.md in the pi-jev-compaction repository"
