import { describe, expect, it } from 'vitest';
import {
  nativeOnceDigest,
  nativeOnceReady,
  validNativeOnceDispatch,
  nativeOnceWriterRemaining,
  planNativeOnceAcquire,
  planNativeOnceRenew,
  planNativeOnceClosed,
  prepareNativeOnceMutation,
  verifyExactNativeOnceCommit,
  type NativeOnceWriterRow,
  type NativeOnceWriter,
  type NativeOnceControl,
  type NativeOnceTask,
  type NativeOnceWrite,
  type NativeOnceMutation,
  type NativeOnceAdmissionFacts,
  type NativeOnceCommitEvidence,
} from './native-schedule-once-state.ts';

const at = '2030-01-01T00:00:00.000Z',
  now = Date.parse(at) + 1000;
const ready = {
  enabled: true,
  storageReady: true,
  legacyClockExcluded: true,
  controlArtifactApproved: true,
};
const reference = {
  artifactId: `sha256:${'a'.repeat(64)}`,
  profileId: 'approved-control-profile',
  storageId: 'owned-storage',
  stateRoot: '/owned/control-root',
};
const writer: NativeOnceWriter = {
  partitionId: 'partition-a',
  ownerId: 'worker-a',
  epoch: 1,
  token: 'private-writer-token-do-not-persist',
};
function lease(): NativeOnceWriterRow {
  return {
    partitionId: writer.partitionId,
    ownerId: writer.ownerId,
    epoch: writer.epoch,
    tokenDigest: nativeOnceDigest(writer.token),
    expiresAtMs: now + 30_000,
    closed: false,
    reference,
  };
}
function control(): NativeOnceControl {
  return {
    partitionId: writer.partitionId,
    controlId: 'control-a',
    organizationId: 'org-a',
    workspaceId: 'workspace-a',
    ownerId: 'resource-owner-a',
    automationId: 'plan-a',
    revision: 1,
    controlSessionId: 'native-control-session-a',
    at,
    sessionState: 'ready',
    nativeTaskId: null,
    taskDeleted: false,
    command: { id: 'command-a', kind: 'create', status: 'pending' },
    dispatch: {
      occurrenceId: 'occurrence-a',
      employeeAssignmentId: 'assignment-a',
      employeeInstanceId: 'instance-a',
      businessSessionId: 'business-session-a',
      clientMessageId: 'stable-message-a',
      reservationDigest: nativeOnceDigest({ configuration: 'frozen' }),
    },
  };
}
function task(delivered = false): NativeOnceTask {
  const receipt = {
    scheduledAt: at,
    deliveredAt: new Date(now).toISOString(),
    messageId: 'native-inbox-message-a',
  };
  return {
    sessionId: 'native-control-session-a',
    record: {
      id: 'native-task-a',
      kind: 'at',
      title: 'AllRice once control',
      prompt: 'Synthetic schedule control only. Never execute business work.',
      scheduledAt: at,
    },
    status: delivered ? 'inactive' : 'active',
    ...(delivered
      ? {
          lastDelivery: receipt,
          deliveryHistory: {
            records: [
              {
                ...receipt,
                prompt:
                  'Synthetic schedule control only. Never execute business work.',
              },
            ],
            earlierRecordsUnavailable: false,
          },
        }
      : {}),
  };
}
function admission(): NativeOnceAdmissionFacts {
  return {
    checkedAtMs: now,
    organizationId: 'org-a',
    workspaceId: 'workspace-a',
    ownerId: 'resource-owner-a',
    automationId: 'plan-a',
    currentRevision: 1,
    employeeAssignmentId: 'assignment-a',
    employeeInstanceId: 'instance-a',
    businessSessionId: 'business-session-a',
    reservationDigest: nativeOnceDigest({ configuration: 'frozen' }),
    planStatus: 'enabled',
    currentWritableIdentity: true,
    cloudEnabled: true,
    assignmentActive: true,
    instanceActive: true,
    businessSessionAvailable: true,
    legacyClockExcluded: true,
  };
}
function write(mutation: NativeOnceMutation): NativeOnceWrite {
  return { writeId: 'write-a', digest: nativeOnceDigest(mutation), mutation };
}
// Represents a caller that has already used the approved public Schedule
// schema. These tests cover DB decision logic, not the native package parser.
const decodeTask = (v: unknown) => structuredClone(v) as NativeOnceTask;
function prepare(
  mutation: NativeOnceMutation = {
    kind: 'put_task',
    controlId: 'control-a',
    task: task(true),
  },
  overrides: Partial<Parameters<typeof prepareNativeOnceMutation>[0]> = {},
) {
  return prepareNativeOnceMutation({
    readiness: ready,
    writerRow: lease(),
    writer,
    dbNowMs: now,
    before: { control: control(), task: null },
    write: write(mutation),
    decodeTask,
    admission: admission(),
    ...overrides,
  });
}
function evidence(
  prepared: ReturnType<typeof prepare>,
): Extract<NativeOnceCommitEvidence, { kind: 'found' }> {
  return {
    kind: 'found',
    journal: structuredClone(prepared.journal),
    committedSnapshot: structuredClone(prepared.after),
    immutableControl: structuredClone(prepared.after.control),
    reference: structuredClone(reference),
    occurrence: structuredClone(prepared.occurrence),
  };
}

