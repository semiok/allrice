import { describe, expect, it } from 'vitest';
import type { Message, RunView } from './chatflow-types';
import { conversationTurns } from './turn-navigation-model';

const message = (
  id: string,
  role: Message['role'],
  text: string,
  runId: string | null = id,
): Message => ({
  id,
  role,
  runId,
  content: { text },
  status: 'completed',
  createdAt: '2026-09-25T00:00:00Z',
});

describe('conversation turn previews', () => {
  it('pairs answers by run even when replies arrive after a newer prompt; ignores internal messages', () => {
    const items = conversationTurns(
      [
        message('q1', 'user', '查财报', 'r1'),
        message('hidden', 'system', 'system secret'),
        message('q2', 'user', '写总结', 'r2'),
        message('hidden-tool', 'tool', 'raw tool secret', 'r2'),
        message('a1', 'assistant', '营收增长', 'r1'),
        message('a2', 'assistant', '总结完成', 'r2'),
      ],
      {},
    );
    expect(items.map((i) => [i.turn, i.prompt, i.response, i.anchor])).toEqual([
      [1, '查财报', '营收增长', { kind: 'loaded', key: 'q1' }],
      [2, '写总结', '总结完成', { kind: 'loaded', key: 'q2' }],
    ]);
  });

  it('handles historical prompt IDs, attachments, orphan replies and an unanswered question', () => {
    const attachment = {
      ...message('q1', 'user', '', null),
      attachments: [
        {
          id: 'file',
          fileName: 'data.xlsx',
          mediaType: 'application/octet-stream',
          sizeBytes: 1,
        },
      ],
    };
    const items = conversationTurns(
      [
        message('a0', 'assistant', '历史回复', 'r0'),
        attachment,
        message('a1', 'assistant', '读完了', 'r1'),
        message('q2', 'user', '继续', 'r2'),
        {
          ...message('a2', 'assistant', 'hidden pending placeholder', 'r2'),
          status: 'pending',
        },
      ],
      {},
    );
    expect(items.map((i) => [i.prompt, i.response])).toEqual([
      ['', '历史回复'],
      ['已发送附件', '读完了'],
      ['继续', ''],
    ]);
  });

  it('bounds existing text and streamed previews without exposing trace summaries', () => {
    const view: RunView = {
      runId: 'r',
      status: 'running',
      cursor: null,
      reconnects: 0,
      events: [
        {
          type: 'tool.started' as const,
          payload: { text: 'secret tool payload' },
        },
        { type: 'assistant.text.delta' as const, payload: { text: '答' } },
        {
          type: 'assistant.text.delta' as const,
          payload: { text: '复\n' + '答复\n'.repeat(10000) },
        },
      ].map((event, sequence) => ({
        ...event,
        schemaVersion: 3,
        eventId: `event-${sequence}`,
        organizationId: 'org',
        workspaceId: 'workspace',
        conversationId: null,
        runId: 'r',
        generation: 1,
        cursor: `r:${sequence}`,
        sequence,
        harness: 'dsh',
        occurredAt: '2026-09-25T00:00:00Z',
        sourceEvent: null,
      })),
    };
    const [item] = conversationTurns(
      [
        message('q', 'user', '问题\n'.repeat(10000), 'r'),
        { ...message('a', 'assistant', '', 'r'), status: 'pending' },
      ],
      { r: view },
    );
    expect(item?.prompt.length).toBeLessThanOrEqual(50);
    expect(item?.response.length).toBeLessThanOrEqual(120);
    expect(item?.response).toMatch(/^答复 答复/);
    expect(item?.response).not.toMatch(/secret|\n/);
  });
});
