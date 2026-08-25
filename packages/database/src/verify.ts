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

  const compactionStatusRows = await sql<
    { version: string | undefined; semantics: string | undefined }[]
  >`
    select value ->> 'version' as version, value ->> 'semantics' as semantics
    from allrice_runtime_metadata
    where key = 'session-compaction-status-schema'
  `;
  if (
    expectedMigrations.includes('0019_session_compaction_status.sql') &&
    (compactionStatusRows[0]?.version !== '0019' ||
      compactionStatusRows[0]?.semantics !== 'floor-pressure-percent')
  ) {
    throw new Error(
      'Session compaction status schema metadata is missing or invalid',
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

  const conversationRuntimeRows = await sql<
    {
      version: string | undefined;
      provider: string | undefined;
      thread_source: string | undefined;
    }[]
  >`
    select value ->> 'version' as version,
      value ->> 'provider' as provider,
      value ->> 'threadSource' as thread_source
    from allrice_runtime_metadata
    where key = 'durable-conversation-runtime-schema'
  `;
  if (
    expectedMigrations.includes('0009_durable_conversation_runtime.sql') &&
    (conversationRuntimeRows[0]?.version !== '0009' ||
      conversationRuntimeRows[0]?.provider !== 'codex-app-server' ||
      conversationRuntimeRows[0]?.thread_source !== 'persistent')
  ) {
    throw new Error(
      'durable conversation runtime schema metadata is missing or invalid',
    );
  }

  const skillGovernanceRows = await sql<
    { version: string | undefined; capability_rule: string | undefined }[]
  >`
    select value ->> 'version' as version,
      value ->> 'capabilityRule' as capability_rule
    from allrice_runtime_metadata
    where key = 'skill-governance-schema'
  `;
  if (
    expectedMigrations.includes('0010_workspace_skill_governance.sql') &&
    (skillGovernanceRows[0]?.version !== '0010' ||
      skillGovernanceRows[0]?.capability_rule !== 'employee-intersection-skill')
  ) {
    throw new Error('Skill governance schema metadata is missing or invalid');
  }

  const employeeDefinitionRows = await sql<
    {
      version: string | undefined;
      definition: string | undefined;
      execution_snapshot: string | undefined;
      assignment: string | undefined;
    }[]
  >`
    select value ->> 'version' as version,
      value ->> 'definition' as definition,
      value ->> 'executionSnapshot' as execution_snapshot,
      value ->> 'assignment' as assignment
    from allrice_runtime_metadata
    where key = 'employee-definition-schema'
  `;
  if (
    expectedMigrations.includes('0015_employee_snapshot_rollout.sql') &&
    (employeeDefinitionRows[0]?.version !== '0015' ||
      employeeDefinitionRows[0]?.definition !== '2' ||
      employeeDefinitionRows[0]?.execution_snapshot !== '1' ||
      employeeDefinitionRows[0]?.assignment !== 'admin-managed')
  ) {
    throw new Error(
      'Employee Definition schema metadata is missing or invalid',
    );
  }
  const employeeSnapshotTriggerRows = await sql<{ installed: boolean }[]>`
    select exists (
      select 1 from pg_trigger
      where tgname = 'allrice_employee_runs_snapshot_rollout'
        and not tgisinternal
    ) as installed
  `;
  if (
    expectedMigrations.includes('0015_employee_snapshot_rollout.sql') &&
    employeeSnapshotTriggerRows[0]?.installed !== true
  ) {
    throw new Error('Employee snapshot rollout trigger is missing');
  }

  const checkpointRows = await sql<
    { version: string | undefined; summary: string | undefined }[]
  >`
    select value ->> 'version' as version, value ->> 'summary' as summary
    from allrice_runtime_metadata
    where key = 'context-checkpoint-schema'
  `;
  if (
    expectedMigrations.includes('0016_context_checkpoints.sql') &&
    (checkpointRows[0]?.version !== '0016' ||
      checkpointRows[0]?.summary !== 'extractive-v1')
  ) {
    throw new Error('Context checkpoint schema metadata is missing or invalid');
  }

  const conversationInputRows = await sql<
    { version: string | undefined; steer: string | undefined }[]
  >`
    select value ->> 'version' as version, value ->> 'steer' as steer
    from allrice_runtime_metadata
    where key = 'conversation-input-schema'
  `;
  if (
    expectedMigrations.includes('0017_active_turn_steer.sql') &&
    (conversationInputRows[0]?.version !== '0017' ||
      conversationInputRows[0]?.steer !== 'turn/steer')
  ) {
    throw new Error('Conversation input schema metadata is missing or invalid');
  }

  const usageWatermarkRows = await sql<
    { version: string | undefined; strategy: string | undefined }[]
  >`
    select value ->> 'version' as version, value ->> 'strategy' as strategy
    from allrice_runtime_metadata
    where key = 'conversation-usage-watermark-schema'
  `;
  if (
    expectedMigrations.includes('0018_conversation_usage_watermark.sql') &&
    (usageWatermarkRows[0]?.version !== '0018' ||
      usageWatermarkRows[0]?.strategy !== 'baseline-relative-max-visible')
  ) {
    throw new Error(
      'Conversation usage watermark schema metadata is missing or invalid',
    );
  }

  console.info(
    `[M5] database verified (${appliedMigrations.length} migration, pgvector ${vectorRows[0].version})`,
  );
} finally {
  await closeDatabase();
}
