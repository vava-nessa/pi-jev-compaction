/**
 * @file pi-messages.test.ts
 * @description Unit tests for the Pi <-> engine message bridging and the renderer.
 * No network, no Pi runtime: plain data in, plain data out.
 */

import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  buildSpan,
  collectOutcomes,
  isExcludedFromContext,
  mapPiMessageToEngine,
  messageText,
  piMessageChars,
  renderSpan,
  textOfContent,
  truncatedResultText,
  type SpanEntry,
} from '../extensions/lib/pi-messages.ts';
import { collectToolCalls, decideCall, type ToolCall } from '../src/index.ts';

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function entry(message: AgentMessage, id = `e-${Math.random().toString(36).slice(2, 8)}`): SpanEntry {
  return { entryId: id, message };
}

describe('engine mapping', () => {
  it('maps user, assistant and tool result messages without touching the originals', () => {
    const text = user('fix the test');
    const assistantMessage = assistant([call('c1', 'read', { path: 'src/a.ts' }), { type: 'text', text: 'looking' }]);
    const result = toolResult('c1', 'file body');

    expect(mapPiMessageToEngine(text)).toEqual({ role: 'user', text: 'fix the test', toolUses: [] });
    expect(mapPiMessageToEngine(assistantMessage)).toEqual({
      role: 'assistant',
      text: 'looking',
      toolUses: [{ tool_use_id: 'c1', tool: 'read', input: { path: 'src/a.ts' } }],
    });
    expect(mapPiMessageToEngine(result)).toEqual({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: 'c1', text: 'file body', isError: false }],
    });
  });

  it('never sends assistant thinking to Jev (parity with the Claude Code original)', () => {
    const message = assistant([{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'answer' }]);
    expect(mapPiMessageToEngine(message).text).toBe('answer');
  });

  it('maps non-LLM message kinds so nothing is silently lost', () => {
    const bash = {
      role: 'bashExecution',
      command: 'ls -la',
      output: 'total 0',
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
      excludeFromContext: true,
    } as unknown as AgentMessage;
    expect(messageText(bash)).toBe('! ls -la\ntotal 0');
    expect(isExcludedFromContext(bash)).toBe(true);

    const branchSummary = {
      role: 'branchSummary',
      summary: 'we came back from the auth branch',
      fromId: 'x',
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(messageText(branchSummary)).toBe('we came back from the auth branch');
    expect(isExcludedFromContext(branchSummary)).toBe(false);
  });

  it('turns images and unknown blocks into readable markers', () => {
    expect(
      textOfContent([
        { type: 'text', text: 'see this' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ]),
    ).toBe('see this\n[image image/png]');
  });

  it('counts thinking, tool inputs and tool output in the raw character budget', () => {
    const message = assistant([
      { type: 'thinking', thinking: 'twelve chars' },
      call('c1', 'read', { path: 'src/a.ts' }),
    ]);
    // "twelve chars" (12) + JSON of the arguments (24)
    expect(piMessageChars(message)).toBe(12 + JSON.stringify({ path: 'src/a.ts' }).length);
    expect(piMessageChars(toolResult('c1', 'body'))).toBe(4);
  });

  it('builds an engine span that stays index aligned with its messages', () => {
    const span = buildSpan([entry(user('a')), entry(toolResult('c1', 'b')), entry(assistant([call('c1', 'read')]))]);
    expect(span.messages).toHaveLength(3);
    expect(span.engine).toHaveLength(3);
    expect(span.engine[0]?.role).toBe('user');
    expect(span.engine[1]?.toolResults?.[0]?.tool_use_id).toBe('c1');
    expect(span.engine[2]?.toolUses[0]?.tool_use_id).toBe('c1');
    expect(span.rawChars).toBeGreaterThan(0);
  });
});

describe('outcomes', () => {
  // A leading user message matters: the engine always pins the first message of a
  // span, so a call sitting in message 0 could never be a candidate.
  const messages = buildSpan([
    entry(user('start here')),
    entry(assistant([call('c1', 'read', { file_path: 'a.ts' })])),
    entry(toolResult('c1', 'a'.repeat(1000))),
    entry(assistant([call('c2', 'bash', { command: 'ls' })])),
    entry(toolResult('c2', 'listed')),
  ]);
  const calls = collectToolCalls(messages.engine, 0);
  const options = { keepThreshold: 0.5 };

  it('keys outcomes by tool call id and keeps undecided calls', () => {
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.2 }, options),
    ];
    const outcomes = collectOutcomes(calls, decisions);
    expect(outcomes.get('c1')).toEqual({ dropCall: true, dropResult: true });
    expect(outcomes.get('c2')).toEqual({ dropCall: false, dropResult: true });
    expect(outcomes.size).toBe(2);
  });

  it('honours forced drops and ignores engine ids that are not tool call ids', () => {
    const stray = { ...calls[0]!, id: 'zz', tool_use_id: 'unknown' } satisfies ToolCall;
    const decisions = [decideCall(stray, { keepCall: 0.9, keepResult: 0.9 }, options)];
    const outcomes = collectOutcomes(calls, decisions, ['c2']);
    expect(outcomes.get('c2')).toEqual({ dropCall: true, dropResult: true });
    expect(outcomes.has('unknown')).toBe(false);
  });
});

