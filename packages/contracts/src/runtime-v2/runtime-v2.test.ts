import { describe, expect, it } from 'vitest';

import {
  RuntimeActionBindingSchema,
  RuntimeAttemptRefSchema,
  RuntimeContentRefSchema,
  RuntimeExecutionScopeSchema,
  RuntimeOperationEventSchema,
  RuntimeOperationResultSchema,
  RuntimeOperationSnapshotSchema,
  RuntimeOperationStatusSchema,
  RuntimeScopeSchema,
  RuntimeTaskRefSchema,
  advanceRuntimeOperation,
  canTransitionRuntimeOperation,
  decodeRuntimeOperationEvent,
  matchesRuntimeScope,
  replayRuntimeOperationEvents,
  runtimeContractEqual,
  type RuntimeActionBinding,
  type RuntimeOperationEvent,
  type RuntimeOperationSignal,
  type RuntimeOperationSnapshot,
  type RuntimeOperationStatus,
} from '../index.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;
const at = '2026-09-07T10:00:00.000Z';
const evidence = { id: id(30), recordedAt: at, digest };

function binding(): RuntimeActionBinding {
  return RuntimeActionBindingSchema.parse({
    task: {
      scope: { organizationId: id(1), workspaceId: id(2), projectId: null },
      chatSessionId: id(3),
      runId: id(4),
      rootRunId: id(4),
      parentRunId: null,
      frozenConfiguration: { employeeVersionId: id(5), digest },
    },
    attempt: {
      operationId: id(6),
      attemptId: id(7),
      attemptNumber: 1,
      generation: 0,
      fence: 1,
    },
    requestedBy: { type: 'user', id: id(8) },
    policy: { snapshotId: id(9), digest },
    execution: {
      targetId: id(10),
      targetKind: 'rice_bridge',
      deviceId: id(11),
      grantId: id(12),
      grantVersion: 1,
      scopeDigest: digest,
      workCopy: { id: id(13), kind: 'in_place' },
    },
    action: 'local.fs.write',
    inputDigest: digest,
    dataScope: [
      {
        content: { kind: 'storage_object', id: id(14), checksum: digest },
        sourceTargetId: id(10),
        purpose: 'execution_input',
        destination: 'in_place',
        authorizationId: id(15),
        authorizationVersion: 1,
      },
    ],
    baseline: [
      {
        kind: 'deliverable_version',
        id: id(16),
        objectId: id(17),
        seriesId: id(18),
        version: 1,
        checksum: digest,
      },
    ],
    command: null,
  });
}

function snapshot(): RuntimeOperationSnapshot {
  return RuntimeOperationSnapshotSchema.parse({
    contractVersion: 1,
    binding: binding(),
    stepId: null,
    agentInstanceId: null,
    processId: null,
    cancelRequestId: null,
    idempotencyKey: id(19),
    status: 'planned',
    result: null,
  });
}

function event(
  sequence: number,
  signal: RuntimeOperationSignal,
): RuntimeOperationEvent {
  const action = binding();
  return RuntimeOperationEventSchema.parse({
    family: 'allrice.runtime.operation',
    contractVersion: 1,
    eventId: id(100 + sequence),
    task: action.task,
    attempt: action.attempt,
    execution: action.execution,
    sequence,
    occurredAt: at,
    signal,
  });
}

const startup = () => [
  event(0, { type: 'operation.ready' }),
  event(1, { type: 'operation.dispatched' }),
  event(2, { type: 'operation.started', processId: id(20) }),
];
const outcome = (
  status: 'succeeded' | 'failed' | 'partial' = 'succeeded',
): RuntimeOperationSignal => ({
  type: 'operation.outcome',
  result: {
    status,
    effects: status === 'partial' ? 'partial' : 'applied',
    evidence,
  },
});

