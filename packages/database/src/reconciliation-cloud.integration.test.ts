import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';
import { runCloudCommandOperation } from '../../../apps/worker/src/cloud-runner/executor.js';
import { exportReconciliation } from '../../../apps/worker/src/tool-broker/handlers/reconciliation.js';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { getWorkbenchArtifact, readArtifactBytes } from './artifact-review.ts';
import type * as Client from './core/client.ts';

// Resolve the Worker's existing ExcelJS dependency, not a second XLSX renderer.
type Sheet = {
  name: string;
  rowCount: number;
  getCell(address: string): { value: unknown };
  getRow(index: number): { values: unknown };
};
const ExcelJS = createRequire(
  new URL('../../../apps/worker/package.json', import.meta.url),
)('exceljs') as {
  Workbook: new () => {
    worksheets: Sheet[];
    getWorksheet(name: string): Sheet | undefined;
    xlsx: { load(bytes: ArrayBuffer): Promise<void> };
  };
};
let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p19_cloud_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_CLOUD_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const backend = new CloudRunnerBackend(),
  attempts: string[] = [];
let delivered:
  | {
      f: Awaited<ReturnType<typeof createCloudExecutionFixture>>;
      exportFile: (
        callId: string,
        parentObjectId?: string,
      ) => Promise<{ artifactId: string; objectId: string }>;
      artifactId: string;
    }
  | undefined;

