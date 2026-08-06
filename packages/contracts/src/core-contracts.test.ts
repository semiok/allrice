import { describe, expect, it } from 'vitest';

import {
  assertJobTransition,
  AssistantTextEventPayloadSchema,
  authorize,
  authorizeExecution,
  CancelRunInputSchema,
  CreateRunInputSchema,
  CreateSessionAttachmentInputSchema,
  CreateWorkspaceMemoryInputSchema,
  formatSseCursor,
  makeObjectKey,
  ObjectKeySchema,
  parseSseCursor,
  replayRunEvents,
  retryDelayMs,
  ToolEventPayloadSchema,
  validateRunEventSequence,
  type RequestContext,
  type ResourceRef,
  type RunEvent,
} from './index.js';

const ids = {
  organizationA: '11111111-1111-4111-8111-111111111111',
  organizationB: '22222222-2222-4222-8222-222222222222',
  workspaceA: '33333333-3333-4333-8333-333333333333',
  workspaceB: '44444444-4444-4444-8444-444444444444',
  userA: '55555555-5555-4555-8555-555555555555',
  userB: '66666666-6666-4666-8666-666666666666',
  resource: '77777777-7777-4777-8777-777777777777',
  membership: '88888888-8888-4888-8888-888888888888',
  request: '99999999-9999-4999-8999-999999999999',
  session: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  run: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  eventA: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  eventB: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  worker: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  policy: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};

const now = '2026-08-05T10:00:00.000Z';

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: ids.request,
    sessionId: ids.session,
    actor: { type: 'user', id: ids.userA },
    organizationId: ids.organizationA,
    workspaceId: ids.workspaceA,
    memberships: [
      {
        id: ids.membership,
        userId: ids.userA,
        organizationId: ids.organizationA,
        workspaceId: ids.workspaceA,
        role: 'admin',
        active: true,
      },
    ],
    authenticatedAt: now,
    ...overrides,
  };
}

function resource(overrides: Partial<ResourceRef> = {}): ResourceRef {
  return {
    type: 'memory',
    id: ids.resource,
    organizationId: ids.organizationA,
    workspaceId: ids.workspaceA,
    ownerId: ids.userB,
    visibility: 'workspace',
    archivedAt: null,
    ...overrides,
  };
}

