import {
  RouteDecisionSchema,
  RouteOutcomeSchema,
  type RouteDecision,
  type RouteOutcome,
} from '@allrice/contracts';

import { getDatabase } from '../core/client.ts';

interface RouteDecisionRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  actor_id: string;
  employee_id: string;
  run_id: string;
  input_checksum: string;
  candidates: unknown;
  selected_kind: RouteDecision['selectedKind'];
  selected_candidate_id: string;
  harness: RouteDecision['harness'];
  provider: string;
  model: string;
  model_connection_id: string | null;
  model_catalog_entry_id: string | null;
  model_policy_revision: number | null;
  fallback_from_decision_id: string | null;
  fallback_condition:
    | 'provider_unavailable'
    | 'rate_limited'
    | 'timeout'
    | 'transient_error'
    | null;
  generation: number;
  attempt: number;
  reason_codes: unknown;
  created_at: Date;
}

function mapDecision(row: RouteDecisionRow) {
  return RouteDecisionSchema.parse({
    schemaVersion: 1,
    id: row.id,
    runId: row.run_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    employeeId: row.employee_id,
    inputChecksum: row.input_checksum,
    candidates: row.candidates,
    selectedKind: row.selected_kind,
    selectedCandidateId: row.selected_candidate_id,
    harness: row.harness,
    provider: row.provider,
    model: row.model,
    modelConnectionId: row.model_connection_id,
    modelCatalogEntryId: row.model_catalog_entry_id,
    modelPolicyRevision: row.model_policy_revision,
    fallbackFromDecisionId: row.fallback_from_decision_id,
    fallbackCondition: row.fallback_condition,
    generation: row.generation,
    attempt: row.attempt,
    reasonCodes: row.reason_codes,
    createdAt: row.created_at.toISOString(),
  });
}

export async function recordRouteDecision(
  input: RouteDecision,
  sql = getDatabase(),
) {
  const decision = RouteDecisionSchema.parse(input);
  return sql.begin(async (transaction) => {
    const inserted = await transaction<{ id: string }[]>`
      insert into allrice_route_decisions (
        id, organization_id, workspace_id, actor_id, employee_id, run_id,
        input_checksum, candidates, selected_kind, selected_candidate_id,
        harness, provider, model, model_connection_id,
        model_catalog_entry_id, model_policy_revision,
        fallback_from_decision_id, fallback_condition,
        generation, attempt, reason_codes, created_at
      ) values (
        ${decision.id}, ${decision.organizationId}, ${decision.workspaceId},
        ${decision.actorId}, ${decision.employeeId}, ${decision.runId},
        ${decision.inputChecksum}, ${transaction.json(decision.candidates)},
        ${decision.selectedKind}, ${decision.selectedCandidateId},
        ${decision.harness}, ${decision.provider}, ${decision.model},
        ${decision.modelConnectionId}, ${decision.modelCatalogEntryId},
        ${decision.modelPolicyRevision},
        ${decision.fallbackFromDecisionId}, ${decision.fallbackCondition},
        ${decision.generation}, ${decision.attempt},
        ${transaction.json(decision.reasonCodes)},
        ${new Date(decision.createdAt)}
      ) on conflict (run_id, attempt) do nothing
      returning id
    `;
    const rows = await transaction<RouteDecisionRow[]>`
      select id, organization_id, workspace_id, actor_id, employee_id, run_id,
        input_checksum, candidates, selected_kind, selected_candidate_id,
        harness, provider, model, model_connection_id,
        model_catalog_entry_id, model_policy_revision,
        fallback_from_decision_id, fallback_condition,
        generation, attempt, reason_codes, created_at
      from allrice_route_decisions
      where run_id = ${decision.runId} and attempt = ${decision.attempt}
        and organization_id = ${decision.organizationId}
        and workspace_id = ${decision.workspaceId}
    `;
    const stored = rows[0];
    if (!stored) throw new Error('route decision persistence failed');
    if (inserted[0]) {
      await transaction`
        insert into allrice_audit_events (
          organization_id, workspace_id, actor_id, action, resource_type,
          resource_id, decision, reason, metadata
        ) values (
          ${decision.organizationId}, ${decision.workspaceId},
          ${decision.actorId}, 'route.decision', 'route_decision', ${stored.id},
          'recorded', ${stored.selected_kind},
          ${transaction.json({
            runId: stored.run_id,
            harness: stored.harness,
            provider: stored.provider,
            model: stored.model,
            fallbackFromDecisionId: stored.fallback_from_decision_id,
            fallbackCondition: stored.fallback_condition,
            reasonCodes: decision.reasonCodes,
          })}
        )
      `;
    }
    return mapDecision(stored);
  });
}

