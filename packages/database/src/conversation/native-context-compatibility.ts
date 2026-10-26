import { getDatabase } from '../core/client.ts';

const CONTROL_PROFILES = [
  'allrice-once-control-v1',
  'allrice-recurring-control-v1',
] as const;

/** Pre-stop release check (MET-221). A context binds to its DSH generation, not
 * to an artifact ID. Chats and pins the installed generation cannot continue are
 * only counted: each is refused on its own, and archiving is its exit. A control
 * partition is global, so one the build cannot load fails the check. Reads only
 * tables and columns that exist before and after 0218. */
export async function inspectNativeContextCompatibility(
  installedGeneration: string,
  sql = getDatabase(),
) {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    const [chats] = await tx<{ n: number }[]>`
      select count(*)::int as n from allrice_chat_sessions
      where archived_at is null and (native_root_origin is null
        or native_root_origin->>'distributionGeneration' is distinct from ${installedGeneration})`;
    const [pins] = await tx<{ n: number }[]>`
      select count(*)::int as n from allrice_native_session_bindings b
      where b.distribution_generation <> ${installedGeneration}
        and not exists (select 1 from allrice_chat_sessions c
          where b.context_kind='chat' and c.id=b.context_id and c.archived_at is not null)`;
    const partitions = await tx<{ partition_id: string }[]>`
      select partition_id from allrice_native_once_partitions
      where not (reference->>'profileId' = any(${tx.array([...CONTROL_PROFILES])}::text[]))
      order by partition_id`;
    if (partitions.length)
      throw Error(
        `DSH_NATIVE_CONTEXT_INCOMPATIBLE control partitions: ${partitions
          .map((p) => p.partition_id)
          .join(', ')}`,
      );
    return { incompatibleChats: chats!.n, incompatiblePins: pins!.n };
  });
}
