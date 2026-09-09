import {
  RuntimeOperationSnapshotSchema,
  RuntimeLocalMcpPayloadSchema,
  RuntimeActionApprovalSnapshotSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { ownedLocalCommandRun } from './local-command-service.ts';
import { getRuntimeActionApproval } from './runtime-policy.ts';

export async function listLocalMcpOperations(
  context: RequestContext,
  runId: string,
  database = getDatabase(),
) {
  await ownedLocalCommandRun(database, context, runId);
  const rows = await database<
    {
      id: string;
      snapshot: unknown;
      bridge_payload: unknown;
      approval_id: string | null;
      name: string | null;
    }[]
  >`select o.id,o.snapshot,o.bridge_payload,a.id as approval_id,d.name from allrice_runtime_operations o
    left join allrice_approval_requests a on a.resource_type='runtime_operation' and a.resource_id=o.id and a.organization_id=o.organization_id and a.workspace_id=o.workspace_id and a.actor_id=${context.actor.id}
    left join allrice_bridge_devices d on d.id=o.device_id and d.organization_id=o.organization_id and d.workspace_id=o.workspace_id
    where o.run_id=${runId} and o.organization_id=${context.organizationId} and o.workspace_id=${context.workspaceId} and o.bridge_payload->>'capability' in ('local.mcp.discover','local.mcp.call') order by o.created_at limit 64`;
  return Promise.all(
    rows.map(async (row) => {
      const [receipt] = await database<
        { evidence: unknown }[]
      >`select payload->'evidence' as evidence from allrice_runtime_operation_receipts where operation_id=${row.id} and disposition='applied' and payload->'signal'->>'type' in ('operation.outcome','operation.stopped','operation.uncertain') order by received_at desc limit 1`;
      return {
        snapshot: RuntimeOperationSnapshotSchema.parse(row.snapshot),
        payload: RuntimeLocalMcpPayloadSchema.parse(row.bridge_payload),
        deviceName: row.name ?? 'Bridge',
        approval: row.approval_id
          ? RuntimeActionApprovalSnapshotSchema.parse(
              await getRuntimeActionApproval(
                context,
                row.approval_id,
                database,
              ),
            )
          : null,
        evidence: receipt?.evidence ?? null,
      };
    }),
  );
}
export type LocalMcpOperationView = Awaited<
  ReturnType<typeof listLocalMcpOperations>
>[number];
