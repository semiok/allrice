import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql as Tx } from 'postgres';
import { getDatabase } from '../core/client.ts';
import { acquireDevAdmission } from '../dev-maintenance.ts';
import { BrandContentError } from './rules.ts';
import {
  nativeOnceDigest,
  nativeOnceReady,
  type NativeOnceControl,
  type NativeOnceSnapshot,
  type NativeOnceJournal,
} from '../native-schedule-once-state.ts';
import type { NativeOnceLockedAdmission } from '../native-schedule-once-sql.ts';
import {
  lockBrandContentReminder,
  completeBrandContentReminder,
  type ReminderRow,
  type BrandReminderGate,
} from './scheduling.ts';

const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
function fail(): never {
  throw new Error('brand_native_reminder_binding_invalid');
}
const PARTITION = 'allrice-once-v1';
const MAX_ATTEMPTS = 8;
type Target = {
  reminder_id: string;
  automation_id: string;
  business_revision: number;
  attempt: number;
  control_id: string;
  partition_id: string;
};
type ControlRow = {
  immutable_control: NativeOnceControl;
  snapshot: NativeOnceSnapshot;
  snapshot_version: string | number;
};

function reservation(row: ReminderRow, revision: number) {
  return nativeOnceDigest({
    reminderId: row.id,
    automationId: row.automation_id,
    revision,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    assignmentId: row.assignment_id,
    instanceId: row.instance_id,
    sessionId: row.session_id,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    plannedAt: row.scheduled_for.toISOString(),
    bundleId: row.bundle_id,
    reviewId: row.review_id,
    bundleDigest: row.bundle_digest,
    workflowRevisionId: row.workflow_revision_id,
    packageDigest: row.package_digest,
    occurrenceId: row.reserved_occurrence_id,
    messageId: row.reserved_message_id,
  });
}
function matches(
  c: NativeOnceControl,
  target: Target,
  gate: BrandReminderGate,
) {
  const d = c.dispatch,
    r = gate.binding;
  return (
    d.consumer === 'brand-reminder-v1' &&
    target.reminder_id === r.id &&
    target.automation_id === r.automation_id &&
    target.control_id === c.controlId &&
    target.partition_id === c.partitionId &&
    target.attempt === c.revision &&
    target.business_revision === d.businessRevision &&
    gate.automation.revision === d.businessRevision &&
    d.reminderId === r.id &&
    c.automationId === r.automation_id &&
    c.organizationId === r.organization_id &&
    c.workspaceId === r.workspace_id &&
    c.ownerId === r.owner_id &&
    d.employeeAssignmentId === r.assignment_id &&
    d.employeeInstanceId === r.instance_id &&
    d.businessSessionId === r.session_id &&
    d.businessOccurrenceId === r.reserved_occurrence_id &&
    d.businessMessageId === r.reserved_message_id &&
    d.plannedAt === r.scheduled_for.toISOString() &&
    Date.parse(c.at) >= r.scheduled_for.getTime() &&
    d.reservationDigest === reservation(r, d.businessRevision) &&
    gate.automation.clock_owner === 'native_once'
  );
}
async function insertControl(
  tx: Tx,
  row: ReminderRow,
  businessRevision: number,
  attempt: number,
  at: string,
) {
  const c: NativeOnceControl = {
    partitionId: PARTITION,
    controlId: randomUUID(),
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    automationId: row.automation_id,
    revision: attempt,
    controlSessionId: `once-${randomUUID()}`,
    at,
    sessionState: 'reserved',
    nativeTaskId: null,
    taskDeleted: false,
    command: { id: randomUUID(), kind: 'create', status: 'pending' },
    dispatch: {
      consumer: 'brand-reminder-v1',
      reminderId: row.id,
      businessRevision,
      plannedAt: row.scheduled_for.toISOString(),
      businessOccurrenceId: row.reserved_occurrence_id,
      businessMessageId: row.reserved_message_id,
      occurrenceId: randomUUID(),
      clientMessageId: randomUUID(),
      employeeAssignmentId: row.assignment_id,
      employeeInstanceId: row.instance_id,
      businessSessionId: row.session_id,
      reservationDigest: reservation(row, businessRevision),
    },
  };
  await tx`insert into allrice_native_once_controls
    (partition_id,control_id,automation_id,revision,control_session_id,occurrence_id,client_message_id,immutable_control,snapshot)
    values(${c.partitionId},${c.controlId},${c.automationId},${c.revision},${c.controlSessionId},${c.dispatch.occurrenceId},
      ${c.dispatch.clientMessageId},${json(tx, c)},${json(tx, { control: c, task: null })})`;
  return c;
}
/** Called inside the existing authorized registration transaction; never creates
 * another plan, request, business occurrence or chat message identity. */
