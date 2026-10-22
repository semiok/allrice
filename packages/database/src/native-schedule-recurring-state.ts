import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  RecurringScheduleRuleSchema,
  UuidSchema,
  type RecurringScheduleRule,
} from '@allrice/contracts';
import {
  nativeOnceDigest,
  nativeOnceReady,
  nativeOnceWriterRemaining,
  type NativeOnceReadiness,
  type NativeOnceReference,
  type NativeOnceWriter,
  type NativeOnceWriterRow,
  type NativeOnceTask,
} from './native-schedule-once-state.ts';

const TITLE = 'AllRice once control';
const PROMPT = 'Synthetic schedule control only. Never execute business work.';
const Key = z.string().min(1).max(512);
const Revision = z.number().int().positive().safe();
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Instant = z
  .string()
  .refine(
    (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
  );

/** The original control Session and task survive business revisions. */
export const NativeRecurringControlSchema = z
  .object({
    kind: z.literal('recurring'),
    partitionId: Key,
    controlId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    automationId: UuidSchema,
    revision: Revision,
    controlSessionId: Key,
    rule: RecurringScheduleRuleSchema,
    appliedRevision: Revision.nullable(),
    appliedRule: RecurringScheduleRuleSchema.nullable(),
    sessionState: z.enum(['reserved', 'initializing', 'ready']),
    nativeTaskId: Key.nullable(),
    taskDeleted: z.boolean(),
    command: z
      .object({
        id: UuidSchema,
        kind: z.enum(['create', 'update', 'delete']),
        status: z.enum(['pending', 'confirmed', 'blocked']),
      })
      .strict(),
    // Existing chat identities remain byte-for-byte unchanged. A private
    // quality schedule delivers to its original durable occurrence queue.
    dispatch: z.union([
      z
        .object({
          employeeAssignmentId: UuidSchema,
          employeeInstanceId: UuidSchema,
          businessSessionId: UuidSchema,
        })
        .strict(),
      z.object({ consumer: z.literal('platform-quality-v1') }).strict(),
    ]),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      (c.appliedRevision === null) !== (c.appliedRule === null) ||
      (c.appliedRevision !== null && c.appliedRevision > c.revision) ||
      (c.nativeTaskId !== null &&
        (c.sessionState !== 'ready' || c.appliedRevision === null))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid applied control identity',
      });
  });
export type NativeRecurringControl = z.infer<
  typeof NativeRecurringControlSchema
>;
const NativeRecurringRevisionBase = z
  .object({
    revision: Revision,
    name: z.string().min(1).max(160),
    prompt: z.string().min(1).max(40_000),
    rule: RecurringScheduleRuleSchema,
    reservationDigest: Digest,
    acceptedAt: Instant,
  })
  .strict();
export const NativeRecurringRevisionSchema = z.union([
  NativeRecurringRevisionBase,
  NativeRecurringRevisionBase.extend({
    consumer: z.literal('platform-quality-v1'),
    qualityConfigurationDigest: Digest,
    legacyScheduledFor: Instant.nullable(),
  }).strict(),
]);
export type NativeRecurringRevision = z.infer<
  typeof NativeRecurringRevisionSchema
>;
export type NativeRecurringTask = NativeOnceTask & {
  record: NativeOnceTask['record'] & {
    everySeconds?: number;
    time?: string;
    timeZone?: string;
    weekdays?: number[];
  };
};
export type NativeRecurringMutation = { controlId: string } & (
  | { kind: 'session_initializing' | 'session_ready' }
  | { kind: 'put_task'; task: unknown }
  | { kind: 'delete_task'; nativeTaskId: string }
  | { kind: 'confirm_command'; commandId: string; nativeTaskId: string | null }
);
export type NativeRecurringWrite = {
  writeId: string;
  digest: string;
  mutation: NativeRecurringMutation;
};
export type NativeRecurringSnapshot = {
  control: NativeRecurringControl;
  task: unknown | null;
};
type Receipt = NonNullable<
  NativeRecurringTask['deliveryHistory']
