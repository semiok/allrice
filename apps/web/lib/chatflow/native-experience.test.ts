import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ChatFlowEventEnvelope } from '@allrice/contracts';

import { projectNativeExperience } from './native-experience';

function event(
  sequence: number,
  type: ChatFlowEventEnvelope['type'],
  payload: Record<string, unknown>,
  sourcePayload: Record<string, unknown> = {},
): ChatFlowEventEnvelope {
  const runId = '00000000-0000-4000-8000-000000000004';
  return {
    schemaVersion: 3,
    eventId: randomUUID(),
    organizationId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    conversationId: '00000000-0000-4000-8000-000000000003',
    runId,
    generation: 0,
    cursor: `${runId}:${sequence}`,
    sequence,
    harness: 'dsh',
    type,
    occurredAt: '2026-08-27T00:00:00.000Z',
    sourceEvent: {
      id: `dsh:${sequence}`,
      type: 'session.event',
      occurredAt: '2026-08-27T00:00:00.000Z',
      payload: sourcePayload,
    },
    payload,
  };
}

describe('projectNativeExperience', () => {
  it('deduplicates native and normalized receipts by call ID and retains the start time', () => {
    const start = event(
      1,
      'harness.native',
      { presentation: 'tool', status: 'started', label: 'market.quote' },
      { callId: 'call-1', name: 'market.quote' },
    );
    const finish = event(2, 'tool.failed', {
      toolCallId: 'call-1',
      name: 'market.quote',
      summary: '服务超时',
    });
    finish.occurredAt = '2026-08-27T00:00:03.000Z';
    const rows = projectNativeExperience([finish, start]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tool:call-1',
      toolName: 'market.quote',
      status: 'failed',
      sequence: 1,
      lastSequence: 2,
      startedAt: start.occurredAt,
      finishedAt: finish.occurredAt,
      detail: '服务超时',
    });
  });
  it('presents a checkpointed question suspension without hiding unrelated tool failures', () => {
    const rows = projectNativeExperience([
      event(
        1,
        'tool.failed',
        {
          toolCallId: 'question',
          name: 'ask_user_question',
          summary: '提问已挂起，等待你的回答',
        },
        { questionWait: true },
      ),
      event(
        2,
        'tool.failed',
        { toolCallId: 'write', name: 'file.write' },
        { questionWait: true },
      ),
    ]);
    expect(rows[0]).toMatchObject({
      status: 'info',
      detail: '提问已挂起，等待你的回答',
    });
    expect(rows[1]).toMatchObject({ status: 'failed' });
  });
  it('hides internal context and replaces a reasoning block in place', () => {
    const projected = projectNativeExperience([
      event(
        1,
        'harness.native',
        {
          presentation: 'context',
          status: 'completed',
          label: '上下文注入',
          summary: 'skill-catalog',
        },
        { source: { plugin: 'skill-catalog' } },
      ),
      event(
        2,
        'harness.native',
        {
          presentation: 'think',
          status: 'started',
          label: 'Rice 正在思考',
        },
        { turn: 1, step: 0, chunk: { index: 0 } },
      ),
      event(
        3,
        'harness.native',
        {
          presentation: 'think',
          status: 'completed',
          label: '思考完成',
        },
        { turn: 1, step: 0, chunk: { index: 0 } },
      ),
    ]);
    expect(projected).toHaveLength(1);
    expect(projected.map((item) => item.kind)).toEqual(['think']);
    expect(projected[0]).toMatchObject({
      status: 'completed',
      title: '思考完成',
      sequence: 2,
    });
  });

  it('keeps one search card while its status changes', () => {
    const projected = projectNativeExperience([
      event(
        4,
        'tool.started',
        { toolCallId: 'search-1', name: 'web.search' },
        { presentation: 'search', query: 'NVIDIA stock price' },
      ),
      event(
        5,
        'tool.completed',
        {
          toolCallId: 'search-1',
          name: 'web.search',
          summary: '找到 5 条结果',
        },
        { presentation: 'search', status: 'completed' },
      ),
    ]);
    expect(projected).toEqual([
      expect.objectContaining({
        kind: 'search',
        status: 'completed',
        title: 'Search · NVIDIA stock price',
        detail: '找到 5 条结果',
        sequence: 4,
      }),
    ]);
  });

  it('matches the DSH completed view with one search and the final think', () => {
    const projected = projectNativeExperience([
      event(
        1,
        'harness.native',
        {
          presentation: 'context',
          status: 'completed',
          label: '上下文注入',
        },
        { turn: 1 },
      ),
      event(
        2,
        'harness.native',
        {
          presentation: 'think',
          status: 'completed',
          label: '思考完成',
        },
        { turn: 1, step: 0, chunk: { index: 0 } },
      ),
      event(
        3,
        'tool.started',
        { toolCallId: 'search-1', name: 'web.search' },
        { presentation: 'search', query: 'NVIDIA price' },
      ),
      event(
        4,
        'tool.completed',
        { toolCallId: 'search-1', name: 'web.search' },
        { presentation: 'search', status: 'completed' },
      ),
      event(
        5,
        'harness.native',
        {
          presentation: 'think',
          status: 'completed',
          label: '思考完成',
        },
        { turn: 1, step: 2, chunk: { index: 0 } },
      ),
      event(
        6,
        'harness.native',
        {
          presentation: 'context',
          status: 'completed',
          label: '上下文注入',
        },
        { turn: 1 },
      ),
    ]);

    expect(projected.map((item) => item.kind)).toEqual(['search', 'think']);
    expect(projected.map((item) => item.sequence)).toEqual([3, 5]);
  });
});
