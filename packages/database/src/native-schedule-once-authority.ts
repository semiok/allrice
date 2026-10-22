import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import type { JobRow } from './queue/row-mappers.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { readWorkAutomation } from './work-automation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

export type NativeOnceJobAdmission =
  | {
      scheduled: true;
      runId: string;
      allowed: boolean;
    }
  | { scheduled: false; allowed: true };

/** Called BEFORE root/job locks. Only native scheduled work receives this additional
 * current-authority gate; an ordinary chat keeps its existing policy. Consumers
 * acquire root/job locks with NOWAIT afterwards, so a revocation transaction
 * cannot deadlock against this principal -> assignment -> chat lock order. */
export async function lockNativeOnceJobAdmission(
  tx: TransactionSql,
  jobId: string,
): Promise<NativeOnceJobAdmission> {
  // Even the metadata read must be bounded before the existing receipt locks.
  await tx`set local lock_timeout='5s'`;
  await tx`set local statement_timeout='10s'`;
  // Historical migration fixtures and older schemas have no once enrollment.
  // Do not gate ordinary jobs there, or skip existing once jobs when disabled.
  const [schema] =
    await tx`select to_regclass(format('%I.allrice_native_once_occurrences',current_schema())) is not null as available`;
  if (!schema?.available) return { scheduled: false, allowed: true };
  type Binding = {
    run_id: string;
    organization_id: string;
    workspace_id: string;
    owner_id: string;
    occurrence_id: string;
    outbox_state: string;
    payload_digest: string;
    business_binding: Record<string, unknown> | null;
    control: {
      dispatch: {
        consumer?: string;
        businessSessionId: string;
        employeeAssignmentId: string;
        employeeInstanceId: string;
        clientMessageId: string;
      };
    };
  };
  let kind: 'once' | 'recurring' = 'once';
  let [binding] = await tx<
    Binding[]
  >`select j.run_id,j.organization_id,j.workspace_id,j.owner_id,ar.native_once_occurrence_id occurrence_id,
      o.outbox_state,o.payload_digest,o.business_binding,c.immutable_control control
    from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id
    left join allrice_native_once_occurrences o on o.occurrence_id=ar.native_once_occurrence_id
    left join allrice_native_once_controls c on c.partition_id=o.partition_id and c.control_id=o.control_id
    where j.id=${jobId} and ar.native_once_occurrence_id is not null`;
  if (!binding) {
    const [recurringSchema] =
      await tx`select to_regclass(format('%I.allrice_native_recurring_occurrences',current_schema())) is not null as available`;
    if (recurringSchema?.available) {
      [binding] = await tx<
        Binding[]
      >`select j.run_id,j.organization_id,j.workspace_id,j.owner_id,ar.native_recurring_occurrence_id occurrence_id,
        o.outbox_state,o.payload_digest,o.business_binding,
        c.immutable_identity || jsonb_build_object('dispatch',c.immutable_identity->'dispatch' || jsonb_build_object('clientMessageId',o.client_message_id::text)) control
        from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id
        left join allrice_native_recurring_occurrences o on o.occurrence_id=ar.native_recurring_occurrence_id
        left join allrice_native_recurring_controls c on c.partition_id=o.partition_id and c.control_id=o.control_id
        where j.id=${jobId} and ar.native_recurring_occurrence_id is not null`;
      kind = 'recurring';
    }
  }
  if (!binding) return { scheduled: false, allowed: true };
  if (
    kind === 'recurring' &&
    binding.control?.dispatch.consumer === 'ordinary-monthly-v1'
  ) {
    const [proof] = await tx<
      { valid: boolean }[]
    >`select allrice_ordinary_monthly_handoff_proved(${binding.occurrence_id}::uuid) valid`;
    if (!proof?.valid)
      return { scheduled: true, runId: binding.run_id, allowed: false };
  }
  if (
    kind === 'recurring' &&
    binding.control?.dispatch.consumer === 'platform-quality-v1'
  ) {
    // Quality is a private static-check consumer, not a personal cloud chat.
    // Its original authority gate remains mandatory after the durable handoff.
    await tx`select id from allrice_users where id=${binding.owner_id} for no key update`;
    const [proof] = await tx<
      { valid: boolean }[]
    >`select allrice_quality_native_handoff_proved(${binding.occurrence_id}::uuid) valid`;
    const [job] = await tx<
      JobRow[]
    >`select * from allrice_jobs where id=${jobId}`;
    const { isPlatformQualityJobAuthorized } =
      await import('./platform-quality.ts');
    return {
      scheduled: true,
      runId: binding.run_id,
      allowed:
        !!proof?.valid &&
        binding.outbox_state === 'enqueued' &&
        !!job &&
        (await isPlatformQualityJobAuthorized(tx, job)),
    };
  }
  if (
    kind === 'recurring' &&
    binding.control?.dispatch.consumer === 'experience-consolidation-v1'
  ) {
    const [job] = await tx<
      JobRow[]
    >`select * from allrice_jobs where id=${jobId}`;
    const { lockExperienceCalendarJobAdmission } =
      await import('./experience-native.ts');
    return {
      scheduled: true,
      runId: binding.run_id,
      allowed:
        binding.outbox_state === 'enqueued' &&
        !!job &&
        (await lockExperienceCalendarJobAdmission(
          tx,
          job,
          binding.occurrence_id,
        )),
    };
  }
  await tx`set local lock_timeout='500ms'`;
  await tx`set local statement_timeout='10000ms'`;
  const deny = (): NativeOnceJobAdmission => ({
    scheduled: true,
    runId: binding.run_id,
    allowed: false,
  });
  if (
    (kind === 'once'
      ? process.env.ALLRICE_NATIVE_ONCE_ENABLED
      : process.env.ALLRICE_NATIVE_RECURRING_ENABLED) !== '1'
  )
    return deny();
  if (
    !binding.control?.dispatch ||
    binding.outbox_state !== 'enqueued' ||
    !binding.business_binding
  )
    return deny();
  const scope = {
    actor: { type: 'user' as const, id: binding.owner_id },
    organizationId: binding.organization_id,
    workspaceId: binding.workspace_id,
  };
  const principal = await readContentPrincipal(scope, tx, true);
  const work = await readWorkAutomation(tx, {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    userId: scope.actor.id,
  });
  if (!principal?.writable || !work.available || !work.settings.cloud)
    return deny();
  const d = binding.control.dispatch;
  const [target] = await tx`select s.id from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    join allrice_employee_instances i on i.id=${d.employeeInstanceId} and i.assignment_id=a.id and i.owner_id=a.user_id
    join allrice_chat_sessions s on s.id=${d.businessSessionId} and s.employee_assignment_id=a.id
      and coalesce(s.employee_instance_id,s.employee_assignment_id)=i.id
      and s.organization_id=a.organization_id and s.workspace_id=a.workspace_id and s.owner_id=a.user_id
    where a.id=${d.employeeAssignmentId} and a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId}
      and a.user_id=${scope.actor.id} and a.active and e.status='active' and e.employee_key not like 'platform-%'
      and i.archived_at is null and s.archived_at is null for share of a,e,i,s`;
  if (!target) return deny();
  const [frozen] = await tx<
    {
      execution_snapshot: unknown;
      user_message_id: string;
      assistant_message_id: string;
      employee_version_id: string;
    }[]
  >`
    select er.execution_snapshot,er.user_message_id,er.assistant_message_id,er.employee_version_id
    from allrice_employee_runs er join allrice_messages m on m.id=er.user_message_id and m.session_id=er.session_id
      and m.organization_id=er.organization_id and m.workspace_id=er.workspace_id and m.owner_id=er.owner_id and m.role='user'
    where er.run_id=${binding.run_id} and er.session_id=${d.businessSessionId} and er.employee_assignment_id=${d.employeeAssignmentId}
      and er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId} and er.owner_id=${scope.actor.id}
      and m.client_message_id=${d.clientMessageId}`;
  if (!frozen) return deny();
  const expected = {
    runId: binding.run_id,
    jobId,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.actor.id,
    sessionId: d.businessSessionId,
    employeeAssignmentId: d.employeeAssignmentId,
    employeeInstanceId: d.employeeInstanceId,
    clientMessageId: d.clientMessageId,
    payloadDigest: binding.payload_digest,
    snapshotDigest: runtimePolicyDigest(frozen.execution_snapshot),
    userMessageId: frozen.user_message_id,
    assistantMessageId: frozen.assistant_message_id,
    employeeVersionId: frozen.employee_version_id,
  };
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, binding.business_binding![key]]),
  );
  return {
    scheduled: true,
    runId: binding.run_id,
    allowed: isDeepStrictEqual(expected, actual),
  };
}
