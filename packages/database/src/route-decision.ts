import {
  RouteDecisionSchema,
  RouteOutcomeSchema,
  type RouteDecision,
  type RouteOutcome,
} from '@allrice/contracts';

import { getDatabase } from './index.ts';

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
    generation: row.generation,
    attempt: row.attempt,
    reasonCodes: row.reason_codes,
    createdAt: row.created_at.toISOString(),
  });
}

export async function recordRouteDecision(input: RouteDecision) {
  const decision = RouteDecisionSchema.parse(input);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const inserted = await transaction<{ id: string }[]>`
      insert into allrice_route_decisions (
        id, organization_id, workspace_id, actor_id, employee_id, run_id,
        input_checksum, candidates, selected_kind, selected_candidate_id,
        harness, provider, model, generation, attempt, reason_codes, created_at
      ) values (
        ${decision.id}, ${decision.organizationId}, ${decision.workspaceId},
        ${decision.actorId}, ${decision.employeeId}, ${decision.runId},
        ${decision.inputChecksum}, ${transaction.json(decision.candidates)},
        ${decision.selectedKind}, ${decision.selectedCandidateId},
        ${decision.harness}, ${decision.provider}, ${decision.model},
        ${decision.generation}, ${decision.attempt},
        ${transaction.json(decision.reasonCodes)},
        ${new Date(decision.createdAt)}
      ) on conflict (run_id, attempt) do nothing
      returning id
    `;
    const rows = await transaction<RouteDecisionRow[]>`
      select id, organization_id, workspace_id, actor_id, employee_id, run_id,
        input_checksum, candidates, selected_kind, selected_candidate_id,
        harness, provider, model, generation, attempt, reason_codes, created_at
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
            reasonCodes: decision.reasonCodes,
          })}
        )
      `;
    }
    return mapDecision(stored);
  });
}

export async function completeRouteDecision(input: {
  organizationId: string;
  workspaceId: string;
  outcome: RouteOutcome;
}) {
  const outcome = RouteOutcomeSchema.parse(input.outcome);
  const sql = getDatabase();
  const rows = await sql<{ id: string }[]>`
    update allrice_route_decisions set
      status = ${outcome.status}, input_tokens = ${outcome.inputTokens},
      cached_input_tokens = ${outcome.cachedInputTokens},
      output_tokens = ${outcome.outputTokens}, cost_cents = ${outcome.costCents},
      error_code = ${outcome.errorCode},
      completed_at = ${new Date(outcome.completedAt)}
    where id = ${outcome.decisionId}
      and organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
      and status in ('pending', ${outcome.status})
    returning id
  `;
  if (!rows[0]) throw new Error('route decision outcome was not accepted');
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
      harness, provider, model, generation, attempt, reason_codes, created_at
    from allrice_route_decisions
    where run_id = ${input.runId} and attempt = ${input.attempt}
      and organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
  `;
  return rows[0] ? mapDecision(rows[0]) : null;
}