describe('native once DB decisions remain default closed', () => {
  it.each([
    undefined,
    {},
    { enabled: true },
    { ...ready, storageReady: false },
    { ...ready, legacyClockExcluded: false },
    { ...ready, controlArtifactApproved: false },
  ])(
    'does not grant a writer before every mainline gate is ready %j',
    (readiness) => {
      expect(nativeOnceReady(readiness)).toBe(false);
      expect(
        planNativeOnceAcquire({
          readiness,
          row: { ...lease(), closed: true },
          ownerId: 'worker-b',
          token: 'token-b',
          expectedReference: reference,
          dbNowMs: now,
          ttlMs: 30_000,
        }),
      ).toBeNull();
    },
  );
  it('does not take over an expired but not closed native writer', () => {
    const row = { ...lease(), expiresAtMs: now - 1 };
    expect(
      planNativeOnceAcquire({
        readiness: ready,
        row,
        ownerId: 'worker-b',
        token: 'token-b',
        expectedReference: reference,
        dbNowMs: now,
        ttlMs: 30_000,
      }),
    ).toBeNull();
  });
  it('increments the epoch only after closed-owner proof and never stores its raw token', () => {
    const acquired = planNativeOnceAcquire({
      readiness: ready,
      row: { ...lease(), closed: true },
      ownerId: 'worker-b',
      token: 'new-private-token',
      expectedReference: reference,
      dbNowMs: now,
      ttlMs: 30_000,
    })!;
    expect(acquired.writer.epoch).toBe(2);
    expect(acquired.remainingMs).toBe(30_000);
    expect(JSON.stringify(acquired.row)).not.toContain('new-private-token');
    expect(nativeOnceWriterRemaining(acquired.row, writer, now)).toBe(0);
    expect(planNativeOnceClosed(acquired.row, writer)).toBeNull();
  });
  it.each([0, -1, 300_001, NaN, Infinity])(
    'rejects invalid TTL %s',
    (ttlMs) => {
      expect(() =>
        planNativeOnceAcquire({
          readiness: ready,
          row: { ...lease(), closed: true },
          ownerId: 'worker-b',
          token: 'token-b',
          expectedReference: reference,
          dbNowMs: now,
          ttlMs,
        }),
      ).toThrow('writer_invalid');
    },
  );
  it('refuses an artifact/profile/storage/root substitution', () => {
    expect(() =>
      planNativeOnceAcquire({
        readiness: ready,
        row: { ...lease(), closed: true },
        ownerId: 'worker-b',
        token: 'token-b',
        expectedReference: { ...reference, stateRoot: '/fresh-empty-root' },
        dbNowMs: now,
        ttlMs: 30_000,
      }),
    ).toThrow('reference_changed');
  });
  it.each([
    { epoch: 2 },
    { token: 'wrong-token' },
    { ownerId: 'worker-b' },
    { partitionId: 'partition-b' },
  ])('cannot renew or close a different fence %j', (change) => {
    expect(
      planNativeOnceRenew(lease(), { ...writer, ...change }, now, 30_000),
    ).toBeNull();
    expect(planNativeOnceClosed(lease(), { ...writer, ...change })).toBeNull();
  });
  it('cannot renew at expiry but may record the expired owner closed after drain', () => {
    const row = { ...lease(), expiresAtMs: now };
    expect(nativeOnceWriterRemaining(row, writer, now)).toBe(0);
    expect(planNativeOnceRenew(row, writer, now, 30_000)).toBeNull();
    expect(planNativeOnceClosed(row, writer)?.closed).toBe(true);
  });
});

