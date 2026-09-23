import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { HarnessEvent } from '@allrice/contracts';

import { AgentLoopGuard, AgentLoopGuardError } from './agent-loop-guard.js';

function toolEvent(order: number, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    harness: 'dsh',
    generation: 0,
    attempt: 1,
    order,
    threadId: 'thread-1',
    turnId: 'turn-1',
    sessionId: randomUUID(),
    messageId: randomUUID(),
    type: 'tool.started',
    toolCallId: `call-${order}`,
    name: 'web.search',
    label: '联网搜索',
    source: 'harness',
    sourcePayload: payload,
  } satisfies HarnessEvent;
}

describe('agent loop guard', () => {
  it('does not reintroduce a wall-clock cap when the durable task clock owns elapsed time', () => {
    const guard = new AgentLoopGuard(undefined, 'durable');
    expect(() =>
      guard.observe(toolEvent(1), Date.now() + 86400000),
    ).not.toThrow();
  });
  it('allows distinct tool work and blocks identical repetition', () => {
    const guard = new AgentLoopGuard({
      maxEvents: 20,
      maxToolCalls: 10,
      maxIdenticalToolCalls: 2,
      maxRuntimeMs: 10_000,
    });
    guard.observe(toolEvent(1, { q: 'one' }));
    guard.observe(toolEvent(2, { q: 'two' }));
    guard.observe(toolEvent(3, { q: 'one' }));
    expect(() => guard.observe(toolEvent(4, { q: 'one' }))).toThrow(
      new AgentLoopGuardError('AGENT_TOOL_LOOP_DETECTED'),
    );
  });

  it('blocks an execution that exceeds its runtime budget', () => {
    const guard = new AgentLoopGuard({
      maxEvents: 20,
      maxToolCalls: 10,
      maxIdenticalToolCalls: 3,
      maxRuntimeMs: 1,
    });
    expect(() => guard.observe(toolEvent(1), Date.now() + 10)).toThrow(
      new AgentLoopGuardError('AGENT_RUNTIME_LIMIT_EXCEEDED'),
    );
  });
});
