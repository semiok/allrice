/** Deterministic growth data only. Never connect this fixture to a tenant DB. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type postgres from 'postgres';
import { collectPendingExperienceEvidence } from './experience-evidence.ts';
import {
  ExperienceOccurrenceSchema,
  type ExperienceOccurrence,
} from './experience-consolidation-contracts.ts';
import { embedWorkspaceText } from './workspace/memory-recall.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';

import type * as NativeClient from './core/client.ts';
import type * as NativeRuntime from './experience-runtime.ts';
import type * as NativeAdoption from './experience-adoption.ts';
import type * as NativeWorkspace from './workspace/service.ts';
import type * as NativeOverview from './experience-overview.ts';
import type * as NativeKernel from '../../../apps/worker/src/employee-kernel.ts';
type Sql = ReturnType<typeof postgres>;
type Target = {
  org: string;
  workspace: string;
  user: string;
  sourceRunId: string;
  rule: { id: string };
  frozen: { occurrence: ExperienceOccurrence };
};
export const growthOrdinaryFacts = [
  '合成名单：7 人到场，3 人未到，2 人状态未知。未知不得计入未到。',
  '合成名单报告：默认分点呈现，仅在用户未指定其他格式时采用。',
  '合成名单复核：保留原始行号；到场与未到分项，未知另列。😀',
] as const;

export async function memoryGrowthFixture(sql: Sql, target: Target) {
  const [location] = await sql`
    select current_database() database,current_schema() schema`;
  assert.ok(location);
  const { database, schema } = location;
  assert.notEqual(database, 'allrice_dev');
  assert.match(schema, /^experience_consolidation_[a-f0-9]{32}$/);
  let history = 0;
  const marker = `MET184 growth ${randomUUID()}`;
  let ordinaryIds: string[] = [];
  return {
    async ordinary(count: number) {
      if (ordinaryIds.length) {
        await sql`delete from allrice_rag_chunks where organization_id=${target.org} and memory_id in ${sql(ordinaryIds)}`;
        await sql`delete from allrice_memories where organization_id=${target.org} and owner_id=${target.user} and source_label=${marker} and id in ${sql(ordinaryIds)}`;
      }
      const records = Array.from({ length: count }, (_, i) => {
        const content =
          growthOrdinaryFacts[i] ?? `Unrelated synthetic note ${i}`;
        return {
          id: randomUUID(),
          content,
          embedding: `[${embedWorkspaceText(content).join(',')}]`,
        };
      });
      ordinaryIds = records.map((r) => r.id);
      await sql`insert into allrice_memories(id,organization_id,workspace_id,owner_id,content,visibility,
        source_type,lifecycle_state,memory_class,revision,trust_level,confidence,source_label)
        select x.id,${target.org},${target.workspace},${target.user},x.content,'private',
          'user','durable','work_note',1,'user_confirmed',1,${marker}
        from jsonb_to_recordset(${sql.json(records)}) x(id uuid,content text)`;
      await sql`insert into allrice_rag_chunks(organization_id,workspace_id,memory_id,owner_id,content,embedding,visibility)
        select ${target.org},${target.workspace},x.id,${target.user},x.content,x.embedding::vector,'private'
        from jsonb_to_recordset(${sql.json(records)}) x(id uuid,content text,embedding text)`;
      return ordinaryIds;
    },
    async history(count: number) {
      assert.ok(count >= history);
      const records = Array.from({ length: count - history }, (_, i) => {
        const id = randomUUID();
        const at = new Date(
          Date.now() - (history + i + 1) * 60_000,
        ).toISOString();
        const occurrence = ExperienceOccurrenceSchema.parse({
          ...target.frozen.occurrence,
          id,
          createdAt: at,
          sources: [],
        });
        return {
          id,
          at,
          occurrence,
          run: randomUUID(),
          message: randomUUID(),
          assistant: randomUUID(),
        };
      });
      if (!records.length) return;
      // Empty, successful collection ticks are a real supported history shape:
      // no model Run/receipt is invented. Pending positive feedback is collected
      // separately by the production evidence producer below.
      await sql`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,status,
        scheduled_for,started_at,completed_at,created_at,experience_occurrence)
        select x.id,${target.org},${target.workspace},${target.rule.id},'succeeded',x.at,x.at,x.at,x.at,x.occurrence
        from jsonb_to_recordset(${sql.json(records)}) x(id uuid,at timestamptz,occurrence jsonb)`;
      await sql`insert into allrice_messages(id,organization_id,workspace_id,owner_id,session_id,role,content,status)
        select x.message,er.organization_id,er.workspace_id,er.owner_id,er.session_id,'user',
          '{"text":"反馈：这份报告分点说明很清晰，阅读起来很方便。","citations":[]}'::jsonb,'completed'
        from jsonb_to_recordset(${sql.json(records)}) x(message uuid)
        cross join allrice_employee_runs er where er.run_id=${target.sourceRunId}`;
      await sql`insert into allrice_messages(id,organization_id,workspace_id,owner_id,session_id,role,content,status)
        select x.assistant,er.organization_id,er.workspace_id,er.owner_id,er.session_id,'assistant',
          '{"text":"已收到合成反馈","citations":[]}'::jsonb,'completed'
        from jsonb_to_recordset(${sql.json(records)}) x(assistant uuid)
        cross join allrice_employee_runs er where er.run_id=${target.sourceRunId}`;
      await sql`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
        select x.run,${target.org},${target.workspace},${target.user},'succeeded','{}','{}'
        from jsonb_to_recordset(${sql.json(records)}) x(run uuid)`;
      await sql`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,session_id,
        employee_assignment_id,employee_version_id,user_message_id,assistant_message_id,status,completed_at,
        provider_snapshot,prompt_snapshot,execution_snapshot,experience_capture_state)
        select x.run,er.organization_id,er.workspace_id,er.owner_id,er.session_id,er.employee_assignment_id,
          er.employee_version_id,x.message,x.assistant,'succeeded',clock_timestamp(),
          er.provider_snapshot,er.prompt_snapshot,er.execution_snapshot,'pending'
        from jsonb_to_recordset(${sql.json(records)}) x(run uuid,message uuid,assistant uuid)
        cross join allrice_employee_runs er where er.run_id=${target.sourceRunId}`;
      const ids = records.map((r) => r.run);
      for (let n = 0; n < Math.ceil(records.length / 16) + 2; n++) {
        const [remaining] =
          await sql`select count(*)::int pending from allrice_employee_runs
          where run_id in ${sql(ids)} and experience_capture_state='pending'`;
        if (!remaining!.pending) break;
        const result = await collectPendingExperienceEvidence({
          database: sql,
          limit: 16,
        });
        assert.equal(
          result.busy,
          0,
          'Diagnose fixture contention instead of silently skipping records',
        );
      }
      const [collected] =
        await sql`select count(*)::int captured from allrice_employee_runs
        where run_id in ${sql(ids)} and experience_capture_state='captured'`;
      assert.equal(collected!.captured, records.length);
      history = count;
    },
  };
}

export async function observeMemorySql<T>(sql: Sql, run: () => Promise<T>) {
  const previous = sql.options.debug;
  const queries: { text: string; parameters: unknown[] }[] = [];
  sql.options.debug = (_connection, text, parameters) => {
    queries.push({ text, parameters });
  };
  const started = performance.now();
  try {
    const value = await run();
    return {
      value,
      milliseconds: performance.now() - started,
      queries,
      counts: queries.reduce(
        (sum, q) => {
          const text = q.text.trim();
          const kind = /^(begin|commit|rollback|savepoint|release)\b/i.test(
            text,
          )
            ? 'transaction'
            : /^set\b|pg_advisory/i.test(text)
              ? 'controlOrAdvisoryLock'
              : /for (?:no key update|key share|share|update)\b/i.test(text)
                ? 'rowLock'
                : 'business';
          sum[kind]++;
          sum.total++;
          return sum;
        },
        {
          business: 0,
          transaction: 0,
          controlOrAdvisoryLock: 0,
          rowLock: 0,
          total: 0,
        },
      ),
    };
  } finally {
    sql.options.debug = previous;
  }
}

export function memoryLatency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length);
  return {
    n: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}

/** Explain the exact observed SELECTs, never a hand-written approximation.
 * Placeholders remain in the evidence; parameter values stay in the fixture. */
