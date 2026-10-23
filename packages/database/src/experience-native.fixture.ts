/** Isolated SQL/Host acceptance setup. No provider request or native Task write. */
import { randomUUID } from 'node:crypto';
import { experiencePolicySchedule } from '@allrice/contracts';
import type { P27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession } from './workspace/service.ts';
import { prepareEmployeeInstanceSnapshot } from './employees/employee-instances.ts';
import { collectPendingExperienceEvidence } from './experience-evidence.ts';
import {
  reserveExperienceOccurrenceInTransaction,
  readExperiencePolicy,
  type ExperienceScheduleRule,
} from './experience-consolidation.ts';
import { nextScheduleAt } from './execution/automation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';

export async function captureCalendarFixtureSource(
  f: P27CodexWorkerFixture,
  instanceId: string,
) {
  const session = await createChatSession(f.context, {
    workspaceId: f.workspaceId,
    employeeAssignmentId: f.assignmentId,
    employeeInstanceId: instanceId,
    title: 'Isolated incremental calendar evidence',
  });
  const instance = await prepareEmployeeInstanceSnapshot(
    f.context,
    session.id,
    f.assignmentId,
    f.employeeVersionId,
  );
  const runId = randomUUID(),
    messageId = randomUUID(),
    assistantId = randomUUID();
  const text = '刚才的对账报告漏了退款，核对时需要单列退款再汇总净回款。🍚';
  await f.db`insert into allrice_messages(id,organization_id,workspace_id,owner_id,session_id,role,content,status)
    values(${messageId},${f.organizationId},${f.workspaceId},${f.ownerId},${session.id},'user',${f.db.json({ text, citations: [] })},'completed'),
    (${assistantId},${f.organizationId},${f.workspaceId},${f.ownerId},${session.id},'assistant','{"text":"SQL fixture completed; no provider call"}','completed')`;
  await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
    values(${runId},${f.organizationId},${f.workspaceId},${f.ownerId},'succeeded','{}','{}')`;
  await f.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,
    session_id,user_message_id,assistant_message_id,status,completed_at,provider_snapshot,prompt_snapshot,execution_snapshot,experience_capture_state)
    values(${runId},${f.organizationId},${f.workspaceId},${f.ownerId},${f.assignmentId},${f.employeeVersionId},${session.id},${messageId},${assistantId},
      'succeeded',clock_timestamp(),'{}','{}',${f.db.json({ instance, personalSkills: { skills: [] } })},'pending')`;
  await collectPendingExperienceEvidence({ database: f.db });
  const [source] = await f.db<
    { memory_id: string }[]
  >`select memory_id from allrice_experience_reviews
    where run_id=${runId} and origin_kind='incremental' and status='pending' and consolidation_occurrence_id is null`;
  if (!source) throw Error('calendar_fixture_incremental_source_missing');
  return {
    id: source.memory_id,
    runId,
    messageId,
    sessionId: session.id,
    text,
  };
}

export async function seedExperienceCalendarRule(
  f: P27CodexWorkerFixture,
  mode: 'empty' | 'queued' | 'budget',
) {
  const policy = await readExperiencePolicy(f.organizationId);
  if (policy.frequency === 'off') throw Error('calendar_fixture_policy_off');
  const schedule = experiencePolicySchedule(policy);
  const [instance] = await f.db<
    { id: string }[]
  >`select id from allrice_employee_instances
    where assignment_id=${f.assignmentId} and owner_id=${f.ownerId} and archived_at is null`;
  if (!instance) throw Error('calendar_fixture_instance_missing');
  let source =
    mode === 'empty'
      ? null
      : await captureCalendarFixtureSource(f, instance.id);
  const automationId = randomUUID(),
    P = new Date(Date.now() - 90 * 86_400_000);
  await f.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,
    conversation_mode,employee_assignment_id,next_run_at,experience_binding)
    values(${automationId},${f.organizationId},${f.workspaceId},${f.ownerId},'Isolated original experience calendar',
      'Only use already captured private evidence','schedule',${f.db.json(schedule)},'enabled','new_each_run',${f.assignmentId},${P},
      ${f.db.json({ schemaVersion: 1, instanceId: instance.id, policyDigest: runtimePolicyDigest(policy) })})`;
  let legacyOccurrenceId: string | null = null;
  if (mode === 'budget') {
    // A real old legacy reservation consumes the ORIGINAL instance quota.
    // Advance by the original calendar rule from its saved, still overdue P.
    legacyOccurrenceId = await f.db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`experience-policy:${f.organizationId}`},183))`;
      const [rule] = await tx<
        ExperienceScheduleRule[]
      >`select * from allrice_automations where id=${automationId} for update`;
      if (!rule) throw Error('calendar_fixture_legacy_rule_missing');
      const reserved = await reserveExperienceOccurrenceInTransaction(
        tx,
        rule,
        P,
      );
      if (reserved.outcome !== 'queued')
        throw Error(`calendar_fixture_legacy_reservation_${reserved.outcome}`);
      // Explicit historical metadata: the original reservation already advanced P.
      await tx`update allrice_automations set next_run_at=${nextScheduleAt(schedule, P)},last_run_at=clock_timestamp(),updated_at=clock_timestamp() where id=${rule.id}`;
      return reserved.automationRunId;
    });
    if (!legacyOccurrenceId)
      throw Error('calendar_fixture_legacy_reservation_missing');
    source = await captureCalendarFixtureSource(f, instance.id);
  }
  const [saved] = await f.db<
    { next_run_at: Date }[]
  >`select next_run_at from allrice_automations where id=${automationId}`;
  if (!saved || saved.next_run_at >= new Date())
    throw Error('calendar_fixture_requires_saved_overdue_P');
  return {
    automationId,
    instanceId: instance.id,
    source,
    legacyOccurrenceId,
    P: saved.next_run_at,
  };
}
