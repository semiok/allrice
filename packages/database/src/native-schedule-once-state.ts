import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyDigest } from './runtime-policy.ts';

/** Pure transaction decisions, NOT a SQL Store or an execution grant. Mainline
 * must supply locked DB rows/current ACL facts and atomically persist all effects.
 * There is deliberately no getDatabase(), migration or provider dependency. */
const TTL_MAX = 300_000;
const TITLE = 'AllRice once control';
const PROMPT = 'Synthetic schedule control only. Never execute business work.';
export class NativeOnceStateError extends Error {
  constructor(readonly code: string) {
    super(`native_once_${code}`);
  }
}
const deny = (code: string): never => {
  throw new NativeOnceStateError(code);
};
export interface NativeOnceWriter {
  partitionId: string;
  ownerId: string;
  epoch: number;
  token: string;
}
export interface NativeOnceReference {
  artifactId: string;
  profileId: string;
  storageId: string;
  stateRoot: string;
}
export interface NativeOnceWriterRow {
  partitionId: string;
  ownerId: string | null;
  epoch: number;
  tokenDigest: string | null;
  expiresAtMs: number | null;
  /** Only set after verified Host/backend drain or separately proved exit.
   * TTL expiry alone must NEVER set this bit. */
  closed: boolean;
  reference: NativeOnceReference;
}
export interface NativeOnceReadiness {
  enabled?: boolean;
  storageReady?: boolean;
  legacyClockExcluded?: boolean;
  controlArtifactApproved?: boolean;
}
export const nativeOnceReady = (v: NativeOnceReadiness = {}) =>
  v.enabled === true &&
  v.storageReady === true &&
  v.legacyClockExcluded === true &&
  v.controlArtifactApproved === true;

/** Reuse the existing strict canonical JSON digest, with a smaller control-only
 * bound. Full mutation bytes are still retained/compared; a hash alone is no ACK. */
export function nativeOnceDigest(value: unknown) {
  let nodes = 0;
  const path = new Set<object>();
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 20_000 || depth > 32) deny('json_limit');
    if (v && typeof v === 'object') {
      if (path.has(v)) deny('invalid_json');
      path.add(v);
      if (
        Object.values(Object.getOwnPropertyDescriptors(v)).some(
          (d) => !('value' in d),
        )
      )
        deny('invalid_json');
      for (const child of Object.values(v)) visit(child, depth + 1);
      path.delete(v);
    }
  };
  visit(value, 0);
  let digest: string;
  try {
    digest = runtimePolicyDigest(value);
  } catch {
    return deny('invalid_json');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 65_536) deny('json_limit');
  return digest;
}
const safeTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const goodId = (value: string) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;
function fence(writer: NativeOnceWriter) {
  if (
    !goodId(writer.partitionId) ||
    !goodId(writer.ownerId) ||
    !goodId(writer.token) ||
    !Number.isSafeInteger(writer.epoch) ||
    writer.epoch < 1
  )
    deny('writer_invalid');
  return {
    partitionId: writer.partitionId,
    ownerId: writer.ownerId,
    epoch: writer.epoch,
    tokenDigest: nativeOnceDigest(writer.token),
  };
}
function sameWriter(row: NativeOnceWriterRow, writer: NativeOnceWriter) {
  const f = fence(writer);
  return (
    row.partitionId === f.partitionId &&
    row.ownerId === f.ownerId &&
    row.epoch === f.epoch &&
    row.tokenDigest === f.tokenDigest
  );
}
export function nativeOnceWriterRemaining(
  row: NativeOnceWriterRow,
  writer: NativeOnceWriter,
  dbNowMs: number,
) {
  if (
    !safeTime(dbNowMs) ||
    !sameWriter(row, writer) ||
    row.closed ||
    !safeTime(row.expiresAtMs ?? -1)
  )
    return 0;
  const remaining = row.expiresAtMs! - dbNowMs;
  return remaining > 0 && remaining <= TTL_MAX ? remaining : 0;
}
export function planNativeOnceAcquire(input: {
  readiness?: NativeOnceReadiness;
  row: NativeOnceWriterRow;
  ownerId: string;
  token: string;
  expectedReference: NativeOnceReference;
  dbNowMs: number;
  ttlMs: number;
}) {
  if (!nativeOnceReady(input.readiness)) return null;
  const { row, dbNowMs, ttlMs } = input;
  if (
    !safeTime(dbNowMs) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > TTL_MAX ||
    !Number.isSafeInteger(row.epoch) ||
    row.epoch < 0 ||
    row.epoch >= Number.MAX_SAFE_INTEGER
  )
    deny('writer_invalid');
  if (!isDeepStrictEqual(row.reference, input.expectedReference))
    deny('reference_changed');
  // A failed/partitioned old Host may still own native Sessions after TTL expiry.
  if (!row.closed) return null;
  const writer = {
    partitionId: row.partitionId,
    ownerId: input.ownerId,
    epoch: row.epoch + 1,
    token: input.token,
  };
  const identity = fence(writer);
  const next = {
    ...structuredClone(row),
    ...identity,
    expiresAtMs: dbNowMs + ttlMs,
    closed: false,
  };
  if (!safeTime(next.expiresAtMs)) deny('writer_invalid');
  return { writer, row: next, remainingMs: ttlMs };
}
export function planNativeOnceRenew(
  row: NativeOnceWriterRow,
  writer: NativeOnceWriter,
  dbNowMs: number,
  ttlMs: number,
) {
  if (!nativeOnceWriterRemaining(row, writer, dbNowMs)) return null;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > TTL_MAX ||
    !safeTime(dbNowMs + ttlMs)
  )
    deny('writer_invalid');
  return { ...structuredClone(row), expiresAtMs: dbNowMs + ttlMs };
}
/** Called only AFTER caller proves public Host close + all transactions drained.
 * Expiry does not prevent old-owner close; a later epoch always does. */
