import { randomUUID } from 'node:crypto';

import {
  createSession,
  getDatabase,
  revokeSession,
} from '../../../packages/database/src/index.ts';

type Policy = {
  connectionId: string;
  modelCatalogEntryId: string;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  fallbackPolicy: 'disabled' | 'explicit';
  fallbackTargets: Array<{
    connectionId: string;
    modelCatalogEntryId: string;
    reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
  }>;
  fallbackOn: Array<
    'provider_unavailable' | 'rate_limited' | 'timeout' | 'transient_error'
  >;
  runLimits: {
    timeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxTotalTokens: number;
    maxCostCents: number | null;
  };
};

const baseUrl =
  process.env.ALLRICE_ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:3001';
const platformEmail =
  process.env.ALLRICE_ACCEPTANCE_PLATFORM_EMAIL ?? 'semiokshen@gmail.com';
const requestedFallbackProvider =
  process.env.ALLRICE_ACCEPTANCE_FALLBACK_PROVIDER ?? null;
const sql = getDatabase();
const bindings = await sql<
  {
    user_id: string;
    organization_id: string;
    workspace_id: string;
    employee_id: string;
    assignment_id: string;
    employee_version_id: string;
  }[]
>`
  select u.id as user_id, m.organization_id, a.workspace_id, a.employee_id,
    a.id as assignment_id, a.employee_version_id
  from allrice_users u
  join allrice_memberships m on m.user_id = u.id and m.active
  join allrice_employee_assignments a
    on a.organization_id = m.organization_id
   and a.user_id = u.id and a.active and a.is_default
  where lower(u.email) = lower(${platformEmail}) and u.status = 'active'
  order by m.created_at
  limit 1
`;
const binding = bindings[0];
if (!binding) {
  await sql.end();
  throw new Error(`default Rice assignment for ${platformEmail} was not found`);
}
const fallbackRows = await sql<
  {
    connection_id: string;
    catalog_id: string;
    provider_key: string;
  }[]
>`
  select c.id as connection_id, m.id as catalog_id, p.provider_key
  from allrice_model_connections c
  join allrice_model_providers p on p.id = c.provider_id
  join allrice_model_catalog_entries m on m.provider_id = p.id
  where p.provider_key <> 'codex' and p.enabled
    and (
      ${requestedFallbackProvider}::text is null
      or p.provider_key = ${requestedFallbackProvider}
    )
    and c.status = 'ready' and m.enabled
  order by c.priority, m.created_at
  limit 1
`;
const fallbackTarget = fallbackRows[0];
if (!fallbackTarget) {
  await sql.end();
  throw new Error(
    requestedFallbackProvider
      ? `a ready ${requestedFallbackProvider} Provider route is required`
      : 'a ready non-Codex Provider route or acceptance fixture is required',
  );
}
const expectedFallbackRoute =
  fallbackTarget.provider_key === 'deepseek'
    ? 'deepseek-official'
    : 'openai-compatible';

