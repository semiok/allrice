import type postgres from 'postgres';
import type { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;

/** Locate immutable mapping first; take the legacy asset lock before Knowledge
 * locks, matching publication. Ownership alone never authorizes a private draft. */
export async function legacyReferenceAuthority(
  sql: Sql,
  sourceId: string,
  lock = false,
) {
  const [mapping] =
    await sql`select legacy_company_asset_id from allrice_knowledge_sources where id=${sourceId}`;
  if (!mapping?.legacy_company_asset_id) return null;
  const [asset] =
    await sql`select id,state,published_revision_id from allrice_company_assets
    where id=${mapping.legacy_company_asset_id} and kind='template' ${lock ? sql`for share` : sql``}`;
  if (!asset || asset.state !== 'published')
    throw new DataAccessError('not_found');
  return asset;
}

/** Recheck the exact publication and retained bytes, including historical pins. */
export async function assertLegacyReferenceRevision(
  sql: Sql,
  revisionId: string,
  assetId: string,
) {
  const [row] = await sql`select r.id from allrice_knowledge_revisions r
    join allrice_company_asset_publications p on p.asset_id=r.legacy_company_asset_id and p.revision_id=r.legacy_company_revision_id
    join allrice_company_asset_revisions cr on cr.asset_id=p.asset_id and cr.id=p.revision_id
    join allrice_storage_objects o on o.id=cr.snapshot_object_id and o.id=r.file_object_id
    where r.id=${revisionId} and p.asset_id=${assetId} and o.organization_id=cr.organization_id
      and o.state='ready' and o.immutable and o.deleted_at is null and o.retention_until is null
      and cr.file_metadata->>'checksum'=o.checksum and (cr.file_metadata->>'sizeBytes')::bigint=o.size_bytes
      and cr.file_metadata->>'mediaType'=o.media_type`;
  if (!row) throw new DataAccessError('not_found');
}
