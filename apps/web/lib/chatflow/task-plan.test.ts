import { describe, expect, it } from 'vitest';
import type { ChatFlowEventEnvelope } from '@allrice/contracts';
import { projectTaskPlan } from './task-plan';

function event(
  sequence: number,
  todos: unknown,
  attempt = 1,
): ChatFlowEventEnvelope {
  return {
    schemaVersion: 3,
    eventId: `event-${sequence}`,
    organizationId: 'org',
    workspaceId: 'workspace',
    conversationId: 'conversation',
    runId: 'run',
    generation: 1,
    cursor: `run:${sequence}`,
    sequence,
    harness: 'dsh',
    type: 'harness.native',
    occurredAt: '2026-09-27T00:00:00Z',
    payload: { presentation: 'todo', attempt, generation: 1 },
    sourceEvent: {
      id: `dsh:${sequence}`,
      type: 'todo/write',
      occurredAt: '2026-09-27T00:00:00Z',
      payload: { todos },
    },
  };
}
const step = (content: string, status = 'in_progress') => ({ content, status });
const project = (events: ChatFlowEventEnvelope[]) =>
  projectTaskPlan(events, 'conversation', 'run');

describe('durable task plan replay', () => {
  it('uses the latest whole snapshot through duplicate and out-of-order delivery, including an empty list', () => {
    const first = event(1, [step('read'), step('write', 'pending')]);
    const latest = event(2, [step('read', 'completed'), step('deliver')]);
    expect(project([latest, first, latest])).toEqual([
      step('read', 'completed'),
      step('deliver'),
    ]);
    expect(project([latest, event(3, []), first])).toEqual([]);
  });
  it('cannot leak another conversation or another run into the dock', () => {
    const own = event(1, [step('own')]);
    expect(
      project([
        own,
        { ...event(3, [step('other run')]), runId: 'other' },
        { ...event(4, [step('other conversation')]), conversationId: 'other' },
      ]),
    ).toEqual([step('own')]);
  });
  it('ignores superseded attempts, legacy count-only receipts, malformed lists and unrelated native events', () => {
    const legacy = event(6, undefined, 2);
    legacy.sourceEvent!.payload = { count: 4, completed: 1 };
    const current = event(3, [step('retry')], 2);
    expect(
      project([
        event(1, [step('old')]),
        current,
        event(4, [{ content: 'invalid', status: 'made up' }], 2),
      { ...event(5, [step('unrelated')], 2), sourceEvent: null },
      legacy,
      event(99, [step('late old attempt')]),
      ]),
    ).toEqual([step('retry')]);
    current.sourceEvent = null;
    expect(project([event(1, [step('old')]), current])).toEqual([step('old')]);
  });
});
