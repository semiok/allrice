/** Synthetic data for isolated PostgreSQL tests, never real tenant acceptance. */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { assistantFixture } from './assistant-runtime.fixture.ts';
export async function tenantValidationFixture(db: ReturnType<typeof postgres>) {
  const a = await assistantFixture(db),
    { organizationId: org, workspaceId: workspace } = a.task.scope,
    owner = a.context.actor.id,
    run = a.task.runId,
    session = a.task.chatSessionId;
  await db`update allrice_memberships set role='member' where user_id=${owner}`;
  const [assignment] =
    await db`select id,employee_version_id from allrice_employee_assignments where user_id=${owner}`;
  const question = randomUUID(),
    answer = randomUUID();
  await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${question},${org},${workspace},${session},${owner},'user',${db.json({ text: 'Synthetic research goal password=PRIVATE_TEST_SECRET', citations: [] })}),(${answer},${org},${workspace},${session},${owner},'assistant',${db.json({ text: 'Synthetic finished report', citations: [] })})`;
  await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot) values(${run},${org},${workspace},${owner},${assignment!.id},${assignment!.employee_version_id},${session},${question},${answer},'{}','{}')`;
  const artifact = await a.artifact(
    run,
    '# Synthetic report\n\nIsolated fixture, not a real model answer.',
  );
  const targetId = randomUUID(),
    operation = randomUUID();
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities) values(${targetId},${org},${workspace},${`cloud.${targetId}`},'cloud_sandbox','Synthetic cloud','online','["process.execute"]')`;
  const snapshot = {
    binding: { action: 'process.execute', requestedBy: { id: owner } },
    status: 'succeeded',
    secret: 'NEVER_EXPOSE_RAW_SNAPSHOT',
  };
  await db`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot) values(${operation},${org},${workspace},${run},${run},${targetId},${randomUUID()},1,1,1,${randomUUID()},${db.json(snapshot)},${db.json(snapshot)})`;
  await db`insert into allrice_runtime_operation_output(operation_id,sequence,stream,content) values(${operation},0,'stdout','Synthetic OK\nAuthorization: Bearer PRIVATE_TEST_SECRET')`;
  return {
    ...a,
    target: { organizationId: org, workspaceId: workspace, subjectId: owner },
    artifact,
    operation,
    targetId,
    versionId: assignment!.employee_version_id,
  };
}
