import { describe, expect, it } from 'vitest';
import {
  NativeCalendarArmSchema,
  NativeCalendarControlSchema,
  NativeCalendarRevisionSchema,
  calendarArmRequestDigest,
  calendarControlIdentity,
  calendarWriterIdentity,
  prepareNativeCalendarTaskPut,
  type NativeCalendarArm,
  type NativeCalendarControl,
  type NativeCalendarPeriod,
  type NativeCalendarRevision,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import { NativeRecurringControlSchema } from './native-schedule-recurring-state.ts';
import {
  nativeOnceDigest,
  type NativeOnceTask,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const reference = {
  artifactId: `sha256:${'a'.repeat(64)}`,
  profileId: 'allrice-recurring-control-v1' as const,
  storageId: 'isolated-calendar-state',
  stateRoot: '/isolated/calendar-state',
};
const writer: NativeOnceWriter = {
  partitionId: 'allrice-recurring-v1',
  ownerId: 'host',
  epoch: 1,
  token: 'writer-token',
};
const readiness = {
  enabled: true,
  storageReady: true,
  legacyClockExcluded: true,
  controlArtifactApproved: true,
};
const P = '2027-01-31T02:00:00.000Z',
  A = '2027-03-01T02:00:00.000Z';
const c: NativeCalendarControl = {
  kind: 'calendar',
  binding: 'rotating-at-v1',
  partitionId: 'allrice-recurring-v1',
  controlId: id(1),
  organizationId: id(2),
  workspaceId: id(3),
  ownerId: id(4),
  automationId: id(5),
  revision: 1,
  controlSessionId: 'original-control-session',
  reference,
  sessionState: 'ready',
  nativeTaskId: null,
  dispatch: {
    consumer: 'experience-consolidation-v1',
    employeeAssignmentId: id(6),
    employeeInstanceId: id(7),
  },
};
const v: NativeCalendarRevision = {
  kind: 'calendar',
  binding: 'rotating-at-v1',
  consumer: 'experience-consolidation-v1',
  revision: 1,
  schedule: {
    frequency: 'monthly',
    monthDay: 31,
    time: '10:00',
    timezone: 'Asia/Shanghai',
  },
  ruleRevision: 1,
  policyRevision: 3,
  policyDigest: nativeOnceDigest('policy'),
  reservationDigest: nativeOnceDigest('reservation'),
  acceptedAt: '2027-01-01T00:00:00.000Z',
};
const p: NativeCalendarPeriod = {
  periodId: id(8),
  partitionId: c.partitionId,
  controlId: c.controlId,
  automationId: c.automationId,
  revision: 1,
  businessScheduledFor: P,
  currentArmId: id(9),
  state: 'prepared',
  version: 0,
};
function freshArm(patch: Partial<NativeCalendarArm> = {}): NativeCalendarArm {
  const a = {
    armId: id(9),
    periodId: p.periodId,
    attempt: 1,
    nativeAt: A,
    reason: 'future_recovery' as const,
    status: 'creating' as const,
    nativeTaskId: null,
    taskSnapshot: null,
    bindWriteId: null,
    lastWriteId: null,
    createWriter: calendarWriterIdentity(writer),
    absenceProof: null,
    snapshotVersion: 1,
    ...patch,
  };
  return {
    ...a,
    requestDigest: calendarArmRequestDigest(c, p, {
      armId: a.armId,
      periodId: a.periodId,
      attempt: a.attempt,
      nativeAt: a.nativeAt,
      reason: a.reason,
    }),
  };
}
function task(a = freshArm()): NativeOnceTask {
  return {
    sessionId: c.controlSessionId,
    status: 'active',
    record: {
      id: 'native-random-task',
      kind: 'at',
      title: 'AllRice once control',
      prompt: 'Synthetic schedule control only. Never execute business work.',
      scheduledAt: a.nativeAt,
    },
    deliveryHistory: { records: [], earlierRecordsUnavailable: false },
  };
}
const decodeTask = (x: unknown) => structuredClone(x) as NativeOnceTask;
type Input = Parameters<typeof prepareNativeCalendarTaskPut>[0];
function prepare(patch: Partial<Input> = {}) {
  const a = patch.arm ?? freshArm(),
    pp = patch.period ?? p;
  const mutation = {
    kind: 'calendar' as const,
    action: 'put_task' as const,
    controlId: c.controlId,
    periodId: pp.periodId,
    armId: a.armId,
    requestDigest: a.requestDigest,
    expectedPeriodVersion: pp.version,
    expectedArmVersion: a.snapshotVersion,
    task: task(a),
  };
  const write: NativeCalendarWrite = {
    writeId: 'bind-write',
    digest: nativeOnceDigest(mutation),
    mutation,
  };
  return prepareNativeCalendarTaskPut({
    readiness,
    reference,
    writer,
    writerRow: {
      ...calendarWriterIdentity(writer),
      reference,
      expiresAtMs: Date.parse(A) + 30_000,
      closed: false,
    },
    dbNowMs: Date.parse(A) + 1_000,
    control: c,
    period: pp,
    arm: a,
    revision: v,
    write,
    decodeTask,
    admission: {
      allowed: true,
      currentRevision: 1,
      policyRevision: v.policyRevision,
      policyDigest: v.policyDigest,
      status: 'enabled',
      resumeAfter: null,
    },
    ...patch,
  });
}
function withTask(value: NativeOnceTask, patch: Partial<Input> = {}) {
  const a = patch.arm ?? freshArm(),
    pp = patch.period ?? p;
  const mutation = {
    kind: 'calendar' as const,
    action: 'put_task' as const,
    controlId: c.controlId,
    periodId: pp.periodId,
    armId: a.armId,
    requestDigest: a.requestDigest,
    expectedPeriodVersion: pp.version,
    expectedArmVersion: a.snapshotVersion,
    task: value,
  };
  return prepare({
    ...patch,
    write: {
      writeId: 'receipt-write',
      digest: nativeOnceDigest(mutation),
      mutation,
    },
  });
}
function delivered(value = task()): NativeOnceTask {
  const t = structuredClone(value);
  t.status = 'inactive';
  t.lastDelivery = {
    scheduledAt: t.record.scheduledAt,
    deliveredAt: '2027-03-01T02:00:02.000Z',
    messageId: 'native-inbox-original',
  };
  t.deliveryHistory = {
    records: [{ ...t.lastDelivery, prompt: t.record.prompt }],
    earlierRecordsUnavailable: false,
  };
  return t;
}

describe('independent calendar identity and rotating at binding', () => {
  it('keeps monthly out of the fixed control and fixes the calendar parent to null Task', () => {
    expect(NativeCalendarControlSchema.parse(c)).toEqual(c);
    expect(NativeRecurringControlSchema.safeParse(c).success).toBe(false);
    expect(
      NativeCalendarControlSchema.safeParse({
        ...c,
        nativeTaskId: 'period-task',
      }).success,
    ).toBe(false);
    expect(
      NativeCalendarControlSchema.safeParse({ ...c, rule: { kind: 'daily' } })
        .success,
    ).toBe(false);
    expect(NativeCalendarRevisionSchema.parse(v).schedule).toEqual(v.schedule);
    expect(
      NativeCalendarRevisionSchema.safeParse({
        ...v,
        schedule: { frequency: 'once', runAt: A },
      }).success,
    ).toBe(false);
  });
  it('binds an already sampled future native A even if the KV put is later than A', () => {
    const result = prepare();
    expect(result.after).toEqual({ control: c, task: null });
    expect(result.period).toMatchObject({
      state: 'bound',
      businessScheduledFor: P,
      version: 1,
    });
    expect(result.arm).toMatchObject({
      status: 'bound',
      nativeTaskId: 'native-random-task',
      bindWriteId: 'bind-write',
      nativeAt: A,
      snapshotVersion: 2,
    });
    expect(result.occurrences).toEqual([]);
    expect(result.journal.identity).toEqual(calendarControlIdentity(c));
    expect(result.journal.calendarLinks[0]?.taskDigest).toBe(
      nativeOnceDigest(task()),
    );
    expect(JSON.stringify(result.journal)).not.toContain(writer.token);
  });
  it.each(['prepared', 'absent'] as const)(
    'does not bind before a unique create authorization: %s',
    (status) => {
      const a = freshArm({
        status,
        createWriter: null,
        absenceProof:
          status === 'absent'
            ? { kind: 'never_started', taskSetDigest: nativeOnceDigest({}) }
            : null,
      });
      expect(() => prepare({ arm: a })).toThrow('create_not_started');
    },
  );
  it('does not accept a Task from an earlier generation into a new unbound arm', () => {
    expect(() =>
      prepare({
        arm: freshArm({
          createWriter: { ...calendarWriterIdentity(writer), epoch: 2 },
        }),
      }),
    ).toThrow('initial_receipt_fabricated');
  });
  it.each([{ sessionId: 'replacement-session' }, { status: 'inactive' }])(
    'rejects a changed Session/status %j',
    (change) => {
      expect(() => withTask({ ...task(), ...change })).toThrow('task_invalid');
    },
  );
  it.each([
    { kind: 'monthly' },
    { kind: 'daily' },
    { scheduledAt: P },
    { title: 'Business work' },
    { prompt: 'Run business work' },
    { id: '' },
  ])('rejects an incompatible full native record %j', (change) => {
    const t = task();
    Object.assign(t.record, change);
    expect(() => withTask(t)).toThrow('task_invalid');
  });
  it('does not accept a decoder that discards retained native fields', () => {
    expect(() =>
      prepare({
        decodeTask: (x) => {
          const t = decodeTask(x);
          delete t.deliveryHistory;
          return t;
        },
      }),
    ).toThrow('task_invalid');
  });
  it('cannot fabricate a first receipt before the Task was bound', () => {
    expect(() => withTask(delivered())).toThrow('initial_receipt_fabricated');
  });
  it.each([
    'enabled',
    'storageReady',
    'legacyClockExcluded',
    'controlArtifactApproved',
  ] as const)('requires %s at every task put', (flag) => {
    expect(() =>
      prepare({ readiness: { ...readiness, [flag]: false } }),
    ).toThrow('writer_fence');
  });
  it('rejects expired writer and a stale period/arm CAS', () => {
    expect(() => prepare({ dbNowMs: Date.parse(A) + 30_000 })).toThrow(
      'writer_fence',
    );
    const base = prepare().journal.write;
    const mutation = { ...base.mutation, expectedArmVersion: 0 };
    expect(() =>
      prepare({
        write: { ...base, mutation, digest: nativeOnceDigest(mutation) },
      }),
    ).toThrow('write_invalid');
  });
  it('rejects NULL/missing arm binding fields and a cross-period request', () => {
    const a = freshArm();
    expect(
      NativeCalendarArmSchema.safeParse({ ...a, taskSnapshot: undefined })
        .success,
    ).toBe(false);
    expect(() => prepare({ arm: { ...a, periodId: id(99) } })).toThrow(
      'binding_invalid',
    );
    expect(() =>
      prepare({ arm: { ...a, requestDigest: nativeOnceDigest('wrong') } }),
    ).toThrow('binding_invalid');
  });
});

describe('calendar receipts preserve P, A and one immutable native Task', () => {
  function receive(patch: Partial<Input> = {}) {
    const bound = prepare();
    return withTask(delivered(), {
      period: bound.period,
      arm: bound.arm,
      ...patch,
    });
  }
  it('creates one occurrence with native scheduledAt=A and business identity P', () => {
    const result = receive();
    expect(result.period).toMatchObject({
      state: 'received',
      businessScheduledFor: P,
    });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({
      state: 'pending',
      reason: null,
      payload: {
        businessScheduledFor: P,
        nativeTaskId: 'native-random-task',
        calendar: { period: { businessScheduledFor: P }, arm: { nativeAt: A } },
        receipt: { scheduledAt: A, messageId: 'native-inbox-original' },
      },
    });
    expect(result.journal.receiptLinks[0]?.payloadDigest).toBe(
      result.occurrences[0]?.payloadDigest,
    );
  });
  it('compares the resume watermark against P rather than a recovery A', () => {
    const result = receive({
      admission: {
        allowed: true,
        currentRevision: 1,
        policyRevision: v.policyRevision,
        policyDigest: v.policyDigest,
        status: 'enabled',
        resumeAfter: '2027-02-01T00:00:00.000Z',
      },
    });
    expect(result.occurrences[0]).toMatchObject({
      state: 'blocked',
      reason: 'before_resume_watermark',
    });
  });
  it.each([
    [undefined, 'current_authority_changed'],
    [{ allowed: false }, 'current_authority_changed'],
    [{ status: 'paused' }, 'paused_or_deleted'],
    [{ currentRevision: 2 }, 'configuration_changed'],
    [{ policyRevision: 4 }, 'configuration_changed'],
    [{ policyDigest: nativeOnceDigest('changed') }, 'configuration_changed'],
  ] as const)(
    'retains receipts when current admission blocks %j',
    (change, reason) => {
      const admission =
        change === undefined
          ? undefined
          : {
              allowed: true,
              currentRevision: 1,
              policyRevision: v.policyRevision,
              policyDigest: v.policyDigest,
              status: 'enabled' as const,
              resumeAfter: null,
              ...change,
            };
      expect(receive({ admission }).occurrences[0]).toMatchObject({
        state: 'blocked',
        reason,
      });
    },
  );
  it('never replaces a bound Task or rewrites its native A', () => {
    const bound = prepare(),
      t = task();
    t.record.id = 'second-native-task';
    expect(() => withTask(t, { period: bound.period, arm: bound.arm })).toThrow(
      'task_invalid',
    );
    const t2 = task();
    t2.record.scheduledAt = P;
    expect(() =>
      withTask(t2, { period: bound.period, arm: bound.arm }),
    ).toThrow('task_invalid');
  });
  it('retains the original receipt and does not emit it twice', () => {
    const received = receive();
    const again = withTask(delivered(), {
      period: received.period,
      arm: received.arm,
    });
    expect(again.occurrences).toEqual([]);
    const changed = delivered();
    changed.lastDelivery!.messageId = 'replacement-inbox';
    changed.deliveryHistory!.records[0]!.messageId = 'replacement-inbox';
    expect(() =>
      withTask(changed, { period: received.period, arm: received.arm }),
    ).toThrow('task_rewritten');
  });
  it('does not prune, duplicate, mismatch or clear native at history', () => {
    const bound = prepare();
    for (const alter of [
      (t: NativeOnceTask) => {
        t.deliveryHistory!.earlierRecordsUnavailable = true;
      },
      (t: NativeOnceTask) => {
        t.deliveryHistory!.records.push(t.deliveryHistory!.records[0]!);
      },
      (t: NativeOnceTask) => {
        t.deliveryHistory!.records[0]!.scheduledAt = P;
      },
    ]) {
      const t = delivered();
      alter(t);
      expect(() =>
        withTask(t, { period: bound.period, arm: bound.arm }),
      ).toThrow();
    }
    const received = receive();
    expect(() =>
      withTask(task(), { period: received.period, arm: received.arm }),
    ).toThrow('task_rewritten');
  });
  it('uses P as its uniqueness key even if a different recovery attempt or inbox is observed', () => {
    const first = receive().occurrences[0]!;
    const a = freshArm({
      armId: id(10),
      attempt: 2,
      nativeAt: '2027-03-02T02:00:00.000Z',
    });
    const pp = { ...p, currentArmId: a.armId };
    const bound = prepare({ arm: a, period: pp });
    const t = delivered(task(a));
    t.lastDelivery!.messageId = 'different-inbox';
    t.deliveryHistory!.records[0]!.messageId = 'different-inbox';
    const second = withTask(t, { arm: bound.arm, period: bound.period })
      .occurrences[0]!;
    expect(second.key).toBe(first.key);
    expect(second.id).toBe(first.id);
    expect(second.payloadDigest).not.toBe(first.payloadDigest);
  });
});
