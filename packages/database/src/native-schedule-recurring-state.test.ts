import { describe, expect, it } from 'vitest';
import {
  nativeOnceDigest,
  type NativeOnceWriterRow,
} from './native-schedule-once-state.ts';
import {
  NativeRecurringControlSchema,
  prepareNativeRecurringMutation,
  recurringControlIdentity,
  recurringRecordMatches,
  type NativeRecurringAdmission,
  type NativeRecurringControl,
  type NativeRecurringMutation,
  type NativeRecurringRevision,
  type NativeRecurringSnapshot,
  type NativeRecurringTask,
} from './native-schedule-recurring-state.ts';

const ID = {
  control: '11111111-1111-4111-8111-111111111111',
  organization: '22222222-2222-4222-8222-222222222222',
  workspace: '33333333-3333-4333-8333-333333333333',
  owner: '44444444-4444-4444-8444-444444444444',
  automation: '55555555-5555-4555-8555-555555555555',
  assignment: '66666666-6666-4666-8666-666666666666',
  instance: '77777777-7777-4777-8777-777777777777',
  session: '88888888-8888-4888-8888-888888888888',
  command: '99999999-9999-4999-8999-999999999999',
};
const PROMPT = 'Synthetic schedule control only. Never execute business work.';
const epoch = Date.parse('2030-01-01T00:00:00.000Z');
const instant = (seconds: number) =>
  new Date(epoch + seconds * 1_000).toISOString();
const readiness = {
  enabled: true,
  storageReady: true,
  legacyClockExcluded: true,
  controlArtifactApproved: true,
};
const reference = {
  artifactId: `sha256:${'a'.repeat(64)}`,
  profileId: 'allrice-recurring-control-v1',
  storageId: 'control-storage',
  stateRoot: '/owned/control',
};
const writer = {
  partitionId: 'allrice-recurring-v1',
  ownerId: 'host-a',
  epoch: 1,
  token: 'synthetic-test-token',
};

function lease(): NativeOnceWriterRow {
  return {
    ...writer,
    tokenDigest: nativeOnceDigest(writer.token),
    expiresAtMs: epoch + 30_000,
    closed: false,
    reference,
  };
}

function control(
  patch: Partial<NativeRecurringControl> = {},
): NativeRecurringControl {
  return {
    kind: 'recurring',
    partitionId: writer.partitionId,
    controlId: ID.control,
    organizationId: ID.organization,
    workspaceId: ID.workspace,
    ownerId: ID.owner,
    automationId: ID.automation,
    revision: 1,
    controlSessionId: 'recurring-control-a',
    rule: { kind: 'every', seconds: 60 },
    appliedRevision: 1,
    appliedRule: { kind: 'every', seconds: 60 },
    sessionState: 'ready',
    nativeTaskId: 'native-task-a',
    taskDeleted: false,
    command: { id: ID.command, kind: 'create', status: 'confirmed' },
    dispatch: {
      employeeAssignmentId: ID.assignment,
      employeeInstanceId: ID.instance,
      businessSessionId: ID.session,
    },
    ...patch,
  };
}

function version(revision = 1, seconds = 60): NativeRecurringRevision {
  return {
    revision,
    name: `Revision ${revision}`,
    prompt: `Business content ${revision}`,
    rule: { kind: 'every', seconds },
    reservationDigest: nativeOnceDigest({ revision, seconds }),
    acceptedAt: instant(0),
  };
}

type Receipt = NonNullable<
  NativeRecurringTask['deliveryHistory']
>['records'][number];
function receipt(seconds: number, patch: Partial<Receipt> = {}): Receipt {
  return {
    scheduledAt: instant(seconds),
    deliveredAt: instant(seconds + 1),
    messageId: `native-inbox-${seconds}`,
    prompt: PROMPT,
    ...patch,
  };
}