export function planNativeOnceClosed(
  row: NativeOnceWriterRow,
  writer: NativeOnceWriter,
) {
  return sameWriter(row, writer)
    ? { ...structuredClone(row), closed: true }
    : null;
}

type NativeOnceDispatchBase = {
  occurrenceId: string;
  employeeAssignmentId: string;
  employeeInstanceId: string;
  businessSessionId: string;
  clientMessageId: string;
  reservationDigest: string;
};
export type NativeOnceDispatch = NativeOnceDispatchBase &
  (
    | { consumer?: never }
    | {
        consumer: 'brand-reminder-v1';
        reminderId: string;
        businessRevision: number;
        plannedAt: string;
        businessOccurrenceId: string;
        businessMessageId: string;
      }
  );
/** Historical ordinary reservations keep their exact bytes. Business consumers
 * use a closed variant, never unchecked extra properties on a chat target. */
export function validNativeOnceDispatch(value: NativeOnceDispatch): boolean {
  if (!value || typeof value !== 'object') return false;
  const base = [
    'occurrenceId',
    'employeeAssignmentId',
    'employeeInstanceId',
    'businessSessionId',
    'clientMessageId',
    'reservationDigest',
  ];
  const extra =
    value.consumer === 'brand-reminder-v1'
      ? [
          'consumer',
          'reminderId',
          'businessRevision',
          'plannedAt',
          'businessOccurrenceId',
          'businessMessageId',
        ]
      : [];
  if (
    Object.keys(value).sort().join(',') !==
      [...base, ...extra].sort().join(',') ||
    !base.every((k) =>
      goodId((value as unknown as Record<string, string>)[k]!),
    ) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.reservationDigest)
  )
    return false;
  return (
    value.consumer !== 'brand-reminder-v1' ||
    ([
      value.reminderId,
      value.businessOccurrenceId,
      value.businessMessageId,
    ].every(goodId) &&
      Number.isSafeInteger(value.businessRevision) &&
      value.businessRevision > 0 &&
      Number.isFinite(Date.parse(value.plannedAt)) &&
      new Date(value.plannedAt).toISOString() === value.plannedAt)
  );
}
export interface NativeOnceControl {
  partitionId: string;
  controlId: string;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  automationId: string;
  revision: number;
  controlSessionId: string;
  at: string;
  sessionState: 'reserved' | 'initializing' | 'ready';
  nativeTaskId: string | null;
  taskDeleted: boolean;
  command: {
    id: string;
    kind: 'create' | 'delete';
    status: 'pending' | 'confirmed' | 'blocked';
  };
  /** Private DB reservation, NOT the synthetic native control Session. */
  dispatch: NativeOnceDispatch;
}
export type NativeOnceMutation = { controlId: string } & (
  | { kind: 'session_initializing' | 'session_ready' }
  | { kind: 'put_task'; task: unknown }
  | { kind: 'delete_task'; nativeTaskId: string }
  | { kind: 'confirm_command'; commandId: string; nativeTaskId: string | null }
  | {
      kind: 'reject_command';
      commandId: string;
      reason: 'target_not_future';
      absence?: {
        controlSessionId: string;
        catalogDigest: string;
        observedAt: string;
        taskCount: 0;
      };
    }
);
export interface NativeOnceWrite {
  writeId: string;
  digest: string;
  mutation: NativeOnceMutation;
}
export interface NativeOnceTask {
  sessionId: string;
  record: {
    id: string;
    kind: string;
    title: string;
    prompt: string;
    scheduledAt: string;
  };
  status: string;
  lastDelivery?: {
    scheduledAt: string;
    deliveredAt: string;
    messageId: string;
  };
  deliveryHistory?: {
    records: {
      scheduledAt: string;
      deliveredAt: string;
      messageId: string;
      prompt?: string;
    }[];
    earlierRecordsUnavailable: boolean;
    earlierRecordsPruned?: boolean;
  };
}
export interface NativeOnceAdmissionFacts {
  /** All fields come from CURRENT rows locked in this same transaction. This
   * structure is evidence input to a pure decision, never an authority token. */
  checkedAtMs: number;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  automationId: string;
  currentRevision: number;
  /** Stable target and task inputs must equal the reservation, not merely
   * an arbitrary assignment/Session that happens to be active now. */
  employeeAssignmentId: string | null;
  employeeInstanceId: string | null;
  businessSessionId: string | null;
  reservationDigest: string | null;
  planStatus: 'enabled' | 'paused' | 'deleted';
  currentWritableIdentity: boolean;
  cloudEnabled: boolean;
  assignmentActive: boolean;
  instanceActive: boolean;
  businessSessionAvailable: boolean;
  legacyClockExcluded: boolean;
}
type OccurrencePayload = {
  control: ReturnType<typeof controlIdentity>;
  nativeTaskId: string;
  receipt: NonNullable<NativeOnceTask['lastDelivery']>;
};
export interface NativeOnceOccurrence {
  id: string;
  key: string;
  payload: OccurrencePayload;
  payloadDigest: string;
  outbox: {
    occurrenceId: string;
    payloadDigest: string;
    state: 'pending' | 'blocked' | 'enqueued';
    reason: string | null;
  };
}
export interface NativeOnceSnapshot {
  control: NativeOnceControl;
  task: unknown | null;
}
export interface NativeOnceJournal {
  writer: ReturnType<typeof fence>;
  referenceDigest: string;
  write: NativeOnceWrite;
  controlIdentity: ReturnType<typeof controlIdentity>;
  afterDigest: string;
  receiptLink: NativeOnceOccurrence | null;
}
function controlIdentity(c: NativeOnceControl) {
  return {
    partitionId: c.partitionId,
    controlId: c.controlId,
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    ownerId: c.ownerId,
    automationId: c.automationId,
    revision: c.revision,
    controlSessionId: c.controlSessionId,
    at: c.at,
    dispatch: structuredClone(c.dispatch),
  };
}
function checkControl(c: NativeOnceControl) {
  if (
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1 ||
    !goodId(c.command.id) ||
    !Number.isFinite(Date.parse(c.at)) ||
    new Date(c.at).toISOString() !== c.at ||
    Object.entries(controlIdentity(c)).some(
      ([k, v]) => k !== 'revision' && k !== 'dispatch' && !goodId(v as string),
    ) ||
    !validNativeOnceDispatch(c.dispatch)
  )
    deny('control_invalid');
}
function checkWrite(write: NativeOnceWrite) {
  const m = write.mutation;
  if (
    !goodId(write.writeId) ||
    !m ||
    !goodId(m.controlId) ||
    write.digest !== nativeOnceDigest(m)
  )
    deny('write_invalid');
  // TS types alone do not validate JSON read from a persistence boundary.
  switch (m.kind) {
    case 'session_initializing':
    case 'session_ready':
      return;
    case 'put_task':
      if (!Object.hasOwn(m, 'task')) deny('write_invalid');
      return;
    case 'delete_task':
      if (!goodId(m.nativeTaskId)) deny('write_invalid');
      return;
    case 'confirm_command':
      if (
        !goodId(m.commandId) ||
        (m.nativeTaskId !== null && !goodId(m.nativeTaskId))
      )
        deny('write_invalid');
      return;
    case 'reject_command':
      if (!goodId(m.commandId) || m.reason !== 'target_not_future')
        deny('write_invalid');
      if (
        m.absence &&
        (Object.keys(m.absence).sort().join(',') !==
          'catalogDigest,controlSessionId,observedAt,taskCount' ||
          !goodId(m.absence.controlSessionId) ||
          !/^sha256:[a-f0-9]{64}$/.test(m.absence.catalogDigest) ||
          m.absence.taskCount !== 0 ||
          !Number.isFinite(Date.parse(m.absence.observedAt)) ||
          new Date(m.absence.observedAt).toISOString() !== m.absence.observedAt)
      )
        deny('write_invalid');
      return;
    default:
      deny('write_invalid');
  }
}
function taskFor(
  c: NativeOnceControl,
  raw: unknown,
  decode: (value: unknown) => NativeOnceTask,
) {
  let task: NativeOnceTask;
  try {
    task = decode(structuredClone(raw));
  } catch {
    return deny('task_invalid');
  }
  nativeOnceDigest(task);
  // Preserve complete canonical native JSON, not a projection that discards facts.
  if (
    !isDeepStrictEqual(task, raw) ||
    task.sessionId !== c.controlSessionId ||
    task.record.kind !== 'at' ||
    !goodId(task.record.id) ||
    task.record.title !== TITLE ||
    task.record.prompt !== PROMPT ||
    task.record.scheduledAt !== c.at ||
    (task.lastDelivery
      ? task.status !== 'inactive'
      : task.status !== 'active') ||
    c.sessionState !== 'ready' ||
    c.taskDeleted ||
    (c.nativeTaskId !== task.record.id &&
      (c.nativeTaskId !== null ||
        c.command.kind !== 'create' ||
        c.command.status !== 'pending'))
  )
    deny('task_invalid');
  const receipt = task.lastDelivery;
  if (
    receipt &&
    (receipt.scheduledAt !== c.at ||
      !goodId(receipt.messageId) ||
      !Number.isFinite(Date.parse(receipt.deliveredAt)))
  )
    deny('receipt_invalid');
  const history = task.deliveryHistory;
  if (
    history &&
    (history.records.length > 1 ||
      history.records.some(
        (r) =>
          !receipt ||
          r.scheduledAt !== c.at ||
          r.messageId !== receipt.messageId ||
          r.deliveredAt !== receipt.deliveredAt ||
          (r.prompt !== undefined && r.prompt !== PROMPT),
      ))
  )
    deny('receipt_invalid');
  return task;
}
function eligibility(
  c: NativeOnceControl,
  facts: NativeOnceAdmissionFacts | undefined,
  now: number,
) {
  if (!facts || facts.checkedAtMs !== now) return 'authority_unavailable';
  if (
    facts.organizationId !== c.organizationId ||
    facts.workspaceId !== c.workspaceId ||
    facts.ownerId !== c.ownerId ||
    facts.automationId !== c.automationId
  )
    deny('scope_mismatch');
  if (facts.currentRevision !== c.revision) return 'revision_changed';
  if (
    facts.employeeAssignmentId !== c.dispatch.employeeAssignmentId ||
    facts.employeeInstanceId !== c.dispatch.employeeInstanceId ||
    facts.businessSessionId !== c.dispatch.businessSessionId
  )
    return 'binding_changed';
  if (facts.reservationDigest !== c.dispatch.reservationDigest)
    return 'reservation_changed';
  if (facts.planStatus !== 'enabled') return 'plan_inactive';
  if (Date.parse(c.at) > now) return 'target_not_due';
  if (
    !facts.currentWritableIdentity ||
    !facts.assignmentActive ||
    !facts.instanceActive ||
    !facts.businessSessionAvailable
  )
    return 'current_access_denied';
  if (!facts.cloudEnabled) return 'cloud_disabled';
  return facts.legacyClockExcluded ? null : 'legacy_clock_not_excluded';
}
/** Run only while the SQL caller holds the full fence + immutable control row
 * and current ACL locks. Caller must recheck DB time/fence at commit and write
 * snapshot, receipt/occurrence, outbox and journal in ONE transaction. */