describe('authorization contracts', () => {
  it('denies cross-tenant and private admin reads', () => {
    expect(
      authorize(
        resource({ organizationId: ids.organizationB }),
        'resource:read',
        context(),
      ).reason,
    ).toBe('denied_tenant_mismatch');
    expect(
      authorize(resource({ visibility: 'private' }), 'resource:read', context())
        .reason,
    ).toBe('denied_private_resource');
    expect(
      authorize(
        resource({ workspaceId: ids.workspaceB }),
        'resource:read',
        context(),
      ).reason,
    ).toBe('denied_workspace_mismatch');
  });

  it('allows the owner but not a viewer write', () => {
    expect(
      authorize(
        resource({ ownerId: ids.userA, visibility: 'private' }),
        'resource:read',
        context(),
      ).allowed,
    ).toBe(true);
    const viewerContext = context({
      memberships: [{ ...context().memberships[0]!, role: 'viewer' }],
    });
    expect(authorize(resource(), 'resource:write', viewerContext).allowed).toBe(
      false,
    );
  });

  it('allows a worker only through a current frozen policy grant', () => {
    const decision = authorizeExecution(
      resource(),
      'resource:read',
      {
        executionId: ids.request,
        runId: ids.run,
        jobId: ids.resource,
        worker: { type: 'worker', id: ids.worker },
        delegatedBy: { type: 'user', id: ids.userA },
        organizationId: ids.organizationA,
        workspaceId: ids.workspaceA,
        policySnapshot: {
          id: ids.policy,
          organizationId: ids.organizationA,
          subjectId: ids.userA,
          version: 1,
          issuedAt: now,
          expiresAt: '2026-08-05T12:00:00.000Z',
          memberships: context().memberships,
          grants: [
            {
              resourceType: 'memory',
              action: 'resource:read',
              workspaceId: ids.workspaceA,
            },
          ],
        },
        startedAt: now,
      },
      new Date('2026-08-05T11:00:00.000Z'),
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('queue contracts', () => {
  it('enforces legal transitions and lease-expiry recovery', () => {
    expect(() => assertJobTransition('queued', 'claimed')).not.toThrow();
    expect(() => assertJobTransition('running', 'queued')).toThrow();
    expect(() =>
      assertJobTransition('running', 'queued', { leaseExpired: true }),
    ).not.toThrow();
  });

  it('caps exponential retry delay', () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(20)).toBe(300_000);
  });

  it('validates durable run submission and cancellation inputs', () => {
    const submission = CreateRunInputSchema.parse({
      workspaceId: ids.workspaceA,
      idempotencyKey: 'employee-task:42',
      type: 'allrice.system.echo',
      input: { value: 'hello' },
    });
    expect(submission.priority).toBe(0);
    expect(submission.maxAttempts).toBe(3);
    expect(submission.timeoutMs).toBe(300_000);
    expect(CancelRunInputSchema.parse({}).reason).toBe('user_requested');
    expect(() =>
      CreateRunInputSchema.parse({
        ...submission,
        timeoutMs: 999,
      }),
    ).toThrow();
  });
});

describe('run and SSE contracts', () => {
  const events: RunEvent[] = [
    {
      eventId: ids.eventA,
      runId: ids.run,
      sequence: 0,
      type: 'run.created',
      schemaVersion: 1,
      occurredAt: now,
      payload: {},
    },
    {
      eventId: ids.eventB,
      runId: ids.run,
      sequence: 1,
      type: 'run.started',
      schemaVersion: 1,
      occurredAt: now,
      payload: {},
    },
  ];

  it('validates monotonic events and replays after Last-Event-ID', () => {
    expect(() => validateRunEventSequence(events)).not.toThrow();
    const cursor = formatSseCursor({ runId: ids.run, sequence: 0 });
    expect(parseSseCursor(cursor)).toEqual({ runId: ids.run, sequence: 0 });
    expect(replayRunEvents(events, cursor)).toEqual([events[1]]);
  });

  it('validates secret-free assistant and Tool Broker event payloads', () => {
    expect(
      AssistantTextEventPayloadSchema.parse({
        source: 'codex',
        text: 'done',
      }),
    ).toEqual({ source: 'codex', text: 'done' });
    expect(
      ToolEventPayloadSchema.parse({
        toolCallId: 'tool-1',
        name: 'workspace.file.list',
        label: '查看工作区文件',
        source: 'tool_broker',
        status: 'completed',
        summary: '找到 2 个可访问文件',
        itemCount: 2,
        attempt: 1,
      }).status,
    ).toBe('completed');
    expect(() =>
      ToolEventPayloadSchema.parse({
        toolCallId: 'tool-1',
        name: 'workspace.file.list',
        label: '查看工作区文件',
        source: 'tool_broker',
        status: 'completed',
        rawCommand: 'cat ~/.ssh/id_rsa',
      }),
    ).toThrow();
  });

  it('rejects expired cursors and terminal-event suffixes', () => {
    expect(() => replayRunEvents(events, `${ids.run}:0`, 2)).toThrow(
      'cursor_expired',
    );
    expect(() =>
      validateRunEventSequence([
        { ...events[0]!, type: 'run.succeeded' },
        events[1]!,
      ]),
    ).toThrow('run event emitted after terminal event');
  });
});

describe('storage contracts', () => {
  it('defaults local conversation uploads to private visibility', () => {
    expect(
      CreateSessionAttachmentInputSchema.parse({
        fileName: 'brief.md',
        mediaType: 'text/markdown',
        contentBase64: 'dGVzdA==',
      }).visibility,
    ).toBe('private');
  });
  it('builds tenant-prefixed opaque keys and rejects host paths', () => {
    const key = makeObjectKey({
      organizationId: ids.organizationA,
      workspaceId: ids.workspaceA,
      ownerId: ids.userA,
      category: 'uploads',
      objectId: ids.resource,
    });
    expect(key).toContain(`organizations/${ids.organizationA}/workspaces/`);
    expect(key).not.toContain('/Users/');
    expect(() =>
      ObjectKeySchema.parse(
        'organizations/------------------------------------/workspaces/------------------------------------/owners/------------------------------------/uploads/------------------------------------',
      ),
    ).toThrow();
  });

  it('allows only workspace attachment MIME types', () => {
    const base = {
      fileName: 'notes.txt',
      contentBase64: 'YWxscmljZQ==',
    };
    expect(
      CreateSessionAttachmentInputSchema.parse({
        ...base,
        mediaType: 'text/plain',
      }).mediaType,
    ).toBe('text/plain');
    expect(() =>
      CreateSessionAttachmentInputSchema.parse({
        ...base,
        mediaType: 'application/x-sh',
      }),
    ).toThrow();
  });

  it('requires explicit, traceable workspace memory sources', () => {
    expect(
      CreateWorkspaceMemoryInputSchema.parse({
        workspaceId: ids.workspaceA,
        content: 'Remember this source',
        visibility: 'private',
        sourceType: 'message',
        sourceId: ids.resource,
      }).sourceType,
    ).toBe('message');
    expect(() =>
      CreateWorkspaceMemoryInputSchema.parse({
        workspaceId: ids.workspaceA,
        content: 'Missing source type',
      }),
    ).toThrow();
  });
});
