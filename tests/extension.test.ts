/**
 * @file extension.test.ts
 * @description Integration tests for the Pi adapter's decision pipeline.
 *
 * Jev is faked at the HTTP boundary (`fetch`), so these tests exercise the real request
 * building, response parsing, batching, concurrency, rendering and fallback logic without
 * touching the network or the TypeSafe API.
 */

import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  buildCompaction,
  computeFileLists,
  goalFromEntries,
  selectSpan,
  type BuildCompactionInput,
} from '../extensions/jev-compaction.ts';
import { defaultConfig, type JevConfig } from '../extensions/lib/config.ts';
import { buildSpan, type SpanEntry } from '../extensions/lib/pi-messages.ts';
import { collectToolCalls, fitState } from '../src/index.ts';

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let sequence = 0;

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as AgentMessage;
}

function assistant(blocks: unknown[]): AgentMessage {
  return {
    role: 'assistant',
    content: blocks,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: USAGE,
    stopReason: 'toolUse',
    timestamp: 1,
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, text: string, isError = false): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 1,
  } as unknown as AgentMessage;
}

function call(id: string, name: string, args: Record<string, unknown> = {}): unknown {
  return { type: 'toolCall', id, name, arguments: args };
}

function messageEntry(message: AgentMessage, id = `e${++sequence}`): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: new Date(sequence).toISOString(), message };
}

function compactionEntry(firstKeptEntryId: string, summary: string, id = `c${++sequence}`): SessionEntry {
  return {
    type: 'compaction',
    id,
    parentId: null,
    timestamp: new Date(sequence).toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore: 10_000,
  };
}

function branchSummaryEntry(summary: string, id = `b${++sequence}`): SessionEntry {
  return {
    type: 'branch_summary',
    id,
    parentId: null,
    timestamp: new Date(sequence).toISOString(),
    summary,
    fromId: 'old-leaf',
  };
}

/** A read call + its result, as Pi stores them: two separate entries. */
function readPair(index: number, body: string): SessionEntry[] {
  const id = `call-${index}`;
  return [
    messageEntry(assistant([call(id, 'read', { file_path: `src/module-${index}.ts` })])),
    messageEntry(toolResult(id, body)),
  ];
}

interface JevRequest {
  model: string;
  state: { goal?: string; history?: unknown[] };
  questions: Record<string, unknown>;
}

function bodyHandler(
  answer: (name: string, request: JevRequest) => number,
  onRequest?: (request: JevRequest) => void,
): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const request = JSON.parse(String(init?.body ?? '{}')) as JevRequest;
    onRequest?.(request);
    const answers = Object.fromEntries(
      Object.keys(request.questions).map((name) => [name, { type: 'noul', noul: answer(name, request) }]),
    );
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 120, output_tokens: 30 } }), {
      status: 200,
    });
  }) as typeof fetch;
}

/**
 * Test config. `preserveRecentMessages` is 0 here on purpose: the default of 6 pins
 * every message of the deliberately small spans these tests build, and the pinning rule
 * itself is covered by the engine suite. Long-session behaviour is verified end to end
 * against a real Pi session instead (see docs/PLAN.md phase 4).
 */
function config(overrides: Partial<JevConfig> = {}): JevConfig {
  return { ...defaultConfig(), preserveRecentMessages: 0, ...overrides };
}

function input(entries: SessionEntry[], overrides: Partial<BuildCompactionInput> = {}): BuildCompactionInput {
  return {
    branchEntries: entries,
    firstKeptEntryId: 'missing-boundary',
    tokensBefore: 10_000,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    config: config(),
    apiKey: 'test-key',
    ...overrides,
  };
}

const BIG = 'export const a = 1;\n'.repeat(200);

