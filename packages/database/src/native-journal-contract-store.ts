// scripts/m1/deploy-dev recognizes a release that knows the journal contract by
// its built packages/database/dist/native-journal-contract-store.js (deploy,
// rollback, restore, --status). Keep this file name, or change that check in the
// same PR.
import { z } from 'zod';
import type postgres from 'postgres';
import { getDatabase } from './core/client.ts';

/** allrice_runtime_metadata key of the DSH journal contract high-water. */
export const NATIVE_JOURNAL_CONTRACT_KEY = 'dsh-journal-contract';

/** The row's only shape. Workers write it at start and 0218 writes the baseline
 * and guards monotonicity with exactly this schema (MET-221). */
export const NativeJournalContractRowSchema = z
  .object({
    highWater: z.number().int().min(1).max(999_999_999),
    since: z.string().min(1).max(40).optional(),
  })
  .strict();

const ContractSchema = z
  .object({
    current: z.number().int().min(1).max(999_999_999),
    readsFrom: z.number().int().min(1).max(999_999_999),
  })
  .refine((c) => c.readsFrom <= c.current);

type Sql = postgres.Sql | postgres.TransactionSql;

function parseRow(value: unknown) {
  const row = NativeJournalContractRowSchema.safeParse(value);
  if (!row.success) throw Error('DSH_NATIVE_JOURNAL_CONTRACT_INVALID');
  return row.data;
}

/** Before 0218 the row may be absent: every journal written then is contract 1. */
export async function readNativeJournalContractHighWater(
  sql: Sql = getDatabase(),
) {
  const [row] = await sql<{ value: unknown }[]>`
    select value from allrice_runtime_metadata
    where key=${NATIVE_JOURNAL_CONTRACT_KEY}`;
  return {
    highWater: row ? parseRow(row.value).highWater : 1,
    recorded: Boolean(row),
  };
}

/** A build reads journals from `readsFrom` through `current`. */
export function assertNativeJournalContractCovers(
  contract: { current: number; readsFrom: number },
  highWater: number,
) {
  const c = ContractSchema.parse(contract);
  if (highWater > c.current) throw Error('DSH_NATIVE_JOURNAL_CONTRACT_AHEAD');
  if (c.readsFrom > highWater)
    throw Error('DSH_NATIVE_JOURNAL_CONTRACT_BEHIND');
}

/** Worker start, before any producer: refuse a build that cannot read the
 * journals already written, then raise the high-water to this build's current. */
export async function recordNativeJournalContract(
  contract: { current: number; readsFrom: number },
  sql = getDatabase(),
) {
  const c = ContractSchema.parse(contract);
  return sql.begin(async (tx) => {
    await tx`set local lock_timeout='5s'`;
    // The row may not exist yet, so a row lock cannot serialize the first write.
    await tx`select pg_advisory_xact_lock(hashtextextended(${NATIVE_JOURNAL_CONTRACT_KEY},0))`;
    const { highWater } = await readNativeJournalContractHighWater(tx);
    assertNativeJournalContractCovers(c, highWater);
    const [row] = await tx<{ value: unknown }[]>`
      insert into allrice_runtime_metadata (key,value,updated_at)
      values (${NATIVE_JOURNAL_CONTRACT_KEY},${tx.json({ highWater: c.current })},clock_timestamp())
      on conflict (key) do update set
        value=allrice_runtime_metadata.value || jsonb_build_object('highWater',
          greatest((allrice_runtime_metadata.value->>'highWater')::int, ${c.current}::int)),
        updated_at=excluded.updated_at
      returning value`;
    return parseRow(row!.value);
  });
}
