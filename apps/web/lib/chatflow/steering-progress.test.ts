import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import type { Message } from '../../app/chatflow/chatflow-types';
import { steeringProgress } from './steering-progress';
import { projectWorkProgress } from './work-progress';

const event = (
  sequence: number,
  type: ChatFlowEventEnvelope['type'],
  payload: object,
  native = sequence,
) =>
  ({
    schemaVersion: 3,
    organizationId: 'org',
    workspaceId: 'workspace',
    conversationId: 'session',
    generation: 2,
    cursor: `run:${sequence}`,
    harness: 'dsh',
    occurredAt: '2026-10-13T00:00:00Z',
    eventId: `event-${sequence}`,
    runId: 'run',
    sequence,
    type,
    sourceEvent: {
      id: `dsh:${native}`,
      type: 'user/message',
      occurredAt: '2026-10-13T00:00:00Z',
      payload: {},
    },
    payload: { generation: 2, turnId: 'turn:5', ...payload },
  }) as ChatFlowEventEnvelope;
const user = (id: string, sequence: number) =>
  ({
    id,
    role: 'user',
    content: { text: id },
    steering: {
      runId: 'run',
      generation: 2,
      turnId: 'turn:5',
      status: 'adopted',
      sequence,
    },
  }) as Message;
const tool = (sequence: number, call: string) =>
  event(sequence, 'tool.started', { toolCallId: call, name: 'read' });

describe('adopted steering inside a native turn', () => {
  it.each([true, false])(
    'keeps old work above inputs and live work below two adopted inputs (streaming=%s)',
    (streaming) => {
      const messages = [user('first', 132), user('second', 139)];
      const events = [
        tool(8, 'a'),
        event(10, 'harness.native', {}, 132),
        tool(11, 'b'),
        event(15, 'harness.native', {}, 139),
        tool(16, 'c'),
      ];
      const progress = projectWorkProgress(events, '', true, streaming);
      const result = steeringProgress(
        [...events, events[0]!],
        messages,
        progress.items,
        progress.parts,
        true,
      );
      expect(result.map((s) => s.message?.id)).toEqual([
        undefined,
        'first',
        'second',
      ]);
      expect(result.map((s) => s.items.map((i) => i.id))).toEqual([
        ['tool:a'],
        ['tool:b'],
        ['tool:c'],
      ]);
      expect(result.map((s) => s.last)).toEqual([false, false, true]);
    },
  );
  it('places the final history reply after all inputs while the event trace is loading', () => {
    const result = steeringProgress(
      [],
      [user('first', 132), user('second', 139)],
      [],
      [{ kind: 'reply', id: 'history-reply', sequence: 0, text: 'done' }],
      false,
    );
    expect(result.map((s) => s.parts?.length)).toEqual([0, 0, 1]);
    expect(result.at(-1)?.parts?.[0]).toMatchObject({
      kind: 'reply',
      text: 'done',
    });
  });
  it('does not use an equal sequence from another native generation as an adoption boundary', () => {
    const wrong = event(10, 'harness.native', { generation: 3 }, 132);
    const progress = projectWorkProgress(
      [tool(8, 'a'), wrong],
      'done',
      false,
      true,
    );
    const result = steeringProgress(
      [wrong],
      [user('first', 132)],
      progress.items,
      progress.parts,
      false,
    );
    expect(result[0]?.items).toEqual(progress.items);
    expect(result[1]?.message?.id).toBe('first');
  });
  it('keeps a completed tool update in its original segment instead of duplicating it after steering', () => {
    const events = [
      tool(8, 'a'),
      event(10, 'harness.native', {}, 132),
      event(11, 'tool.completed', { toolCallId: 'a', name: 'read' }),
      tool(12, 'b'),
    ];
    const progress = projectWorkProgress(events, '', true);
    const result = steeringProgress(
      events,
      [user('first', 132)],
      progress.items,
      progress.parts,
      true,
    );
    expect(result[0]?.items[0]).toMatchObject({
      id: 'tool:a',
      status: 'completed',
    });
    expect(result[1]?.items.map((i) => i.id)).toEqual(['tool:b']);
  });
});
