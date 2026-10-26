import { z } from 'zod';
import { getDatabase } from '../core/client.ts';

const PARTITIONS = {
  'allrice-once-control-v1': {
    partitionId: 'allrice-once-v1',
    controls: 'allrice_native_once_controls',
  },
  'allrice-recurring-control-v1': {
    partitionId: 'allrice-recurring-v1',
    controls: 'allrice_native_recurring_controls',
  },
} as const;
const SessionStateSchema = z.enum(['reserved', 'initializing', 'ready']);

/** Pre-stop release check (MET-221). A context binds to its DSH generation, not
 * to an artifact ID. Chats and pins the installed generation cannot continue are
 * only counted: each is refused on its own, and archiving is its exit. Pins
 * outside this deployment's storage roots and control partitions are global,
 * so the caller fails on them; it verifies each partition's control history
 * with the candidate. Reads only tables and columns that exist before and after
 * migration 0218. */
export async function inspectNativeContextCompatibility(
  input: { generation: string; storageRoots: readonly string[] },
  sql = getDatabase(),
) {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const [chats] = await tx<{ n: number }[]>`
      select count(*)::int as n from allrice_chat_sessions
      where archived_at is null and (native_root_origin is null
        or native_root_origin->>'distributionGeneration' is distinct from ${input.generation})`;
    const live = () => tx`not exists (select 1 from allrice_chat_sessions c
      where b.context_kind='chat' and c.id=b.context_id and c.archived_at is not null)`;
    const [pins] = await tx<{ n: number }[]>`
      select count(*)::int as n from allrice_native_session_bindings b
      where b.distribution_generation <> ${input.generation} and ${live()}`;
    const roots = input.storageRoots.map(
      (root) => root.replace(/\/+$/, '') + '/',
    );
    const [moved] = await tx<{ n: number }[]>`
      select count(*)::int as n from allrice_native_session_bindings b
      where not exists (select 1 from unnest(${tx.array(roots)}::text[]) r(root)
        where starts_with(b.storage_namespace, r.root)) and ${live()}`;
    const rows = await tx<{ partition_id: string; reference: unknown }[]>`
      select partition_id,reference from allrice_native_once_partitions order by partition_id`;
    const controlPartitions = [];
    for (const row of rows) {
      const profileId = (row.reference as { profileId?: unknown } | null)
        ?.profileId;
      const known =
        typeof profileId === 'string' && Object.hasOwn(PARTITIONS, profileId)
          ? PARTITIONS[profileId as keyof typeof PARTITIONS]
          : undefined;
      if (!known || known.partitionId !== row.partition_id)
        throw Error(
          `DSH_NATIVE_CONTEXT_INCOMPATIBLE control partition ${row.partition_id}`,
        );
      const controls = await tx<
        { control_session_id: string; session_state: unknown }[]
      >`select control_session_id,snapshot->'control'->>'sessionState' session_state
        from ${tx(known.controls)} where partition_id=${row.partition_id}
        order by control_session_id`;
      controlPartitions.push({
        partitionId: row.partition_id,
        reference: row.reference,
        controls: controls.map((c) => ({
          controlSessionId: c.control_session_id,
          sessionState: SessionStateSchema.parse(c.session_state),
        })),
      });
    }
    return {
      incompatibleChats: chats!.n,
      incompatiblePins: pins!.n,
      pinsOutsideStorageRoots: moved!.n,
      controlPartitions,
    };
  });
}