describe('span selection', () => {
  it('takes the raw entries before the kept boundary, skipping previous compactions', () => {
    const entries = [
      messageEntry(user('first instruction')),
      ...readPair(1, BIG),
      compactionEntry('e-kept', 'STALE SUMMARY'),
      messageEntry(user('later instruction'), 'e-kept'),
      ...readPair(2, BIG),
    ];
    const span = selectSpan(entries, 'e-kept');
    expect(span?.map((entry) => entry.entryId)).toEqual([entries[0]?.id, entries[1]?.id, entries[2]?.id]);
    // The stale summary is gone; the originals it replaced are all still there.
    const rendered = span?.map((entry) => (entry.message as { role: string }).role);
    expect(rendered).toEqual(['user', 'assistant', 'toolResult']);
  });

  it('keeps branch summaries, because their branch is not on this path', () => {
    const entries = [
      messageEntry(user('a')),
      branchSummaryEntry('we left the auth branch with a half-finished migration'),
      messageEntry(user('b'), 'e-kept'),
    ];
    const span = selectSpan(entries, 'e-kept');
    expect(span).toHaveLength(2);
    expect(goalFromEntries(span ?? [])).toContain('a');
  });

  it('skips bash executions the user marked as excluded from context', () => {
    const bash = {
      role: 'bashExecution',
      command: 'secret',
      output: 'nope',
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: 1,
    } as unknown as AgentMessage;
    const entries = [messageEntry(bash), messageEntry(user('b'), 'e-kept')];
    expect(selectSpan(entries, 'e-kept')).toEqual([]);
  });

  it('returns nothing when the boundary is missing or first', () => {
    const entries = [messageEntry(user('a')), messageEntry(user('b'))];
    expect(selectSpan(entries, 'nope')).toBeUndefined();
    expect(selectSpan(entries, entries[0]?.id ?? '')).toBeUndefined();
    expect(selectSpan([], 'x')).toBeUndefined();
  });
});

describe('file tracking and goal', () => {
  it('reproduces Pi cumulative file lists', () => {
    expect(
      computeFileLists({
        read: new Set(['b.ts', 'a.ts', 'shared.ts']),
        written: new Set(['new.ts']),
        edited: new Set(['shared.ts']),
      }),
    ).toEqual({ readFiles: ['a.ts', 'b.ts'], modifiedFiles: ['new.ts', 'shared.ts'] });
    expect(computeFileLists(undefined)).toEqual({ readFiles: [], modifiedFiles: [] });
  });

  it('uses the last user prompts as the goal and puts custom instructions first', () => {
    const entries: SpanEntry[] = [
      { entryId: '1', message: user('first prompt') },
      { entryId: '2', message: toolResult('x', 'noise') },
      { entryId: '3', message: user('second prompt') },
      { entryId: '4', message: user('   ') },
    ];
    expect(goalFromEntries(entries)).toBe('first prompt\nsecond prompt');
    expect(goalFromEntries(entries, 'focus on the parser')).toBe(
      'Focus requested by the user: focus on the parser\nfirst prompt\nsecond prompt',
    );
  });
});