const identitySession = await createSession(binding.user_id);
const headers = {
  'content-type': 'application/json',
  cookie: `allrice_session=${identitySession.token}`,
  'x-allrice-organization-id': binding.organization_id,
  'x-allrice-workspace-id': binding.workspace_id,
};

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(
      `${response.url} returned ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

const policyUrl = new URL(
  `/api/v1/employees/${binding.employee_id}/model-policy?workspaceId=${binding.workspace_id}`,
  baseUrl,
);
let originalPolicy: Policy | null = null;
let primaryConnectionId: string | null = null;
let originalKillSwitch = false;

try {
  originalPolicy = (
    await readJson<{ policy: Policy }>(
      await fetch(policyUrl, { headers, cache: 'no-store' }),
    )
  ).policy;
  primaryConnectionId = originalPolicy.connectionId;
  const governanceUrl = new URL(
    `/api/v1/admin/model-connections/${primaryConnectionId}/governance`,
    baseUrl,
  );
  originalKillSwitch = (
    await readJson<{ provider: { killSwitch: boolean } }>(
      await fetch(governanceUrl, { headers, cache: 'no-store' }),
    )
  ).provider.killSwitch;
  await readJson(
    await fetch(policyUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        connectionId: originalPolicy.connectionId,
        modelCatalogEntryId: originalPolicy.modelCatalogEntryId,
        reasoningEffort: originalPolicy.reasoningEffort,
        fallbackPolicy: 'explicit',
        fallbackTargets: [
          {
            connectionId: fallbackTarget.connection_id,
            modelCatalogEntryId: fallbackTarget.catalog_id,
            reasoningEffort: 'high',
          },
        ],
        fallbackOn: ['provider_unavailable'],
        runLimits: originalPolicy.runLimits,
      }),
    }),
  );
  await readJson(
    await fetch(governanceUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ killSwitch: true }),
    }),
  );

  const created = await readJson<{ session: { id: string } }>(
    await fetch(new URL('/api/v1/sessions', baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workspaceId: binding.workspace_id,
        employeeAssignmentId: binding.assignment_id,
        employeeVersionId: binding.employee_version_id,
        title: 'MET-83 explicit Provider fallback acceptance',
      }),
    }),
  );
  const submitted = await readJson<{ run: { id: string } }>(
    await fetch(
      new URL(
        `/api/v1/sessions/${created.session.id}/messages?workspaceId=${binding.workspace_id}`,
        baseUrl,
      ),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          clientMessageId: randomUUID(),
          text: '请只回复：MET-83 显式 Provider 降级验收通过',
          attachmentIds: [],
          deliveryMode: 'auto',
        }),
      },
    ),
  );

  const deadline = Date.now() + 120_000;
  let state = 'queued';
  let errorCode: string | null = null;
  while (Date.now() < deadline) {
    const runRows = await sql<{ state: string; error_code: string | null }[]>`
      select state, error_code from allrice_runs where id = ${submitted.run.id}
    `;
    state = runRows[0]?.state ?? 'missing';
    errorCode = runRows[0]?.error_code ?? null;
    if (
      ['succeeded', 'failed', 'canceled', 'needs_attention'].includes(state)
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (state !== 'succeeded') {
    throw new Error(
      `fallback run ${submitted.run.id} ended as ${state} (${errorCode ?? 'no error code'})`,
    );
  }
  const decisions = await sql<
    {
      harness: string;
      provider: string;
      model: string;
      status: string;
      fallback_condition: string | null;
      reason_codes: string[];
    }[]
  >`
    select harness, provider, model, status, fallback_condition, reason_codes
    from allrice_route_decisions
    where run_id = ${submitted.run.id}
    order by attempt desc
    limit 1
  `;
  const decision = decisions[0];
  if (
    !decision ||
    decision.harness !== 'dsh' ||
    decision.provider !== expectedFallbackRoute ||
    decision.status !== 'succeeded' ||
    decision.fallback_condition !== 'provider_unavailable' ||
    !decision.reason_codes.includes('fallback_provider_selected')
  ) {
    throw new Error(
      `unexpected fallback decision: ${JSON.stringify(decision ?? null)}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      sessionId: created.session.id,
      runId: submitted.run.id,
      harness: decision.harness,
      provider: decision.provider,
      model: decision.model,
      fallbackCondition: decision.fallback_condition,
      reasonCodes: decision.reason_codes,
    })}\n`,
  );
} finally {
  if (primaryConnectionId) {
    await fetch(
      new URL(
        `/api/v1/admin/model-connections/${primaryConnectionId}/governance`,
        baseUrl,
      ),
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ killSwitch: originalKillSwitch }),
      },
    );
  }
  if (originalPolicy) {
    await fetch(policyUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        connectionId: originalPolicy.connectionId,
        modelCatalogEntryId: originalPolicy.modelCatalogEntryId,
        reasoningEffort: originalPolicy.reasoningEffort,
        fallbackPolicy: originalPolicy.fallbackPolicy,
        fallbackTargets: originalPolicy.fallbackTargets,
        fallbackOn: originalPolicy.fallbackOn,
        runLimits: originalPolicy.runLimits,
      }),
    });
  }
  await revokeSession(identitySession.token);
  await sql.end();
}
