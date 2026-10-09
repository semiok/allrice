import { maintenanceGithubReady } from './platform-maintenance-github.ts';
import { repositoryCatalog } from './platform-repository-source.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import {
  defaultMaintenancePolicy,
  MaintenanceCatalogSchema,
  MaintenanceDeploymentSchema,
  RegisterMaintenanceDeploymentSchema,
  UpdateMaintenanceDeploymentSchema,
  RotateMaintenanceCredentialSchema,
} from './platform-maintenance-contracts.ts';

export class MaintenanceConflict extends Error {
  constructor() {
    super('maintenance_configuration_conflict');
  }
}
export async function currentMaintenanceAdmin(
  context: RequestContext,
  sql: postgres.TransactionSql,
) {
  const owner = await requirePlatformAdmin(context, sql);
  const [user] =
    await sql`select id from allrice_users where id=${owner} and status='active' for share`;
  if (!user) throw new DataAccessError('authorization_denied');
  if (!context.sessionId || !context.authenticatedAt)
    throw new DataAccessError('authorization_denied');
  const [session] = await sql`select id from allrice_sessions
    where id=${context.sessionId} and user_id=${owner}
    and date_trunc('milliseconds',created_at)=${context.authenticatedAt}::timestamptz
    and revoked_at is null and expires_at>clock_timestamp() for share`;
  if (!session) throw new DataAccessError('authorization_denied');
  return owner;
}
function mapped(row: Record<string, unknown>) {
  const time = (v: unknown) => (v instanceof Date ? v.toISOString() : null);
  return MaintenanceDeploymentSchema.parse({
    id: row.id,
    companySlug: row.company_slug,
    companyName: row.company_name,
    deploymentName: row.deployment_name,
    policy: row.policy,
    revision: row.revision,
    credentialRevision: row.credential_revision,
    enabledAt: time(row.enabled_at),
    revokedAt: time(row.revoked_at),
    createdAt: time(row.created_at),
    updatedAt: time(row.updated_at),
  });
}
async function repairReady(tx: postgres.TransactionSql) {
  if (!(await maintenanceGithubReady(tx))) return false;
  try {
    return repositoryCatalog(
      process.env.ALLRICE_REPOSITORY_BASELINE_DIR,
    ).baselines.some(
      (b) =>
        b.sourceSha === process.env.ALLRICE_RELEASE_SHA &&
        !!b.compiledDependencies,
    );
  } catch {
    return false;
  }
}
export async function listMaintenanceDeployments(context: RequestContext) {
  const rows = await getDatabase().begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    return {
      deployments:
        await tx`select * from allrice_platform_maintenance_deployments
      where owner_id=${owner} order by created_at desc,id desc limit 100`,
      ready: await repairReady(tx),
    };
  });
  return MaintenanceCatalogSchema.parse({
    deployments: rows.deployments.map(mapped),
    capabilities: {
      repairReady: rows.ready,
      automaticMerge: false,
      automaticDeployment: false,
      globalRepairConcurrency: 1,
    },
  });
}
/** Registration emits the installation key once; an uncertain response is read
 * back by requestId. It must never silently generate another installation. */
