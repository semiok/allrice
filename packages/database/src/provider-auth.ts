import { randomUUID } from 'node:crypto';

import {
  ProviderAuthorizationFlowSchema,
  ProviderGrantSchema,
  StartProviderAuthorizationInputSchema,
  UuidSchema,
  type ProviderAuthorizationFlow,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';

import { DataAccessError } from './data.ts';
import { getDatabase } from './index.ts';
import { isPlatformAdmin } from './model-pool.ts';

const codexProviderId = '51000000-0000-4000-8000-000000000001';
const codexConnectionId = '52000000-0000-4000-8000-000000000001';
const credentialReference = 'deployment:codex-default';

interface FlowRow {
  id: string;
  connection_id: string;
  state: ProviderAuthorizationFlow['state'];
  verification_uri: string | null;
  user_code: string | null;
  detail_code: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function actorId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

async function requirePlatformAdmin(context: RequestContext) {
  if (!(await isPlatformAdmin(context))) {
    throw new DataAccessError('authorization_denied');
  }
  return actorId(context);
}

function mapFlow(row: FlowRow) {
  return ProviderAuthorizationFlowSchema.parse({
    id: row.id,
    provider: 'codex',
    connectionId: row.connection_id,
    state: row.state,
    verificationUri: row.verification_uri,
    userCode: row.user_code,
    detailCode: row.detail_code,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

export async function startCodexAuthorization(
  context: RequestContext,
  input: unknown,
) {
  const requestedBy = await requirePlatformAdmin(context);
  const parsed = StartProviderAuthorizationInputSchema.parse(input);
  const connectionId = parsed.connectionId ?? codexConnectionId;
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(8182)`;
    const valid = await transaction<{ id: string }[]>`
      select c.id
      from allrice_model_connections c
      join allrice_model_providers p on p.id = c.provider_id
      where c.id = ${connectionId} and c.scope = 'platform'
        and p.id = ${codexProviderId} and p.provider_key = 'codex'
    `;
    if (!valid[0]) throw new DataAccessError('not_found');
    const active = await transaction<FlowRow[]>`
      select id, connection_id, state, verification_uri, user_code,
        detail_code, expires_at, created_at, updated_at, completed_at
      from allrice_provider_authorization_flows
      where connection_id = ${connectionId}
        and state in ('pending', 'running', 'awaiting_user')
      order by created_at desc limit 1
    `;
    if (active[0]) return mapFlow(active[0]);
    const rows = await transaction<FlowRow[]>`
      insert into allrice_provider_authorization_flows (
        id, provider_id, connection_id, requested_by, expires_at
      ) values (
        ${randomUUID()}, ${codexProviderId}, ${connectionId}, ${requestedBy},
        now() + interval '20 minutes'
      ) returning id, connection_id, state, verification_uri, user_code,
        detail_code, expires_at, created_at, updated_at, completed_at
    `;
    const row = rows[0];
    if (!row) throw new Error('authorization flow creation failed');
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id, metadata
      ) values (
        ${context.organizationId}, ${context.workspaceId}, ${requestedBy},
        'provider_authorization.start', 'model_connection', ${connectionId},
        'recorded', 'platform_admin', ${context.requestId},
        ${transaction.json({ provider: 'codex', flowId: row.id })}
      )
    `;
    return mapFlow(row);
  });
}

export async function getCodexAuthorization(
  context: RequestContext,
  flowId?: string,
) {
  await requirePlatformAdmin(context);
  const sql = getDatabase();
  const rows = await sql<FlowRow[]>`
    select id, connection_id, state, verification_uri, user_code,
      detail_code, expires_at, created_at, updated_at, completed_at
    from allrice_provider_authorization_flows
    where provider_id = ${codexProviderId}
      ${flowId ? sql`and id = ${UuidSchema.parse(flowId)}` : sql``}
    order by created_at desc limit 1
  `;
  return rows[0] ? mapFlow(rows[0]) : null;
}

export async function cancelCodexAuthorization(
  context: RequestContext,
  flowId: string,
) {
  const canceledBy = await requirePlatformAdmin(context);
  const sql = getDatabase();
  const rows = await sql<FlowRow[]>`
    update allrice_provider_authorization_flows
    set state = 'canceled', detail_code = 'platform_admin_canceled',
      completed_at = now(), updated_at = now()
    where id = ${UuidSchema.parse(flowId)} and provider_id = ${codexProviderId}
      and state in ('pending', 'running', 'awaiting_user')
    returning id, connection_id, state, verification_uri, user_code,
      detail_code, expires_at, created_at, updated_at, completed_at
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${context.organizationId}, ${context.workspaceId}, ${canceledBy},
      'provider_authorization.cancel', 'model_connection',
      ${row.connection_id}, 'recorded', 'platform_admin', ${context.requestId},
      ${sql.json({ provider: 'codex', flowId: row.id })}
    )
  `;
  return mapFlow(row);
}

export async function recoverCodexAuthorizationFlows() {
  const sql = getDatabase();
  await sql`
    update allrice_provider_authorization_flows
    set state = case when expires_at <= now() then 'expired' else 'pending' end,
      claimed_by = null,
      detail_code = case
        when expires_at <= now() then 'device_code_expired'
        else 'worker_restarted'
      end,
      completed_at = case when expires_at <= now() then now() else null end,
      updated_at = now()
    where state in ('running', 'awaiting_user')
      and updated_at < now() - interval '2 minutes'
  `;
}

export async function claimCodexAuthorizationFlow(workerId: string) {
  const claimedBy = UuidSchema.parse(workerId);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await transaction`
      update allrice_provider_authorization_flows
      set state = 'expired', detail_code = 'device_code_expired',
        completed_at = now(), updated_at = now()
      where state in ('pending', 'running', 'awaiting_user')
        and expires_at <= now()
    `;
    const rows = await transaction<FlowRow[]>`
      with candidate as (
        select id from allrice_provider_authorization_flows
        where state = 'pending' and expires_at > now()
        order by created_at
        for update skip locked limit 1
      )
      update allrice_provider_authorization_flows flow
      set state = 'running', claimed_by = ${claimedBy},
        detail_code = 'worker_starting_device_authorization', updated_at = now()
      from candidate
      where flow.id = candidate.id
      returning flow.id, flow.connection_id, flow.state,
        flow.verification_uri, flow.user_code, flow.detail_code,
        flow.expires_at, flow.created_at, flow.updated_at, flow.completed_at
    `;
    return rows[0] ? mapFlow(rows[0]) : null;
  });
}

export async function publishCodexAuthorizationChallenge(input: {
  flowId: string;
  workerId: string;
  verificationUri: string;
  userCode: string;
}) {
  const values = z
    .object({
      flowId: UuidSchema,
      workerId: UuidSchema,
      verificationUri: z.string().url().max(2_000),
      userCode: z.string().trim().min(4).max(64),
    })
    .parse(input);
  const sql = getDatabase();
  const rows = await sql<FlowRow[]>`
    update allrice_provider_authorization_flows
    set state = 'awaiting_user', verification_uri = ${values.verificationUri},
      user_code = ${values.userCode}, detail_code = 'awaiting_user',
      updated_at = now()
    where id = ${values.flowId} and claimed_by = ${values.workerId}
      and state in ('running', 'awaiting_user') and expires_at > now()
    returning id, connection_id, state, verification_uri, user_code,
      detail_code, expires_at, created_at, updated_at, completed_at
  `;
  return rows[0] ? mapFlow(rows[0]) : null;
}

export async function codexAuthorizationFlowState(flowId: string) {
  const sql = getDatabase();
  const rows = await sql<{ state: ProviderAuthorizationFlow['state'] }[]>`
    select state from allrice_provider_authorization_flows
    where id = ${UuidSchema.parse(flowId)}
  `;
  return rows[0]?.state ?? null;
}

export async function completeCodexAuthorization(input: {
  flowId: string;
  workerId: string;
  connected: boolean;
  detailCode: string;
}) {
  const values = z
    .object({
      flowId: UuidSchema,
      workerId: UuidSchema,
      connected: z.boolean(),
      detailCode: z.string().trim().min(1).max(160),
    })
    .parse(input);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const rows = await transaction<
      (FlowRow & { requested_by: string; provider_id: string })[]
    >`
      update allrice_provider_authorization_flows
      set state = ${values.connected ? 'connected' : 'failed'},
        detail_code = ${values.detailCode}, completed_at = now(),
        updated_at = now()
      where id = ${values.flowId} and claimed_by = ${values.workerId}
        and state in ('running', 'awaiting_user')
      returning id, provider_id, connection_id, requested_by, state,
        verification_uri, user_code, detail_code, expires_at, created_at,
        updated_at, completed_at
    `;
    const row = rows[0];
    if (!row) return null;
    await transaction`
      insert into allrice_provider_grants (
        id, provider_id, connection_id, auth_mode, status,
        credential_reference, authorized_by, authorized_at,
        last_checked_at, detail_code
      ) values (
        ${randomUUID()}, ${row.provider_id}, ${row.connection_id},
        'chatgpt_subscription', ${values.connected ? 'connected' : 'error'},
        ${credentialReference}, ${row.requested_by},
        ${values.connected ? new Date() : null}, now(), ${values.detailCode}
      ) on conflict (connection_id) do update set
        status = excluded.status,
        authorized_by = excluded.authorized_by,
        authorized_at = coalesce(excluded.authorized_at, allrice_provider_grants.authorized_at),
        last_checked_at = excluded.last_checked_at,
        detail_code = excluded.detail_code,
        updated_at = now()
    `;
    return mapFlow(row);
  });
}

export async function getCodexProviderGrant(context: RequestContext) {
  await requirePlatformAdmin(context);
  const sql = getDatabase();
  const rows = await sql<
    {
      connection_id: string;
      status: 'connected' | 'disconnected' | 'error';
      credential_reference: string;
      authorized_at: Date | null;
      last_checked_at: Date | null;
      detail_code: string | null;
    }[]
  >`
    select connection_id, status, credential_reference, authorized_at,
      last_checked_at, detail_code
    from allrice_provider_grants where provider_id = ${codexProviderId}
    order by updated_at desc limit 1
  `;
  const row = rows[0];
  return row
    ? ProviderGrantSchema.parse({
        connectionId: row.connection_id,
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        status: row.status,
        credentialReference: row.credential_reference,
        authorizedAt: row.authorized_at?.toISOString() ?? null,
        lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
        detailCode: row.detail_code,
      })
    : null;
}