describe('native once mutations require a single locked transaction', () => {
  it('produces an atomic task/receipt/occurrence/outbox/journal plan without mutating inputs', () => {
    const before = { control: control(), task: null },
      original = structuredClone(before);
    const result = prepare(undefined, { before });
    expect(before).toEqual(original);
    expect(result.after.control.nativeTaskId).toBe('native-task-a');
    expect(result.after.task).toEqual(task(true));
    expect(result.occurrence?.outbox).toMatchObject({
      state: 'pending',
      occurrenceId: 'occurrence-a',
    });
    expect(result.occurrence?.payload.receipt).toEqual(task(true).lastDelivery);
    expect(result.occurrence?.payload.control.dispatch.businessSessionId).toBe(
      'business-session-a',
    );
    expect(result.occurrence?.payload.control.controlSessionId).not.toBe(
      'business-session-a',
    );
    expect(JSON.stringify(result.journal)).not.toContain(writer.token);
  });
  it('distinguishes native once consumed/inactive from user pause', () => {
    expect((prepare().after.task as NativeOnceTask).status).toBe('inactive');
    expect(prepare().occurrence?.outbox.state).toBe('pending');
    expect(
      prepare(undefined, {
        admission: { ...admission(), planStatus: 'paused' },
      }).occurrence?.outbox,
    ).toMatchObject({ state: 'blocked', reason: 'plan_inactive' });
  });
  it.each([
    [undefined, 'authority_unavailable'],
    [{ ...admission(), checkedAtMs: now - 1 }, 'authority_unavailable'],
    [{ ...admission(), currentRevision: 2 }, 'revision_changed'],
    [
      { ...admission(), employeeAssignmentId: 'other-active-assignment' },
      'binding_changed',
    ],
    [
      { ...admission(), employeeInstanceId: 'other-active-instance' },
      'binding_changed',
    ],
    [
      { ...admission(), businessSessionId: 'other-active-session' },
      'binding_changed',
    ],
    [
      {
        ...admission(),
        reservationDigest: nativeOnceDigest({ configuration: 'changed' }),
      },
      'reservation_changed',
    ],
    [{ ...admission(), planStatus: 'deleted' }, 'plan_inactive'],
    [
      { ...admission(), currentWritableIdentity: false },
      'current_access_denied',
    ],
    [{ ...admission(), assignmentActive: false }, 'current_access_denied'],
    [{ ...admission(), instanceActive: false }, 'current_access_denied'],
    [
      { ...admission(), businessSessionAvailable: false },
      'current_access_denied',
    ],
    [{ ...admission(), cloudEnabled: false }, 'cloud_disabled'],
    [
      { ...admission(), legacyClockExcluded: false },
      'legacy_clock_not_excluded',
    ],
  ] as const)(
    'records an exact historical receipt with blocked outbox for current authority loss (%s)',
    (facts, reason) => {
      const result = prepare(undefined, { admission: facts });
      expect(result.after.task).toEqual(task(true));
      expect(result.occurrence?.outbox).toMatchObject({
        state: 'blocked',
        reason,
      });
    },
  );
  it('does not accept another tenant owner as current authority', () => {
    expect(() =>
      prepare(undefined, {
        admission: { ...admission(), ownerId: 'foreign-owner' },
      }),
    ).toThrow('scope_mismatch');
  });
  it('rejects a mutation at DB expiry and never treats local time as a lease', () => {
    expect(() =>
      prepare(undefined, { writerRow: { ...lease(), expiresAtMs: now } }),
    ).toThrow('lease_lost');
  });
  it('requires the full request digest, not just writeId', () => {
    const mutation: NativeOnceMutation = {
      kind: 'put_task',
      controlId: 'control-a',
      task: task(true),
    };
    expect(() =>
      prepare(mutation, {
        write: {
          ...write(mutation),
          digest: nativeOnceDigest({ unrelated: true }),
        },
      }),
    ).toThrow('write_invalid');
  });
  it.each([
    { sessionId: 'foreign-control-session' },
    { record: { ...task().record, id: 'foreign-native-task' } },
    { record: { ...task().record, kind: 'every' } },
    {
      record: {
        ...task().record,
        prompt: 'Business work must not run in control Host',
      },
    },
    { record: { ...task().record, scheduledAt: '2030-01-02T00:00:00.000Z' } },
  ])('rejects a task identity/rule substitution %j', (change) => {
    const c = { ...control(), nativeTaskId: 'native-task-a' };
    expect(() =>
      prepare(
        {
          kind: 'put_task',
          controlId: c.controlId,
          task: { ...task(), ...change },
        },
        { before: { control: c, task: task() } },
      ),
    ).toThrow('task_invalid');
  });
  it('never drops or changes a previously stored delivery', () => {
    const c = { ...control(), nativeTaskId: 'native-task-a' };
    expect(() =>
      prepare(
        { kind: 'put_task', controlId: c.controlId, task: task() },
        { before: { control: c, task: task(true) } },
      ),
    ).toThrow('receipt_rewind');
  });
  it('reuses only an exact occurrence and never resets a later enqueued outbox', () => {
    const original = prepare().occurrence!;
    const progressed = {
      ...original,
      outbox: { ...original.outbox, state: 'enqueued' as const },
    };
    expect(
      prepare(undefined, { existingOccurrence: progressed }).occurrence,
    ).toEqual(progressed);
    const conflicting = {
      ...original,
      payload: {
        ...original.payload,
        receipt: {
          ...original.payload.receipt,
          messageId: 'different-native-inbox-message',
        },
      },
    };
    expect(() =>
      prepare(undefined, { existingOccurrence: conflicting }),
    ).toThrow('occurrence_conflict');
  });
  it('keeps revision in the occurrence key at the same target instant', () => {
    const first = prepare().occurrence!;
    const c = control();
    c.revision = 2;
    c.dispatch.occurrenceId = 'occurrence-b';
    const second = prepare(undefined, {
      before: { control: c, task: null },
      admission: { ...admission(), currentRevision: 2 },
    }).occurrence!;
    expect(first.key).not.toBe(second.key);
  });
  it('requires initializing before ready and does not regress command CAS', () => {
    const c = control();
    c.sessionState = 'reserved';
    expect(() =>
      prepare(
        { kind: 'session_ready', controlId: c.controlId },
        { before: { control: c, task: null } },
      ),
    ).toThrow('session_cas');
    const init = prepare(
      { kind: 'session_initializing', controlId: c.controlId },
      { before: { control: c, task: null } },
    );
    expect(
      prepare(
        { kind: 'session_ready', controlId: c.controlId },
        { before: init.after },
      ).after.control.sessionState,
    ).toBe('ready');
    const bound = prepare({
      kind: 'put_task',
      controlId: c.controlId,
      task: task(),
    });
    expect(() =>
      prepare(
        {
          kind: 'confirm_command',
          controlId: c.controlId,
          commandId: 'stale-command',
          nativeTaskId: 'native-task-a',
        },
        { before: bound.after },
      ),
    ).toThrow('command_cas');
  });
  it('deletes task bytes only while retaining original mapping/tombstone', () => {
    const bound = prepare({
      kind: 'put_task',
      controlId: 'control-a',
      task: task(),
    });
    bound.after.control.command = {
      id: 'delete-command',
      kind: 'delete',
      status: 'pending',
    };
    const deleted = prepare(
      {
        kind: 'delete_task',
        controlId: 'control-a',
        nativeTaskId: 'native-task-a',
      },
      { before: bound.after },
    );
    expect(deleted.after.task).toBeNull();
    expect(deleted.after.control.taskDeleted).toBe(true);
    expect(deleted.after.control.nativeTaskId).toBe('native-task-a');
  });
});