export async function enrollBrandReminderNative(tx: Tx, row: ReminderRow) {
  const [partition] =
    await tx`select activation from allrice_native_once_partitions where partition_id=${PARTITION} for share`;
  if (!partition || !nativeOnceReady(partition.activation))
    throw new BrandContentError('reminder_unavailable');
  const [automation] =
    await tx`select revision,clock_owner from allrice_automations where id=${row.automation_id} for update`;
  if (
    !automation ||
    automation.clock_owner !== 'legacy' ||
    row.state !== 'registered'
  )
    fail();
  const revision = Number(automation.revision);
  const [now] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  const at = new Date(
    Math.max(row.scheduled_for.getTime(), now!.now.getTime() + 15_000),
  ).toISOString();
  await tx`update allrice_automations set clock_owner='native_once',native_once_request_id=${row.id},native_once_request_digest=${row.request_digest}
    where id=${row.automation_id}`;
  const c = await insertControl(tx, row, revision, 1, at);
  await tx`insert into allrice_brand_native_reminder_targets(reminder_id,automation_id,business_revision,attempt,partition_id,control_id)
    values(${row.id},${row.automation_id},${revision},1,${c.partitionId},${c.controlId})`;
}

async function lockedTarget(tx: Tx, c: NativeOnceControl) {
  const gate = await lockBrandContentReminder(tx, c.automationId);
  if (!gate) return null;
  const [target] = await tx<
    Target[]
  >`select * from allrice_brand_native_reminder_targets where automation_id=${c.automationId} for update`;
  return target ? { gate, target } : null;
}
export async function lockBrandNativeReminderAdmission(
  tx: Tx,
  c: NativeOnceControl,
): Promise<NativeOnceLockedAdmission | null> {
  const state = await lockedTarget(tx, c);
  if (!state) return null;
  const { gate, target } = state,
    current = matches(c, target, gate),
    allowed = current && !gate.blocked;
  return {
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    ownerId: c.ownerId,
    automationId: c.automationId,
    currentRevision: target.attempt,
    employeeAssignmentId: gate.binding.assignment_id,
    employeeInstanceId: gate.binding.instance_id,
    businessSessionId: gate.binding.session_id,
    reservationDigest: current ? c.dispatch.reservationDigest : null,
    planStatus: gate.automation.deleted_at
      ? 'deleted'
      : gate.automation.status === 'enabled'
        ? 'enabled'
        : 'paused',
    currentWritableIdentity: allowed,
    cloudEnabled: allowed,
    assignmentActive: allowed,
    instanceActive: allowed,
    businessSessionAvailable: allowed,
    legacyClockExcluded: gate.automation.clock_owner === 'native_once',
  };
}

/** Only an exact journaled rejection with a fresh complete public catalog proof
 * can reserve another attempt. Unknown writes never enter this path. Existing
 * controller refresh performs real close/drain before the new control is used. */
