import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql as Tx } from 'postgres';
import { z } from 'zod';
import type { QualityScheduleOrigin } from './platform-quality-contracts.ts';
import { DataAccessError } from './data.ts';
import { isPlatformAdmin } from './platform-authority.ts';
import { cloudStableId } from './cloud-execution.ts';
import {
  nativeOnceDigest,
  nativeOnceReady,
} from './native-schedule-once-state.ts';
import {
  NativeRecurringControlSchema,
  NativeRecurringRevisionSchema,
  recurringControlIdentity,
  type NativeRecurringControl,
  type NativeRecurringRevision,
  type NativeRecurringSnapshot,
  type NativeRecurringAdmission,
  type NativeRecurringOccurrence,
} from './native-schedule-recurring-state.ts';
import {
  qualityScheduleConfigurationDigest,
  QualityScheduleUnavailableError,
  reservePlatformQualityOccurrence,
  type QualityScheduleRule,
} from './platform-quality-automation.ts';

const PARTITION = 'allrice-recurring-v1';
const CONSUMER = 'platform-quality-v1';
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
const scheduleSchema = z
  .object({
    frequency: z.literal('daily'),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    timezone: z.literal('Asia/Shanghai'),
  })
  .strict();
type Rule = QualityScheduleRule & {
  clock_owner: string;
  name: string;
  prompt: string;
  native_recurring_revision: number | null;
  native_recurring_resume_after: Date | null;
  created_at: Date;
};
type QualityVersion = Extract<
  NativeRecurringRevision,
  { consumer: typeof CONSUMER }
>;
function invalid(): never {
  throw new DataAccessError('authorization_denied');
}
function qualityReceiptReason(reason: string | null | undefined) {
  const known: Record<string, string> = {
    current_authority_changed: 'QUALITY_PREPARATION_BLOCKED',
    paused_or_deleted: 'QUALITY_SCHEDULE_PAUSED',
    configuration_changed: 'QUALITY_SCHEDULE_CHANGED',
    quality_configuration_changed: 'QUALITY_SCHEDULE_CHANGED',
    before_resume_watermark: 'QUALITY_BEFORE_RESUME',
  };
  return reason && /^[A-Z0-9_]{1,100}$/.test(reason)
    ? reason
    : (known[reason ?? ''] ?? 'QUALITY_NATIVE_BLOCKED');
}
function versionFor(
  rule: Rule,
  acceptedAt: string,
  legacyScheduledFor: string | null = null,
): QualityVersion {
  const schedule = scheduleSchema.parse(rule.schedule);
  const version = {
    consumer: CONSUMER as typeof CONSUMER,
    revision: Number(rule.revision),
    name: rule.name,
    prompt: rule.prompt,
    rule: {
      kind: 'daily' as const,
      time: `${schedule.time}:00`,
      timezone: schedule.timezone,
    },
    acceptedAt,
    qualityConfigurationDigest: qualityScheduleConfigurationDigest(rule),
    legacyScheduledFor,
  };
  return {
    ...version,
    reservationDigest: nativeOnceDigest({
      automationId: rule.id,
      organizationId: rule.organization_id,
      workspaceId: rule.workspace_id,
      ownerId: rule.owner_id,
      ...version,
    }),
  };
}

/** Existing configuration transaction owns user -> rule locks. Preserve the
 * original daily rule, request identity and private workspace, not a chat copy. */
