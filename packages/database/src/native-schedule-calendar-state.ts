import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AutomationScheduleSchema, UuidSchema } from '@allrice/contracts';
import {
  nativeOnceDigest,
  nativeOnceReady,
  nativeOnceWriterRemaining,
  type NativeOnceReadiness,
  type NativeOnceReference,
  type NativeOnceTask,
  type NativeOnceWriter,
  type NativeOnceWriterRow,
} from './native-schedule-once-state.ts';

export const nativeCalendarTitle = 'AllRice once control';
export const nativeCalendarPrompt =
  'Synthetic schedule control only. Never execute business work.';
const Key = z.string().min(1).max(512);
const Revision = z.number().int().positive().safe();
const Version = z.number().int().nonnegative().safe();
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Instant = z
  .string()
  .refine(
    (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
  );
export const NativeCalendarWriterIdentitySchema = z
  .object({
    partitionId: Key,
    ownerId: Key,
    epoch: Revision,
    tokenDigest: Digest,
  })
  .strict();

/** A calendar parent never owns one of its rotating native Tasks. Fixed
 * recurring controls and their rule union deliberately remain separate. */
export const NativeCalendarControlSchema = z
  .object({
    kind: z.literal('calendar'),
    binding: z.literal('rotating-at-v1'),
    partitionId: z.literal('allrice-recurring-v1'),
    controlId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    automationId: UuidSchema,
    revision: Revision,
    controlSessionId: Key,
    reference: z
      .object({
        artifactId: Key,
        profileId: z.literal('allrice-recurring-control-v1'),
        storageId: Key,
        stateRoot: Key,
      })
      .strict(),
    sessionState: z.enum(['reserved', 'initializing', 'ready']),
    nativeTaskId: z.null(),
    dispatch: z
      .object({
        consumer: z.literal('experience-consolidation-v1'),
        employeeAssignmentId: UuidSchema,
        employeeInstanceId: UuidSchema,
      })
      .strict(),
  })
  .strict();
export type NativeCalendarControl = z.infer<typeof NativeCalendarControlSchema>;
export const NativeCalendarRevisionSchema = z
  .object({
    kind: z.literal('calendar'),
    binding: z.literal('rotating-at-v1'),
    consumer: z.literal('experience-consolidation-v1'),
    revision: Revision,
    schedule: AutomationScheduleSchema.refine((s) => s.frequency !== 'once'),
    ruleRevision: Revision,
    policyRevision: Revision,
    policyDigest: Digest,
    reservationDigest: Digest,
    acceptedAt: Instant,
  })
  .strict();
export type NativeCalendarRevision = z.infer<
  typeof NativeCalendarRevisionSchema
>;
export const NativeCalendarPeriodSchema = z
  .object({
    periodId: UuidSchema,
    partitionId: z.literal('allrice-recurring-v1'),
    controlId: UuidSchema,
    automationId: UuidSchema,
    revision: Revision,
    businessScheduledFor: Instant,
    currentArmId: UuidSchema,
    state: z.enum(['prepared', 'recovery_required', 'bound', 'received']),
    version: Version,
  })
  .strict();
export type NativeCalendarPeriod = z.infer<typeof NativeCalendarPeriodSchema>;
export const NativeCalendarAbsenceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('never_started'), taskSetDigest: Digest })
    .strict(),
  z
    .object({
      kind: z.literal('fenced_generation'),
      taskSetDigest: Digest,
      closeProofDigest: Digest,
      closedWriter: NativeCalendarWriterIdentitySchema,
    })
    .strict(),
]);
export const NativeCalendarArmSchema = z
  .object({
    armId: UuidSchema,
    periodId: UuidSchema,
    attempt: Revision,
    nativeAt: Instant,
    reason: z.enum(['business_target', 'future_recovery']),
    requestDigest: Digest,
    status: z.enum(['prepared', 'creating', 'absent', 'bound', 'received']),
    nativeTaskId: Key.nullable(),
    taskSnapshot: z.unknown(),
    bindWriteId: Key.nullable(),
    lastWriteId: Key.nullable(),
    createWriter: NativeCalendarWriterIdentitySchema.nullable(),
    absenceProof: NativeCalendarAbsenceSchema.nullable(),
    snapshotVersion: Version,
  })
  .strict()
  .superRefine((a, ctx) => {
    const bound = a.status === 'bound' || a.status === 'received';
    if (
      a.taskSnapshot === undefined ||
      (a.nativeTaskId !== null) !== bound ||
      (a.taskSnapshot !== null) !== bound ||
      (a.bindWriteId !== null) !== bound ||
      (a.lastWriteId !== null) !== bound ||
      ((a.status === 'creating' || bound) && a.createWriter === null) ||
      (a.status === 'prepared' && a.createWriter !== null) ||
      (a.status === 'absent') !== (a.absenceProof !== null) ||
      (a.absenceProof?.kind === 'never_started' && a.createWriter !== null) ||
      (a.absenceProof?.kind === 'fenced_generation' &&
        !isDeepStrictEqual(a.createWriter, a.absenceProof.closedWriter))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid calendar arm binding' });
  });
export type NativeCalendarArm = z.infer<typeof NativeCalendarArmSchema>;
export type NativeCalendarSnapshot = {
  control: NativeCalendarControl;
  task: null;
};
export type NativeCalendarAdmission = {
  allowed: boolean;
  currentRevision: number;
  policyRevision: number;
  policyDigest: string;
  status: 'enabled' | 'paused' | 'deleted';
  resumeAfter: string | null;
};
const SessionMutation = z
  .object({
    kind: z.literal('calendar'),
    action: z.enum(['session_initializing', 'session_ready']),
    controlId: UuidSchema,
    expectedControlVersion: Version,
  })
  .strict();
const PutMutation = z
  .object({
    kind: z.literal('calendar'),
    action: z.literal('put_task'),
    controlId: UuidSchema,
    periodId: UuidSchema,
    armId: UuidSchema,
    requestDigest: Digest,
    expectedPeriodVersion: Version,
    expectedArmVersion: Version,
    task: z.unknown(),
  })
  .strict();
export const NativeCalendarMutationSchema = z.union([
  SessionMutation,
  PutMutation,
]);
export type NativeCalendarMutation = z.infer<
  typeof NativeCalendarMutationSchema
>;
export type NativeCalendarWrite = {
  writeId: string;
  digest: string;
  mutation: NativeCalendarMutation;
};
type Receipt = NonNullable<
  NativeOnceTask['deliveryHistory']
>['records'][number];
export class NativeCalendarStateError extends Error {
  constructor(readonly code: string) {
    super(`native_calendar_${code}`);
  }
}
export function requireCalendar(value: unknown, code: string): asserts value {
  if (!value) throw new NativeCalendarStateError(code);
}
export function calendarWriterIdentity(w: NativeOnceWriter) {
  return NativeCalendarWriterIdentitySchema.parse({
    partitionId: w.partitionId,
    ownerId: w.ownerId,
    epoch: w.epoch,
    tokenDigest: nativeOnceDigest(w.token),
  });
}
export function calendarControlIdentity(c: NativeCalendarControl) {
  return {
    kind: c.kind,
    binding: c.binding,
    partitionId: c.partitionId,
    controlId: c.controlId,
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    ownerId: c.ownerId,
    automationId: c.automationId,
    controlSessionId: c.controlSessionId,
    reference: structuredClone(c.reference),
    dispatch: structuredClone(c.dispatch),
  };
}
export function calendarPeriodIdentity(p: NativeCalendarPeriod) {
  return {
    periodId: p.periodId,
    partitionId: p.partitionId,
    controlId: p.controlId,
    automationId: p.automationId,
    revision: p.revision,
    businessScheduledFor: p.businessScheduledFor,
  };
}
export function calendarArmIdentity(a: NativeCalendarArm) {
  return {
    armId: a.armId,
    periodId: a.periodId,
    attempt: a.attempt,
    nativeAt: a.nativeAt,
    reason: a.reason,
    requestDigest: a.requestDigest,
  };
}
export function calendarArmRequestDigest(
  c: NativeCalendarControl,
  p: NativeCalendarPeriod,
  a: Pick<
    NativeCalendarArm,
    'armId' | 'periodId' | 'attempt' | 'nativeAt' | 'reason'
  >,
) {
  return nativeOnceDigest({
    control: calendarControlIdentity(c),
    period: calendarPeriodIdentity(p),
    arm: a,
    title: nativeCalendarTitle,
    prompt: nativeCalendarPrompt,
  });
}
export function validateCalendarBinding(
  c: NativeCalendarControl,
  p: NativeCalendarPeriod,
  a: NativeCalendarArm,
) {
  NativeCalendarControlSchema.parse(c);
  NativeCalendarPeriodSchema.parse(p);
  NativeCalendarArmSchema.parse(a);
  requireCalendar(
    p.partitionId === c.partitionId &&
      p.controlId === c.controlId &&
      p.automationId === c.automationId &&
      p.revision <= c.revision &&
      a.periodId === p.periodId &&
      (a.reason !== 'business_target' ||
        a.nativeAt === p.businessScheduledFor) &&
      (p.currentArmId !== a.armId ||
        (p.state === 'prepared' &&
          ['prepared', 'creating'].includes(a.status)) ||
        (p.state === 'recovery_required' && a.status === 'absent') ||
        (p.state === 'bound' && a.status === 'bound') ||
        (p.state === 'received' && a.status === 'received')) &&
      a.requestDigest ===
        calendarArmRequestDigest(c, p, {
          armId: a.armId,
          periodId: a.periodId,
          attempt: a.attempt,
          nativeAt: a.nativeAt,
          reason: a.reason,
        }),
    'binding_invalid',
  );
}
/** The public decoder must preserve the complete approved DSH value. Neither a
 * catalog projection nor a constructed ScheduleRecord is persistence evidence. */
export function validateCalendarTask(
  c: NativeCalendarControl,
  p: NativeCalendarPeriod,
  a: NativeCalendarArm,
  raw: unknown,
  decode: (v: unknown) => NativeOnceTask,
) {
  validateCalendarBinding(c, p, a);
  const task = decode(structuredClone(raw));
  nativeOnceDigest(task);
  requireCalendar(
    isDeepStrictEqual(task, raw) &&
      c.sessionState === 'ready' &&
      task.sessionId === c.controlSessionId &&
      Key.safeParse(task.record.id).success &&
      task.record.kind === 'at' &&
      task.record.title === nativeCalendarTitle &&
      task.record.prompt === nativeCalendarPrompt &&
      task.record.scheduledAt === a.nativeAt &&
      (a.nativeTaskId === null || a.nativeTaskId === task.record.id) &&
      task.status === (task.lastDelivery ? 'inactive' : 'active'),
    'task_invalid',
  );
  const h = task.deliveryHistory;
  requireCalendar(
    !h ||
      (h.earlierRecordsUnavailable === false &&
        h.earlierRecordsPruned !== true &&
        h.records.length === (task.lastDelivery ? 1 : 0)),
    'receipt_history',
  );
  if (task.lastDelivery) {
    const r = task.lastDelivery;
    requireCalendar(
      r.scheduledAt === a.nativeAt &&
        Instant.safeParse(r.deliveredAt).success &&
        Key.safeParse(r.messageId).success,
      'receipt_invalid',
    );
    if (h)
      requireCalendar(
        h.records.every(
          (x) =>
            x.scheduledAt === r.scheduledAt &&
            x.deliveredAt === r.deliveredAt &&
            x.messageId === r.messageId &&
            (x.prompt === undefined || x.prompt === nativeCalendarPrompt),
        ),
        'receipt_invalid',
      );
  }
  return task;
}
function stableUuid(parts: readonly string[]) {
  const h = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Reconfiguration can cancel a future period and accept the same wall-clock P
 * under a new immutable period. Its late old receipt must not occupy the new
 * period's outbox identity. The original business Run remains unique by P. */
export function calendarOccurrenceIdentity(
  automationId: string,
  periodId: string,
  businessScheduledFor: string,
) {
  const key = nativeOnceDigest([
    'calendar-period-v1',
    automationId,
    periodId,
    businessScheduledFor,
  ]);
  return {
    key,
    id: stableUuid(['calendar-occurrence', key]),
    clientMessageId: stableUuid(['calendar-message', key]),
  };
}
export function calendarAdmissionReason(
  p: NativeCalendarPeriod,
  v: NativeCalendarRevision,
  admission: NativeCalendarAdmission | undefined,
) {
  return !admission?.allowed
    ? 'current_authority_changed'
    : admission.status !== 'enabled'
      ? 'paused_or_deleted'
      : admission.currentRevision !== p.revision ||
          admission.policyRevision !== v.policyRevision ||
          admission.policyDigest !== v.policyDigest
        ? 'configuration_changed'
        : admission.resumeAfter &&
            Date.parse(p.businessScheduledFor) <=
              Date.parse(admission.resumeAfter)
          ? 'before_resume_watermark'
          : null;
}
export function prepareNativeCalendarTaskPut(input: {
  readiness: NativeOnceReadiness;
  reference: NativeOnceReference;
  writerRow: NativeOnceWriterRow;
  writer: NativeOnceWriter;
  dbNowMs: number;
  control: NativeCalendarControl;
  period: NativeCalendarPeriod;
  arm: NativeCalendarArm;
  revision: NativeCalendarRevision;
  write: NativeCalendarWrite;
  decodeTask: (v: unknown) => NativeOnceTask;
  admission?: NativeCalendarAdmission;
}) {
  const { writer, write, control: c, period: p, arm: a } = input;
  requireCalendar(
    nativeOnceReady(input.readiness) &&
      nativeOnceWriterRemaining(input.writerRow, writer, input.dbNowMs) > 0 &&
      isDeepStrictEqual(input.writerRow.reference, input.reference) &&
      isDeepStrictEqual(c.reference, input.reference),
    'writer_fence',
  );
  const m = NativeCalendarMutationSchema.parse(write.mutation);
  requireCalendar(
    m.action === 'put_task' &&
      Key.safeParse(write.writeId).success &&
      write.digest === nativeOnceDigest(m) &&
      writer.partitionId === c.partitionId &&
      m.controlId === c.controlId &&
      m.periodId === p.periodId &&
      m.armId === a.armId &&
      m.requestDigest === a.requestDigest &&
      p.currentArmId === a.armId &&
      m.expectedPeriodVersion === p.version &&
      m.expectedArmVersion === a.snapshotVersion,
    'write_invalid',
  );
  // Narrow after the checked discriminant, without adding calendar to fixed rules.
  if (m.action !== 'put_task')
    throw new NativeCalendarStateError('write_invalid');
  const v = NativeCalendarRevisionSchema.parse(input.revision);
  requireCalendar(v.revision === p.revision, 'revision_missing');
  requireCalendar(
    ['creating', 'bound', 'received'].includes(a.status),
    'create_not_started',
  );
  const task = validateCalendarTask(c, p, a, m.task, input.decodeTask);
  const before =
    a.taskSnapshot === null
      ? null
      : validateCalendarTask(c, p, a, a.taskSnapshot, input.decodeTask);
  if (!before)
    requireCalendar(
      a.status === 'creating' &&
        p.state === 'prepared' &&
        isDeepStrictEqual(a.createWriter, calendarWriterIdentity(writer)) &&
        task.status === 'active' &&
        !task.lastDelivery,
      'initial_receipt_fabricated',
    );
  if (before)
    requireCalendar(
      isDeepStrictEqual(before.record, task.record) &&
        (!before.lastDelivery || isDeepStrictEqual(before, task)),
      'task_rewritten',
    );
  const afterArm = structuredClone(a);
  const afterPeriod = structuredClone(p);
  afterArm.nativeTaskId = task.record.id;
  afterArm.taskSnapshot = task;
  afterArm.bindWriteId ??= write.writeId;
  afterArm.lastWriteId = write.writeId;
  afterArm.status = task.lastDelivery ? 'received' : 'bound';
  afterArm.snapshotVersion++;
  afterPeriod.state = task.lastDelivery ? 'received' : 'bound';
  afterPeriod.version++;
  NativeCalendarArmSchema.parse(afterArm);
  NativeCalendarPeriodSchema.parse(afterPeriod);
  const receipt =
    task.lastDelivery && !before?.lastDelivery
      ? ((task.deliveryHistory?.records[0] ?? task.lastDelivery) as Receipt)
      : null;
  const occurrences = receipt
    ? (() => {
        // Recovery A and messageId never become the business identity P.
        const identity = calendarOccurrenceIdentity(
          c.automationId,
          p.periodId,
          p.businessScheduledFor,
        );
        const payload = {
          control: calendarControlIdentity(c),
          revision: structuredClone(v),
          calendar: {
            period: calendarPeriodIdentity(p),
            arm: calendarArmIdentity(a),
          },
          businessScheduledFor: p.businessScheduledFor,
          nativeTaskId: task.record.id,
          receipt: structuredClone(receipt),
        };
        const reason = calendarAdmissionReason(p, v, input.admission);
        return [
          {
            ...identity,
            payload,
            payloadDigest: nativeOnceDigest(payload),
            state: reason ? ('blocked' as const) : ('pending' as const),
            reason,
          },
        ];
      })()
    : [];
  const after: NativeCalendarSnapshot = {
    control: structuredClone(c),
    task: null,
  };
  const journal = {
    writer: calendarWriterIdentity(writer),
    reference: structuredClone(input.reference),
    write: structuredClone(write),
    identity: calendarControlIdentity(c),
    beforeDigest: nativeOnceDigest({ control: c, period: p, arm: a }),
    afterDigest: nativeOnceDigest(after),
    calendarLinks: [
      {
        period: afterPeriod,
        arm: afterArm,
        periodDigest: nativeOnceDigest(afterPeriod),
        armDigest: nativeOnceDigest(afterArm),
        taskDigest: nativeOnceDigest(task),
      },
    ],
    receiptLinks: occurrences.map((o) => ({
      id: o.id,
      key: o.key,
      payloadDigest: o.payloadDigest,
    })),
  };
  nativeOnceDigest(journal);
  return { after, period: afterPeriod, arm: afterArm, occurrences, journal };
}
