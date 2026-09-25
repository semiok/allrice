import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { projectWorkProgress } from './work-progress';

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

const reply = (seq: number, id: string, text: string, textMode = 'append') =>
  event(seq, 'assistant.text.delta', { replyId: id, text, textMode });
const tool = (seq: number, type: 'tool.started' | 'tool.completed') =>
  event(seq, type, {
    toolCallId: 'read',
    name: 'read',
    summary: '读取入口文件',
  });

describe('native reading order adapted to Allrice', () => {
  it('interleaves settled replies and tools without duplicates on replay; final stays outside the fold', () => {
    const first = reply(1, 'a', '先查看目录');
    const events = [
      first,
      tool(3, 'tool.started'),
      reply(2, 'a', '先查看目录', 'replace'),
      tool(4, 'tool.completed'),
      reply(5, 'b', '已确认入口'),
      first,
    ];
    const live = projectWorkProgress(events.reverse(), '', true);
    expect(live.parts?.map((part) => part.kind)).toEqual([
      'reply',
      'steps',
      'reply',
    ]);
    expect(
      live.parts
        ?.filter((part) => part.kind === 'reply')
        .map((part) => part.text),
    ).toEqual(['先查看目录', '已确认入口']);
    expect(live.finalText).toBe('');
    events.push(
      event(6, 'assistant.text.completed', {
        replyId: 'b',
        text: '已确认入口（校准）',
      }),
    );
    const done = projectWorkProgress(events, 'stale', false);
    expect(done.parts?.map((part) => part.kind)).toEqual(['reply', 'steps']);
    expect(done.finalText).toBe('已确认入口（校准）');
  });
  it('replaces an abandoned partial reply, isolates attempts and retains visible progress on failure', () => {
    const stale = reply(1, 'old', '旧任务');
    stale.payload.attempt = 1;
    const current = [
      reply(2, 'a', '失败半句'),
      reply(3, 'a', '', 'replace'),
      reply(4, 'a', '重新检查'),
      tool(5, 'tool.started'),
    ];
    current.forEach((e) => {
      e.payload.attempt = 2;
    });
    const result = projectWorkProgress(
      [stale, ...current],
      '执行中断，请重试',
      false,
    );
    expect(result.parts?.map((part) => part.kind)).toEqual(['reply', 'steps']);
    expect(JSON.stringify(result.parts)).toContain('重新检查');
    expect(JSON.stringify(result.parts)).not.toMatch(/失败半句|旧任务/);
    expect(result.finalText).toBe('执行中断，请重试');
  });
  it('does not infer historical reply boundaries; the authoritative final wins', () => {
    const result = projectWorkProgress(
      [
        event(1, 'assistant.text.delta', { text: '旧增量' }),
        event(2, 'assistant.text.completed', { text: '最终回复' }),
      ],
      'fallback',
      false,
    );
    expect(result.parts).toBeUndefined();
    expect(result.finalText).toBe('最终回复');
  });
});