export function prepareNativeOnceMutation(input: {
  readiness?: NativeOnceReadiness;
  writerRow: NativeOnceWriterRow;
  writer: NativeOnceWriter;
  dbNowMs: number;
  before: NativeOnceSnapshot;
  write: NativeOnceWrite;
  decodeTask: (value: unknown) => NativeOnceTask;
  admission?: NativeOnceAdmissionFacts;
  existingOccurrence?: NativeOnceOccurrence;
}) {
  if (!nativeOnceReady(input.readiness)) deny('disabled');
  if (!nativeOnceWriterRemaining(input.writerRow, input.writer, input.dbNowMs))
    deny('lease_lost');
  checkWrite(input.write);
  const after = structuredClone(input.before),
    c = after.control,
    m = input.write.mutation;
  checkControl(c);
  if (c.partitionId !== input.writer.partitionId || c.controlId !== m.controlId)
    deny('scope_mismatch');
  let occurrence: NativeOnceOccurrence | null = null;
  if (m.kind === 'session_initializing') {
    if (c.sessionState !== 'reserved') deny('session_cas');
    c.sessionState = 'initializing';
  } else if (m.kind === 'session_ready') {
    if (c.sessionState !== 'initializing') deny('session_cas');
    c.sessionState = 'ready';
  } else if (m.kind === 'put_task') {
    const task = taskFor(c, m.task, input.decodeTask);
    if (after.task !== null) {
      const previous = taskFor(c, after.task, input.decodeTask);
      if (
        previous.lastDelivery &&
        !isDeepStrictEqual(previous.lastDelivery, task.lastDelivery)
      )
        deny('receipt_rewind');
    }
    c.nativeTaskId = task.record.id;
    after.task = structuredClone(task);
    if (task.lastDelivery) {
      const payload = {
        control: controlIdentity(c),
        nativeTaskId: task.record.id,
        receipt: structuredClone(task.lastDelivery),
      };
      const payloadDigest = nativeOnceDigest(payload);
      const key = nativeOnceDigest([
        c.automationId,
        c.revision,
        task.lastDelivery.scheduledAt,
      ]);
      const reason = eligibility(c, input.admission, input.dbNowMs);
      const outbox = {
        occurrenceId: c.dispatch.occurrenceId,
        payloadDigest,
        state: reason ? ('blocked' as const) : ('pending' as const),
        reason,
      };
      occurrence = {
        id: c.dispatch.occurrenceId,
        key,
        payload,
        payloadDigest,
        outbox,
      };
      if (input.existingOccurrence) {
        const previous = input.existingOccurrence;
        if (
          previous.id !== occurrence.id ||
          previous.key !== key ||
          previous.payloadDigest !== payloadDigest ||
          !isDeepStrictEqual(previous.payload, payload) ||
          previous.outbox.occurrenceId !== previous.id ||
          previous.outbox.payloadDigest !== payloadDigest
        )
          deny('occurrence_conflict');
        // Historical record recovery never rewinds an outbox or reauthorizes it.
        occurrence = structuredClone(previous);
      }
    }
  } else if (m.kind === 'delete_task') {
    if (
      c.nativeTaskId !== m.nativeTaskId ||
      c.command.kind !== 'delete' ||
      c.command.status !== 'pending'
    )
      deny('command_cas');
    after.task = null;
    c.taskDeleted = true;
  } else if (m.kind === 'confirm_command') {
    if (
      c.command.id !== m.commandId ||
      c.command.status !== 'pending' ||
      c.nativeTaskId !== m.nativeTaskId ||
      (c.command.kind === 'create'
        ? after.task === null || c.taskDeleted
        : c.nativeTaskId !== null && !c.taskDeleted)
    )
      deny('command_cas');
    c.command.status = 'confirmed';
  } else if (m.kind === 'reject_command') {
    if (
      m.reason !== 'target_not_future' ||
      c.command.id !== m.commandId ||
      c.command.kind !== 'create' ||
      c.command.status !== 'pending' ||
      c.nativeTaskId !== null ||
      after.task !== null ||
      (m.absence && m.absence.controlSessionId !== c.controlSessionId) ||
      (c.dispatch.consumer === 'brand-reminder-v1' && !m.absence)
    )
      deny('command_cas');
    c.command.status = 'blocked';
  } else deny('mutation_invalid');
  const journal: NativeOnceJournal = {
    writer: fence(input.writer),
    referenceDigest: nativeOnceDigest(input.writerRow.reference),
    write: structuredClone(input.write),
    controlIdentity: controlIdentity(c),
    afterDigest: nativeOnceDigest(after),
    receiptLink: occurrence ? structuredClone(occurrence) : null,
  };
  return { after, occurrence, journal };
}

