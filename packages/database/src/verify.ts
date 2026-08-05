import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { closeDatabase, getDatabase } from './index.js';

const migrationsDirectory = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

try {
  const sql = getDatabase();
  const expectedMigrations = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const appliedRows = await sql<{ name: string }[]>`
    select name from allrice_schema_migrations order by name
  `;
  const appliedMigrations = appliedRows.map((row) => row.name);

  if (
    JSON.stringify(appliedMigrations) !== JSON.stringify(expectedMigrations)
  ) {
    throw new Error(
      `migration mismatch: expected ${expectedMigrations.join(', ') || 'none'}, got ${appliedMigrations.join(', ') || 'none'}`,
    );
  }

  const vectorRows = await sql<{ version: string }[]>`
    select extversion as version from pg_extension where extname = 'vector'
  `;
  if (!vectorRows[0]?.version) {
    throw new Error('pgvector extension is not installed');
  }

  const metadataRows = await sql<{ version: string | undefined }[]>`
    select value ->> 'version' as version
    from allrice_runtime_metadata
    where key = 'baseline'
  `;
  if (metadataRows[0]?.version !== '0.1.0') {
    throw new Error('baseline runtime metadata is missing or invalid');
  }

  const dataStorageRows = await sql<{ version: string | undefined }[]>`
    select value ->> 'version' as version
    from allrice_runtime_metadata
    where key = 'data-storage-schema'
  `;
  if (
    expectedMigrations.includes('0003_data_storage.sql') &&
    dataStorageRows[0]?.version !== '0003'
  ) {
    throw new Error('data/storage schema metadata is missing or invalid');
  }

  const executionRows = await sql<{ version: string | undefined }[]>`
    select value ->> 'version' as version
    from allrice_runtime_metadata
    where key = 'execution-plane-schema'
  `;
  if (
    expectedMigrations.includes('0005_execution_plane.sql') &&
    executionRows[0]?.version !== '0005'
  ) {
    throw new Error('execution plane schema metadata is missing or invalid');
  }

  const skillHubRows = await sql<
    { version: string | undefined; provider: string | undefined }[]
  >`
    select value ->> 'version' as version, value ->> 'provider' as provider
    from allrice_runtime_metadata
    where key = 'skillhub-schema'
  `;
  if (
    expectedMigrations.includes('0006_skillhub_codex.sql') &&
    (skillHubRows[0]?.version !== '0006' ||
      skillHubRows[0]?.provider !== 'codex')
  ) {
    throw new Error('SkillHub/Codex schema metadata is missing or invalid');
  }

  const employeeHubRows = await sql<
    { version: string | undefined; default_employee: string | undefined }[]
  >`
    select value ->> 'version' as version,
      value ->> 'defaultEmployee' as default_employee
    from allrice_runtime_metadata
    where key = 'employeehub-schema'
  `;
  if (
    expectedMigrations.includes('0007_employeehub_rice.sql') &&
    (employeeHubRows[0]?.version !== '0007' ||
      employeeHubRows[0]?.default_employee !== 'Rice')
  ) {
    throw new Error('EmployeeHub/Rice schema metadata is missing or invalid');
  }

  console.info(
    `[M5] database verified (${appliedMigrations.length} migration, pgvector ${vectorRows[0].version})`,
  );
} finally {
  await closeDatabase();
}