export async function completeRouteDecision(
  input: {
    organizationId: string;
    workspaceId: string;
    outcome: RouteOutcome;
  },
  sql = getDatabase(),
) {
  const outcome = RouteOutcomeSchema.parse(input.outcome);
  await sql.begin(async (transaction) => {
    const decisions = await transaction<
      {
        id: string;
        model_connection_id: string | null;
        model_catalog_entry_id: string | null;
      }[]
    >`
      select id, model_connection_id, model_catalog_entry_id
      from allrice_route_decisions
      where id = ${outcome.decisionId}
        and organization_id = ${input.organizationId}
        and workspace_id = ${input.workspaceId}
      for update
    `;
    const decision = decisions[0];
    if (!decision) throw new Error('route decision outcome was not accepted');
    const rows = await transaction<{ id: string }[]>`
      update allrice_route_decisions set
        status = ${outcome.status}, input_tokens = ${outcome.inputTokens},
        cached_input_tokens = ${outcome.cachedInputTokens},
        output_tokens = ${outcome.outputTokens}, cost_cents = ${outcome.costCents},
        cache_usage_known = ${outcome.cacheUsageKnown},
        usage_complete = ${outcome.usageComplete},
        error_code = ${outcome.errorCode},
        completed_at = ${new Date(outcome.completedAt)}
      where id = ${outcome.decisionId}
        and organization_id = ${input.organizationId}
        and workspace_id = ${input.workspaceId}
        and status in ('pending', ${outcome.status})
      returning id
    `;
    if (!rows[0]) throw new Error('route decision outcome was not accepted');
    await transaction`
      insert into allrice_model_usage_ledger (
        id, organization_id, workspace_id, route_decision_id, connection_id,
        model_catalog_entry_id, status, input_tokens, cached_input_tokens,
        output_tokens, cost_cents, cache_usage_known, usage_complete, occurred_at
      ) values (
        ${randomUUID()}, ${input.organizationId}, ${input.workspaceId},
        ${decision.id}, ${decision.model_connection_id},
        ${decision.model_catalog_entry_id}, ${outcome.status},
        ${outcome.inputTokens}, ${outcome.cachedInputTokens},
        ${outcome.outputTokens}, ${outcome.costCents},
        ${outcome.cacheUsageKnown}, ${outcome.usageComplete},
        ${new Date(outcome.completedAt)}
      ) on conflict (route_decision_id) do update set
        status = excluded.status, input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        output_tokens = excluded.output_tokens,
        cost_cents = excluded.cost_cents,
        cache_usage_known = excluded.cache_usage_known,
        usage_complete = excluded.usage_complete,
        occurred_at = excluded.occurred_at
    `;
    if (!decision.model_connection_id) return;
    const previous = await transaction<
      { circuit_state: 'closed' | 'open' | 'half_open' }[]
    >`
      select circuit_state from allrice_provider_circuit_breakers
      where connection_id = ${decision.model_connection_id}
    `;
    if (outcome.status === 'succeeded') {
      await transaction`
        insert into allrice_provider_circuit_breakers (
          connection_id, circuit_state, consecutive_failures,
          opened_until, last_error_code
        ) values (${decision.model_connection_id}, 'closed', 0, null, null)
        on conflict (connection_id) do update set
          circuit_state = 'closed', consecutive_failures = 0,
          opened_until = null, last_error_code = null, updated_at = now()
      `;
      if (previous[0] && previous[0].circuit_state !== 'closed') {
        await transaction`
          insert into allrice_operational_incidents (
            id, organization_id, workspace_id, connection_id, kind,
            severity, detail_code, metadata
          ) values (
            ${randomUUID()}, ${input.organizationId}, ${input.workspaceId},
            ${decision.model_connection_id}, 'provider_recovered', 'info',
            'provider_execution_succeeded',
            ${transaction.json({ routeDecisionId: decision.id })}
          )
        `;
      }
      return;
    }
    if (outcome.status !== 'failed' || !outcome.failureCategory) return;
    const circuits = await transaction<
      {
        circuit_state: 'closed' | 'open' | 'half_open';
        consecutive_failures: number;
      }[]
    >`
      insert into allrice_provider_circuit_breakers (
        connection_id, circuit_state, consecutive_failures,
        opened_until, last_error_code
      ) values (
        ${decision.model_connection_id}, 'closed', 1, null, ${outcome.errorCode}
      ) on conflict (connection_id) do update set
        consecutive_failures = allrice_provider_circuit_breakers.consecutive_failures + 1,
        circuit_state = case
          when allrice_provider_circuit_breakers.consecutive_failures + 1 >= 3
            then 'open'
          else allrice_provider_circuit_breakers.circuit_state
        end,
        opened_until = case
          when allrice_provider_circuit_breakers.consecutive_failures + 1 >= 3
            then now() + interval '60 seconds'
          else allrice_provider_circuit_breakers.opened_until
        end,
        last_error_code = excluded.last_error_code,
        updated_at = now()
      returning circuit_state, consecutive_failures
    `;
    const circuit = circuits[0];
    if (
      circuit?.circuit_state === 'open' &&
      previous[0]?.circuit_state !== 'open'
    ) {
      await transaction`
        insert into allrice_operational_incidents (
          id, organization_id, workspace_id, connection_id, kind,
          severity, detail_code, metadata
        ) values (
          ${randomUUID()}, ${input.organizationId}, ${input.workspaceId},
          ${decision.model_connection_id}, 'circuit_opened', 'critical',
          ${outcome.errorCode ?? outcome.failureCategory},
          ${transaction.json({
            routeDecisionId: decision.id,
            failureCategory: outcome.failureCategory,
            consecutiveFailures: circuit.consecutive_failures,
          })}
        )
      `;
    }
  });
}

