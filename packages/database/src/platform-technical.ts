import { createHash } from 'node:crypto';
import {
  CaptureTechnicalIssueSchema,
  TechnicalDiagnosticsSchema,
  TechnicalIssueDetailSchema,
  TechnicalIssueSchema,
  TechnicalRecordSchema,
  UpdateTechnicalIssueSchema,
  type TechnicalDiagnostics,
  type TechnicalEnvironmentSchema,
  type TechnicalEvidence,
  type TechnicalRecord,
} from './platform-technical-contracts.ts';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import type { z } from 'zod';
import type postgres from 'postgres';
import { getDatabase, getDiagnosticsDatabase } from './core/client.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { readOperationsInventory } from './operations-resources.ts';
import { executionPressureSnapshot } from './execution-diagnostics.ts';
import { DataAccessError } from './data.ts';

type Database = ReturnType<typeof getDatabase>;
type Sql = Database | postgres.TransactionSql;
type Environment = z.infer<typeof TechnicalEnvironmentSchema>;
export function technicalEnvironment(): Environment {
  const value = process.env.ALLRICE_ENV;
  return value === 'development'
    ? 'dev'
    : value === 'production'
      ? 'prod'
      : value === 'test'
        ? 'test'
        : 'unknown';
}
function code(value: unknown, max = 100) {
  return typeof value === 'string' &&
    value.length <= max &&
    /^[A-Za-z0-9_.:-]+$/.test(value)
    ? value
    : null;
}
function date(value: unknown) {
  return value instanceof Date ? value.toISOString() : value;
}
function record(row: Record<string, unknown>): TechnicalRecord {
  return TechnicalRecordSchema.parse({
    kind: row.kind,
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id ?? null,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    status: row.status,
    errorCode: code(row.error_code),
    action: code(row.action, 120),
    category: code(row.category),
    observedAt: date(row.observed_at),
  });
}

/** Explicit fields only: never select prompts, responses, scripts, SQL text or credentials. */
async function records(
  kind: TechnicalRecord['kind'],
  sql: Sql,
  start: string | null,
  end: string,
  id?: string,
) {
  const rows =
    kind === 'run'
      ? await sql`select 'run' kind,r.id,r.id run_id,j.id job_id,r.organization_id,r.workspace_id,r.state status,r.error_code,
        r.updated_at observed_at from allrice_runs r left join allrice_jobs j on j.run_id=r.id
        where (${id ?? null}::uuid is null or r.id=${id ?? null}::uuid)
          and (${start}::timestamptz is null or r.updated_at>=${start}::timestamptz) and r.updated_at<=${end}::timestamptz
        order by r.updated_at desc,r.id limit 20`
      : kind === 'operation'
        ? await sql`select 'operation' kind,o.id,o.run_id,j.id job_id,o.organization_id,o.workspace_id,
          o.snapshot->>'status' status,o.snapshot->'binding'->>'action' action,o.updated_at observed_at
          from allrice_runtime_operations o left join allrice_jobs j on j.run_id=o.run_id
          where (${id ?? null}::uuid is null or o.id=${id ?? null}::uuid)
            and (${start}::timestamptz is null or o.updated_at>=${start}::timestamptz) and o.updated_at<=${end}::timestamptz
          order by o.updated_at desc,o.id limit 20`
        : await sql`select 'feedback' kind,f.id,f.run_id,j.id job_id,f.organization_id,f.workspace_id,f.review_status status,
          f.category,f.updated_at observed_at from allrice_run_feedback f left join allrice_jobs j on j.run_id=f.run_id
          where (${id ?? null}::uuid is null or f.id=${id ?? null}::uuid)
            and (${start}::timestamptz is null or f.updated_at>=${start}::timestamptz) and f.updated_at<=${end}::timestamptz
          order by f.updated_at desc,f.id limit 20`;
  return rows.map(record);
}

