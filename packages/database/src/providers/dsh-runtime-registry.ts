import type postgres from 'postgres';
import { UuidSchema } from '@allrice/contracts';
import { z } from 'zod';

import { getDatabase } from '../core/client.ts';
import { readDshRuntimeCloseCoverage } from './dsh-runtime-close-observations.ts';

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
    await upsertRuntimeInventory(transaction, workerId, runtimes);
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

async function upsertRuntimeInventory(
  transaction: postgres.TransactionSql,
  workerId: string,
  runtimes: readonly DshRuntimeProcessSnapshot[],
  preserveIdentity = false,
) {
  for (const runtime of runtimes) {
    const written = await transaction`
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
        where ${!preserveIdentity} or (
          allrice_dsh_runtime_instances.id = excluded.id
          and allrice_dsh_runtime_instances.worker_id = excluded.worker_id
          and allrice_dsh_runtime_instances.organization_id = excluded.organization_id
          and allrice_dsh_runtime_instances.workspace_id = excluded.workspace_id
          and allrice_dsh_runtime_instances.session_id = excluded.session_id
          and allrice_dsh_runtime_instances.owner_id = excluded.owner_id
        )
        returning id
      `;
    if (preserveIdentity && written.length !== 1)
      throw Error('DSH_CLOSE_REGISTRY_IDENTITY_CONFLICT');
  }
}

/** Final physical reconciliation, after the old heartbeat has drained. Only
 * exact witnessed-exited IDs change to offline. Other boots/history/unknown
 * rows are retained; this is not semantic closure or retirement authority. */
export async function finalizeWorkerDshRuntimeInventory(input: {
  workerId: string;
  workerBootId: string;
  serviceManifestDigest: string;
  runtimes: readonly DshRuntimeProcessSnapshot[];
  exitedRuntimeIds: readonly string[];
}) {
  const workerId = UuidSchema.parse(input.workerId);
  const workerBootId = UuidSchema.parse(input.workerBootId);
  const serviceManifestDigest = z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .parse(input.serviceManifestDigest);
  const runtimes = input.runtimes.map((value) =>
    RuntimeSnapshotSchema.parse(value),
  );
  const exitedRuntimeIds = input.exitedRuntimeIds.map((id) =>
    UuidSchema.parse(id),
  );
  const activeIds = new Set(runtimes.map((runtime) => runtime.id));
  if (
    activeIds.size !== runtimes.length ||
    new Set(exitedRuntimeIds).size !== exitedRuntimeIds.length ||
    exitedRuntimeIds.some((id) => activeIds.has(id))
  )
    throw Error('DSH_CLOSE_INVENTORY_CONFLICT');
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    await transaction`set local statement_timeout='5000'`;
    await transaction`set local lock_timeout='1000'`;
    // Re-read the existing append-only observation table inside the write
    // transaction. A caller's in-memory exited ID alone is not boot authority.
    const coverage = await readDshRuntimeCloseCoverage(transaction, {
      workerBootId,
    });
    const byId = new Map<string, (typeof coverage)[number]>();
    for (const item of coverage) {
      if (
        item.owner.workerId !== workerId ||
        item.owner.workerBootId !== workerBootId ||
        item.owner.serviceManifestDigest !== serviceManifestDigest ||
        byId.has(item.owner.runtimeId)
      )
        throw Error('DSH_CLOSE_BOOT_IDENTITY_MISMATCH');
      byId.set(item.owner.runtimeId, item);
    }
    const matchesScope = (
      item: (typeof coverage)[number] | undefined,
      row: {
        organizationId: string;
        workspaceId: string;
        sessionId: string;
        ownerId: string;
      },
    ) => {
      const c = item?.owner.context;
      return (
        c?.kind === 'context' &&
        c.contextKind === 'chat' &&
        c.contextId === row.sessionId &&
        c.organizationId === row.organizationId &&
        c.workspaceId === row.workspaceId &&
        c.ownerId === row.ownerId
      );
    };
    for (const runtime of runtimes) {
      const item = byId.get(runtime.id);
      if (!matchesScope(item, runtime))
        throw Error('DSH_CLOSE_PHYSICAL_OWNER_MISMATCH');
      if (item!.physical !== 'unknown')
        throw Error('DSH_CLOSE_PHYSICAL_EVIDENCE_CONFLICT');
    }
    for (const id of exitedRuntimeIds)
      if (byId.get(id)?.physical !== 'exited')
        throw Error('DSH_CLOSE_EXIT_NOT_WITNESSED');
    const ids = [...activeIds, ...exitedRuntimeIds].sort();
    const rows = await transaction<
      {
        id: string;
        workerId: string;
        organizationId: string;
        workspaceId: string;
        sessionId: string;
        ownerId: string;
        threadId: string;
      }[]
    >`select id,worker_id as "workerId",organization_id as "organizationId",
      workspace_id as "workspaceId",session_id as "sessionId",owner_id as "ownerId",thread_id as "threadId"
      from allrice_dsh_runtime_instances
      where id=any(${transaction.array(ids)}::uuid[])
        or thread_id=any(${transaction.array(runtimes.map((r) => r.threadId))}::text[])
      order by id for update`;
    const liveById = new Map(runtimes.map((r) => [r.id, r]));
    for (const row of rows) {
      const expectedLive = liveById.get(row.id);
      if (
        !ids.includes(row.id) ||
        row.workerId !== workerId ||
        !matchesScope(byId.get(row.id), row) ||
        (expectedLive && expectedLive.threadId !== row.threadId)
      )
        throw Error('DSH_CLOSE_REGISTRY_IDENTITY_CONFLICT');
    }
    await transaction`
      update allrice_dsh_runtime_instances
      set status = 'offline', ended_at = coalesce(ended_at, now()), updated_at = now()
      where worker_id = ${workerId} and id = any(${transaction.array(exitedRuntimeIds)}::uuid[])
        and status = 'live'
    `;
    await upsertRuntimeInventory(transaction, workerId, runtimes, true);
  });
}
