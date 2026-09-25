import {
  WorkAutomationSchema,
  defaultWorkAutomation,
  UpdateWorkAutomationSchema,
  UuidSchema,
  type RequestContext,
  type WorkAutomation,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

type Scope = { organizationId: string; workspaceId: string; userId: string };
type Database = ReturnType<typeof getDatabase>;
export class WorkAutomationConflict extends Error {}

/** Shared with execution admission. The transaction lock includes absent rows,
 * so a first explicit OFF cannot race an admission using the default ON. */
export async function readWorkAutomation(tx: TransactionSql, scope: Scope) {
  const [schema] =
    await tx`select to_regclass(format('%I.allrice_member_work_automation',current_schema())) is not null as available`;
  if (!schema?.available)
    return {
      available: false,
      revision: 0,
      settings: { cloud: false, computer: false, assistants: true },
    };
  await tx`select pg_advisory_xact_lock(hashtextextended(${`work-automation:${scope.organizationId}:${scope.workspaceId}:${scope.userId}`},0))`;
  const [row] = await tx<{ revision: number; settings: unknown }[]>`
    select revision,settings from allrice_member_work_automation where organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and user_id=${scope.userId}`;
  return {
    available: true,
    revision: row?.revision ?? 0,
    settings: row
      ? WorkAutomationSchema.parse(row.settings)
      : { ...defaultWorkAutomation },
  };
}

async function member(
  tx: TransactionSql,
  context: RequestContext,
  workspaceId: string,
) {
  UuidSchema.parse(workspaceId);
  if (context.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  const rows = await tx<{ role: string }[]>`
    select m.role from allrice_memberships m
    join allrice_users u on u.id=m.user_id and u.status='active'
    join allrice_workspaces w on w.id=${workspaceId} and w.organization_id=m.organization_id and w.archived_at is null
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    where m.organization_id=${context.organizationId} and m.user_id=${context.actor.id} and m.active
      and (m.workspace_id is null or m.workspace_id=w.id) for share of m,u,w,o`;
  if (!rows.length) throw new DataAccessError('authorization_denied');
  return rows.some((r) => ['admin', 'member'].includes(r.role));
}
export async function getWorkAutomation(
  context: RequestContext,
  workspaceId: string,
  db: Database = getDatabase(),
) {
  return db.begin(async (tx) => {
    const editable = await member(tx, context, workspaceId);
    const value = await readWorkAutomation(tx, {
      organizationId: context.organizationId,
      workspaceId,
      userId: context.actor.id,
    });
    return {
      workspaceId,
      revision: value.revision,
      settings: value.settings,
      editable: editable && value.available,
    };
  });
}
export async function updateWorkAutomation(
  context: RequestContext,
  workspaceId: string,
  input: unknown,
  db: Database = getDatabase(),
) {
  const change = UpdateWorkAutomationSchema.parse(input);
  return db.begin(async (tx) => {
    if (!(await member(tx, context, workspaceId)))
      throw new DataAccessError('authorization_denied');
    const scope = {
      organizationId: context.organizationId,
      workspaceId,
      userId: context.actor.id,
    };
    const old = await readWorkAutomation(tx, scope);
    if (!old.available)
      throw new WorkAutomationConflict('服务正在更新，请稍后重新读取。');
    if (change.expectedRevision !== old.revision)
      throw new WorkAutomationConflict('工作方式已变化，请刷新后重试。');
    const settings: WorkAutomation = {
      ...old.settings,
      [change.capability]: change.enabled,
    };
    const revision = old.revision + 1;
    await tx`insert into allrice_member_work_automation(organization_id,workspace_id,user_id,revision,settings)
      values(${scope.organizationId},${workspaceId},${scope.userId},${revision},${tx.json(settings)})
      on conflict(organization_id,workspace_id,user_id) do update set revision=excluded.revision,settings=excluded.settings,updated_at=now()`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,metadata)
      values(${scope.organizationId},${workspaceId},${scope.userId},'member.work_automation.update','user',${scope.userId},'recorded','member_setting',${tx.json({ ...change, revision })})`;
    return { workspaceId, revision, settings, editable: true };
  });
}