type DiagnosticOptions = {
  database?: Database;
  diagnostics?: Database;
  environment?: Environment;
  health?: TechnicalDiagnostics['web'];
  workerHealth?: TechnicalDiagnostics['worker'];
};
/** Bounded independent collector; failure in one source preserves the others. */
export async function readPlatformTechnicalDiagnostics(
  context: RequestContext,
  options: DiagnosticOptions = {},
): Promise<TechnicalDiagnostics> {
  await requirePlatformAdmin(context, options.database);
  const environment = options.environment ?? technicalEnvironment();
  const capturedAt = new Date().toISOString();
  const start = new Date(Date.now() - 86400_000).toISOString();
  const evidence = (
    source: TechnicalEvidence['source'],
    windowStart: string | null = null,
  ): TechnicalEvidence => ({
    source,
    environment,
    freshness: 'fresh',
    sampledAt: capturedAt,
    windowStart,
    windowEnd: capturedAt,
    unavailableReason: null,
  });
  async function collect<T>(
    source: TechnicalEvidence['source'],
    read: (sql: Database) => Promise<T>,
    windowStart: string | null = null,
  ): Promise<{ evidence: TechnicalEvidence; value: T | null }> {
    try {
      const value = await read(options.diagnostics ?? getDiagnosticsDatabase());
      return { evidence: evidence(source, windowStart), value };
    } catch {
      return {
        evidence: {
          ...evidence(source, windowStart),
          freshness: 'unknown' as const,
          sampledAt: null,
          unavailableReason: 'collection_failed' as const,
        },
        value: null,
      };
    }
  }
  const [inventory, pressure, runs, operations, feedback] = await Promise.all([
    collect('worker_samples', readOperationsInventory),
    collect('execution_pressure', async (sql) => {
      const p = await executionPressureSnapshot(sql);
      if (!p.jobs || !p.resources) throw Error('missing_pressure_sample');
      return {
        jobs: {
          queued: p.jobs.queued,
          active: p.jobs.active,
          longestWaitMs: p.jobs.longest_wait_ms,
        },
        resources: {
          waiting: p.resources.waiting,
          executing: p.resources.executing,
        },
        locks: p.blocked.map((l) => ({
          pid: l.pid,
          blockingPids: l.blocking_pids,
          waitMs: l.wait_ms,
        })),
      };
    }),
    collect('runs', (sql) => records('run', sql, start, capturedAt), start),
    collect(
      'operations',
      (sql) => records('operation', sql, start, capturedAt),
      start,
    ),
    collect(
      'feedback',
      (sql) => records('feedback', sql, start, capturedAt),
      start,
    ),
  ]);
  if (inventory.value) {
    const latest = inventory.value.workers[0];
    inventory.evidence.sampledAt = latest?.observedAt ?? null;
    if (!latest) {
      inventory.evidence.freshness = 'unknown';
      inventory.evidence.unavailableReason = 'no_sample';
      inventory.value = null;
    } else if (!inventory.value.workers.some((w) => w.online))
      inventory.evidence.freshness = 'stale';
  }
  const missingHealth = (source: TechnicalEvidence['source']) => ({
    evidence: {
      ...evidence(source),
      freshness: 'unknown' as const,
      sampledAt: null,
      unavailableReason: 'not_configured' as const,
    },
    value: null,
  });
  return TechnicalDiagnosticsSchema.parse({
    schemaVersion: 1,
    environment,
    capturedAt,
    web: options.health ?? missingHealth('web_health'),
    worker: options.workerHealth ?? missingHealth('worker_health'),
    inventory,
    pressure,
    runs,
    operations,
    feedback,
  });
}

