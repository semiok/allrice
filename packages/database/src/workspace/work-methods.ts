import {
  completedToolWorkMethods,
  operationWorkMethod,
  type WorkMethod,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';

/** Caller must first authorize this Session with sessionRow. Read only the
 * already-visible Runs; return fixed labels, never arguments, files or outputs.
 * History reload after stream completion provides the same facts as a refresh. */
export async function readSessionWorkMethods(
  organizationId: string,
  workspaceId: string,
  sessionId: string,
  db = getDatabase(),
) {
  const facts = await db<
    {
      run_id: string;
      action: string;
      target: string | null;
      kind: 'completed_tool' | 'operation';
    }[]
  >`
    with visible_runs as (
      select run_id from allrice_employee_runs
      where organization_id=${organizationId} and workspace_id=${workspaceId}
        and session_id=${sessionId}
    ), facts as (
      select e.run_id, e.payload->>'name' as action, null::text as target,
        'completed_tool' as kind, min(e.occurred_at) as at
      from visible_runs r join allrice_run_events e on e.run_id=r.run_id
      where e.organization_id=${organizationId} and e.workspace_id=${workspaceId}
        and e.event_type='tool.completed'
        and e.payload->>'source' in ('dsh','codex','tool_broker')
        and e.payload->>'name' in ${db(Object.keys(completedToolWorkMethods))}
      group by e.run_id,e.payload->>'name'
      union all
      select o.root_run_id as run_id, o.snapshot->'binding'->>'action' as action,
        o.snapshot->'binding'->'execution'->>'targetKind' as target,
        'operation' as kind, min(started.at) as at
      from visible_runs r join allrice_runtime_operations o on o.root_run_id=r.run_id
      join lateral (
        select min(e.created_at) as at from allrice_runtime_operation_events e
        where e.operation_id=o.id and e.payload->'signal'->>'type'='operation.started'
        having count(*) > 0
      ) started on true
      where o.organization_id=${organizationId} and o.workspace_id=${workspaceId}
      group by o.root_run_id,o.snapshot->'binding'->>'action',
        o.snapshot->'binding'->'execution'->>'targetKind'
    ) select run_id,action,target,kind from facts order by at,action,target nulls first
  `;
  const result = new Map<string, WorkMethod[]>();
  for (const fact of facts) {
    const method =
      fact.kind === 'operation'
        ? operationWorkMethod(fact.action, fact.target ?? '')
        : completedToolWorkMethods[fact.action];
    if (!method) continue;
    const methods = result.get(fact.run_id) ?? [];
    if (!methods.includes(method)) methods.push(method);
    result.set(fact.run_id, methods);
  }
  return result;
}
