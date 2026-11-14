import type postgres from 'postgres';
/** Explicit synthetic organization opt-in; never changes shared Dev defaults. */
export async function enableSyntheticMemorySourceCollection(
  db: postgres.Sql,
  organizationId: string,
) {
  await db`insert into allrice_settings(scope_type,scope_id,key,value)
    values('organization',${organizationId},'employee_memory_source_policy',
      ${db.json({ schemaVersion: 1, enabled: true, revision: 1, collectionStartedAt: new Date(0).toISOString() })})`;
}