describe('remaining control command and ACK boundaries', () => {
  it('rejects all mutations while the rollout is disabled', () => {
    expect(() => prepare(undefined, { readiness: undefined })).toThrow(
      'disabled',
    );
  });
  it('stores an active native task without inventing a delivery or occurrence', () => {
    const result = prepare({
      kind: 'put_task',
      controlId: 'control-a',
      task: task(),
    });
    expect(result.after.task).toEqual(task());
    expect(result.occurrence).toBeNull();
    expect(result.journal.receiptLink).toBeNull();
  });
  it('blocks a receipt that is not due according to the DB clock', () => {
    const earlier = now - 2_000;
    expect(
      prepare(undefined, {
        dbNowMs: earlier,
        admission: { ...admission(), checkedAtMs: earlier },
      }).occurrence?.outbox,
    ).toMatchObject({
      state: 'blocked',
      reason: 'target_not_due',
    });
  });
  it('requires the approved decoder to preserve the complete task JSON', () => {
    expect(() =>
      prepare(undefined, {
        decodeTask: (v) => {
          const parsed = structuredClone(v) as NativeOnceTask;
          delete parsed.deliveryHistory;
          return parsed;
        },
      }),
    ).toThrow('task_invalid');
  });
  it.each([
    'session_initializing',
    'session_ready',
    'confirm_create',
    'delete_task',
    'confirm_delete',
    'reject_command',
  ] as const)(
    'confirms only the exact committed control transition: %s',
    (kind) => {
      const c = control();
      let before: { control: NativeOnceControl; task: unknown | null } = {
        control: c,
        task: null,
      };
      let mutation: NativeOnceMutation;
      if (kind === 'session_initializing' || kind === 'session_ready') {
        c.sessionState =
          kind === 'session_initializing' ? 'reserved' : 'initializing';
        mutation = { kind, controlId: c.controlId };
      } else if (kind === 'reject_command') {
        mutation = {
          kind,
          controlId: c.controlId,
          commandId: c.command.id,
          reason: 'target_not_future',
        };
      } else {
        before = prepare({
          kind: 'put_task',
          controlId: c.controlId,
          task: task(),
        }).after;
        if (kind === 'confirm_create') {
          mutation = {
            kind: 'confirm_command',
            controlId: c.controlId,
            commandId: c.command.id,
            nativeTaskId: 'native-task-a',
          };
        } else {
          before.control.command = {
            id: 'delete-command',
            kind: 'delete',
            status: 'pending',
          };
          const deletion: NativeOnceMutation = {
            kind: 'delete_task',
            controlId: c.controlId,
            nativeTaskId: 'native-task-a',
          };
          if (kind === 'delete_task') mutation = deletion;
          else {
            before = prepare(deletion, { before }).after;
            mutation = {
              kind: 'confirm_command',
              controlId: c.controlId,
              commandId: 'delete-command',
              nativeTaskId: 'native-task-a',
            };
          }
        }
      }
      const result = prepare(mutation, { before });
      expect(result.occurrence).toBeNull();
      expect(
        verifyExactNativeOnceCommit(
          writer,
          result.journal.write,
          evidence(result),
        ),
      ).toBe('committed');
      const proof = evidence(result);
      proof.journal.write.writeId = 'not-the-original-write';
      expect(
        verifyExactNativeOnceCommit(writer, result.journal.write, proof),
      ).toBe('unknown');
      if (kind === 'reject_command')
        expect(result.after.control.command.status).toBe('blocked');
      else if (kind === 'confirm_create' || kind === 'confirm_delete') {
        expect(result.after.control.command.status).toBe('confirmed');
        expect(() => prepare(mutation, { before: result.after })).toThrow(
          'command_cas',
        );
      }
    },
  );
  it('does not ACK an unknown persisted mutation even with a matching digest', () => {
    const invalid = {
      kind: 'unknown_from_storage',
      controlId: 'control-a',
    } as unknown as NativeOnceMutation;
    const invalidWrite = write(invalid);
    const proof = evidence(prepare());
    proof.journal.write = invalidWrite;
    proof.journal.receiptLink = null;
    expect(() => prepare(invalid)).toThrow('write_invalid');
    expect(verifyExactNativeOnceCommit(writer, invalidWrite, proof)).toBe(
      'unknown',
    );
  });
});