describe('rendering', () => {
  const long = 'x'.repeat(1000);
  const span = buildSpan([
    entry(user('Never edit src/generated. Fix the failing test.')),
    entry(assistant([call('c1', 'read', { file_path: 'src/a.ts' }), { type: 'text', text: 'reading a.ts' }])),
    entry(toolResult('c1', long)),
    entry(assistant([call('c2', 'bash', { command: 'npm test' })])),
    entry(toolResult('c2', 'FAIL b.test.ts: expected 2 to be 3', true)),
    entry(assistant([{ type: 'text', text: 'fixing now' }])),
  ]);

  it('keeps everything verbatim when nothing is dropped', () => {
    const text = renderSpan(span, new Map(), { headChars: 300 });
    expect(text).toContain('[User]: Never edit src/generated. Fix the failing test.');
    expect(text).toContain('[Assistant tool calls]: read(file_path="src/a.ts")');
    expect(text).toContain('[Assistant]: reading a.ts');
    expect(text).toContain(`[Tool result read (ok)]: ${long}`);
    expect(text).toContain('[Tool result read (error)]: FAIL b.test.ts');
    expect(text).toContain('[Assistant]: fixing now');
  });

  it('removes a dropped call together with its result', () => {
    const text = renderSpan(span, new Map([['c1', { dropCall: true, dropResult: true }]]), { headChars: 300 });
    expect(text).not.toContain('read(file_path="src/a.ts")');
    expect(text).not.toContain(long);
    expect(text).toContain('reading a.ts');
    expect(text).toContain('[Assistant tool calls]: bash(command="npm test")');
  });

  it('keeps a call and truncates its result to the configured head plus a note', () => {
    const text = renderSpan(span, new Map([['c1', { dropCall: false, dropResult: true }]]), { headChars: 50 });
    expect(text).toContain('read(file_path="src/a.ts")');
    expect(text).toContain(`[Tool result read (ok)]: ${'x'.repeat(50)}\n[pi-jev-compaction truncated 950 chars`);
    expect(text).toContain('re-run the tool if needed]');
    expect(text).not.toContain(long);
  });

  it('drops a call-only assistant message entirely once all its calls are gone', () => {
    const thinkingSpan = buildSpan([
      entry(assistant([{ type: 'thinking', thinking: 'should I read this file?' }, call('c1', 'read', {})])),
      entry(toolResult('c1', long)),
      entry(assistant([{ type: 'text', text: 'done' }])),
    ]);
    const text = renderSpan(thinkingSpan, new Map([['c1', { dropCall: true, dropResult: true }]]), { headChars: 300 });
    expect(text).toBe('[Assistant]: done');
  });

  it('abridges thinking by default and can drop or keep it', () => {
    const thinking = 't'.repeat(1000);
    const thinkingSpan = buildSpan([
      entry(assistant([{ type: 'thinking', thinking }, { type: 'text', text: 'answer' }])),
    ]);
    const abridged = renderSpan(thinkingSpan, new Map(), { headChars: 300, thinking: 'abridge', thinkingHeadChars: 100 });
    expect(abridged).toContain(`${'t'.repeat(100)}\n[… 900 chars of thinking omitted …]`);
    const dropped = renderSpan(thinkingSpan, new Map(), { headChars: 300, thinking: 'drop' });
    expect(dropped).toContain('[Assistant thinking omitted by pi-jev-compaction]');
    expect(dropped).not.toContain('tttt');
    const kept = renderSpan(thinkingSpan, new Map(), { headChars: 300, thinking: 'keep' });
    expect(kept).toContain(`[Assistant thinking]: ${thinking}`);
  });

  it('renders the header and the cumulative file lists Pi expects', () => {
    const text = renderSpan(span, new Map(), {
      headChars: 300,
      header: 'Jev kept 2/2 tool calls verbatim (no summary).',
      fileOps: { readFiles: ['src/a.ts'], modifiedFiles: ['src/b.ts'] },
    });
    expect(text.startsWith('Jev kept 2/2 tool calls verbatim (no summary).')).toBe(true);
    expect(text).toContain('<read-files>\nsrc/a.ts\n</read-files>');
    expect(text).toContain('<modified-files>\nsrc/b.ts\n</modified-files>');
  });

  it('leaves short dropped results untouched and explains long ones', () => {
    expect(truncatedResultText('short', false, 300)).toBe('short');
    expect(truncatedResultText('y'.repeat(500), true, 0)).toBe(
      `[pi-jev-compaction truncated 500 chars of this tool result (error); re-run the tool if needed]`,
    );
  });
});