export async function explainMemoryQueries(
  sql: Sql,
  queries: { text: string; parameters: unknown[] }[],
) {
  const unique = new Map<string, (typeof queries)[number]>();
  for (const query of queries) {
    if (
      /^\s*select\b/i.test(query.text) &&
      /\ballrice_\w+/i.test(query.text) &&
      !/\bfor (?:no key update|key share|share|update)\b|pg_advisory/i.test(
        query.text,
      )
    )
      unique.set(query.text, query);
  }
  const plans = [];
  for (const query of unique.values()) {
    const rows = await sql.unsafe(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.text,
      query.parameters as Parameters<Sql['unsafe']>[1],
    );
    plans.push({
      querySha256: createHash('sha256').update(query.text).digest('hex'),
      parameterizedSql: query.text,
      plan: rows[0]!['QUERY PLAN'],
    });
  }
  return plans;
}

export function isolatedMemoryBenchmarkUrl(schema: string) {
  assert.match(schema, /^experience_consolidation_[a-f0-9]{32}$/);
  const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
  assertRuntimeFixtureDatabase(url);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  return url.toString();
}

// Native import is deliberate: Vite aliases would otherwise replace the old
// release's contract dependency with the candidate, invalidating the comparison.
const nativeImport = createRequire(import.meta.url)(
  './memory-growth-native.fixture.cjs',
).nativeImport as (url: string) => Promise<Record<string, unknown>>;