describe('exact native write ACK is history, never renewed admission', () => {
  it('accepts an exact primary proof even after lease expiry; execution still has no fence', () => {
    const result = prepare(),
      proof = evidence(result);
    expect(
      verifyExactNativeOnceCommit(writer, result.journal.write, proof),
    ).toBe('committed');
    expect(
      nativeOnceWriterRemaining({ ...lease(), expiresAtMs: now }, writer, now),
    ).toBe(0);
    proof.occurrence!.outbox.state = 'enqueued';
    expect(
      verifyExactNativeOnceCommit(writer, result.journal.write, proof),
    ).toBe('committed');
  });
  it.each([
    'writeId',
    'digest',
    'mutation',
    'writer',
    'snapshot',
    'mapping',
    'reference',
    'occurrence',
    'outbox',
    'same-id-later-task',
  ] as const)('refuses an inexact proof: %s', (change) => {
    const result = prepare(),
      proof = evidence(result);
    if (change === 'writeId') proof.journal.write.writeId = 'another-write';
    if (change === 'digest')
      proof.journal.write.digest = nativeOnceDigest({ other: true });
    if (change === 'mutation')
      proof.journal.write.mutation = {
        kind: 'session_ready',
        controlId: 'control-a',
      };
    if (change === 'writer') proof.journal.writer.epoch++;
    if (change === 'snapshot')
      (proof.committedSnapshot.task as NativeOnceTask).lastDelivery!.messageId =
        'different-message';
    if (change === 'mapping') proof.immutableControl.ownerId = 'foreign-owner';
    if (change === 'reference') proof.reference.stateRoot = '/replacement-root';
    if (change === 'occurrence')
      proof.occurrence!.payload.receipt.messageId = 'different-message';
    if (change === 'outbox')
      proof.occurrence!.outbox.occurrenceId = 'another-occurrence';
    if (change === 'same-id-later-task') {
      const later = task(true);
      later.lastDelivery!.deliveredAt = '2030-01-01T00:00:05.000Z';
      proof.committedSnapshot.task = later;
      proof.journal.afterDigest = nativeOnceDigest(proof.committedSnapshot);
    }
    expect(
      verifyExactNativeOnceCommit(writer, result.journal.write, proof),
    ).toBe('unknown');
  });
  it('reports only an exact query absence; missing/failed read stays unknown', () => {
    const result = prepare(),
      w = result.journal.write;
    expect(verifyExactNativeOnceCommit(writer, w, { kind: 'unknown' })).toBe(
      'unknown',
    );
    expect(
      verifyExactNativeOnceCommit(writer, w, {
        kind: 'absent',
        partitionId: writer.partitionId,
        writeId: w.writeId,
      }),
    ).toBe('absent');
    expect(
      verifyExactNativeOnceCommit(writer, w, {
        kind: 'absent',
        partitionId: 'foreign',
        writeId: w.writeId,
      }),
    ).toBe('unknown');
  });
  it('bounds malformed JSON before canonical hashing', () => {
    for (const value of [
      NaN,
      undefined,
      {
        get privateValue() {
          throw Error('must not evaluate');
        },
      },
      { text: 'x'.repeat(70_000) },
    ])
      expect(() => nativeOnceDigest(value)).toThrow();
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => nativeOnceDigest(cycle)).toThrow('invalid_json');
  });
});

