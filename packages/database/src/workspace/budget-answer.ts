import { getDatabase } from '../core/client.ts';

/** Read-only repair projection. Never rewrite historical status or usage. */
export async function completedBudgetAnswers(
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    sessionId: string;
    runIds: string[];
  },
  sql = getDatabase(),
) {
  if (!input.runIds.length) return new Map<string, string>();
  const rows = await sql<{ run_id: string; text: string }[]>`
    select distinct on (e.run_id) e.run_id, e.payload->>'text' as text
    from allrice_run_events e
    join allrice_runs r on r.id=e.run_id
    join allrice_jobs j on j.run_id=r.id
    join allrice_employee_runs er on er.run_id=r.id
    where r.organization_id=${input.organizationId}
      and r.workspace_id=${input.workspaceId}
      and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id
      and er.owner_id=${input.ownerId} and er.session_id=${input.sessionId}
      and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id
      and r.id in ${sql(input.runIds)} and r.state='failed'
      and not exists(select 1 from allrice_assistant_roots a where a.root_run_id=r.id)
      and not exists(select 1 from allrice_assistant_instances a where a.run_id=r.id)
      and r.error_code in ('MODEL_OUTPUT_BUDGET_EXCEEDED','MODEL_TOTAL_TOKEN_BUDGET_EXCEEDED')
      and e.event_type='assistant.text.completed'
      and e.payload->>'attempt'=j.attempt::text
      and length(e.payload->>'text') between 1 and 100000
      and exists (
        select 1 from allrice_run_events done
        where done.run_id=r.id and done.organization_id=r.organization_id
          and done.workspace_id=r.workspace_id and done.event_type='turn.completed'
          and done.sequence > e.sequence
          and done.payload->>'generation'=e.payload->>'generation'
          and done.payload->>'turnId'=e.payload->>'turnId'
      )
      and exists (
        select 1 from allrice_route_decisions d
        join allrice_route_subscription_snapshots proof on proof.route_decision_id=d.id
        join allrice_model_usage_ledger l on l.route_decision_id=d.id
        where d.run_id=r.id and d.organization_id=r.organization_id
          and d.workspace_id=r.workspace_id and l.usage_complete
          and d.error_code=r.error_code
      )
      and not exists (
        select 1 from allrice_route_decisions d
        join allrice_model_usage_ledger l on l.route_decision_id=d.id
        where d.run_id=r.id and not l.usage_complete
      )
    order by e.run_id, e.sequence desc
  `;
  return new Map(rows.map((row) => [row.run_id, row.text]));
}