export type NativeOnceCommitEvidence =
  | { kind: 'unknown' }
  | { kind: 'absent'; partitionId: string; writeId: string }
  | {
      kind: 'found';
      journal: NativeOnceJournal;
      committedSnapshot: NativeOnceSnapshot;
      immutableControl: NativeOnceControl;
      reference: NativeOnceReference;
      occurrence: NativeOnceOccurrence | null;
    };
/** Evidence must come from a consistent primary SQL read, never cached Host
 * state. This confirms an exact historical COMMIT only; it grants NO admission. */
export function verifyExactNativeOnceCommit(
  writer: NativeOnceWriter,
  write: NativeOnceWrite,
  evidence: NativeOnceCommitEvidence,
): 'committed' | 'absent' | 'unknown' {
  try {
    checkWrite(write);
    if (evidence.kind === 'unknown') return 'unknown';
    if (evidence.kind === 'absent')
      return evidence.partitionId === writer.partitionId &&
        evidence.writeId === write.writeId
        ? 'absent'
        : 'unknown';
    const j = evidence.journal,
      after = evidence.committedSnapshot,
      c = after.control,
      m = write.mutation;
    checkControl(c);
    if (
      !isDeepStrictEqual(j.writer, fence(writer)) ||
      !isDeepStrictEqual(j.write, write) ||
      j.referenceDigest !== nativeOnceDigest(evidence.reference) ||
      !isDeepStrictEqual(
        j.controlIdentity,
        controlIdentity(evidence.immutableControl),
      ) ||
      !isDeepStrictEqual(j.controlIdentity, controlIdentity(c)) ||
      c.partitionId !== writer.partitionId ||
      c.controlId !== m.controlId ||
      j.afterDigest !== nativeOnceDigest(after)
    )
      return 'unknown';
    if (m.kind === 'put_task') {
      if (!isDeepStrictEqual(after.task, m.task)) return 'unknown';
      const task = after.task as NativeOnceTask;
      if (
        c.nativeTaskId !== task.record.id ||
        task.sessionId !== c.controlSessionId
      )
        return 'unknown';
      if (task.lastDelivery) {
        const o = evidence.occurrence,
          link = j.receiptLink;
        const payload = {
          control: controlIdentity(c),
          nativeTaskId: task.record.id,
          receipt: task.lastDelivery,
        };
        if (
          !o ||
          !link ||
          o.id !== c.dispatch.occurrenceId ||
          o.key !==
            nativeOnceDigest([
              c.automationId,
              c.revision,
              task.lastDelivery.scheduledAt,
            ]) ||
          o.payloadDigest !== nativeOnceDigest(payload) ||
          !isDeepStrictEqual(o.payload, payload) ||
          o.outbox.occurrenceId !== o.id ||
          o.outbox.payloadDigest !== o.payloadDigest ||
          link.id !== o.id ||
          link.key !== o.key ||
          !isDeepStrictEqual(link.payload, o.payload) ||
          link.payloadDigest !== o.payloadDigest ||
          link.outbox.occurrenceId !== o.id ||
          link.outbox.payloadDigest !== o.payloadDigest
        )
          return 'unknown';
      } else if (j.receiptLink) return 'unknown';
    } else {
      if (j.receiptLink) return 'unknown';
      if (
        m.kind === 'delete_task' &&
        (after.task !== null ||
          !c.taskDeleted ||
          c.nativeTaskId !== m.nativeTaskId)
      )
        return 'unknown';
      if (
        m.kind === 'session_initializing' &&
        c.sessionState !== 'initializing'
      )
        return 'unknown';
      if (m.kind === 'session_ready' && c.sessionState !== 'ready')
        return 'unknown';
      if (
        m.kind === 'confirm_command' &&
        (c.command.id !== m.commandId ||
          c.command.status !== 'confirmed' ||
          c.nativeTaskId !== m.nativeTaskId)
      )
        return 'unknown';
      if (
        m.kind === 'reject_command' &&
        (c.command.id !== m.commandId || c.command.status !== 'blocked')
      )
        return 'unknown';
    }
    return 'committed';
  } catch {
    return 'unknown';
  }
}