export async function reconcileBrandNativeReminderAttempt() {
  const db = getDatabase();
  const result = await db.begin(async (tx) => {
    await tx`set local lock_timeout='1000ms'`;
    await tx`set local statement_timeout='10000ms'`;
    await acquireDevAdmission(tx);
    const [candidate] = await tx<
      { snapshot: NativeOnceSnapshot }[]
    >`select c.snapshot from allrice_brand_native_reminder_targets t
      join allrice_brand_content_reminders r on r.id=t.reminder_id and r.state='registered'
      join allrice_native_once_controls c on c.partition_id=t.partition_id and c.control_id=t.control_id
      where c.snapshot->'control'->'command'->>'kind'='create' and c.snapshot->'control'->'command'->>'status'='blocked'
      order by t.reminder_id limit 1`;
    if (!candidate) return null;
    const c = candidate.snapshot.control,
      state = await lockedTarget(tx, c);
    if (!state || !matches(c, state.target, state.gate)) return false;
    const [current] = await tx<
      ControlRow[]
    >`select immutable_control,snapshot,snapshot_version from allrice_native_once_controls
      where partition_id=${c.partitionId} and control_id=${c.controlId} for update`;
    if (
      !current ||
      !isDeepStrictEqual(current.snapshot, candidate.snapshot) ||
      current.snapshot.task !== null ||
      c.nativeTaskId !== null ||
      c.command.kind !== 'create' ||
      c.command.status !== 'blocked'
    )
      return false;
    const [receipt] =
      await tx`select 1 from allrice_native_once_occurrences where partition_id=${c.partitionId} and control_id=${c.controlId}`;
    if (receipt) fail();
    const proofs = await tx<
      {
        journal: NativeOnceJournal;
        after_snapshot: NativeOnceSnapshot;
        reference: unknown;
        writer_owner_id: string;
        writer_epoch: string;
        writer_token_digest: string;
      }[]
    >`
      select journal,after_snapshot,reference,writer_owner_id,writer_epoch,writer_token_digest from allrice_native_once_journal
      where partition_id=${c.partitionId} and control_id=${c.controlId} and entry_kind='control'
        and mutation->>'kind'='reject_command' and mutation->>'commandId'=${c.command.id}`;
    if (proofs.length !== 1) return false;
    const proof = proofs[0]!,
      j = proof.journal,
      m = j.write.mutation;
    if (
      m.kind !== 'reject_command' ||
      m.reason !== 'target_not_future' ||
      !m.absence ||
      m.absence.controlSessionId !== c.controlSessionId ||
      m.absence.taskCount !== 0 ||
      !/^sha256:[a-f0-9]{64}$/.test(m.absence.catalogDigest) ||
      m.controlId !== c.controlId ||
      m.commandId !== c.command.id ||
      j.receiptLink !== null ||
      j.write.digest !== nativeOnceDigest(m) ||
      j.afterDigest !== nativeOnceDigest(current.snapshot) ||
      !isDeepStrictEqual(proof.after_snapshot, current.snapshot) ||
      j.referenceDigest !== nativeOnceDigest(proof.reference) ||
      j.writer.ownerId !== proof.writer_owner_id ||
      j.writer.epoch !== Number(proof.writer_epoch) ||
      j.writer.tokenDigest !== proof.writer_token_digest
    )
      return false;
    // Denied/canceled business work must not be rescheduled, even if its clock
    // was rejected before creation. Expose the original deterministic failure.
    if (state.gate.blocked || c.revision >= MAX_ATTEMPTS) {
      await completeBrandContentReminder(tx, state.gate, {
        blocked: state.gate.blocked ?? 'NATIVE_ATTEMPT_LIMIT',
      });
      return true;
    }
    const [now] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
    const next = await insertControl(
      tx,
      state.gate.binding,
      state.target.business_revision,
      c.revision + 1,
      new Date(now!.now.getTime() + 15_000).toISOString(),
    );
    await tx`update allrice_brand_native_reminder_targets set attempt=${next.revision},control_id=${next.controlId}
      where reminder_id=${state.target.reminder_id} and attempt=${c.revision} and control_id=${c.controlId}`;
    return true;
  });
  return result ?? false;
}

