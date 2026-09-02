import { UuidSchema } from '@allrice/contracts';
import { z } from 'zod';

import { getDatabase } from '../core/client.ts';

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RuntimeSnapshotSchema = z.object({
  id: UuidSchema,
  organizationId: UuidSchema,
  workspaceId: UuidSchema,
  sessionId: UuidSchema,
  ownerId: UuidSchema,
  threadId: z.string().trim().min(1).max(255),
  providerRoute: z.string().trim().min(1).max(120),
  model: z.string().trim().min(1).max(200),
  reasoningEffort: z.string().trim().min(1).max(40),
  profileFingerprint: FingerprintSchema,
  nativeTools: z.array(z.string().trim().min(1).max(160)).max(200),
  startedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
});

export type DshRuntimeProcessSnapshot = z.infer<typeof RuntimeSnapshotSchema>;

export async function replaceWorkerDshRuntimeInventory(input: {
  workerId: string;
  runtimes: readonly DshRuntimeProcessSnapshot[];
}) {
  const workerId = UuidSchema.parse(input.workerId);
  const runtimes = input.runtimes.map((item) =>
    RuntimeSnapshotSchema.parse(item),
  );
  const liveIds = runtimes.map((item) => item.id);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    await transaction`
      update allrice_dsh_runtime_instances
      set status = 'offline', ended_at = now(), updated_at = now()
      where status = 'live' and last_seen_at < now() - interval '15 seconds'
    `;
    await transaction`
      update allrice_dsh_runtime_instances
      set status = 'offline', ended_at = now(), updated_at = now()
      where worker_id = ${workerId} and status = 'live'
        and id <> all(${transaction.array(liveIds)}::uuid[])
    `;
    for (const runtime of runtimes) {
      await transaction`
        insert into allrice_dsh_runtime_instances (
          id, worker_id, organization_id, workspace_id, session_id, owner_id,
          thread_id, provider_route, model, reasoning_effort,
          profile_fingerprint, native_tools, status, started_at,
          last_activity_at, last_seen_at
        ) values (
          ${runtime.id}, ${workerId}, ${runtime.organizationId},
          ${runtime.workspaceId}, ${runtime.sessionId}, ${runtime.ownerId},
          ${runtime.threadId}, ${runtime.providerRoute}, ${runtime.model},
          ${runtime.reasoningEffort}, ${runtime.profileFingerprint},
          ${transaction.json(runtime.nativeTools)}, 'live',
          ${runtime.startedAt}, ${runtime.lastActivityAt}, now()
        )
        on conflict (thread_id) do update set
          id = excluded.id,
          worker_id = excluded.worker_id,
          organization_id = excluded.organization_id,
          workspace_id = excluded.workspace_id,
          session_id = excluded.session_id,
          owner_id = excluded.owner_id,
          provider_route = excluded.provider_route,
          model = excluded.model,
          reasoning_effort = excluded.reasoning_effort,
          profile_fingerprint = excluded.profile_fingerprint,
          native_tools = excluded.native_tools,
          status = 'live', last_activity_at = excluded.last_activity_at,
          last_seen_at = now(), ended_at = null, updated_at = now()
      `;
    }
  });
}

export async function markWorkerDshRuntimesOffline(workerId: string) {
  const sql = getDatabase();
  await sql`
    update allrice_dsh_runtime_instances
    set status = 'offline', ended_at = coalesce(ended_at, now()),
        updated_at = now()
    where worker_id = ${UuidSchema.parse(workerId)} and status = 'live'
  `;
}