export async function syncPlatformQualityNative(tx: Tx, automationId: string) {
  const [rule] = await tx<
    Rule[]
  >`select * from allrice_automations where id=${automationId} for update`;
  if (!rule?.quality_binding) invalid();
  if (
    rule.clock_owner !== 'native_recurring' &&
    (process.env.ALLRICE_NATIVE_RECURRING_ENABLED !== '1' || rule.deleted_at)
  )
    return false;
  scheduleSchema.parse(rule.schedule);
  const [now] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  const [current] = await tx<{ snapshot: NativeRecurringSnapshot }[]>`
    select snapshot from allrice_native_recurring_controls where automation_id=${rule.id} for update`;
  if (rule.clock_owner === 'native_recurring' && !current) invalid();
  if (!current) {
    if (rule.clock_owner !== 'legacy') invalid();
    const [partition] =
      await tx`select activation from allrice_native_once_partitions where partition_id=${PARTITION} for share`;
    if (!partition || !nativeOnceReady(partition.activation))
      throw new QualityScheduleUnavailableError();
    // Do not reinterpret an overdue historical target as a new native schedule.
    // The authorized configuration transaction must supply a future target.
    if (
      rule.status === 'enabled' &&
      rule.next_run_at &&
      rule.next_run_at <= now!.now
    )
      return false;
    const version = versionFor(
      rule,
      now!.now.toISOString(),
      rule.status === 'enabled'
        ? (rule.next_run_at?.toISOString() ?? null)
        : null,
    );
    const control: NativeRecurringControl = {
      kind: 'recurring',
      partitionId: PARTITION,
      controlId: randomUUID(),
      organizationId: rule.organization_id,
      workspaceId: rule.workspace_id,
      ownerId: rule.owner_id,
      automationId: rule.id,
      revision: Number(rule.revision),
      controlSessionId: `recurring-${randomUUID()}`,
      rule: version.rule,
      appliedRevision: null,
      appliedRule: null,
      sessionState: 'reserved',
      nativeTaskId: null,
      taskDeleted: false,
      command: { id: randomUUID(), kind: 'create', status: 'pending' },
      dispatch: { consumer: CONSUMER },
    };
    // The original future target is a lower bound, never a synthesized receipt.
    const watermark = new Date(
      Math.max(now!.now.getTime(), (rule.next_run_at?.getTime() ?? 0) - 1),
    );
    await tx`update allrice_automations set clock_owner='native_recurring',native_recurring_request_id=${rule.id},
      native_recurring_request_digest=${version.reservationDigest},native_recurring_revision=${rule.revision},
      native_recurring_resume_after=${watermark},next_run_at=null where id=${rule.id}`;
    await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration)
      values(${rule.id},${rule.revision},${json(tx, version)})`;
    await tx`insert into allrice_native_recurring_controls(partition_id,control_id,automation_id,control_session_id,immutable_identity,snapshot)
      values(${PARTITION},${control.controlId},${rule.id},${control.controlSessionId},${json(tx, recurringControlIdentity(control))},${json(tx, { control, task: null })})`;
    return true;
  }
  const control = NativeRecurringControlSchema.parse(current.snapshot.control);
  if (
    !('consumer' in control.dispatch) ||
    control.dispatch.consumer !== CONSUMER
  )
    invalid();
  if (rule.deleted_at) {
    if (control.command.kind !== 'delete')
      control.command = { id: randomUUID(), kind: 'delete', status: 'pending' };
  } else {
    if (control.revision === Number(rule.revision)) return true;
    if (
      control.revision > Number(rule.revision) ||
      control.taskDeleted ||
      control.command.kind === 'delete'
    )
      invalid();
    const version = versionFor(rule, now!.now.toISOString());
    await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration)
      values(${rule.id},${rule.revision},${json(tx, version)})`;
    control.revision = Number(rule.revision);
    control.rule = version.rule;
    control.command = {
      id: randomUUID(),
      kind: control.nativeTaskId ? 'update' : 'create',
      status: 'pending',
    };
    await tx`update allrice_automations set native_recurring_revision=${rule.revision},
      native_recurring_resume_after=${now!.now},next_run_at=null where id=${rule.id}`;
  }
  await tx`update allrice_native_recurring_controls set snapshot=${json(tx, { ...current.snapshot, control })},snapshot_version=snapshot_version+1
    where partition_id=${control.partitionId} and control_id=${control.controlId}`;
  await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',outbox_reason='quality_configuration_changed'
    where automation_id=${rule.id} and outbox_state='pending'`;
  return true;
}

/** No ordinary personal cloud toggle or borrowed company login grants platform
 * QA. Current platform authority and the original private deployment are held. */
async function lockQualityRule(tx: Tx, ownerId: string, automationId: string) {
  await tx`select id from allrice_users where id=${ownerId} for no key update`;
  const [rule] = await tx<
    Rule[]
  >`select * from allrice_automations where id=${automationId} and owner_id=${ownerId} for update`;
  if (!rule?.quality_binding) return null;
  const platform = await isPlatformAdmin(
    { actor: { type: 'user', id: ownerId } },
    tx,
  );
  const [target] =
    await tx`select a.id from allrice_platform_quality_deployments d
    join allrice_employee_assignments a on a.id=d.assignment_id and a.organization_id=d.organization_id and a.workspace_id=d.workspace_id and a.user_id=d.owner_id
    join allrice_employees e on e.id=a.employee_id and e.status='active'
    join allrice_platform_employee_tenant_assignments pa on pa.tenant_employee_id=e.id and pa.workspace_id=d.workspace_id and pa.active
    join allrice_organizations o on o.id=d.organization_id and o.slug='allrice-platform' and o.archived_at is null
    join allrice_workspaces w on w.id=d.workspace_id and w.organization_id=o.id and w.slug='employee-tests-'||d.owner_id::text and w.archived_at is null
    join allrice_memberships m on m.organization_id=o.id and m.user_id=d.owner_id and m.active and (m.workspace_id is null or m.workspace_id=w.id)
    where d.owner_id=${ownerId} and d.organization_id=${rule.organization_id} and d.workspace_id=${rule.workspace_id}
      and a.id=(select employee_assignment_id from allrice_automations where id=${rule.id}) and a.active and a.selection_mode<>'exclude'
    for share of d,a,e,pa,o,w,m`;
  return { rule, allowed: platform && !!target };
}
export async function lockPlatformQualityNativeAdmission(
  tx: Tx,
  control: NativeRecurringControl,
): Promise<NativeRecurringAdmission | null> {
  const gate = await lockQualityRule(tx, control.ownerId, control.automationId);
  if (!gate) return null;
  const r = gate.rule;
  return {
    allowed:
      gate.allowed &&
      r.clock_owner === 'native_recurring' &&
      r.organization_id === control.organizationId &&
      r.workspace_id === control.workspaceId,
    currentRevision: Number(r.native_recurring_revision),
    status: r.deleted_at ? 'deleted' : (r.status as 'enabled' | 'paused'),
    resumeAfter: r.native_recurring_resume_after?.toISOString() ?? null,
  };
}

type Receipt = {
  occurrence_id: string;
  revision: number;
  payload: NativeRecurringOccurrence['payload'];
  payload_digest: string;
  outbox_state: string;
  outbox_reason?: string | null;
  outbox_owner_id: string | null;
  outbox_epoch: number | string;
  outbox_token_digest: string | null;
};
export async function dispatchPlatformQualityNative(
  tx: Tx,
  control: NativeRecurringControl,
  // The shared claim also carries calendar receipts. Treat its raw payload as
  // untrusted here; the locked quality row, digest and exact control/revision
  // comparisons below establish the fixed quality binding before enqueue.
  receipt: Omit<Receipt, 'payload'> & { payload: unknown },
  workerId: string,
  tokenDigest: string,
) {
  const gate = await lockQualityRule(tx, control.ownerId, control.automationId);
  const [live] = await tx<
    Receipt[]
  >`select * from allrice_native_recurring_occurrences where occurrence_id=${receipt.occurrence_id} for update`;
  if (
    !live ||
    live.outbox_owner_id !== workerId ||
    Number(live.outbox_epoch) !== Number(receipt.outbox_epoch) ||
    live.outbox_token_digest !== tokenDigest ||
    !isDeepStrictEqual(live.payload, receipt.payload) ||
    live.payload_digest !== nativeOnceDigest(receipt.payload)
  )
    invalid();
  const [lease] =
    await tx`select 1 from allrice_native_recurring_occurrences where occurrence_id=${live.occurrence_id} and outbox_expires_at>clock_timestamp()`;
  if (!lease || !gate || !['pending', 'blocked'].includes(live.outbox_state))
    invalid();
  const [stored] = await tx<
    { configuration: NativeRecurringRevision }[]
  >`select configuration from allrice_native_recurring_versions where automation_id=${control.automationId} and revision=${live.revision}`;
  const version = NativeRecurringRevisionSchema.parse(stored?.configuration);
  if (
    !('consumer' in version) ||
    version.consumer !== CONSUMER ||
    !isDeepStrictEqual(
      live.payload.control,
      recurringControlIdentity(control),
    ) ||
    !isDeepStrictEqual(live.payload.revision, {
      revision: version.revision,
      rule: version.rule,
      reservationDigest: version.reservationDigest,
      acceptedAt: version.acceptedAt,
    }) ||
    live.payload.nativeTaskId !== control.nativeTaskId
  )
    invalid();
  const { reservationDigest, ...base } = version;
  if (
    reservationDigest !==
    nativeOnceDigest({
      automationId: control.automationId,
      organizationId: control.organizationId,
      workspaceId: control.workspaceId,
      ownerId: control.ownerId,
      ...base,
    })
  )
    invalid();
  const r = gate.rule,
    scheduledAt = new Date(live.payload.receipt.scheduledAt);
  const reason =
    live.outbox_state === 'blocked'
      ? qualityReceiptReason(live.outbox_reason)
      : !gate.allowed
        ? 'QUALITY_PREPARATION_BLOCKED'
        : r.deleted_at ||
            r.status !== 'enabled' ||
            Number(r.revision) !== version.revision ||
            r.clock_owner !== 'native_recurring' ||
            qualityScheduleConfigurationDigest(r) !==
              version.qualityConfigurationDigest
          ? 'QUALITY_SCHEDULE_CHANGED'
          : r.native_recurring_resume_after &&
              scheduledAt <= r.native_recurring_resume_after
            ? 'QUALITY_BEFORE_RESUME'
            : null;
  const result = await reservePlatformQualityOccurrence(tx, r, scheduledAt, {
    occurrenceId: live.occurrence_id,
    businessId: cloudStableId(`quality-native:${live.occurrence_id}`),
    revision: version.revision,
    configurationDigest: version.qualityConfigurationDigest,
    blocked: reason,
  });
  if (!result || result.reason) {
    await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',outbox_reason=${result?.reason ?? 'QUALITY_TARGET_ALREADY_CLAIMED'} where occurrence_id=${live.occurrence_id}`;
    return;
  }
  await tx`update allrice_automations set last_run_at=clock_timestamp() where id=${r.id}`;
  await tx`update allrice_native_recurring_occurrences set outbox_state='enqueued',business_binding=${json(
    tx,
    {
      consumer: CONSUMER,
      automationRunId: result.id,
      organizationId: r.organization_id,
      workspaceId: r.workspace_id,
      ownerId: r.owner_id,
      payloadDigest: live.payload_digest,
      origin: result.origin,
    },
  )} where occurrence_id=${live.occurrence_id}`;
}