describe('brand reminder closed dispatch variant and rejected creation proof', () => {
  function brand() {
    const c = control();
    c.dispatch = {
      ...c.dispatch,
      consumer: 'brand-reminder-v1',
      reminderId: 'reminder-a',
      businessRevision: 1,
      plannedAt: at,
      businessOccurrenceId: 'original-occurrence',
      businessMessageId: 'original-message',
    };
    return c;
  }
  it('preserves ordinary reservations and rejects unknown or malformed business fields', () => {
    expect(validNativeOnceDispatch(control().dispatch)).toBe(true);
    const d = brand().dispatch;
    expect(validNativeOnceDispatch(d)).toBe(true);
    for (const patch of [
      { consumer: 'other' },
      { businessRevision: '1' },
      { businessRevision: 0 },
      { plannedAt: 'yesterday' },
      { businessMessageId: '' },
      { extra: true },
    ]) {
      expect(validNativeOnceDispatch({ ...d, ...patch } as typeof d)).toBe(
        false,
      );
    }
  });
  it('requires absence for a new brand rejection, but still reads old ordinary rejection journals', () => {
    const c = brand();
    const m: NativeOnceMutation = {
      kind: 'reject_command',
      controlId: c.controlId,
      commandId: c.command.id,
      reason: 'target_not_future',
    };
    expect(prepare(m).after.control.command.status).toBe('blocked');
    expect(() => prepare(m, { before: { control: c, task: null } })).toThrow(
      'command_cas',
    );
    const absence = {
      controlSessionId: c.controlSessionId,
      catalogDigest: nativeOnceDigest([]),
      observedAt: new Date(now).toISOString(),
      taskCount: 0 as const,
    };
    const accepted = prepare(
      { ...m, absence },
      { before: { control: c, task: null } },
    );
    expect(accepted.journal.write.mutation).toEqual({ ...m, absence });
    expect(() =>
      prepare(
        { ...m, absence: { ...absence, controlSessionId: 'another-session' } },
        { before: { control: c, task: null } },
      ),
    ).toThrow('command_cas');
    expect(() =>
      prepare(
        { ...m, absence: { ...absence, taskCount: 1 as 0 } },
        { before: { control: c, task: null } },
      ),
    ).toThrow('write_invalid');
  });
});
