import { randomUUID } from 'node:crypto';

import {
  EmployeeModelPolicySchema,
  ModelCatalogEntrySchema,
  ModelConnectionSchema,
  ModelProviderSchema,
  SaasCapabilityManifestSchema,
  SessionModelSnapshotSchema,
  UpdateModelConnectionInputSchema,
  UpsertEmployeeModelPolicyInputSchema,
  UpsertModelConnectionInputSchema,
  type EmployeeModelPolicy,
  type ModelCatalogEntry,
  type ModelConnection,
  type ModelProvider,
  type RequestContext,
} from '@allrice/contracts';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';

const defaultProviderId = '51000000-0000-4000-8000-000000000001';
const defaultConnectionId = '52000000-0000-4000-8000-000000000001';
const defaultModelId = '53000000-0000-4000-8000-000000000001';

interface ProviderRow {
  id: string;
  provider_key: string;
  name: string;
  harness: ModelProvider['harness'];
  auth_mode: ModelProvider['authMode'];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ConnectionRow {
  id: string;
  provider_id: string;
  organization_id: string | null;
  scope: ModelConnection['scope'];
  name: string;
  credential_reference: string | null;
  base_url: string | null;
  status: ModelConnection['status'];
  stability: ModelConnection['stability'];
  priority: number;
  created_at: Date;
  updated_at: Date;
}

interface CatalogRow {
  id: string;
  provider_id: string;
  model: string;
  display_name: string;
  context_window_tokens: number | null;
  reasoning_efforts: unknown;
  default_reasoning_effort: ModelCatalogEntry['defaultReasoningEffort'];
  input_modalities: unknown;
  output_modalities: unknown;
  enabled: boolean;
  stability: ModelCatalogEntry['stability'];
  created_at: Date;
  updated_at: Date;
}

interface PolicyRow {
  employee_id: string;
  organization_id: string;
  workspace_id: string;
  connection_id: string;
  model_catalog_entry_id: string;
  reasoning_effort: EmployeeModelPolicy['reasoningEffort'];
  fallback_policy: EmployeeModelPolicy['fallbackPolicy'];
  fallback_targets: unknown;
  fallback_on: unknown;
  timeout_ms: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_total_tokens: number;
  max_cost_cents: number | null;
  revision: number;
  updated_by: string;
  updated_at: Date;
}

function userId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function tenantAdmin(context: RequestContext, workspaceId?: string | null) {
  const actorId = userId(context);
  return context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actorId &&
      membership.organizationId === context.organizationId &&
      membership.role === 'admin' &&
      (workspaceId === undefined ||
        workspaceId === null ||
        membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
}

function platformAdminEmails() {
  return new Set(
    (process.env.ALLRICE_PLATFORM_ADMIN_EMAILS ?? 'semiokshen@gmail.com')
      .split(',')
      .map((email) => email.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
}

export async function isPlatformAdmin(context: RequestContext) {
  const actorId = userId(context);
  const sql = getDatabase();
  const rows = await sql<{ email: string }[]>`
    select email from allrice_users
    where id = ${actorId} and status = 'active'
  `;
  const email = rows[0]?.email.toLocaleLowerCase();
  return email ? platformAdminEmails().has(email) : false;
}

export async function getSaasCapabilities(context: RequestContext) {
  const workspaceId = context.workspaceId;
  return buildSaasCapabilityManifest({
    member: context.actor.type === 'user',
    tenantAdmin: tenantAdmin(context, workspaceId),
    platformAdmin: await isPlatformAdmin(context),
  });
}

export function buildSaasCapabilityManifest(input: {
  member: boolean;
  tenantAdmin: boolean;
  platformAdmin: boolean;
}) {
  const roles = [
    ...(input.member ? (['member'] as const) : []),
    ...(input.tenantAdmin ? (['tenant_admin'] as const) : []),
    ...(input.platformAdmin ? (['platform_admin'] as const) : []),
  ];
  const actions = [
    'conversation:read',
    'conversation:create',
    'conversation:send',
    'conversation:cancel',
    'conversation:recover',
    'file:upload',
    'employee:read',
    ...(input.tenantAdmin
      ? ([
          'employee:manage',
          'skill:assign',
          'workflow:manage',
          'knowledge:manage',
          'model_policy:manage',
        ] as const)
      : []),
    ...(input.platformAdmin
      ? (['model_connection:manage', 'platform_audit:read'] as const)
      : []),
  ];
  return SaasCapabilityManifestSchema.parse({
    schemaVersion: 1,
    roles,
    actions,
    surfaces: [
      'chatflow',
      ...(input.tenantAdmin ? (['tenant_admin'] as const) : []),
      ...(input.platformAdmin ? (['platform_admin'] as const) : []),
    ],
    features: {
      chatFlowV3: true,
      nativeHarnessEvents: true,
    },
  });
}

async function requirePlatformAdmin(context: RequestContext) {
  if (!(await isPlatformAdmin(context))) {
    throw new DataAccessError('authorization_denied');
  }
  return userId(context);
}

function requireTenantAdmin(context: RequestContext, workspaceId: string) {
  if (!tenantAdmin(context, workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  return userId(context);
}

function mapProvider(row: ProviderRow) {
  return ModelProviderSchema.parse({
    id: row.id,
    key: row.provider_key,
    name: row.name,
    harness: row.harness,
    authMode: row.auth_mode,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapConnection(row: ConnectionRow) {
  return ModelConnectionSchema.parse({
    id: row.id,
    providerId: row.provider_id,
    organizationId: row.organization_id,
    scope: row.scope,
    name: row.name,
    credentialReference: row.credential_reference,
    baseUrl: row.base_url,
    status: row.status,
    stability: row.stability,
    priority: row.priority,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapCatalogEntry(row: CatalogRow) {
  return ModelCatalogEntrySchema.parse({
    id: row.id,
    providerId: row.provider_id,
    model: row.model,
    displayName: row.display_name,
    contextWindowTokens: row.context_window_tokens,
    reasoningEfforts: row.reasoning_efforts,
    defaultReasoningEffort: row.default_reasoning_effort,
    inputModalities: row.input_modalities,
    outputModalities: row.output_modalities,
    enabled: row.enabled,
    stability: row.stability,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapPolicy(row: PolicyRow) {
  return EmployeeModelPolicySchema.parse({
    schemaVersion: 1,
    employeeId: row.employee_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    connectionId: row.connection_id,
    modelCatalogEntryId: row.model_catalog_entry_id,
    reasoningEffort: row.reasoning_effort,
    fallbackPolicy: row.fallback_policy,
    fallbackTargets: row.fallback_targets,
    fallbackOn: row.fallback_on,
    runLimits: {
      timeoutMs: row.timeout_ms,
      maxInputTokens: row.max_input_tokens,
      maxOutputTokens: row.max_output_tokens,
      maxTotalTokens: row.max_total_tokens,
      maxCostCents: row.max_cost_cents,
    },
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function listModelPool(context: RequestContext) {
  userId(context);
  const sql = getDatabase();
  const platformAdmin = await isPlatformAdmin(context);
  if (!platformAdmin && !tenantAdmin(context, context.workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  const [providerRows, connectionRows, catalogRows] = await Promise.all([
    sql<ProviderRow[]>`
      select id, provider_key, name, harness, auth_mode, enabled,
        created_at, updated_at
      from allrice_model_providers
      where enabled
      order by name, id
    `,
    sql<ConnectionRow[]>`
      select id, provider_id, organization_id, scope, name,
        credential_reference, base_url, status, stability, priority,
        created_at, updated_at
      from allrice_model_connections
      where scope = 'platform' or organization_id = ${context.organizationId}
      order by priority, name, id
    `,
    sql<CatalogRow[]>`
      select id, provider_id, model, display_name, context_window_tokens,
        reasoning_efforts, default_reasoning_effort, input_modalities,
        output_modalities, enabled, stability, created_at, updated_at
      from allrice_model_catalog_entries
      where enabled
      order by display_name, id
    `,
  ]);
  return {
    providers: providerRows.map((row) => {
      const provider = mapProvider(row);
      return platformAdmin
        ? provider
        : {
            id: provider.id,
            key: provider.key,
            name: provider.name,
            enabled: provider.enabled,
            createdAt: provider.createdAt,
            updatedAt: provider.updatedAt,
          };
    }),
    connections: connectionRows.map((row) =>
      mapConnection({
        ...row,
        credential_reference: platformAdmin ? row.credential_reference : null,
        base_url: platformAdmin ? row.base_url : null,
      }),
    ),
    models: catalogRows.map(mapCatalogEntry),
    defaultSelection: {
      providerId: defaultProviderId,
      connectionId: defaultConnectionId,
      modelCatalogEntryId: defaultModelId,
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh' as const,
      fallbackPolicy: 'disabled' as const,
      fallbackTargets: [],
      fallbackOn: [
        'provider_unavailable',
        'rate_limited',
        'timeout',
        'transient_error',
      ] as const,
      runLimits: {
        timeoutMs: 300_000,
        maxInputTokens: 120_000,
        maxOutputTokens: 16_000,
        maxTotalTokens: 136_000,
        maxCostCents: null,
      },
    },
  };
}

export async function createModelConnection(
  context: RequestContext,
  input: unknown,
) {
  const actorId = await requirePlatformAdmin(context);
  const connection = UpsertModelConnectionInputSchema.parse(input);
  if (connection.scope !== 'platform' || connection.organizationId !== null) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<ConnectionRow[]>`
    insert into allrice_model_connections (
      id, provider_id, organization_id, scope, name, credential_reference,
      base_url, status, stability, priority
    ) values (
      ${randomUUID()}, ${connection.providerId}, null, ${connection.scope},
      ${connection.name}, ${connection.credentialReference},
      ${connection.baseUrl}, ${connection.status}, ${connection.stability},
      ${connection.priority}
    )
    returning id, provider_id, organization_id, scope, name,
      credential_reference, base_url, status, stability, priority,
      created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('model connection creation failed');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${context.organizationId}, ${context.workspaceId}, ${actorId},
      'model_connection.create', 'model_connection', ${row.id},
      'recorded', 'platform_admin', ${context.requestId},
      ${sql.json({ providerId: row.provider_id, scope: row.scope })}
    )
  `;
  return mapConnection(row);
}

export async function updateModelConnection(input: {
  context: RequestContext;
  connectionId: string;
  update: unknown;
}) {
  const actorId = await requirePlatformAdmin(input.context);
  const update = UpdateModelConnectionInputSchema.parse(input.update);
  const sql = getDatabase();
  const currentRows = await sql<ConnectionRow[]>`
    select id, provider_id, organization_id, scope, name,
      credential_reference, base_url, status, stability, priority,
      created_at, updated_at
    from allrice_model_connections
    where id = ${input.connectionId} and scope = 'platform'
  `;
  const current = currentRows[0];
  if (!current) throw new DataAccessError('not_found');
  const rows = await sql<ConnectionRow[]>`
    update allrice_model_connections set
      name = ${update.name ?? current.name},
      credential_reference = ${
        update.credentialReference === undefined
          ? current.credential_reference
          : update.credentialReference
      },
      base_url = ${
        update.baseUrl === undefined ? current.base_url : update.baseUrl
      },
      status = ${update.status ?? current.status},
      stability = ${update.stability ?? current.stability},
      priority = ${update.priority ?? current.priority},
      updated_at = now()
    where id = ${current.id}
    returning id, provider_id, organization_id, scope, name,
      credential_reference, base_url, status, stability, priority,
      created_at, updated_at
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${input.context.organizationId}, ${input.context.workspaceId}, ${actorId},
      'model_connection.update', 'model_connection', ${row.id},
      'recorded', 'platform_admin', ${input.context.requestId},
      ${sql.json({
        changedFields: Object.keys(update).sort(),
        status: row.status,
        stability: row.stability,
      })}
    )
  `;
  return mapConnection(row);
}

async function validateSelection(input: {
  organizationId: string;
  connectionId: string;
  modelCatalogEntryId: string;
  reasoningEffort: EmployeeModelPolicy['reasoningEffort'];
}) {
  const sql = getDatabase();
  const rows = await sql<
    (ConnectionRow & {
      catalog_provider_id: string;
      reasoning_efforts: unknown;
      catalog_enabled: boolean;
    })[]
  >`
    select c.id, c.provider_id, c.organization_id, c.scope, c.name,
      c.credential_reference, c.base_url, c.status, c.stability, c.priority,
      c.created_at, c.updated_at,
      m.provider_id as catalog_provider_id,
      m.reasoning_efforts, m.enabled as catalog_enabled
    from allrice_model_connections c
    join allrice_model_catalog_entries m
      on m.id = ${input.modelCatalogEntryId}
    where c.id = ${input.connectionId}
      and (c.scope = 'platform' or c.organization_id = ${input.organizationId})
  `;
  const selection = rows[0];
  if (
    !selection ||
    selection.status !== 'ready' ||
    !selection.catalog_enabled ||
    selection.provider_id !== selection.catalog_provider_id ||
    !Array.isArray(selection.reasoning_efforts) ||
    !selection.reasoning_efforts.includes(input.reasoningEffort)
  ) {
    throw new DataAccessError('grant_invalid');
  }
  return selection;
}

export async function getEmployeeModelPolicy(input: {
  context: RequestContext;
  workspaceId: string;
  employeeId: string;
}) {
  requireTenantAdmin(input.context, input.workspaceId);
  const sql = getDatabase();
  const rows = await sql<PolicyRow[]>`
    select employee_id, organization_id, workspace_id, connection_id,
      model_catalog_entry_id, reasoning_effort, fallback_policy,
      fallback_targets, fallback_on, timeout_ms, max_input_tokens,
      max_output_tokens, max_total_tokens, max_cost_cents,
      revision, updated_by, updated_at
    from allrice_employee_model_policies
    where organization_id = ${input.context.organizationId}
      and workspace_id = ${input.workspaceId}
      and employee_id = ${input.employeeId}
  `;
  return rows[0] ? mapPolicy(rows[0]) : null;
}

export async function upsertEmployeeModelPolicy(input: {
  context: RequestContext;
  workspaceId: string;
  employeeId: string;
  policy: unknown;
}) {
  const actorId = requireTenantAdmin(input.context, input.workspaceId);
  const policy = UpsertEmployeeModelPolicyInputSchema.parse(input.policy);
  await validateSelection({
    organizationId: input.context.organizationId,
    connectionId: policy.connectionId,
    modelCatalogEntryId: policy.modelCatalogEntryId,
    reasoningEffort: policy.reasoningEffort,
  });
  for (const fallback of policy.fallbackTargets) {
    await validateSelection({
      organizationId: input.context.organizationId,
      connectionId: fallback.connectionId,
      modelCatalogEntryId: fallback.modelCatalogEntryId,
      reasoningEffort: fallback.reasoningEffort,
    });
  }
  const sql = getDatabase();
  const rows = await sql<PolicyRow[]>`
    insert into allrice_employee_model_policies (
      employee_id, organization_id, workspace_id, connection_id,
      model_catalog_entry_id, reasoning_effort, fallback_policy,
      fallback_targets, fallback_on, timeout_ms, max_input_tokens,
      max_output_tokens, max_total_tokens, max_cost_cents,
      revision, updated_by
    ) values (
      ${input.employeeId}, ${input.context.organizationId},
      ${input.workspaceId}, ${policy.connectionId},
      ${policy.modelCatalogEntryId}, ${policy.reasoningEffort},
      ${policy.fallbackPolicy}, ${sql.json(policy.fallbackTargets)},
      ${sql.json(policy.fallbackOn)}, ${policy.runLimits.timeoutMs},
      ${policy.runLimits.maxInputTokens}, ${policy.runLimits.maxOutputTokens},
      ${policy.runLimits.maxTotalTokens}, ${policy.runLimits.maxCostCents}, 1,
      ${actorId}
    ) on conflict (employee_id) do update set
      connection_id = excluded.connection_id,
      model_catalog_entry_id = excluded.model_catalog_entry_id,
      reasoning_effort = excluded.reasoning_effort,
      fallback_policy = excluded.fallback_policy,
      fallback_targets = excluded.fallback_targets,
      fallback_on = excluded.fallback_on,
      timeout_ms = excluded.timeout_ms,
      max_input_tokens = excluded.max_input_tokens,
      max_output_tokens = excluded.max_output_tokens,
      max_total_tokens = excluded.max_total_tokens,
      max_cost_cents = excluded.max_cost_cents,
      revision = allrice_employee_model_policies.revision + 1,
      updated_by = excluded.updated_by,
      updated_at = now()
    where allrice_employee_model_policies.organization_id = excluded.organization_id
      and allrice_employee_model_policies.workspace_id = excluded.workspace_id
    returning employee_id, organization_id, workspace_id, connection_id,
      model_catalog_entry_id, reasoning_effort, fallback_policy,
      fallback_targets, fallback_on, timeout_ms, max_input_tokens,
      max_output_tokens, max_total_tokens, max_cost_cents,
      revision, updated_by, updated_at
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  const persistedPolicy = mapPolicy(row);
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${input.context.organizationId}, ${input.workspaceId}, ${actorId},
      'employee_model_policy.update', 'employee', ${input.employeeId},
      'recorded', 'tenant_admin', ${input.context.requestId},
      ${sql.json({
        connectionId: row.connection_id,
        modelCatalogEntryId: row.model_catalog_entry_id,
        reasoningEffort: row.reasoning_effort,
        fallbackPolicy: row.fallback_policy,
        fallbackOn: persistedPolicy.fallbackOn,
        runLimits: persistedPolicy.runLimits,
        revision: row.revision,
      })}
    )
  `;
  return persistedPolicy;
}

async function ensureDefaultPolicy(input: {
  organizationId: string;
  workspaceId: string;
  employeeId: string;
  actorId: string;
}) {
  const sql = getDatabase();
  const rows = await sql<PolicyRow[]>`
    insert into allrice_employee_model_policies (
      employee_id, organization_id, workspace_id, connection_id,
      model_catalog_entry_id, reasoning_effort, fallback_policy,
      fallback_targets, fallback_on, timeout_ms, max_input_tokens,
      max_output_tokens, max_total_tokens, max_cost_cents,
      revision, updated_by
    ) values (
      ${input.employeeId}, ${input.organizationId}, ${input.workspaceId},
      ${defaultConnectionId}, ${defaultModelId}, 'xhigh', 'disabled',
      ${sql.json([])},
      ${sql.json([
        'provider_unavailable',
        'rate_limited',
        'timeout',
        'transient_error',
      ])}, 300000, 120000, 16000, 136000, null,
      1, ${input.actorId}
    ) on conflict (employee_id) do update
      set employee_id = excluded.employee_id
    returning employee_id, organization_id, workspace_id, connection_id,
      model_catalog_entry_id, reasoning_effort, fallback_policy,
      fallback_targets, fallback_on, timeout_ms, max_input_tokens,
      max_output_tokens, max_total_tokens, max_cost_cents,
      revision, updated_by, updated_at
  `;
  const row = rows[0];
  if (!row) throw new Error('default model policy creation failed');
  return mapPolicy(row);
}

async function resolveFrozenTarget(input: {
  organizationId: string;
  connectionId: string;
  modelCatalogEntryId: string;
  reasoningEffort: EmployeeModelPolicy['reasoningEffort'];
}) {
  const sql = getDatabase();
  const rows = await sql<
    {
      harness: 'codex' | 'dsh';
      provider_key: string;
      auth_mode: 'chatgpt_subscription' | 'api_key' | 'none';
      model: string;
      credential_reference: string | null;
      base_url: string | null;
    }[]
  >`
    select p.harness, p.provider_key, p.auth_mode, m.model,
      c.credential_reference, c.base_url
    from allrice_model_connections c
    join allrice_model_providers p on p.id = c.provider_id
    join allrice_model_catalog_entries m
      on m.id = ${input.modelCatalogEntryId} and m.provider_id = p.id
    where c.id = ${input.connectionId}
      and (c.scope = 'platform' or c.organization_id = ${input.organizationId})
      and c.status = 'ready' and p.enabled and m.enabled
  `;
  const selection = rows[0];
  if (!selection) throw new DataAccessError('grant_invalid');
  if (
    selection.harness === 'dsh' &&
    selection.auth_mode === 'api_key' &&
    !selection.credential_reference
  ) {
    throw new DataAccessError('grant_invalid');
  }
  return {
    connectionId: input.connectionId,
    modelCatalogEntryId: input.modelCatalogEntryId,
    // Codex is a Provider inside DSH. The legacy provider row may still say
    // `codex` until migration 0038 is applied, but no new snapshot may select
    // a peer Codex Harness.
    harness: 'dsh',
    provider:
      selection.provider_key === 'codex'
        ? 'openai-codex'
        : selection.provider_key === 'deepseek'
          ? 'deepseek-official'
          : 'openai-compatible',
    authMode: selection.auth_mode,
    model: selection.model,
    reasoningEffort: input.reasoningEffort,
    credentialReference: selection.credential_reference,
    baseUrl: selection.base_url,
  } as const;
}

export async function freezeSessionModelSnapshot(input: {
  organizationId: string;
  workspaceId: string;
  sessionId: string;
}) {
  const sql = getDatabase();
  const existing = await sql<{ snapshot: unknown }[]>`
    select snapshot from allrice_session_model_snapshots
    where organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
      and session_id = ${input.sessionId}
  `;
  if (existing[0])
    return SessionModelSnapshotSchema.parse(existing[0].snapshot);

  const sessions = await sql<{ employee_id: string; owner_id: string }[]>`
    select a.employee_id, s.owner_id
    from allrice_chat_sessions s
    join allrice_employee_assignments a
      on a.id = s.employee_assignment_id
      and a.organization_id = s.organization_id
      and a.workspace_id = s.workspace_id
    where s.organization_id = ${input.organizationId}
      and s.workspace_id = ${input.workspaceId}
      and s.id = ${input.sessionId}
      and s.archived_at is null
  `;
  const session = sessions[0];
  if (!session) throw new DataAccessError('not_found');
  const policy = await ensureDefaultPolicy({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    employeeId: session.employee_id,
    actorId: session.owner_id,
  });
  const selection = await resolveFrozenTarget({
    organizationId: input.organizationId,
    connectionId: policy.connectionId,
    modelCatalogEntryId: policy.modelCatalogEntryId,
    reasoningEffort: policy.reasoningEffort,
  });
  const resolvedFallbacks = await Promise.all(
    policy.fallbackTargets.map((fallback) =>
      resolveFrozenTarget({
        organizationId: input.organizationId,
        connectionId: fallback.connectionId,
        modelCatalogEntryId: fallback.modelCatalogEntryId,
        reasoningEffort: fallback.reasoningEffort,
      }),
    ),
  );
  const snapshot = SessionModelSnapshotSchema.parse({
    schemaVersion: 1,
    sessionId: input.sessionId,
    employeeId: session.employee_id,
    policyRevision: policy.revision,
    connectionId: selection.connectionId,
    modelCatalogEntryId: selection.modelCatalogEntryId,
    harness: selection.harness,
    provider: selection.provider,
    authMode: selection.authMode,
    model: selection.model,
    reasoningEffort: policy.reasoningEffort,
    credentialReference: selection.credentialReference,
    baseUrl: selection.baseUrl,
    fallbackPolicy: policy.fallbackPolicy,
    fallbackTargets: policy.fallbackTargets,
    fallbackOn: policy.fallbackOn,
    runLimits: policy.runLimits,
    resolvedFallbacks,
    frozenAt: new Date().toISOString(),
  });
  const inserted = await sql<{ snapshot: unknown }[]>`
    insert into allrice_session_model_snapshots (
      session_id, organization_id, workspace_id, employee_id,
      policy_revision, connection_id, model_catalog_entry_id, snapshot,
      frozen_at
    ) values (
      ${input.sessionId}, ${input.organizationId}, ${input.workspaceId},
      ${session.employee_id}, ${policy.revision}, ${policy.connectionId},
      ${policy.modelCatalogEntryId}, ${sql.json(snapshot)},
      ${new Date(snapshot.frozenAt)}
    ) on conflict (session_id) do update
      set session_id = excluded.session_id
    returning snapshot
  `;
  return SessionModelSnapshotSchema.parse(inserted[0]?.snapshot);
}