function task(
  next = 60,
  records: Receipt[] = [],
  pruned = false,
): NativeRecurringTask {
  const last = records.at(-1);
  return {
    sessionId: 'recurring-control-a',
    status: 'active',
    record: {
      id: 'native-task-a',
      kind: 'every',
      everySeconds: 60,
      title: 'AllRice once control',
      prompt: PROMPT,
      scheduledAt: instant(next),
    },
    ...(last
      ? {
          lastDelivery: {
            scheduledAt: last.scheduledAt,
            deliveredAt: last.deliveredAt,
            messageId: last.messageId,
          },
        }
      : {}),
    deliveryHistory: {
      records,
      earlierRecordsUnavailable: pruned,
      ...(pruned ? { earlierRecordsPruned: true } : {}),
    },
  };
}

function admission(
  patch: Partial<NativeRecurringAdmission> = {},
): NativeRecurringAdmission {
  return {
    allowed: true,
    currentRevision: 1,
    status: 'enabled',
    resumeAfter: null,
    ...patch,
  };
}

// As in the once decision tests, the caller has already decoded the approved
// public DSH schema. These tests exercise the DB decisions, not that decoder.
const decodeTask = (value: unknown) =>
  structuredClone(value) as NativeRecurringTask;
type Input = Parameters<typeof prepareNativeRecurringMutation>[0];
function prepare(
  mutation: NativeRecurringMutation = {
    kind: 'put_task',
    controlId: ID.control,
    task: task(120, [receipt(60)]),
  },
  patch: Partial<Input> = {},
) {
  return prepareNativeRecurringMutation({
    readiness,
    reference,
    writerRow: lease(),
    writer,
    dbNowMs: epoch + 1_000,
    before: { control: control(), task: task() },
    write: { writeId: 'write-a', digest: nativeOnceDigest(mutation), mutation },
    revisions: new Map([[1, version()]]),
    decodeTask,
    admission: admission(),
    ...patch,
  });
}
function put(value: NativeRecurringTask): NativeRecurringMutation {
  return { kind: 'put_task', controlId: ID.control, task: value };
}

describe('recurring control reservations and writer boundaries', () => {
  it('binds the first native task without manufacturing an occurrence', () => {
    const before = {
      control: control({
        nativeTaskId: null,
        appliedRevision: null,
        appliedRule: null,
        command: { id: ID.command, kind: 'create', status: 'pending' },
      }),
      task: null,
    };
    const result = prepare(put(task()), { before });
    expect(result.occurrences).toEqual([]);
    expect(result.after.control).toMatchObject({
      nativeTaskId: 'native-task-a',
      appliedRevision: 1,
      appliedRule: { kind: 'every', seconds: 60 },
    });
    expect(before.task).toBeNull();
    expect(before.control.nativeTaskId).toBeNull();
  });

  it('rejects a first write that claims an earlier native delivery', () => {
    const before = {
      control: control({
        nativeTaskId: null,
        appliedRevision: null,
        appliedRule: null,
        command: { id: ID.command, kind: 'create', status: 'pending' },
      }),
      task: null,
    };
    expect(() => prepare(undefined, { before })).toThrow(
      'initial_receipt_fabricated',
    );
  });

  it.each([
    { closed: true },
    { epoch: 2 },
    { ownerId: 'another-host' },
    { tokenDigest: nativeOnceDigest('another-token') },
    { expiresAtMs: epoch + 1_000 },
    { reference: { ...reference, stateRoot: '/replacement' } },
  ])('denies an expired or replaced writer/reference %j', (patch) => {
    expect(() =>
      prepare(undefined, { writerRow: { ...lease(), ...patch } }),
    ).toThrow('writer_fence');
  });

  it.each([
    'enabled',
    'storageReady',
    'legacyClockExcluded',
    'controlArtifactApproved',
  ] as const)('does not accept a mutation without %s', (key) => {
    expect(() =>
      prepare(undefined, { readiness: { ...readiness, [key]: false } }),
    ).toThrow('writer_fence');
  });

  it('cannot redirect the mutation to another control', () => {
    expect(() =>
      prepare({ kind: 'put_task', controlId: ID.command, task: task() }),
    ).toThrow('write_invalid');
  });

  it('rejects a missing immutable configuration revision', () => {
    expect(() => prepare(undefined, { revisions: new Map() })).toThrow(
      'revision_missing',
    );
  });

  it.each([
    { appliedRevision: 2 },
    { appliedRule: null },
    { sessionState: 'initializing' as const },
  ])('rejects inconsistent persisted control identities %j', (patch) => {
    expect(NativeRecurringControlSchema.safeParse(control(patch)).success).toBe(
      false,
    );
  });
});