/** Admission/recovery verifies the durable handoff, not its expired 30s lease.
 * Legacy origins remain valid even after the original rule changes clock owner. */
export async function assertQualityNativeOccurrence(
  tx: Tx,
  origin: QualityScheduleOrigin,
) {
  const [proof] = await tx<
    { valid: boolean }[]
  >`select allrice_quality_native_handoff_proved(native_recurring_occurrence_id) valid
    from allrice_automation_runs where id=${origin.occurrenceId} and quality_occurrence=${json(tx, origin)}`;
  if (!proof?.valid) invalid();
}

/** A first public task may be created after the original legacy target. Retain
 * that missed target explicitly in the original history, without inventing a
 * native receipt or executing catch-up work. The public task owns future time. */
export async function recordQualityNativeClockHandoff(
  tx: Tx,
  control: NativeRecurringControl,
  version: NativeRecurringRevision,
  firstTarget: string,
) {
  if (
    !('consumer' in version) ||
    !version.legacyScheduledFor ||
    Date.parse(firstTarget) <= Date.parse(version.legacyScheduledFor)
  )
    return;
  const [rule] = await tx<
    Rule[]
  >`select * from allrice_automations where id=${control.automationId}`;
  if (
    !rule ||
    Number(rule.revision) !== version.revision ||
    qualityScheduleConfigurationDigest(rule) !==
      version.qualityConfigurationDigest
  )
    return;
  await reservePlatformQualityOccurrence(
    tx,
    rule,
    new Date(version.legacyScheduledFor),
    undefined,
    'QUALITY_CLOCK_HANDOFF_MISSED',
  );
}