describe('buildCompaction', () => {
  it('drops the calls Jev rejects, keeps the rest verbatim and reports honest numbers', async () => {
    const entries = [
      messageEntry(user('Never edit src/generated. Fix the failing test.')),
      ...readPair(1, BIG),
      ...readPair(2, BIG),
      messageEntry(user('now add a changelog entry'), 'e-kept'),
    ];
    const requests: JevRequest[] = [];
    const attempt = await buildCompaction(
      input(entries, {
        firstKeptEntryId: 'e-kept',
        fileOps: { read: new Set(['src/module-1.ts', 'src/module-2.ts']), written: new Set(), edited: new Set(['src/x.ts']) },
        fetchImpl: bodyHandler(
          (name) => (name.includes('_t1') ? 0.1 : 0.9),
          (request) => requests.push(request),
        ),
      }),
    );

    expect(attempt.status).toBe('compacted');
    if (attempt.status !== 'compacted') return;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe('jev-latest');
    expect(requests[0]?.state.goal).toContain('Fix the failing test');
    // Both calls plus their results are visible in the state, results replaced by a note.
    expect(JSON.stringify(requests[0]?.state)).toContain('chars (omitted)');
    expect(Object.keys(requests[0]?.questions ?? {}).sort()).toEqual([
      'call_t1',
      'call_t2',
      'result_t1',
      'result_t2',
    ]);

    expect(attempt.firstKeptEntryId).toBe('e-kept');
    expect(attempt.tokensBefore).toBe(10_000);
    expect(attempt.summary).toContain('Never edit src/generated');
    expect(attempt.summary).not.toContain('read(file_path="src/module-1.ts")');
    expect(attempt.summary).toContain('src/module-2.ts');
    // The kept boundary entry itself is not part of the replacement: Pi keeps it verbatim.
    expect(attempt.summary).not.toContain('now add a changelog entry');
    // The file lists stay cumulative on purpose: they are Pi's navigation aid, and a
    // dropped read does not make the file irrelevant. Safety-critical modified files are
    // never removed.
    expect(attempt.details.readFiles).toEqual(['src/module-1.ts', 'src/module-2.ts']);
    expect(attempt.details.modifiedFiles).toEqual(['src/x.ts']);
    expect(attempt.details.jev).toMatchObject({
      model: 'jev-latest',
      calls: 2,
      callsDropped: 1,
      kept: 1,
      requests: 1,
      usage: { input: 120, output: 30 },
    });
    expect(attempt.details.jev.decisions).toContain('t1:read:drop_call');
    expect(attempt.stats.charsAfter).toBe(attempt.summary.length);
    expect(attempt.stats.reduction).toBeGreaterThan(0.25);
  });

  it('re-prunes the original history on a second compaction instead of keeping the old blob', async () => {
    const entries = [
      messageEntry(user('the very first instruction')),
      ...readPair(1, BIG),
      compactionEntry('e-kept', 'PREVIOUS JEV VERBATIM BLOB'),
      messageEntry(user('a later request'), 'e-kept'),
      ...readPair(2, BIG),
      messageEntry(user('latest'), 'e-now'),
    ];
    const attempt = await buildCompaction(
      input(entries, {
        firstKeptEntryId: 'e-now',
        fetchImpl: bodyHandler(() => 0.1),
      }),
    );
    expect(attempt.status).toBe('compacted');
    if (attempt.status !== 'compacted') return;
    expect(attempt.summary).toContain('the very first instruction');
    expect(attempt.summary).not.toContain('PREVIOUS JEV VERBATIM BLOB');
    expect(attempt.summary).not.toContain('read(file_path="src/module-1.ts")');
    expect(attempt.summary).not.toContain('src/module-2.ts');
    expect(attempt.details.jev.callsDropped).toBe(2);
  });

  it('splits questions into several requests, resending the full state and bounding concurrency', async () => {
    const entries = [messageEntry(user('start'))];
    for (let index = 1; index <= 20; index += 1) {
      entries.push(...readPair(index, `body-${index}-${'x'.repeat(200)}`));
    }
    entries.push(messageEntry(user('go'), 'e-kept'));

    const states = new Set<string>();
    let inFlight = 0;
    let maxInFlight = 0;
    const trackingFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body ?? '{}')) as JevRequest;
      states.add(JSON.stringify(request.state));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      // Drop the even-numbered calls and keep the odd ones, so there is a real reduction
      // to measure while still needing several batches.
      const answers = Object.fromEntries(
        Object.keys(request.questions).map((name) => [
          name,
          { type: 'noul', noul: Number(/_t(\d+)$/.exec(name)?.[1] ?? 0) % 2 === 0 ? 0.1 : 0.9 },
        ]),
      );
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch;
    // Size the budgets off the real state so the split is deterministic: the state fits
    // whole, and the questions get roughly 560 tokens of room per request.
    const span = buildSpan(selectSpan(entries, 'e-kept') ?? []);
    const fitted = fitState(span.engine, collectToolCalls(span.engine, 0), {
      maxStateTokens: 25_000,
      preserveRecentMessages: 0,
      goal: '',
    });
    const attempt = await buildCompaction(
      input(entries, {
        firstKeptEntryId: 'e-kept',
        config: config({
          maxStateTokens: fitted.tokens + 200,
          maxRequestTokens: fitted.tokens + 600,
          maxConcurrentRequests: 2,
        }),
        fetchImpl: trackingFetch,
      }),
    );

    expect(attempt.status, JSON.stringify(attempt)).toBe('compacted');
    if (attempt.status !== 'compacted') return;
    expect(attempt.details.jev.requests).toBeGreaterThan(1);
    // Upstream invariant: the whole state is resent with every batch.
    expect(states.size).toBe(1);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(inFlight).toBe(0);
    expect(attempt.stats.kept).toBe(10);
    expect(attempt.stats.callsDropped).toBe(10);
  });

  it('falls back when there is nothing to prune and nothing to shrink', async () => {
    const entries = [messageEntry(user('just text')), messageEntry(user('more text'), 'e-kept')];
    const attempt = await buildCompaction(input(entries, { firstKeptEntryId: 'e-kept' }));
    expect(attempt).toEqual({ status: 'fallback', reason: 'no tool call in the replaced span' });
  });

  it('says so explicitly when every call of the span is pinned', async () => {
    const entries = [messageEntry(user('start')), ...readPair(1, BIG), messageEntry(user('go'), 'e-kept')];
    const attempt = await buildCompaction(
      input(entries, { firstKeptEntryId: 'e-kept', config: config({ preserveRecentMessages: 99 }) }),
    );
    expect(attempt).toEqual({
      status: 'fallback',
      reason: 'all 1 tool calls in the span are pinned by preserveRecentMessages',
    });
  });

  it('falls back when the reduction is under the minimum', async () => {
    const entries = [
      messageEntry(user('start')),
      ...readPair(1, 'tiny'),
      messageEntry(user('go'), 'e-kept'),
    ];
    const attempt = await buildCompaction(
      input(entries, { firstKeptEntryId: 'e-kept', fetchImpl: bodyHandler(() => 0.9) }),
    );
    expect(attempt.status).toBe('fallback');
    if (attempt.status !== 'fallback') return;
    expect(attempt.reason).toMatch(/under the 25% minimum/);
  });

  it('falls back on a Jev HTTP error, a malformed answer and an unfittable state', async () => {
    const entries = [messageEntry(user('start')), ...readPair(1, BIG), messageEntry(user('go'), 'e-kept')];
    const failing = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const httpError = await buildCompaction(input(entries, { firstKeptEntryId: 'e-kept', fetchImpl: failing }));
    expect(httpError.status).toBe('fallback');
    if (httpError.status === 'fallback') expect(httpError.reason).toMatch(/Jev failed \(Jev request failed \(500\)/);

    const malformed = (async () =>
      new Response(JSON.stringify({ answers: { call_t1: { noul: 0.5 } } }), { status: 200 })) as typeof fetch;
    const badAnswer = await buildCompaction(input(entries, { firstKeptEntryId: 'e-kept', fetchImpl: malformed }));
    expect(badAnswer.status).toBe('fallback');
    if (badAnswer.status === 'fallback') expect(badAnswer.reason).toMatch(/Invalid Jev answer for result_t1/);

    const tooSmall = await buildCompaction(
      input(entries, {
        firstKeptEntryId: 'e-kept',
        config: config({ maxStateTokens: 40, maxRequestTokens: 60 }),
        fetchImpl: bodyHandler(() => 0.1),
      }),
    );
    expect(tooSmall.status).toBe('fallback');
    if (tooSmall.status === 'fallback') expect(tooSmall.reason).toMatch(/state too large for Jev/);
  });

  it('gives up on a hung request instead of blocking compaction forever', async () => {
    const entries = [messageEntry(user('start')), ...readPair(1, BIG), messageEntry(user('go'), 'e-kept')];
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });
      throw new Error('unreachable');
    }) as typeof fetch;
    const attempt = await buildCompaction(
      input(entries, { firstKeptEntryId: 'e-kept', config: config({ timeoutMs: 30 }), fetchImpl: hanging }),
    );
    expect(attempt.status).toBe('fallback');
    if (attempt.status === 'fallback') expect(attempt.reason).toMatch(/timed out|Jev failed/);
  });

  it('reports a cancelled compaction when the host aborts', async () => {
    const entries = [messageEntry(user('start')), ...readPair(1, BIG), messageEntry(user('go'), 'e-kept')];
    const controller = new AbortController();
    controller.abort();
    const attempt = await buildCompaction(
      input(entries, {
        firstKeptEntryId: 'e-kept',
        signal: controller.signal,
        fetchImpl: bodyHandler(() => 0.1),
      }),
    );
    expect(attempt).toEqual({ status: 'fallback', reason: 'compaction cancelled' });
  });

  it('never sends thinking or the API key through the Jev state', async () => {
    const entries = [
      messageEntry(user('start')),
      messageEntry(assistant([{ type: 'thinking', thinking: 'PRIVATE REASONING' }, call('call-1', 'read', {})])),
      messageEntry(toolResult('call-1', BIG)),
      messageEntry(user('go'), 'e-kept'),
    ];
    const seen: string[] = [];
    const attempt = await buildCompaction(
      input(entries, {
        firstKeptEntryId: 'e-kept',
        fetchImpl: bodyHandler(
          () => 0.1,
          (request) => seen.push(JSON.stringify(request)),
        ),
      }),
    );
    expect(attempt.status).toBe('compacted');
    expect(seen.join('\n')).not.toContain('PRIVATE REASONING');
    expect(seen.join('\n')).not.toContain('test-key');
    if (attempt.status === 'compacted') {
      // Thinking stays in the replacement even when the call it reasoned about is gone
      // from the state Jev sees.
      expect(attempt.summary).not.toContain('PRIVATE REASONING');
    }
  });
});