export async function getRouteDecisionForRun(input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
  attempt: number;
}) {
  const sql = getDatabase();
  const rows = await sql<RouteDecisionRow[]>`
    select id, organization_id, workspace_id, actor_id, employee_id, run_id,
      input_checksum, candidates, selected_kind, selected_candidate_id,
      harness, provider, model, model_connection_id,
      model_catalog_entry_id, model_policy_revision,
      fallback_from_decision_id, fallback_condition,
      generation, attempt, reason_codes, created_at
    from allrice_route_decisions
    where run_id = ${input.runId} and attempt = ${input.attempt}
      and organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
  `;
  return rows[0] ? mapDecision(rows[0]) : null;
}

export async function listFailedRouteDecisions(input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
  beforeAttempt: number;
}) {
  const sql = getDatabase();
  const rows = await sql<RouteDecisionRow[]>`
    select id, organization_id, workspace_id, actor_id, employee_id, run_id,
      input_checksum, candidates, selected_kind, selected_candidate_id,
      harness, provider, model, model_connection_id,
      model_catalog_entry_id, model_policy_revision,
      fallback_from_decision_id, fallback_condition,
      generation, attempt, reason_codes, created_at
    from allrice_route_decisions
    where run_id = ${input.runId} and attempt < ${input.beforeAttempt}
      and organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
      and status = 'failed'
    order by attempt
  `;
  const errors = await sql<{ id: string; error_code: string | null }[]>`
    select id, error_code from allrice_route_decisions
    where run_id = ${input.runId} and attempt < ${input.beforeAttempt}
      and organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
      and status = 'failed'
  `;
  const errorById = new Map(errors.map((row) => [row.id, row.error_code]));
  return rows.map((row) => ({
    decision: mapDecision(row),
    errorCode: errorById.get(row.id) ?? null,
  }));
}
import { randomUUID } from 'node:crypto';
