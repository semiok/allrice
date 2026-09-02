import type { RequestContext, RunEvent } from '@allrice/contracts';
import { describe, expect, it, vi } from 'vitest';

const { chatFlowRealtimeEnabled, getRequestContext, getRun, listRunEvents } =
  vi.hoisted(() => ({
    chatFlowRealtimeEnabled: vi.fn(),
    getRequestContext: vi.fn(),
    getRun: vi.fn(),
    listRunEvents: vi.fn(),
  }));

vi.mock(import('@allrice/database'), async (importOriginal) => ({
  ...(await importOriginal()),
  getRun,
  listRunEvents,
}));

vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext,
}));

vi.mock('../../../../../../lib/chatflow/rollout', () => ({
  chatFlowRealtimeEnabled,
}));

import { GET } from './route';

const ids = {
  conversation: '44444444-4444-4444-8444-444444444444',
  event: '55555555-5555-4555-8555-555555555555',
  membership: '66666666-6666-4666-8666-666666666666',
  organization: '11111111-1111-4111-8111-111111111111',
  request: '77777777-7777-4777-8777-777777777777',
  run: '33333333-3333-4333-8333-333333333333',
  session: '88888888-8888-4888-8888-888888888888',
  user: '99999999-9999-4999-8999-999999999999',
  workspace: '22222222-2222-4222-8222-222222222222',
};

const occurredAt = '2026-08-31T08:00:00.000Z';

const context: RequestContext = {
  requestId: ids.request,
  sessionId: ids.session,
  actor: { type: 'user', id: ids.user },
  organizationId: ids.organization,
  workspaceId: ids.workspace,
  memberships: [
    {
      id: ids.membership,
      userId: ids.user,
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      role: 'member',
      active: true,
    },
  ],
  authenticatedAt: occurredAt,
};

const replayedEvent: RunEvent = {
  eventId: ids.event,
  runId: ids.run,
  sequence: 1,
  type: 'run.succeeded',
  schemaVersion: 1,
  occurredAt,
  payload: {
    source: 'dsh',
    conversationId: ids.conversation,
    generation: 2,
    sourceEventId: 'dsh:event:42',
    sourceEventType: 'turn/completed',
    sourceOccurredAt: occurredAt,
    nativePayload: { text: '完成' },
    text: '完成',
  },
};

describe('GET /api/v1/runs/:id/events', () => {
  it('replays a terminal event after Last-Event-ID using the v3 SSE contract', async () => {
    getRequestContext.mockResolvedValue(context);
    chatFlowRealtimeEnabled.mockReturnValue(false);
    getRun.mockResolvedValue({ status: 'succeeded' });
    listRunEvents.mockResolvedValueOnce([replayedEvent]).mockResolvedValue([]);

    const response = await GET(
      new Request(
        `http://localhost/api/v1/runs/${ids.run}/events?workspaceId=${ids.workspace}`,
        { headers: { 'last-event-id': `${ids.run}:0` } },
      ),
      { params: Promise.resolve({ id: ids.run }) },
    );
    const body = await response.text();

    expect(listRunEvents).toHaveBeenNthCalledWith(
      1,
      context,
      ids.workspace,
      ids.run,
      0,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'no-cache, no-transform',
    );
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(response.headers.get('content-type')).toBe(
      'text/event-stream; charset=utf-8',
    );
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('x-allrice-chatflow-version')).toBe('3');
    expect(response.headers.get('x-allrice-chatflow-event-contract')).toBe(
      'chatflow-native-v3',
    );
    expect(response.headers.get('x-allrice-chatflow-transport')).toBe(
      'polling',
    );

    const envelope = {
      schemaVersion: 3,
      eventId: ids.event,
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      conversationId: ids.conversation,
      runId: ids.run,
      generation: 2,
      cursor: `${ids.run}:1`,
      sequence: 1,
      harness: 'dsh',
      type: 'run.succeeded',
      occurredAt,
      sourceEvent: {
        id: 'dsh:event:42',
        type: 'turn/completed',
        occurredAt,
        payload: { text: '完成' },
      },
      payload: replayedEvent.payload,
    };
    expect(body).toBe(
      [
        `id: ${ids.run}:1`,
        'event: chatflow-event',
        `data: ${JSON.stringify(envelope)}`,
        '',
        '',
      ].join('\n'),
    );
  });
});