>['records'][number];
export type NativeRecurringOccurrence = {
  id: string;
  key: string;
  clientMessageId: string;
  payload: {
    control: ReturnType<typeof recurringControlIdentity>;
    revision: Pick<
      NativeRecurringRevision,
      'revision' | 'rule' | 'reservationDigest' | 'acceptedAt'
    >;
    nativeTaskId: string;
    receipt: Receipt;
  };
  payloadDigest: string;
  state: 'pending' | 'blocked';
  reason: string | null;
};
export type NativeRecurringAdmission = {
  allowed: boolean;
  currentRevision: number;
  status: 'enabled' | 'paused' | 'deleted';
  /** A resume rejects every delayed target at or before the DB commit watermark. */
  resumeAfter: string | null;
};
export class NativeRecurringStateError extends Error {
  constructor(readonly code: string) {
    super(`native_recurring_${code}`);
  }
}
function need(value: unknown, code: string): asserts value {
  if (!value) throw new NativeRecurringStateError(code);
}

export function recurringControlIdentity(c: NativeRecurringControl) {
  return {
    partitionId: c.partitionId,
    controlId: c.controlId,
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    ownerId: c.ownerId,
    automationId: c.automationId,
    controlSessionId: c.controlSessionId,
    dispatch: structuredClone(c.dispatch),
  };
}
export function recurringRecordMatches(
  record: NativeRecurringTask['record'],
  rule: RecurringScheduleRule,
) {
  if (record.kind !== rule.kind) return false;
  if (rule.kind === 'every') return record.everySeconds === rule.seconds;
  if (
    rule.kind === 'weekly' &&
    (!Array.isArray(record.weekdays) ||
      record.weekdays.length !== rule.weekdays.length ||
      record.weekdays.some((day, i) => day !== rule.weekdays[i]))
  )
    return false;
  try {
    return (
      typeof record.timeZone === 'string' &&
      record.time === `${rule.time}.000` &&
      new Intl.DateTimeFormat('en', {
        timeZone: record.timeZone,
      }).resolvedOptions().timeZone ===
        new Intl.DateTimeFormat('en', {
          timeZone: rule.timezone,
        }).resolvedOptions().timeZone
    );
  } catch {
    return false;
  }
}
function receiptKey(r: Receipt) {
  return JSON.stringify([r.scheduledAt, r.deliveredAt, r.messageId]);
}
function receipts(task: NativeRecurringTask | null): Receipt[] {
  if (!task) return [];
  return (
    task.deliveryHistory?.records ??
    (task.lastDelivery ? [task.lastDelivery] : [])
  );
}
function stableUuid(parts: readonly string[]) {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Parse with the exact approved DSH value schema, preserving every stored field. */
export function validateRecurringTask(
  c: NativeRecurringControl,
  raw: unknown,
  decode: (value: unknown) => NativeRecurringTask,
) {
  const task = decode(structuredClone(raw));
  nativeOnceDigest(task);
  need(
    isDeepStrictEqual(task, raw) &&
      task.sessionId === c.controlSessionId &&
      task.record.title === TITLE &&
      task.record.prompt === PROMPT &&
      ['every', 'daily', 'weekly'].includes(task.record.kind) &&
      task.status === 'active' &&
      Instant.safeParse(task.record.scheduledAt).success &&
      c.sessionState === 'ready' &&
      !c.taskDeleted,
    'task_invalid',
  );
  need(
    c.nativeTaskId === task.record.id ||
      (c.nativeTaskId === null &&
        c.command.kind === 'create' &&
        c.command.status === 'pending'),
    'task_binding',
  );
  need(
    (c.appliedRule && recurringRecordMatches(task.record, c.appliedRule)) ||
      (c.command.status === 'pending' &&
        ['create', 'update'].includes(c.command.kind) &&
        recurringRecordMatches(task.record, c.rule)),
    'task_rule',
  );
  const history = receipts(task);
  need(
    history.length <= 200 &&
      new Set(history.map(receiptKey)).size === history.length,
    'receipt_history',
  );
  for (const r of history)
    need(
      Instant.safeParse(r.scheduledAt).success &&
        Instant.safeParse(r.deliveredAt).success &&
        Key.safeParse(r.messageId).success &&
        (r.prompt === undefined || r.prompt === PROMPT),
      'receipt_invalid',
    );
  const last = history.at(-1);
  need(
    task.lastDelivery
      ? last &&
          task.lastDelivery.scheduledAt === last.scheduledAt &&
          task.lastDelivery.deliveredAt === last.deliveredAt &&
          task.lastDelivery.messageId === last.messageId
      : !last,
    'receipt_tail',
  );
  return task;
}

/** Pure state transition. SQL persists all receipt links and the full snapshot
 * atomically under the existing DB-time writer and deferred COMMIT fences. */
export function prepareNativeRecurringMutation(input: {
  readiness: NativeOnceReadiness;
  reference: NativeOnceReference;
  writerRow: NativeOnceWriterRow;
  writer: NativeOnceWriter;
  dbNowMs: number;
  before: NativeRecurringSnapshot;
  write: NativeRecurringWrite;
  revisions: ReadonlyMap<number, NativeRecurringRevision>;
  decodeTask: (value: unknown) => NativeRecurringTask;
  admission?: NativeRecurringAdmission;
}) {
  const { writer, write, dbNowMs } = input;
  need(
    nativeOnceReady(input.readiness) &&
      nativeOnceWriterRemaining(input.writerRow, writer, dbNowMs) > 0 &&
      isDeepStrictEqual(input.writerRow.reference, input.reference),
    'writer_fence',
  );
  const c = NativeRecurringControlSchema.parse(
    structuredClone(input.before.control),
  );
  need(
    c.partitionId === writer.partitionId &&
      Key.safeParse(write.writeId).success &&
      write.mutation.controlId === c.controlId &&
      write.digest === nativeOnceDigest(write.mutation),
    'write_invalid',
  );
  nativeOnceDigest(input.before);
  const desired = input.revisions.get(c.revision);
  need(
    desired &&
      isDeepStrictEqual(
        NativeRecurringRevisionSchema.parse(desired).rule,
        c.rule,
      ),
    'revision_missing',
  );
  const after = structuredClone(input.before),
    occurrences: NativeRecurringOccurrence[] = [];
  const m = write.mutation;
  switch (m.kind) {
    case 'session_initializing':
      need(
        c.sessionState === 'reserved' || c.sessionState === 'initializing',
        'session_transition',
      );
      after.control.sessionState = 'initializing';
      break;
    case 'session_ready':
      need(
        c.sessionState === 'initializing' || c.sessionState === 'ready',
        'session_transition',
      );
      after.control.sessionState = 'ready';
      break;
    case 'put_task': {
      const task = validateRecurringTask(c, m.task, input.decodeTask);
      const before =
        input.before.task === null
          ? null
          : validateRecurringTask(c, input.before.task, input.decodeTask);
      const prior = receipts(before),
        next = receipts(task);
      const old = new Map(prior.map((r) => [receiptKey(r), r]));
      const added = next.filter((r) => !old.has(receiptKey(r)));
      for (const r of next)
        if (old.has(receiptKey(r)))
          need(
            isDeepStrictEqual(old.get(receiptKey(r)), r),
            'receipt_rewritten',
          );
      const retained = next.filter((r) => old.has(receiptKey(r)));
      need(
        isDeepStrictEqual(
          retained,
          prior.slice(prior.length - retained.length),
        ),
        'receipt_prefix_changed',
      );
      need(
        retained.length === prior.length ||
          task.deliveryHistory?.earlierRecordsPruned === true,
        'unproved_history_pruning',
      );
      need(
        isDeepStrictEqual(next, [...retained, ...added]),
        'receipt_append_order',
      );
      if (!before)
        need(
          added.length === 0 && c.appliedRevision === null,
          'initial_receipt_fabricated',
        );
      if (added.length) {
        need(
          before &&
            c.appliedRule &&
            c.appliedRevision !== null &&
            recurringRecordMatches(task.record, c.appliedRule),
          'receipt_rule_changed',
        );
        const version = input.revisions.get(c.appliedRevision);
        need(
          version && isDeepStrictEqual(version.rule, c.appliedRule),
          'applied_revision_missing',
        );
        let floor = Date.parse(before.record.scheduledAt);
        for (const receipt of added) {
          need(
            Date.parse(receipt.scheduledAt) >= floor &&
              Date.parse(receipt.scheduledAt) <
                Date.parse(task.record.scheduledAt),
            'receipt_target_rewind',
          );
          floor = Date.parse(receipt.scheduledAt) + 1;
          const key = nativeOnceDigest([
            c.automationId,
            version.revision,
            receipt.scheduledAt,
          ]);
          // Content remains in the immutable version row. Receipts retain its
          // exact digest, avoiding a 40k instruction copy on every timer tick.
          const payload = {
            control: recurringControlIdentity(c),
            revision: {
              revision: version.revision,
              rule: structuredClone(version.rule),
              reservationDigest: version.reservationDigest,
              acceptedAt: version.acceptedAt,
            },
            nativeTaskId: task.record.id,
            receipt: structuredClone(receipt),
          };
          const a = input.admission;
          const reason = !a?.allowed
            ? 'current_authority_changed'
            : a.status !== 'enabled'
              ? 'paused_or_deleted'
              : a.currentRevision !== version.revision
                ? 'configuration_changed'
                : a.resumeAfter &&
                    Date.parse(receipt.scheduledAt) <= Date.parse(a.resumeAfter)
                  ? 'before_resume_watermark'
                  : null;
          occurrences.push({
            id: stableUuid(['recurring-occurrence', key]),
            key,
            clientMessageId: stableUuid(['recurring-message', key]),
            payload,
            payloadDigest: nativeOnceDigest(payload),
            state: reason ? 'blocked' : 'pending',
            reason,
          });
        }
      }
      if (
        !before ||
        (c.command.kind === 'update' &&
          c.command.status === 'pending' &&
          recurringRecordMatches(task.record, c.rule) &&
          !recurringRecordMatches(before.record, c.rule))
      ) {
        need(!added.length, 'update_mixed_with_delivery');
        after.control.appliedRule = structuredClone(c.rule);
        after.control.appliedRevision = c.revision;
      } else if (before) {
        need(
          added.length > 0 ||
            task.record.scheduledAt === before.record.scheduledAt,
          'unproved_target_change',
        );
      }
      after.control.nativeTaskId = task.record.id;
      after.task = task;
      break;
    }
    case 'delete_task':
      need(
        c.command.kind === 'delete' &&
          c.command.status === 'pending' &&
          c.nativeTaskId === m.nativeTaskId,
        'delete_binding',
      );
      after.control.taskDeleted = true;
      after.task = null;
      break;
    case 'confirm_command':
      need(
        c.command.id === m.commandId &&
          c.command.status === 'pending' &&
          c.nativeTaskId === m.nativeTaskId,
        'command_binding',
      );
      if (c.command.kind === 'delete')
        need(c.nativeTaskId === null || c.taskDeleted, 'delete_not_persisted');
      else {
        need(
          after.task !== null &&
            recurringRecordMatches(
              validateRecurringTask(c, after.task, input.decodeTask).record,
              c.rule,
            ),
          'command_not_persisted',
        );
        after.control.appliedRevision = c.revision;
        after.control.appliedRule = structuredClone(c.rule);
      }
      after.control.command.status = 'confirmed';
      break;
    default:
      throw new NativeRecurringStateError('mutation_invalid');
  }
  NativeRecurringControlSchema.parse(after.control);
  nativeOnceDigest(after);
  const journal = {
    writer: {
      partitionId: writer.partitionId,
      ownerId: writer.ownerId,
      epoch: writer.epoch,
      tokenDigest: nativeOnceDigest(writer.token),
    },
    reference: input.reference,
    write,
    identity: recurringControlIdentity(c),
    beforeDigest: nativeOnceDigest(input.before),
    afterDigest: nativeOnceDigest(after),
    receiptLinks: occurrences.map((o) => ({
      id: o.id,
      key: o.key,
      payloadDigest: o.payloadDigest,
    })),
  };
  return { after, occurrences, journal };
}
