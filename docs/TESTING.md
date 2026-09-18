# Testing pi-jev-compaction by hand

Three levels, from ten seconds to five minutes. No Jev mocking anywhere: if you follow
level 1 or 2 you are watching real decisions on a real session.

The extension is installed globally, so every command below works in any directory. Nothing
has to be enabled first: it hooks `session_before_compact`, which means **`/compact` is the
test**.

---

## Level 0 - is it alive? (10 seconds)

In any Pi session:

```
/jev
```

You should see a block like this. The three things that matter are `on`, `key=set` and the
config line:

```
pi-jev-compaction v1 - on
config: enabled=true key=set model=jev-latest threshold=0.5 keepRecent=1 state=25000 ...
config file: /Users/you/.pi/agent/jev-compaction.json (absent, defaults in use)
last: no compaction yet
totals: 0 Jev compaction(s), 0 fallback(s), 0 failed, 0 calls + 0 results dropped, 0 chars saved
```

If it says `key=MISSING`, the extension is inert and Pi will keep using its own summary:
export `TYPESAFE_API_KEY` in the shell that starts Pi, or put the key in
`~/.pi/agent/jev-compaction.json` as `"apiKey": "..."` (then `chmod 600` that file).

## Level 1 - the real thing (3 minutes)

This builds a small project with one big irrelevant file, one real bug and one failing test:
the shape of a normal coding session, where a lot of context deserves to disappear once the
work is done.

```sh
~/Documents/GitHub/pi-jev-compaction/scripts/test-lab.sh ~/jev-test
cd ~/jev-test && pi -a
```

`-a` trusts the project-local settings in `~/jev-test/.pi/settings.json`, which set
`keepRecentTokens` to 1500. **Why that matters:** Pi refuses to compact when the kept-recent
window already covers the whole session, and reports `Nothing to compact (session too small)`.
The default window is 20k tokens, which a hand-made session never reaches in a few minutes,
so the lab lowers it. This is a property of Pi, not of the extension.

Then paste this prompt:

```
The test in test.mjs fails. Work in this order:
1) read legacy/parser.mjs to check whether the legacy parser is involved (never edit it),
2) read src/parser.mjs,
3) fix the bug so both tests pass without changing test.mjs,
4) run 'node test.mjs' until it prints ALL TESTS PASSED,
5) reply DONE.
```

Wait for `DONE`, then compact:

```
/compact
```

**What you should see**

| Where | What |
| --- | --- |
| The toast under the compaction row | `pi-jev-compaction: 97% smaller; 3 calls dropped, ... state ~700 tokens (full) in 1 request(s), 625ms` |
| The footer | `jev 97% smaller` |
| The compaction row | `Compacted from 19,xxx tokens` |

**The part that proves it works.** After the compaction, ask:

```
Quote, word for word, the first instruction I gave you. Then say which file you were told never to edit.
```

The model answers with your full original instruction and `legacy/parser.mjs`, even though
the 50 KB read of that file is gone from the context. That is the whole point: the
instruction survived verbatim, the noise did not. Then:

```
/jev
```

`last:` now shows the reduction and per-reason counts, and `totals:` accumulates across the
session. To read the decisions outside the TUI, including Jev's two probabilities per call:

```sh
node ~/Documents/GitHub/pi-jev-compaction/scripts/last-compaction.mjs ~/jev-test
```

Add `--summary` to also print the exact text Pi stored (that is the verbatim history the
model sees).

## Level 2 - watch it refuse (2 minutes)

The extension is designed to give up rather than to guess, and the interesting half of its
behaviour is the refusals. Replay the lab and compact at the wrong moment:

```sh
cd ~/jev-test && ./RESET.sh && pi -a
```

- **Compact right after the first tool batch** (before the work is done, while the reads are
  still the working set): `/compact` gives
  `built-in summary used (only 6% smaller, under the 25% minimum)`. Jev is right, the
  outputs are still needed, and the extension declines to pay a verbatim cost for nothing.
  This is also what Pi's own threshold trigger does when it fires mid-turn.
- **Compact a tiny session** (start Pi, ask one question, then `/compact`): Pi refuses before
  the extension is even called, and the extension explains it:
  `nothing to compact yet - the session is smaller than the kept-recent window`. Lower
  `keepRecentTokens` to test compaction on small sessions.
- **Break the key** (`TYPESAFE_API_KEY=wrong pi -a`) and compact: the request fails, the
  toast says `built-in summary used (Jev failed (...)`), the footer keeps
  `jev fallback (...)`, and your session still compacts normally. Compaction never depends
  on Jev being reachable.

## Level 3 - reading the code path (for debugging)

```sh
# one line per step, including the fallback reason
echo '{"debug": true}' > ~/.pi/agent/jev-compaction.json
tail -f ~/.pi/agent/jev-compaction.log
```

Log lines look like this, and the last one is the outcome:

```
session start; enabled=true key=set model=jev-latest ... debug=true
compact requested (manual); entries=13 boundary=76ffc21b tokensBefore=19645
compacted: 4 calls, 3 dropped, 0 truncated, 97% smaller, state 678 (full) in 1 request(s), 625ms
```

Turn it back off with `rm ~/.pi/agent/jev-compaction.json` (the log is only written when
`debug` is true).

---

## Expectations to keep in mind

- **The compaction row is long.** Pi's custom compaction API takes a string, and ours is the
  verbatim surviving history rather than a summary, so the row is collapsed by default and
  its first line is the one-line report. That is the accepted cost of not summarizing.
- **A session made only of prose will not shrink.** Only tool calls and tool outputs are
  candidates; long user or assistant text stays verbatim, so such a session falls back to
  Pi's summary instead.
- **One Jev request costs ~3000 input tokens and under a second** for a typical span, and the
  whole state is resent with every batch when the questions need to be split.
- **`preserveRecentMessages` defaults to 1** here, not 6 as upstream: Pi already keeps the
  newest context through `compaction.keepRecentTokens`. Raising it makes the extension more
  conservative and can make it do nothing at all on short sessions.