describe('recurring native receipts and stable occurrence identity', () => {
  it('links one native receipt to its frozen business revision and tenant target', () => {
    const result = prepare();
    expect(result.occurrences).toHaveLength(1);
    const occurrence = result.occurrences[0]!;
    expect(occurrence).toMatchObject({
      state: 'pending',
      reason: null,
      payload: {
        control: recurringControlIdentity(control()),
        nativeTaskId: 'native-task-a',
        revision: {
          revision: 1,
          reservationDigest: version().reservationDigest,
          acceptedAt: instant(0),
        },
        receipt: receipt(60),
      },
    });
    expect(occurrence.payloadDigest).toBe(nativeOnceDigest(occurrence.payload));
    expect(occurrence.payload).not.toHaveProperty('prompt');
    expect(result.journal.receiptLinks).toEqual([
      {
        id: occurrence.id,
        key: occurrence.key,
        payloadDigest: occurrence.payloadDigest,
      },
    ]);
    expect(JSON.stringify(result.journal)).not.toContain(writer.token);
    expect(JSON.stringify(result.journal)).not.toContain('Business content');
  });

  it('uses the same business/message identities for the same target independently of writeId', () => {
    const first = prepare();
    const mutation = put(task(120, [receipt(60)]));
    const second = prepare(mutation, {
      write: {
        writeId: 'a-different-write',
        mutation,
        digest: nativeOnceDigest(mutation),
      },
    });
    expect(second.occurrences).toEqual(first.occurrences);
    const observed = prepare(put(task(120, [receipt(60)])), {
      before: first.after,
    });
    expect(observed.occurrences).toEqual([]);
  });

  it('does not give a conflicting receipt for the same target a second identity', () => {
    const first = prepare().occurrences[0]!;
    const other = prepare(
      put(task(120, [receipt(60, { messageId: 'conflicting-inbox' })])),
    ).occurrences[0]!;
    expect(other.id).toBe(first.id);
    expect(other.key).toBe(first.key);
    expect(other.clientMessageId).toBe(first.clientMessageId);
    expect(other.payloadDigest).not.toBe(first.payloadDigest);
    // The SQL insert checks this exact payload conflict and never replaces it.
  });

  it('keeps different business targets distinct even at the same scheduled instant', () => {
    const first = prepare().occurrences[0]!;
    const second = prepare(undefined, {
      before: { control: control({ automationId: ID.command }), task: task() },
    }).occurrences[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.clientMessageId).not.toBe(first.clientMessageId);
  });

  it.each([
    { records: [receipt(59)] },
    { records: [receipt(120)] },
    { records: [receipt(60), receipt(60, { messageId: 'second-inbox' })] },
  ])('rejects a rewound, unadvanced or duplicate target %j', ({ records }) => {
    expect(() => prepare(put(task(120, records)))).toThrow(
      'receipt_target_rewind',
    );
  });

  it('rejects advancing the target without native delivery evidence', () => {
    expect(() => prepare(put(task(120)))).toThrow('unproved_target_change');
  });

  it('rejects duplicate native receipt records', () => {
    expect(() => prepare(put(task(120, [receipt(60), receipt(60)])))).toThrow(
      'receipt_history',
    );
  });

  it('does not accept a decoder that drops stored native fields', () => {
    expect(() =>
      prepare(undefined, {
        decodeTask: (value) => {
          const decoded = decodeTask(value);
          delete decoded.deliveryHistory;
          return decoded;
        },
      }),
    ).toThrow('task_invalid');
  });

  it.each(['session', 'task', 'prompt', 'status'] as const)(
    'rejects a changed synthetic %s identity',
    (field) => {
      const value = task(120, [receipt(60)]);
      if (field === 'session') value.sessionId = 'another-native-session';
      if (field === 'task') value.record.id = 'another-task';
      if (field === 'prompt')
        value.record.prompt = 'Execute actual business work';
      if (field === 'status') value.status = 'inactive';
      expect(() => prepare(put(value))).toThrow();
    },
  );
});