function issue(row: Record<string, unknown>) {
  return TechnicalIssueSchema.parse({
    id: row.id,
    environment: row.environment,
    fingerprint: row.fingerprint,
    title: row.title,
    category: row.category,
    severity: row.severity,
    status: row.status,
    occurrenceCount: row.occurrence_count,
    version: row.version,
    firstSeenAt: date(row.first_seen_at),
    lastSeenAt: date(row.last_seen_at),
    updatedAt: date(row.updated_at),
    linkedPr: row.linked_pr,
    releaseSha: row.release_sha,
  });
}
async function detail(id: string, sql: Sql) {
  const [row] =
    await sql`select * from allrice_platform_technical_issues where id=${id}`;
  if (!row) throw new DataAccessError('not_found');
  const refs =
    await sql`select record from allrice_platform_technical_evidence where issue_id=${id} order by recorded_at desc,source_id limit 100`;
  return TechnicalIssueDetailSchema.parse({
    issue: issue(row),
    records: refs.map((r) => r.record),
  });
}
export async function listPlatformTechnicalIssues(
  context: RequestContext,
  sql = getDatabase(),
) {
  await requirePlatformAdmin(context, sql);
  return (
    await sql`select * from allrice_platform_technical_issues order by updated_at desc,id limit 100`
  ).map(issue);
}
export async function getPlatformTechnicalIssue(
  context: RequestContext,
  id: string,
  sql = getDatabase(),
) {
  await requirePlatformAdmin(context, sql);
  return detail(UuidSchema.parse(id), sql);
}
async function writeAuthority(
  context: RequestContext,
  tx: postgres.TransactionSql,
) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  // Keep revocation and authority checking in the same write transaction.
  await tx`select id from allrice_users where id=${context.actor.id} for share`;
  return requirePlatformAdmin(context, tx);
}
async function event(
  tx: postgres.TransactionSql,
  row: Record<string, unknown>,
  actorId: string,
  action: 'created' | 'evidence_linked' | 'status_changed',
) {
  await tx`insert into allrice_platform_technical_issue_events(issue_id,version,actor_id,action,status,category,severity)
    values(${row.id as string},${row.version as number},${actorId},${action},${row.status as string},${row.category as string},${row.severity as string})`;
}
export async function capturePlatformTechnicalIssue(
  context: RequestContext,
  raw: unknown,
  sql = getDatabase(),
  environment = technicalEnvironment(),
) {
  const input = CaptureTechnicalIssueSchema.parse(raw);
  return sql.begin(async (tx) => {
    const actorId = await writeAuthority(context, tx);
    // One source has one canonical problem; ambiguous retries read this record.
    await tx`select pg_advisory_xact_lock(hashtextextended(${`platform-technical:${input.kind}:${input.id}`},0))`;
    const [existing] =
      await tx`select issue_id from allrice_platform_technical_evidence where source_kind=${input.kind} and source_id=${input.id}`;
    if (existing)
      return {
        created: false,
        detail: await detail(existing.issue_id as string, tx),
      };
    const [source] = await records(
      input.kind,
      tx,
      null,
      new Date().toISOString(),
      input.id,
    );
    if (!source) throw new DataAccessError('not_found');
    let row;
    if (input.issueId) {
      [row] =
        await tx`select * from allrice_platform_technical_issues where id=${input.issueId} and environment=${environment} for update`;
      if (!row) throw new DataAccessError('not_found');
      [row] =
        await tx`update allrice_platform_technical_issues set occurrence_count=occurrence_count+1,
        version=version+1,last_seen_at=clock_timestamp(),updated_at=clock_timestamp(),updated_by=${actorId} where id=${input.issueId} returning *`;
    } else {
      const fingerprint = `sha256:${createHash('sha256').update(`${environment}:${input.kind}:${input.id}`).digest('hex')}`;
      const name =
        input.kind === 'feedback'
          ? '员工反馈'
          : input.kind === 'operation'
            ? '工具操作'
            : 'Run';
      [row] =
        await tx`insert into allrice_platform_technical_issues(environment,fingerprint,title,created_by,updated_by)
        values(${environment},${fingerprint},${`${name} ${input.id.slice(0, 8)} · ${source.errorCode ?? source.status}`},${actorId},${actorId}) returning *`;
    }
    await tx`insert into allrice_platform_technical_evidence(source_kind,source_id,issue_id,record,observed_at,recorded_by)
      values(${input.kind},${input.id},${row!.id as string},${tx.json(source)},${source.observedAt},${actorId})`;
    await event(
      tx,
      row!,
      actorId,
      input.issueId ? 'evidence_linked' : 'created',
    );
    return {
      created: !input.issueId,
      detail: await detail(row!.id as string, tx),
    };
  });
}
export async function updatePlatformTechnicalIssue(
  context: RequestContext,
  id: string,
  raw: unknown,
  sql = getDatabase(),
) {
  UuidSchema.parse(id);
  const input = UpdateTechnicalIssueSchema.parse(raw);
  return sql.begin(async (tx) => {
    const actorId = await writeAuthority(context, tx);
    const [row] =
      await tx`update allrice_platform_technical_issues set status=${input.status},category=${input.category},severity=${input.severity},
      version=version+1,updated_at=clock_timestamp(),updated_by=${actorId} where id=${id} and version=${input.ifVersion} returning *`;
    if (row) await event(tx, row, actorId, 'status_changed');
    return { updated: !!row, detail: await detail(id, tx) };
  });
}
