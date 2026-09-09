/** Synthetic P20 evidence only; callers must provide their dedicated schema. */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestContext, Role } from '@allrice/contracts';
import {
  ensureDefaultEmployee,
  createChatSession,
} from './workspace/service.ts';

export async function createExperienceFixture(db: ReturnType<typeof postgres>) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID();
  await db`insert into allrice_organizations(id,slug,name) values(${org},${`p20-${org}`},'P20 synthetic')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'p20','P20 synthetic')`;
  async function member(role: Role, id = randomUUID()) {
    const membership = randomUUID();
    await db`insert into allrice_users(id,email,display_name,password_hash) values(${id},${`${id}@example.test`},'P20 synthetic','not-a-password')`;
    await db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${id},${role})`;
    const context: RequestContext = {
      requestId: randomUUID(),
      sessionId: randomUUID(),
      actor: { type: 'user', id },
      organizationId: org,
      workspaceId: workspace,
      authenticatedAt: new Date().toISOString(),
      memberships: [
        {
          id: membership,
          userId: id,
          organizationId: org,
          workspaceId: workspace,
          role,
          active: true,
        },
      ],
    };
    return context;
  }
  const owner = await member('member', user),
    reviewer = await member('admin'),
    neighbor = await member('member');
  await ensureDefaultEmployee(owner, workspace);
  const session = await createChatSession(owner, {
    workspaceId: workspace,
    title: 'P20 completed task',
  });
  const [assignment] = await db<
    { id: string; employee_version_id: string }[]
  >`select id,employee_version_id from allrice_employee_assignments where user_id=${user} and workspace_id=${workspace}`;
  const run = randomUUID(),
    message = randomUUID(),
    assistant = randomUUID();
  const text =
    'Reconciliation rule: preserve original files and use decimal amounts. Private customer: SYNTHETIC-ONLY.';
  await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content,status)
    values(${message},${org},${workspace},${session.id},${user},'user',${db.json({ text, citations: [] })},'completed'),
    (${assistant},${org},${workspace},${session.id},${user},'assistant','{"text":"Synthetic task delivered","citations":[]}','completed')`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${run},${org},${workspace},${user},'succeeded','{}','{}')`;
  await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,status,completed_at,provider_snapshot,prompt_snapshot)
    values(${run},${org},${workspace},${user},${assignment!.id},${assignment!.employee_version_id},${session.id},${message},${assistant},'succeeded',now(),'{}','{}')`;
  const input = {
    clientRequestId: randomUUID(),
    runId: run,
    messageId: message,
    sourceExcerpt: 'preserve original files and use decimal amounts',
    content:
      'Reconciliation rule: preserve original files and use decimal amounts.',
    memoryClass: 'work_note',
    scope: 'private',
    shareAcknowledged: false,
  };
  return {
    org,
    workspace,
    user,
    owner,
    reviewer,
    neighbor,
    session,
    run,
    message,
    assistant,
    input,
    member,
  };
}
