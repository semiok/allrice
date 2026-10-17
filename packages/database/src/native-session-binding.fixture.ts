/** Synthetic descriptors for isolated SQL authority tests, not approved
 * production artifact evidence and never used by a consuming Worker. */
import { DSH_INSTALLED_DISTRIBUTION } from '@allrice/contracts';
import { randomUUID } from 'node:crypto';
import type { NativeSessionDescriptor } from './conversation/native-session-binding.ts';
import type postgres from 'postgres';
export function nativeBindingDescriptor(input: {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  contextKey?: string;
  profileId?: 'restricted' | 'technical';
}): NativeSessionDescriptor {
  const key = input.contextKey ?? randomUUID();
  return {
    nativeSessionId: 'dsh-' + key,
    artifactId: 'sha256:' + 'a'.repeat(64),
    artifactManifestDigest: 'sha256:' + 'a'.repeat(64),
    distributionGeneration: DSH_INSTALLED_DISTRIBUTION.generation,
    profileId: input.profileId ?? 'restricted',
    storageContextKey: key,
    storageNamespace: `/isolated-native/${input.organizationId}/${input.workspaceId}/${input.ownerId}/${key}/sessions`,
  };
}

export async function nativeBindingInsertGate(
  db: ReturnType<typeof postgres>,
  id: string,
) {
  const [scope] = await db`select current_schema() name`;
  if (!/^(p25_[a-f0-9]+|experience_consolidation_[a-f0-9]+)$/.test(scope!.name))
    throw Error('isolated schema required');
  await db.unsafe(`create or replace function native_binding_fixture_gate() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(hashtextextended(new.native_session_id,9187)); return new; end $$;
    drop trigger if exists native_binding_fixture_gate on allrice_native_session_bindings;
    create trigger native_binding_fixture_gate before insert on allrice_native_session_bindings
      for each row execute function native_binding_fixture_gate()`);
  const connection = await db.reserve();
  const [r] =
    await connection`select pg_backend_pid() pid,pg_advisory_lock(hashtextextended(${id},9187))`;
  let released = false;
  return {
    pid: r!.pid as number,
    release: async () => {
      if (released) return;
      released = true;
      await connection`select pg_advisory_unlock(hashtextextended(${id},9187))`;
      connection.release();
    },
  };
}
export async function nativeBindingWaiter(
  db: ReturnType<typeof postgres>,
  pid: number,
) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const [r] =
      await db`select pid from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) limit 1`;
    if (r) return r.pid as number;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('expected isolated PostgreSQL blocker not observed');
}