export async function registerMaintenanceDeployment(
  context: RequestContext,
  input: unknown,
) {
  const request = RegisterMaintenanceDeploymentSchema.parse(input);
  const digest = createHash('sha256')
    .update(JSON.stringify(request))
    .digest('hex');
  const key = randomBytes(32).toString('base64url');
  const sql = getDatabase();
  return sql.begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtext(${`maintenance-register:${owner}`}))`;
    await currentMaintenanceAdmin(context, tx);
    const [existing] =
      await tx`select * from allrice_platform_maintenance_deployments
      where owner_id=${owner} and request_id=${request.requestId}`;
    if (existing) {
      if (existing.input_digest !== digest) throw new MaintenanceConflict();
      return { deployment: mapped(existing), installationKey: null };
    }
    const [duplicate] =
      await tx`select id from allrice_platform_maintenance_deployments
      where owner_id=${owner} and company_slug=${request.companySlug} and deployment_name=${request.deploymentName}`;
    if (duplicate) throw new MaintenanceConflict();
    const [total] = await tx<
      { count: number }[]
    >`select count(*)::int as count from allrice_platform_maintenance_deployments where owner_id=${owner}`;
    if (!total || total.count >= 100) throw new MaintenanceConflict();
    const [row] = await tx`insert into allrice_platform_maintenance_deployments
      (id,owner_id,request_id,input_digest,company_slug,company_name,deployment_name,credential_digest,policy)
      values (${randomUUID()},${owner},${request.requestId},${digest},${request.companySlug},${request.companyName},${request.deploymentName},
      ${createHash('sha256').update(key).digest('hex')},${tx.json(defaultMaintenancePolicy)}) returning *`;
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values (${context.organizationId},${context.workspaceId},${owner},'platform_maintenance.register','maintenance_deployment',${row!.id},
      'recorded','platform_admin',${context.requestId},${tx.json({ companySlug: request.companySlug, deploymentName: request.deploymentName })})`;
    await currentMaintenanceAdmin(context, tx);
    return { deployment: mapped(row!), installationKey: key };
  });
}
export async function updateMaintenanceDeployment(
  context: RequestContext,
  id: string,
  input: unknown,
) {
  const request = UpdateMaintenanceDeploymentSchema.parse(input);
  UuidSchema.parse(id);
  const policy = {
    ...request.policy,
    automaticAuthorizationUntil:
      request.policy.mode === 'report_only'
        ? null
        : request.policy.automaticAuthorizationUntil,
  };
  const sql = getDatabase();
  return sql.begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    if (policy.mode === 'repair_and_pr') {
      const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
      const expiry = Date.parse(policy.automaticAuthorizationUntil ?? '');
      if (
        !(await repairReady(tx)) ||
        !Number.isFinite(expiry) ||
        expiry <= clock!.now.getTime() ||
        expiry > clock!.now.getTime() + 7 * 86400000
      )
        throw new DataAccessError('grant_invalid');
    }
    const [row] = await tx`update allrice_platform_maintenance_deployments
      set policy=${tx.json(policy)},enabled_at=${policy.mode === 'repair_and_pr' && !policy.paused ? tx`clock_timestamp()` : null},revision=revision+1,updated_at=clock_timestamp()
      where id=${id} and owner_id=${owner} and revision=${request.expectedRevision}
      returning *`;
    if (!row) {
      const [owned] =
        await tx`select id from allrice_platform_maintenance_deployments where id=${id} and owner_id=${owner}`;
      if (!owned) throw new DataAccessError('not_found');
      throw new MaintenanceConflict();
    }
    await currentMaintenanceAdmin(context, tx);
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values (${context.organizationId},${context.workspaceId},${owner},'platform_maintenance.configure','maintenance_deployment',${id},
      'recorded','platform_admin',${context.requestId},${tx.json({ revision: row.revision, policy: request.policy })})`;
    return mapped(row);
  });
}

/** A lost first response is recovered by explicitly rotating the key, never by
 * replaying registration. Revocation/rotation invalidate all previous keys. */
export async function rotateMaintenanceCredential(
  context: RequestContext,
  id: string,
  input: unknown,
) {
  const request = RotateMaintenanceCredentialSchema.parse(input);
  UuidSchema.parse(id);
  return getDatabase().begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    const key =
      request.action === 'rotate'
        ? randomBytes(32).toString('base64url')
        : null;
    const [row] = await tx`update allrice_platform_maintenance_deployments
      set credential_digest=${createHash('sha256')
        .update(key ?? randomBytes(32))
        .digest('hex')},
      credential_revision=credential_revision+1,revision=revision+1,
      revoked_at=${request.action === 'revoke' ? new Date() : null},updated_at=clock_timestamp()
      where id=${id} and owner_id=${owner} and revision=${request.expectedRevision} returning *`;
    if (!row) {
      const [owned] =
        await tx`select id from allrice_platform_maintenance_deployments where id=${id} and owner_id=${owner}`;
      if (!owned) throw new DataAccessError('not_found');
      throw new MaintenanceConflict();
    }
    await currentMaintenanceAdmin(context, tx);
    await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values (${context.organizationId},${context.workspaceId},${owner},${`platform_maintenance.${request.action}`},'maintenance_deployment',${id},
      'recorded','platform_admin',${context.requestId},${tx.json({ revision: row.revision, credentialRevision: row.credential_revision })})`;
    return { deployment: mapped(row), installationKey: key };
  });
}
