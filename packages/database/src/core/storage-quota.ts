import { UuidSchema } from '@allrice/contracts';
import type { TransactionSql } from 'postgres';

/** Every storage increment takes this gate as its FIRST transaction lock,
 * before session, runtime root, operation, browser or task admission locks.
 * Nested exporters may reacquire it only because their entry already owns it.
 * Identity rows remain SHARE-locked authority, never an upgradable quota mutex.
 * Seed 42 retains the existing upload quota namespace; tenants do not share it.
 */
export async function lockWorkspaceStorageQuota(
  tx: TransactionSql,
  organizationId: string,
  workspaceId: string | null,
) {
  const key = `${UuidSchema.parse(organizationId)}:${UuidSchema.parse(workspaceId)}`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${key},42))`;
}
