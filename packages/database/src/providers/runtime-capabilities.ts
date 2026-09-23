import {
  WorkerCapabilitySnapshotSchema,
  WorkerCapabilityObservationSchema,
  type WorkerCapabilitySnapshot,
  type RuntimeCapabilityInventory,
  type RuntimeCapabilityPublication,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';

const prefix = 'dsh-worker-capabilities:';

export async function recordWorkerCapabilities(
  input: WorkerCapabilitySnapshot,
  sql = getDatabase(),
) {
  const snapshot = WorkerCapabilitySnapshotSchema.parse(input);
  await sql`insert into allrice_runtime_metadata (key,value,updated_at)
    values (${prefix + snapshot.workerId},${sql.json(snapshot)},clock_timestamp())
    on conflict (key) do update set value=excluded.value,updated_at=excluded.updated_at`;
}

export async function removeWorkerCapabilities(
  workerId: string,
  sql = getDatabase(),
) {
  await sql`delete from allrice_runtime_metadata where key=${prefix + workerId}`;
}

export async function readRuntimeCapabilityInventory(
  sql = getDatabase(),
): Promise<RuntimeCapabilityInventory> {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const [clock] = await tx<{ now: Date }[]>`select now() as now`;
    const reports = await tx<
      { value: unknown; updated_at: Date; online: boolean }[]
    >`
      select value,updated_at,updated_at > now()-interval '20 seconds' as online
      from allrice_runtime_metadata where starts_with(key,${prefix})
      order by updated_at desc`;
    const workers = reports.map((row) =>
      WorkerCapabilityObservationSchema.parse({
        ...WorkerCapabilitySnapshotSchema.parse(row.value),
        observedAt: row.updated_at.toISOString(),
        online: row.online,
      }),
    );
    // Read tenant-side versions actually assigned to active users. A platform
    // draft/currentPublished pointer is not evidence of a deployed binding.
    const publications = await tx<RuntimeCapabilityPublication[]>`
      select distinct e.name as "employeeName",w.id as "workspaceId",w.name as "workspaceName",
        v.version,
        array(select s->>'id' from jsonb_array_elements(coalesce(v.manifest#>'{runtimePackage,skills}','[]'::jsonb)) s) as "skillIds",
        array(select jsonb_array_elements_text(coalesce(v.manifest#>'{capabilityBindings,toolNames}','[]'::jsonb))) as "toolNames",
        coalesce((p.controls->>'enabled')::boolean,false) as "policyEnabled",p.controls->>'mode' as "policyMode"
      from allrice_employee_assignments a
      join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
      join allrice_employee_versions v on v.id=a.employee_version_id and v.employee_id=e.id
      join allrice_workspaces w on w.id=a.workspace_id
      join allrice_organizations o on o.id=a.organization_id
      left join allrice_runtime_policy_controls p on p.organization_id=a.organization_id and p.workspace_id=a.workspace_id
      where a.active and e.status='active' and w.archived_at is null and o.archived_at is null
        and exists (select 1 from allrice_memberships m where m.user_id=a.user_id and m.organization_id=a.organization_id
          and (m.workspace_id is null or m.workspace_id=a.workspace_id) and m.active)
      order by "workspaceName","employeeName",v.version`;
    return { checkedAt: clock!.now.toISOString(), workers, publications };
  });
}