suite('P19 actual cloud business delivery, no Bridge', () => {
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('dedicated DB required');
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    const localDisposable =
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.port === '5432' &&
      url.username === 'a123' &&
      ['/allrice_b1', '/allrice_b2'].includes(url.pathname);
    const ciDisposable =
      url.hostname === '127.0.0.1' &&
      url.port === '54329' &&
      url.username === 'allrice' &&
      url.pathname === '/allrice';
    if (!localDisposable && !ciDisposable)
      throw Error(
        'Only the local disposable B1/B2 or CI database is permitted',
      );
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
    });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(20260907,1)`;
      await tx`create extension if not exists vector with schema public`;
      await tx`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    url.searchParams.set('application_name', schema);
    db = postgres(url.toString(), { max: 12, onnotice: () => {} });
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p19-storage-'));
  }, 60000);
  afterAll(async () => {
    for (const id of attempts) {
      await backend.stop(id);
      await backend.cleanup(id);
    }
    await db?.end();
    if (admin) {
      if (!/^p19_cloud_[a-f0-9]{32}$/.test(schema))
        throw Error('bad test schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
    if (storageRoot && storageRoot.includes('/allrice-p19-storage-'))
      await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it('authorizes two input files, computes exact cents in runsc, destroys the sandbox, renders and reopens versioned XLSX', async () => {
    const f = await createCloudExecutionFixture(db, storageRoot, {
      workbench: true,
      reconciliationOnly: true,
    });
    const [frozen] =
      await db`select execution_snapshot->'capabilitySnapshot'->'bindings'->'toolNames' as tools from allrice_employee_runs where run_id=${f.run}`;
    expect(frozen!.tools).toContain('workspace.reconciliation.export');
    expect(frozen!.tools).not.toContain('workspace.export.create');
    const directory = new URL(
      '../../../skills/business-reconciliation/',
      import.meta.url,
    );
    const script = await readFile(
      new URL('scripts/reconcile.mjs', directory),
      'utf8',
    );
    const inputs = [];
    for (const path of ['invoices.csv', 'payments.csv']) {
      const object = await f.upload(
        await readFile(new URL(`assets/${path}`, directory)),
        'text/csv',
      );
      inputs.push({ path, objectId: object.id, checksum: object.checksum });
    }
    const c = await f.create('p19-reconcile', {
      script,
      inputs,
      outputs: [
        {
          path: 'reconciliation.json',
          fileName: 'reconciliation.json',
          format: 'json',
        },
        {
          path: 'reconciliation.csv',
          fileName: 'reconciliation.csv',
          format: 'csv',
        },
      ],
    });
    attempts.push(c.snapshot.binding.attempt.attemptId);
    expect(c.snapshot.status).toBe('waiting_user');
    expect(c.snapshot.binding.dataScope).toHaveLength(2);
    expect(
      (
        await db`select id from allrice_bridge_devices where organization_id=${f.org}`
      ).length,
    ).toBe(0);
    await f.approve(c);
    const computed = await runCloudCommandOperation(c, {
      storage: f.storage,
      backend,
      database: db,
    });
    expect(computed.status).toBe('succeeded');
    expect(computed.artifacts).toHaveLength(2);
    expect(
      await backend.inspect(c.snapshot.binding.attempt.attemptId),
    ).toBeNull();
    const json = computed.artifacts.find(
      (a) => a.fileName === 'reconciliation.json',
    )!;
    const source = await getWorkbenchArtifact(
      f.context,
      f.session,
      json.versionId,
      db,
    );
    const report = JSON.parse(
      (await readArtifactBytes(f.storage, source.object)).toString(),
    );
    // Independent hand-computed reference, never derived from the script result.
    const totals = {
      invoice_rows: 6,
      payment_rows: 6,
      invoice_cents: 36049,
      valid_payment_cents: 34550,
      allocated_payment_cents: 34050,
      unallocated_payment_cents: 500,
      difference_cents: 1999,
    };
    const rows = [
      {
        invoice_id: 'A',
        invoice_cents: 10050,
        paid_cents: 10050,
        difference_cents: 0,
        status: 'matched',
      },
      {
        invoice_id: 'B',
        invoice_cents: 20000,
        paid_cents: 18000,
        difference_cents: 2000,
        status: 'ambiguous',
      },
      {
        invoice_id: 'C',
        invoice_cents: 5000,
        paid_cents: 6000,
        difference_cents: -1000,
        status: 'overpaid',
      },
      {
        invoice_id: 'DUP',
        invoice_cents: null,
        paid_cents: 0,
        difference_cents: null,
        status: 'ambiguous',
      },
      {
        invoice_id: 'MISS',
        invoice_cents: 999,
        paid_cents: 0,
        difference_cents: 999,
        status: 'underpaid',
      },
    ];
    expect(report.totals).toEqual(totals);
    expect(report.rows).toEqual(rows);
    expect(report.issues).toEqual([
      { code: 'duplicate_invoice_id', id: 'DUP', rows: [5, 6] },
      {
        code: 'unallocated_payment',
        id: 'PX',
        invoice_id: 'UNKNOWN',
        row: 5,
        amount_cents: 500,
      },
      { code: 'duplicate_payment_id', id: 'PDUP', rows: [6, 7] },
    ]);
    const csv = computed.artifacts.find(
      (a) => a.fileName === 'reconciliation.csv',
    )!;
    const csvSource = await getWorkbenchArtifact(
      f.context,
      f.session,
      csv.versionId,
      db,
    );
    expect(
      (await readArtifactBytes(f.storage, csvSource.object)).toString(),
    ).toContain('"MISS","999","0","999","underpaid"');
    const exportFile = async (callId: string, parentObjectId?: string) => {
      const args = {
        artifactId: json.versionId,
        fileName: '验收对账',
        ...(parentObjectId ? { parentObjectId } : {}),
      };
      return JSON.parse(
        (
          await exportReconciliation({
            input: {
              context: f.execution,
              capabilities: ['storage:read', 'storage:write'],
              storageRoot,
              sessionId: f.session,
              call: {
                id: callId,
                name: 'workspace.reconciliation.export',
                arguments: args,
              },
            },
            arguments: args,
          })
        ).modelContent,
      ) as {
        artifactId: string;
        objectId: string;
        fileName: string;
        version: number;
        totals: typeof totals;
      };
    };
    const exported = await exportFile('p19-xlsx');
    expect(exported.version).toBe(1);
    expect(exported.totals).toEqual(totals);
    const artifact = await getWorkbenchArtifact(
      f.context,
      f.session,
      exported.artifactId,
      db,
    );
    expect(artifact.provenance.kind).toBe('tool_result');
    expect(artifact.provenance.operationId).toBe(
      c.snapshot.binding.attempt.operationId,
    );
    expect(artifact.object.immutable).toBe(true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Uint8Array.from(
        await readArtifactBytes(f.storage, artifact.object, 2_000_000),
      ).buffer,
    );
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      '核对摘要',
      '发票明细',
      '待人工核查',
    ]);
    const detail = workbook.getWorksheet('发票明细')!;
    expect(detail.rowCount).toBe(6);
    rows.forEach((row, i) => {
      expect(detail.getCell(`A${i + 2}`).value).toBe(row.invoice_id);
      expect(detail.getCell(`B${i + 2}`).value).toBe(row.invoice_cents);
      expect(detail.getCell(`C${i + 2}`).value).toBe(row.paid_cents);
      expect(detail.getCell(`D${i + 2}`).value).toBe(row.difference_cents);
      expect(detail.getCell(`E${i + 2}`).value).toBe(row.status);
    });
    const summary = workbook.getWorksheet('核对摘要')!;
    expect(summary.getCell('B2').value).toBe(source.object.id);
    expect(summary.getCell('B3').value).toBe(source.object.checksum);
    Object.entries(totals).forEach(([key, value], i) => {
      expect(summary.getCell(`A${i + 4}`).value).toBe(key);
      expect(summary.getCell(`B${i + 4}`).value).toBe(value);
    });
    const issueSheet = workbook.getWorksheet('待人工核查')!;
    expect(issueSheet.rowCount).toBe(4);
    const issueRows = [
      ['duplicate_invoice_id', 'DUP', '', '5,6', null],
      ['unallocated_payment', 'PX', 'UNKNOWN', 5, 500],
      ['duplicate_payment_id', 'PDUP', '', '6,7', null],
    ];
    issueRows.forEach((row, i) =>
      row.forEach((value, j) =>
        expect(
          issueSheet.getCell(`${String.fromCharCode(65 + j)}${i + 2}`).value,
        ).toBe(value),
      ),
    );
    expect(await exportFile('p19-xlsx')).toEqual(exported);
    const version2 = await exportFile('p19-xlsx-v2', exported.objectId);
    expect(version2.version).toBe(2);
    expect(
      (
        await getWorkbenchArtifact(
          f.context,
          f.session,
          version2.artifactId,
          db,
        )
      ).version.seriesId,
    ).toBe(artifact.version.seriesId);
    const other = await createCloudExecutionFixture(db, storageRoot, {
      workbench: true,
    });
    await expect(
      getWorkbenchArtifact(other.context, f.session, exported.artifactId, db),
    ).rejects.toThrow();
    const foreign = { artifactId: json.versionId, fileName: 'forbidden' };
    await expect(
      exportReconciliation({
        input: {
          context: other.execution,
          capabilities: ['storage:read', 'storage:write'],
          storageRoot,
          sessionId: other.session,
          call: {
            id: 'cross-tenant',
            name: 'workspace.reconciliation.export',
            arguments: foreign,
          },
        },
        arguments: foreign,
      }),
    ).rejects.toThrow();
    expect(
      await backend.inspect(c.snapshot.binding.attempt.attemptId),
    ).toBeNull();
    delivered = { f, exportFile, artifactId: exported.artifactId };
  }, 45000);

  it('rejects a new XLSX version from the same Worker after its original cloud job lease is replaced', async () => {
    expect(delivered).toBeDefined();
    const { f, exportFile, artifactId } = delivered!;
    const [before] =
      await db`select lease_token::text from allrice_jobs where id=${f.execution.jobId}`;
    const count =
      await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`;
    try {
      await db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.execution.jobId}`;
      await expect(exportFile('p19-replaced-lease')).rejects.toThrow();
      expect(
        await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`,
      ).toHaveLength(count.length);
      expect(
        (await getWorkbenchArtifact(f.context, f.session, artifactId, db))
          .object.immutable,
      ).toBe(true);
    } finally {
      // Only restore this synthetic fixture; no business job is touched.
      await db`update allrice_jobs set lease_token=${before!.lease_token} where id=${f.execution.jobId}`;
    }
  });

  it('rolls back a publication when the final audit write crosses the job deadline', async () => {
    expect(delivered).toBeDefined();
    const { f, exportFile, artifactId } = delivered!;
    const [job] =
      await db`select timeout_at from allrice_jobs where id=${f.execution.jobId}`;
    const versions =
      await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`;
    const objects =
      await db`select id from allrice_storage_objects where organization_id=${f.org}`;
    const audits =
      await db`select id from allrice_audit_events where organization_id=${f.org} and action='artifact.published'`;
    // Function and trigger exist only in this suite's random search_path schema.
    await db.unsafe(
      `create function p19_delay_final_audit() returns trigger language plpgsql as $$ begin if new.action='artifact.published' and new.actor_id='${f.user}'::uuid then perform pg_sleep(2.5); end if; return new; end; $$`,
    );
    await db.unsafe(
      'create trigger p19_delay_final_audit before insert on allrice_audit_events for each row execute function p19_delay_final_audit()',
    );
    try {
      await db`update allrice_jobs set timeout_at=clock_timestamp()+interval '2 seconds' where id=${f.execution.jobId}`;
      const denied = expect(exportFile('p19-audit-expired')).rejects.toThrow();
      // Confirm the actual audit trigger is sleeping; an earlier unrelated
      // rejection must not accidentally satisfy this deadline test.
      await vi.waitFor(
        async () => {
          const [state] =
            await db`select exists(select 1 from pg_stat_activity where application_name=${schema} and wait_event='PgSleep') as sleeping`;
          expect(state!.sleeping).toBe(true);
        },
        { timeout: 2500, interval: 25 },
      );
      await denied;
      const [expired] =
        await db`select timeout_at<=clock_timestamp() as expired from allrice_jobs where id=${f.execution.jobId}`;
      expect(expired!.expired).toBe(true);
      expect(
        await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`,
      ).toHaveLength(versions.length);
      expect(
        await db`select id from allrice_storage_objects where organization_id=${f.org}`,
      ).toHaveLength(objects.length);
      expect(
        await db`select id from allrice_audit_events where organization_id=${f.org} and action='artifact.published'`,
      ).toHaveLength(audits.length);
      expect(
        (await getWorkbenchArtifact(f.context, f.session, artifactId, db))
          .object.immutable,
      ).toBe(true);
    } finally {
      await db.unsafe(
        'drop trigger p19_delay_final_audit on allrice_audit_events',
      );
      await db.unsafe('drop function p19_delay_final_audit()');
      await db`update allrice_jobs set timeout_at=${job!.timeout_at} where id=${f.execution.jobId}`;
    }
  }, 10000);
});