describe('recurring delivery history pruning', () => {
  const prior = [receipt(0), receipt(60), receipt(120)];
  const before: NativeRecurringSnapshot = {
    control: control(),
    task: task(180, prior),
  };

  it('accepts only a proved prefix prune and emits only the new receipt', () => {
    const result = prepare(
      put(task(240, [...prior.slice(1), receipt(180)], true)),
      { before },
    );
    expect(
      result.occurrences.map((item) => item.payload.receipt.scheduledAt),
    ).toEqual([instant(180)]);
    expect(result.after.task).toEqual(
      task(240, [...prior.slice(1), receipt(180)], true),
    );
    expect(before.task).toEqual(task(180, prior));
  });

  it('does not treat generic unavailable history as proof of an actual prune', () => {
    const value = task(240, [...prior.slice(1), receipt(180)]);
    value.deliveryHistory!.earlierRecordsUnavailable = true;
    expect(() => prepare(put(value), { before })).toThrow(
      'unproved_history_pruning',
    );
  });

  it('rejects removing a middle receipt even with the prune flag', () => {
    expect(() =>
      prepare(put(task(240, [prior[0]!, prior[2]!, receipt(180)], true)), {
        before,
      }),
    ).toThrow('receipt_prefix_changed');
  });

  it('rejects placing new receipts before retained historical evidence', () => {
    expect(() =>
      prepare(put(task(240, [receipt(180), ...prior.slice(1)], true)), {
        before,
      }),
    ).toThrow('receipt_append_order');
  });

  it('rejects rewriting even optional data on an existing receipt', () => {
    const changed = { ...prior[2]! };
    delete changed.prompt;
    expect(() =>
      prepare(put(task(180, [...prior.slice(0, 2), changed])), { before }),
    ).toThrow('receipt_rewritten');
  });

  it('requires lastDelivery to agree with the retained history tail', () => {
    const value = task(240, [...prior, receipt(180)]);
    value.lastDelivery = { ...value.lastDelivery!, messageId: 'wrong-tail' };
    expect(() => prepare(put(value), { before })).toThrow('receipt_tail');
  });
});

describe('recurring pause, resume and current admission', () => {
  it.each([
    [undefined, 'current_authority_changed'],
    [admission({ allowed: false }), 'current_authority_changed'],
    [admission({ status: 'paused' }), 'paused_or_deleted'],
    [admission({ status: 'deleted' }), 'paused_or_deleted'],
    [admission({ currentRevision: 2 }), 'configuration_changed'],
    [admission({ resumeAfter: instant(60) }), 'before_resume_watermark'],
    [admission({ resumeAfter: instant(61) }), 'before_resume_watermark'],
  ] as const)(
    'retains the native fact without dispatching disallowed work %j',
    (current, reason) => {
      const result = prepare(undefined, { admission: current });
      expect(result.occurrences[0]).toMatchObject({
        state: 'blocked',
        reason,
        payload: { receipt: receipt(60) },
      });
      expect(result.after.task).toEqual(task(120, [receipt(60)]));
    },
  );

  it('permits only targets strictly after the resume commit watermark', () => {
    expect(
      prepare(undefined, {
        admission: admission({ resumeAfter: instant(59.999) }),
      }).occurrences[0],
    ).toMatchObject({ state: 'pending', reason: null });
  });

  it('does not generate another occurrence when a blocked receipt is observed after resume', () => {
    const blocked = prepare(undefined, {
      admission: admission({ status: 'paused' }),
    });
    expect(
      prepare(put(task(120, [receipt(60)])), {
        before: blocked.after,
        admission: admission({ resumeAfter: instant(61) }),
      }).occurrences,
    ).toEqual([]);
  });
});