describe('P01 runtime identity and action references (P00 A01/A03/A04)', () => {
  it('represents cloud work without a Bridge, Project or manufactured chat Session', () => {
    const action = binding();
    action.task.chatSessionId = null;
    action.execution = {
      ...action.execution,
      targetKind: 'cloud_sandbox',
      deviceId: null,
      workCopy: { id: id(40), kind: 'cloud_copy' },
    };
    expect(RuntimeActionBindingSchema.parse(action)).toEqual(action);
    expect(
      RuntimeScopeSchema.safeParse({
        organizationId: id(1),
        workspaceId: null,
        projectId: null,
      }).success,
    ).toBe(false);
  });

  it('reserves child Run links without authorizing an Agent spawn or new budget', () => {
    const task = binding().task;
    expect(
      RuntimeTaskRefSchema.safeParse({
        ...task,
        runId: id(50),
        parentRunId: task.runId,
      }).success,
    ).toBe(true);
    for (const patch of [
      { parentRunId: task.runId },
      { rootRunId: id(50) },
      { runId: id(50), parentRunId: id(50) },
    ]) {
      expect(
        RuntimeTaskRefSchema.safeParse({ ...task, ...patch }).success,
      ).toBe(false);
    }
  });

  it.each(['organizationId', 'workspaceId', 'projectId'] as const)(
    'does not accept a different trusted %s',
    (field) => {
      const scope = binding().task.scope;
      expect(matchesRuntimeScope(scope, scope)).toBe(true);
      expect(matchesRuntimeScope({ ...scope, [field]: id(90) }, scope)).toBe(
        false,
      );
    },
  );

  it('requires a Bridge device but does not confuse a directory label with a grant', () => {
    const execution = binding().execution;
    expect(
      RuntimeExecutionScopeSchema.safeParse({ ...execution, deviceId: null })
        .success,
    ).toBe(false);
    expect(
      RuntimeExecutionScopeSchema.safeParse({
        ...execution,
        targetKind: 'cloud_sandbox',
      }).success,
    ).toBe(false);
    expect(
      RuntimeExecutionScopeSchema.safeParse({
        ...execution,
        grantId: 'AI-what',
      }).success,
    ).toBe(false);
    expect(
      RuntimeExecutionScopeSchema.safeParse({
        ...execution,
        localPath: '/Users/example',
      }).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'rejects invalid attempt number %s',
    (attemptNumber) => {
      expect(
        RuntimeAttemptRefSchema.safeParse({
          ...binding().attempt,
          attemptNumber,
        }).success,
      ).toBe(false);
    },
  );

  it('requires exact content version and checksum instead of an unversioned filename', () => {
    expect(
      RuntimeContentRefSchema.safeParse({
        kind: 'deliverable_version',
        id: id(16),
      }).success,
    ).toBe(false);
    expect(
      RuntimeContentRefSchema.safeParse({ kind: 'path', path: 'report.xlsx' })
        .success,
    ).toBe(false);
    expect(
      RuntimeContentRefSchema.safeParse({
        kind: 'artifact',
        id: id(16),
        checksum: 'not-a-digest',
      }).success,
    ).toBe(false);
  });

  it('accepts command constraint digests, not raw environment or shell strings', () => {
    const command = {
      executableDigest: digest,
      argumentsDigest: digest,
      workingDirectoryDigest: digest,
      effectiveEnvironmentDigest: digest,
      networkPolicyDigest: digest,
      toolchainDigest: digest,
      budgetDigest: digest,
    };
    expect(
      RuntimeActionBindingSchema.parse({ ...binding(), command }).command,
    ).toEqual(command);
    expect(
      RuntimeActionBindingSchema.safeParse({
        ...binding(),
        command: { ...command, shell: 'pnpm test' },
      }).success,
    ).toBe(false);
    expect(
      RuntimeActionBindingSchema.safeParse({
        ...binding(),
        command: { ...command, env: { SECRET: 'synthetic' } },
      }).success,
    ).toBe(false);
  });

  it('compares parsed contract values independently of key order but not array/content changes', () => {
    const original = binding();
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    expect(runtimeContractEqual(original, reordered)).toBe(true);
    expect(
      runtimeContractEqual(original, { ...original, inputDigest: otherDigest }),
    ).toBe(false);
    expect(runtimeContractEqual([id(1), id(2)], [id(2), id(1)])).toBe(false);
  });
});

describe('P01 attempt lifecycle (P00 A05/A07)', () => {
  // Intentionally independent expected matrix, covering every possible pair.
  const expected: Record<
    RuntimeOperationStatus,
    readonly RuntimeOperationStatus[]
  > = {
    planned: [
      'waiting_user',
      'waiting_device',
      'waiting_dependency',
      'ready',
      'cancel_requested',
    ],
    waiting_user: [
      'waiting_device',
      'waiting_dependency',
      'ready',
      'cancel_requested',
    ],
    waiting_device: [
      'waiting_user',
      'waiting_dependency',
      'ready',
      'cancel_requested',
    ],
    waiting_dependency: [
      'waiting_user',
      'waiting_device',
      'ready',
      'cancel_requested',
    ],
    ready: [
      'waiting_user',
      'waiting_device',
      'waiting_dependency',
      'dispatched',
      'cancel_requested',
    ],
    dispatched: [
      'running',
      'unknown',
      'cancel_requested',
      'succeeded',
      'failed',
      'partial',
    ],
    running: ['unknown', 'cancel_requested', 'succeeded', 'failed', 'partial'],
    cancel_requested: ['unknown', 'succeeded', 'failed', 'partial', 'canceled'],
    unknown: ['succeeded', 'failed', 'partial', 'canceled'],
    succeeded: [],
    failed: [],
    canceled: [],
    partial: [],
  };
  it.each(
    RuntimeOperationStatusSchema.options.flatMap((from) =>
      RuntimeOperationStatusSchema.options.map((to) => [from, to] as const),
    ),
  )('%s -> %s follows the explicit transition table', (from, to) => {
    expect(canTransitionRuntimeOperation(from, to)).toBe(
      expected[from].includes(to),
    );
  });

  it('cancel acceptance and transport ACK do not claim that the process stopped', () => {
    const result = replayRuntimeOperationEvents(snapshot(), [
      ...startup(),
      event(3, { type: 'operation.cancel_requested', requestId: id(25) }),
      event(4, { type: 'operation.transport_ack' }),
    ]);
    expect(result.blocked).toBeNull();
    expect(result.snapshot).toMatchObject({
      status: 'cancel_requested',
      result: null,
      processId: id(20),
    });
  });

  it('requires stopped evidence and records partial effects instead of a clean cancel', () => {
    const prefix = [
      ...startup(),
      event(3, { type: 'operation.cancel_requested', requestId: id(25) }),
    ];
    const canceled = replayRuntimeOperationEvents(snapshot(), [
      ...prefix,
      event(4, { type: 'operation.stopped', evidence, effects: 'none' }),
    ]);
    const partial = replayRuntimeOperationEvents(snapshot(), [
      ...prefix,
      event(4, { type: 'operation.stopped', evidence, effects: 'partial' }),
    ]);
    expect(canceled.snapshot.status).toBe('canceled');
    expect(partial.snapshot).toMatchObject({
      status: 'partial',
      result: { effects: 'partial', evidence },
    });
    expect(
      RuntimeOperationResultSchema.safeParse({
        status: 'canceled',
        effects: 'partial',
        evidence,
      }).success,
    ).toBe(false);
  });

  it('reconciles a completion racing cancellation, rather than reporting canceled', () => {
    const result = replayRuntimeOperationEvents(snapshot(), [
      ...startup(),
      event(3, { type: 'operation.cancel_requested', requestId: id(25) }),
      event(4, outcome()),
    ]);
    expect(result.snapshot.status).toBe('succeeded');
  });

  it('preserves cancellation when a same-attempt startup receipt arrives late', () => {
    const initial = snapshot();
    const prefix = [
      ...startup().slice(0, 2),
      event(2, { type: 'operation.cancel_requested', requestId: id(25) }),
      event(3, { type: 'operation.started', processId: id(20) }),
    ];
    expect(replayRuntimeOperationEvents(initial, prefix)).toMatchObject({
      blocked: null,
      snapshot: {
        status: 'cancel_requested',
        cancelRequestId: id(25),
        processId: id(20),
      },
    });
    expect(
      replayRuntimeOperationEvents(initial, [
        ...prefix,
        event(4, { type: 'operation.stopped', evidence, effects: 'none' }),
      ]),
    ).toMatchObject({
      blocked: null,
      snapshot: { status: 'canceled', cancelRequestId: id(25) },
    });
  });

  it('records cancellation while offline without clearing unknown effects', () => {
    const initial = snapshot();
    const prefix = [
      ...startup(),
      event(3, { type: 'operation.uncertain', reason: 'connection_lost' }),
      event(4, { type: 'operation.cancel_requested', requestId: id(25) }),
      event(5, { type: 'operation.transport_ack' }),
    ];
    expect(replayRuntimeOperationEvents(initial, prefix)).toMatchObject({
      blocked: null,
      snapshot: { status: 'unknown', result: null, cancelRequestId: id(25) },
    });
    expect(
      replayRuntimeOperationEvents(initial, [
        ...prefix,
        event(6, { type: 'operation.stopped', evidence, effects: 'partial' }),
      ]),
    ).toMatchObject({ blocked: null, snapshot: { status: 'partial' } });
  });

  it('absorbs repeated uncertain/start/cancel facts while preserving the final evidence path', () => {
    const result = replayRuntimeOperationEvents(snapshot(), [
      ...startup(),
      event(3, { type: 'operation.started', processId: id(20) }),
      event(4, { type: 'operation.cancel_requested', requestId: id(25) }),
      event(5, { type: 'operation.cancel_requested', requestId: id(26) }),
      event(6, { type: 'operation.uncertain', reason: 'connection_lost' }),
      event(7, { type: 'operation.uncertain', reason: 'lease_lost' }),
      event(8, { type: 'operation.started', processId: id(20) }),
      event(9, outcome()),
    ]);
    expect(result).toMatchObject({
      blocked: null,
      applied: 10,
      snapshot: { status: 'succeeded', cancelRequestId: id(25) },
    });
  });

  it('never silently changes process identity within an attempt', () => {
    const result = replayRuntimeOperationEvents(snapshot(), [
      ...startup(),
      event(3, { type: 'operation.cancel_requested', requestId: id(25) }),
      event(4, { type: 'operation.started', processId: id(21) }),
    ]);
    expect(result).toMatchObject({
      blocked: { reason: 'illegal_transition' },
      snapshot: { status: 'cancel_requested', processId: id(20) },
    });
  });

  it('keeps missing receipts unknown; no lease-expired requeue or automatic cloud fallback', () => {
    const initial = snapshot();
    const unknown = replayRuntimeOperationEvents(initial, [
      ...startup(),
      event(3, { type: 'operation.uncertain', reason: 'lease_lost' }),
    ]);
    expect(unknown.snapshot).toMatchObject({
      status: 'unknown',
      result: null,
      binding: initial.binding,
    });
    expect(() =>
      advanceRuntimeOperation(unknown.snapshot, { type: 'operation.ready' }),
    ).toThrow('illegal operation transition');
    expect(
      replayRuntimeOperationEvents(initial, [
        ...startup(),
        event(3, { type: 'operation.uncertain', reason: 'receipt_missing' }),
        event(4, outcome()),
      ]).snapshot.status,
    ).toBe('succeeded');
    expect(initial.status).toBe('planned');
  });

  it('rejects terminal state without evidence and preserves unknown instead of filling a result', () => {
    expect(
      RuntimeOperationSnapshotSchema.safeParse({
        ...snapshot(),
        status: 'succeeded',
      }).success,
    ).toBe(false);
    expect(
      RuntimeOperationSnapshotSchema.safeParse({
        ...snapshot(),
        status: 'unknown',
      }).success,
    ).toBe(true);
    expect(
      RuntimeOperationSnapshotSchema.safeParse({
        ...snapshot(),
        status: 'failed',
        result: { status: 'succeeded', effects: 'none', evidence },
      }).success,
    ).toBe(false);
  });
});

describe('P01 ordered operation evidence, not a new transport/ledger (P00 A05/A07)', () => {
  it('replays exact duplicates once, including a redelivery after completion', () => {
    const finish = event(3, outcome());
    const input = [...startup(), finish, startup()[0], finish];
    const result = replayRuntimeOperationEvents(snapshot(), input);
    expect(result).toMatchObject({
      blocked: null,
      applied: 4,
      duplicates: 2,
      nextSequence: 4,
      snapshot: { status: 'succeeded' },
    });
    expect(replayRuntimeOperationEvents(snapshot(), input)).toEqual(result);
  });

  it('rejects identical event IDs with changed contents, even after completion', () => {
    const finish = event(3, outcome());
    const result = replayRuntimeOperationEvents(snapshot(), [
      ...startup(),
      finish,
      { ...finish, occurredAt: '2026-09-07T10:00:01.000Z' },
    ]);
    expect(result.blocked?.reason).toBe('event_id_conflict');
    expect(result.applied).toBe(4);
  });

  it('rejects two event IDs claiming the same durable sequence', () => {
    const first = startup()[0]!;
    expect(
      replayRuntimeOperationEvents(snapshot(), [
        first,
        { ...first, eventId: id(999) },
      ]).blocked?.reason,
    ).toBe('sequence_conflict');
  });

  it('blocks at gaps and out-of-order evidence instead of sorting or skipping', () => {
    const events = startup();
    const gap = replayRuntimeOperationEvents(snapshot(), [
      events[0],
      events[2],
      events[1],
    ]);
    expect(gap).toMatchObject({
      applied: 1,
      nextSequence: 1,
      blocked: { index: 1, reason: 'sequence_gap' },
      snapshot: { status: 'ready' },
    });
    expect(replayRuntimeOperationEvents(snapshot(), events).blocked).toBeNull();
  });

  it.each(['organizationId', 'workspaceId', 'projectId'] as const)(
    'does not advance on a foreign %s event',
    (field) => {
      const first = startup()[0]!;
      first.task.scope[field] = id(999);
      expect(replayRuntimeOperationEvents(snapshot(), [first])).toMatchObject({
        applied: 0,
        blocked: { reason: 'task_mismatch' },
      });
    },
  );

  it.each(['attemptId', 'attemptNumber', 'generation', 'fence'] as const)(
    'fences an event with a different %s without discarding evidence in a fake retry',
    (field) => {
      const first = startup()[0]!;
      const next = {
        ...first,
        attempt: {
          ...first.attempt,
          [field]: field === 'attemptId' ? id(999) : 2,
        },
      };
      expect(replayRuntimeOperationEvents(snapshot(), [next])).toMatchObject({
        applied: 0,
        blocked: { reason: 'attempt_mismatch' },
      });
    },
  );

  it('separates a foreign operation, a changed frozen Run configuration and execution target', () => {
    const first = startup()[0]!;
    expect(
      replayRuntimeOperationEvents(snapshot(), [
        { ...first, attempt: { ...first.attempt, operationId: id(999) } },
      ]).blocked?.reason,
    ).toBe('operation_mismatch');
    expect(
      replayRuntimeOperationEvents(snapshot(), [
        {
          ...first,
          task: {
            ...first.task,
            frozenConfiguration: {
              employeeVersionId: id(5),
              digest: otherDigest,
            },
          },
        },
      ]).blocked?.reason,
    ).toBe('task_mismatch');
    expect(
      replayRuntimeOperationEvents(snapshot(), [
        { ...first, execution: { ...first.execution, targetId: id(999) } },
      ]).blocked?.reason,
    ).toBe('execution_scope_mismatch');
  });

  it.each([
    [{ contractVersion: 2 }, 'unsupported_version'],
    [
      { signal: { type: 'operation.new_power', allowed: true } },
      'unsupported_type',
    ],
    [{ signal: { type: 'operation.ready', allowed: true } }, 'invalid_event'],
    [{ signal: { type: 'operation.stopped' } }, 'invalid_event'],
    [{ sequence: 1.2 }, 'invalid_event'],
    [{ family: 'legacy' }, 'invalid_event'],
  ] as const)(
    'does not promote unknown or malformed events: %j',
    (patch, reason) => {
      const value = { ...startup()[0], ...patch };
      expect(decodeRuntimeOperationEvent(value)).toEqual({ ok: false, reason });
      expect(replayRuntimeOperationEvents(snapshot(), [value])).toMatchObject({
        applied: 0,
        blocked: { reason },
      });
    },
  );

  it('does not append a new execution after terminal operation evidence', () => {
    const result = replayRuntimeOperationEvents(snapshot(), [
      ...startup(),
      event(3, outcome()),
      event(4, { type: 'operation.started', processId: id(20) }),
    ]);
    expect(result).toMatchObject({
      snapshot: { status: 'succeeded' },
      blocked: { reason: 'illegal_transition' },
    });
  });

  it('requires a fresh initial projection and bounds a single validation pass', () => {
    expect(
      replayRuntimeOperationEvents({ ...snapshot(), status: 'ready' }, [])
        .blocked?.reason,
    ).toBe('invalid_initial_state');
    expect(
      replayRuntimeOperationEvents(
        snapshot(),
        Array.from({ length: 10_001 }, () => null),
      ).blocked?.reason,
    ).toBe('replay_limit');
  });
});