export async function openMemoryBenchmarkArm(
  rootInput: string,
  expectedSha: string,
  schema: string,
) {
  const root = await realpath(rootInput);
  assert.match(root, /^\/Users\/a123\/allrice-dev-releases\/[^/]+$/);
  assert.match(schema, /^experience_consolidation_[a-f0-9]{32}$/);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(sha, expectedSha);
  const manifest = JSON.parse(
    await readFile(root + '/.local/dev-build-identity.json', 'utf8'),
  );
  assert.equal(manifest.sourceSha, sha);
  // The caller holds this guarded environment for the full A/B lifecycle,
  // including every later getDatabase() call, and restores it after closing.
  assert.equal(process.env.DATABASE_URL, isolatedMemoryBenchmarkUrl(schema));
  const load = (path: string) =>
    nativeImport(pathToFileURL(root + '/' + path).href);
  const core = (await load(
    'packages/database/dist/core/client.js',
  )) as unknown as typeof NativeClient;
  const sql = core.getDatabase();
  try {
    assert.equal((await sql`select current_schema() name`)[0]!.name, schema);
    const artifacts = {} as Record<string, string>;
    const paths = [
      'packages/database/dist/workspace/memory-recall.js',
      'packages/database/dist/workspace/service.js',
      'packages/database/dist/experience-runtime.js',
      'packages/database/dist/experience-adoption.js',
      'packages/contracts/dist/experience-adoption.js',
      'apps/worker/dist/employee-kernel.js',
    ];
    for (const path of paths)
      artifacts[path] = createHash('sha256')
        .update(await readFile(root + '/' + path))
        .digest('hex');
    const loadTyped = async <T>(path: string) =>
      (await load(path)) as unknown as T;
    const source = await loadTyped<typeof NativeRuntime>(
      'packages/database/dist/experience-runtime.js',
    );
    const adoption = await loadTyped<typeof NativeAdoption>(
      'packages/database/dist/experience-adoption.js',
    );
    const workspace = await loadTyped<typeof NativeWorkspace>(
      'packages/database/dist/workspace/service.js',
    );
    const overview = await loadTyped<typeof NativeOverview>(
      'packages/database/dist/experience-overview.js',
    );
    const kernel = await loadTyped<typeof NativeKernel>(
      'apps/worker/dist/employee-kernel.js',
    );
    return {
      root,
      sha,
      artifacts,
      sql,
      source,
      adoption,
      workspace,
      overview,
      kernel,
      loadTyped,
      close: () => core.closeDatabase(),
    };
  } catch (error) {
    await core.closeDatabase();
    throw error;
  }
}