describe('recurring revision updates and terminal deletion', () => {
  function updating(seconds = 120): NativeRecurringControl {
    return control({
      revision: 2,
      rule: { kind: 'every', seconds },
      command: { id: ID.command, kind: 'update', status: 'pending' },
    });
  }
  const revisions = new Map([
    [1, version()],
    [2, version(2, 120)],
  ]);

  it('applies a rule update without changing the native task or business target identity', () => {
    const value = task(120);
    value.record.everySeconds = 120;
    const result = prepare(put(value), {
      before: { control: updating(), task: task() },
      revisions,
    });
    expect(result.occurrences).toEqual([]);
    expect(result.after.control).toMatchObject({
      nativeTaskId: 'native-task-a',
      revision: 2,
      appliedRevision: 2,
      appliedRule: { kind: 'every', seconds: 120 },
    });
    expect(recurringControlIdentity(result.after.control)).toEqual(
      recurringControlIdentity(control()),
    );
    const confirmed = prepare(
      {
        kind: 'confirm_command',
        controlId: ID.control,
        commandId: ID.command,
        nativeTaskId: 'native-task-a',
      },
      { before: result.after, revisions },
    );
    expect(confirmed.after.control.command.status).toBe('confirmed');
    const delivered = task(240, [receipt(120)]);
    delivered.record.everySeconds = 120;
    expect(
      prepare(put(delivered), {
        before: confirmed.after,
        revisions,
        admission: admission({ currentRevision: 2 }),
      }).occurrences[0]?.payload.revision.revision,
    ).toBe(2);
  });

  it('attributes an old-rule delivery racing an update to its old frozen revision and blocks dispatch', () => {
    const result = prepare(undefined, {
      before: { control: updating(), task: task() },
      revisions,
      admission: admission({ currentRevision: 2 }),
    });
    expect(result.occurrences[0]).toMatchObject({
      state: 'blocked',
      reason: 'configuration_changed',
      payload: {
        revision: { revision: 1, rule: { kind: 'every', seconds: 60 } },
      },
    });
    expect(result.after.control.appliedRevision).toBe(1);
  });

  it('rejects a new-rule write mixed with a receipt from the old rule', () => {
    const value = task(120, [receipt(60)]);
    value.record.everySeconds = 120;
    expect(() =>
      prepare(put(value), {
        before: { control: updating(), task: task() },
        revisions,
      }),
    ).toThrow('receipt_rule_changed');
  });

  it('does not confirm an update before its native rule is persisted', () => {
    expect(() =>
      prepare(
        {
          kind: 'confirm_command',
          controlId: ID.control,
          commandId: ID.command,
          nativeTaskId: 'native-task-a',
        },
        { before: { control: updating(), task: task() }, revisions },
      ),
    ).toThrow('command_not_persisted');
  });

  it('can confirm a content-only revision without duplicating the existing native target', () => {
    const before = { control: updating(60), task: task() };
    const sameRuleVersions = new Map([
      [1, version()],
      [2, version(2, 60)],
    ]);
    const result = prepare(
      {
        kind: 'confirm_command',
        controlId: ID.control,
        commandId: ID.command,
        nativeTaskId: 'native-task-a',
      },
      { before, revisions: sameRuleVersions },
    );
    expect(result.after.control.appliedRevision).toBe(2);
    expect(result.after.task).toEqual(before.task);
    expect(result.occurrences).toEqual([]);
  });

  it('requires persisted deletion before confirming and forbids later receipt writes', () => {
    const before = {
      control: control({
        command: { id: ID.command, kind: 'delete', status: 'pending' },
      }),
      task: task(),
    };
    const confirm: NativeRecurringMutation = {
      kind: 'confirm_command',
      controlId: ID.control,
      commandId: ID.command,
      nativeTaskId: 'native-task-a',
    };
    expect(() => prepare(confirm, { before })).toThrow('delete_not_persisted');
    const deleted = prepare(
      {
        kind: 'delete_task',
        controlId: ID.control,
        nativeTaskId: 'native-task-a',
      },
      { before },
    );
    expect(deleted.after).toMatchObject({
      control: { taskDeleted: true, nativeTaskId: 'native-task-a' },
      task: null,
    });
    const confirmed = prepare(confirm, { before: deleted.after });
    expect(confirmed.after.control.command.status).toBe('confirmed');
    expect(() => prepare(undefined, { before: confirmed.after })).toThrow(
      'task_invalid',
    );
  });

  it('compares daily wall time and canonical timezone without inventing DST targets', () => {
    const record = {
      ...task().record,
      kind: 'daily' as const,
      time: '01:30:00.000',
      timeZone: 'US/Eastern',
    };
    expect(
      recurringRecordMatches(record, {
        kind: 'daily',
        time: '01:30:00',
        timezone: 'America/New_York',
      }),
    ).toBe(true);
    expect(
      recurringRecordMatches(record, {
        kind: 'daily',
        time: '02:30:00',
        timezone: 'America/New_York',
      }),
    ).toBe(false);
    expect(
      recurringRecordMatches(
        { ...record, timeZone: 'invalid/timezone' },
        { kind: 'daily', time: '01:30:00', timezone: 'America/New_York' },
      ),
    ).toBe(false);
  });

  it('matches the complete weekly weekday set and canonical timezone', () => {
    const rule = {
      kind: 'weekly' as const,
      time: '01:30:00',
      timezone: 'America/New_York',
      weekdays: [1, 7],
    };
    const record = {
      ...task().record,
      kind: 'weekly' as const,
      time: '01:30:00.000',
      timeZone: 'US/Eastern',
      weekdays: [1, 7],
    };
    expect(recurringRecordMatches(record, rule)).toBe(true);
    for (const weekdays of [undefined, [], [1], [7, 1], [1, 1], [1, 6]])
      expect(recurringRecordMatches({ ...record, weekdays }, rule)).toBe(false);
    expect(recurringRecordMatches({ ...record, kind: 'daily' }, rule)).toBe(
      false,
    );
    expect(
      recurringRecordMatches({ ...record, timeZone: 'Mars/Invalid' }, rule),
    ).toBe(false);
    expect(
      recurringRecordMatches({ ...record, time: '02:30:00.000' }, rule),
    ).toBe(false);
    expect(
      NativeRecurringControlSchema.safeParse(
        control({ rule: { ...rule, weekdays: [7, 1] } }),
      ).success,
    ).toBe(false);
  });

  it('preserves weekly identity and revision through a rule update and one native receipt', () => {
    const rule = {
      kind: 'weekly' as const,
      time: '09:30:00',
      timezone: 'Asia/Shanghai',
      weekdays: [1, 7],
    };
    const weeklyTask = (next: number, records: Receipt[] = []) => {
      const value = task(next, records);
      value.record = {
        id: value.record.id,
        kind: 'weekly',
        title: value.record.title,
        prompt: value.record.prompt,
        scheduledAt: value.record.scheduledAt,
        time: `${rule.time}.000`,
        timeZone: rule.timezone,
        weekdays: [...rule.weekdays],
      };
      return value;
    };
    const weeklyVersions = new Map([
      [1, version()],
      [2, { ...version(2), rule }],
    ]);
    const updated = prepare(put(weeklyTask(604_800)), {
      before: {
        control: control({
          revision: 2,
          rule,
          command: { id: ID.command, kind: 'update', status: 'pending' },
        }),
        task: task(),
      },
      revisions: weeklyVersions,
    });
    expect(updated.occurrences).toEqual([]);
    expect(updated.after.control.appliedRule).toEqual(rule);
    expect(recurringControlIdentity(updated.after.control)).toEqual(
      recurringControlIdentity(control()),
    );
    const confirmed = prepare(
      {
        kind: 'confirm_command',
        controlId: ID.control,
        commandId: ID.command,
        nativeTaskId: 'native-task-a',
      },
      { before: updated.after, revisions: weeklyVersions },
    );
    const delivered = weeklyTask(1_209_600, [receipt(604_800)]);
    const consumed = prepare(put(delivered), {
      before: confirmed.after,
      revisions: weeklyVersions,
      admission: admission({ currentRevision: 2 }),
    });
    expect(consumed.occurrences).toHaveLength(1);
    expect(consumed.occurrences[0]?.payload).toMatchObject({
      revision: { revision: 2, rule },
      nativeTaskId: 'native-task-a',
      receipt: { scheduledAt: instant(604_800) },
    });
    expect(consumed.after.control.controlSessionId).toBe('recurring-control-a');
    expect(
      prepare(put(delivered), {
        before: consumed.after,
        revisions: weeklyVersions,
        admission: admission({ currentRevision: 2 }),
      }).occurrences,
    ).toEqual([]);
  });
});