type Receipt = {
  occurrence_id: string;
  payload_digest: string;
  payload: {
    control: unknown;
    nativeTaskId: string;
    receipt: { scheduledAt: string };
  };
  outbox_state: string;
  outbox_reason: string | null;
  outbox_owner_id: string | null;
  outbox_epoch: string | number;
  outbox_token_digest: string | null;
};
/** Same original private message sink; this branch never enters the chat Run queue. */
export async function dispatchBrandNativeReminder(
  tx: Tx,
  c: NativeOnceControl,
  receipt: Receipt,
  workerId: string,
  tokenDigest: string,
) {
  const state = await lockedTarget(tx, c);
  const [live] = await tx<
    Receipt[]
  >`select * from allrice_native_once_occurrences where occurrence_id=${receipt.occurrence_id} for update`;
  if (
    !live ||
    live.outbox_owner_id !== workerId ||
    live.outbox_epoch !== receipt.outbox_epoch ||
    live.outbox_token_digest !== tokenDigest ||
    !isDeepStrictEqual(live.payload, receipt.payload) ||
    live.payload_digest !== nativeOnceDigest(receipt.payload)
  )
    fail();
  const [lease] =
    await tx`select 1 from allrice_native_once_occurrences where occurrence_id=${live.occurrence_id} and outbox_expires_at>clock_timestamp()`;
  if (!lease) fail();
  if (!state || !matches(c, state.target, state.gate)) {
    if (live.outbox_state === 'pending')
      await tx`update allrice_native_once_occurrences set outbox_state='blocked',outbox_reason='brand_binding_changed' where occurrence_id=${live.occurrence_id}`;
    return;
  }
  const [mapped] =
    await tx`select 1 from allrice_native_once_controls where partition_id=${c.partitionId} and control_id=${c.controlId}
    and native_task_id=${live.payload.nativeTaskId} and immutable_control->'dispatch'=${json(tx, c.dispatch)}
    and immutable_control->>'at'=${live.payload.receipt.scheduledAt}`;
  if (!mapped || !['pending', 'blocked'].includes(live.outbox_state)) fail();
  const denied =
    state.gate.blocked ??
    (live.outbox_state === 'blocked'
      ? (live.outbox_reason ?? 'NATIVE_RECEIPT_BLOCKED')
      : null);
  await completeBrandContentReminder(tx, state.gate, {
    nativeOccurrenceId: live.occurrence_id,
    ...(denied ? { blocked: denied } : {}),
  });
  if (denied) {
    if (live.outbox_state === 'pending')
      await tx`update allrice_native_once_occurrences set outbox_state='blocked',outbox_reason=${denied} where occurrence_id=${live.occurrence_id}`;
  } else {
    const r = state.gate.binding;
    const binding = {
      consumer: 'brand-reminder-v1',
      reminderId: r.id,
      automationRunId: r.reserved_occurrence_id,
      messageId: r.reserved_message_id,
      organizationId: r.organization_id,
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      sessionId: r.session_id,
      payloadDigest: live.payload_digest,
    };
    await tx`update allrice_native_once_occurrences set outbox_state='enqueued',business_binding=${json(tx, binding)} where occurrence_id=${live.occurrence_id}`;
  }
}

/** Called only after the original brand/plan cancellation locks. */
export async function cancelBrandNativeReminder(tx: Tx, automationId: string) {
  const rows = await tx<
    { partition_id: string; control_id: string; snapshot: NativeOnceSnapshot }[]
  >`select c.partition_id,c.control_id,c.snapshot
    from allrice_native_once_controls c join allrice_brand_native_reminder_targets t on t.automation_id=c.automation_id
    where t.automation_id=${automationId} order by c.revision for update of c`;
  for (const row of rows) {
    if (row.snapshot.control.command.kind === 'delete') continue;
    row.snapshot.control.command = {
      id: randomUUID(),
      kind: 'delete',
      status: 'pending',
    };
    await tx`update allrice_native_once_controls set snapshot=${json(tx, row.snapshot)},snapshot_version=snapshot_version+1
      where partition_id=${row.partition_id} and control_id=${row.control_id}`;
  }
  await tx`update allrice_native_once_occurrences set outbox_state='blocked',outbox_reason='user_canceled'
    where automation_id=${automationId} and outbox_state='pending'`;
}
