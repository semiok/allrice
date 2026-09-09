import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { makeObjectKey } from '@allrice/contracts';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import {
  createStorageMetadata,
  markStorageReady,
  abandonStorageMetadata,
  getStoredFile,
} from './data.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import { registerManagedBrowserEvidenceArtifact } from './execution/p1-runtime.ts';
import { registerWorkflowArtifact } from './execution/workflow-runtime.ts';
import {
  assertWorkbenchSession,
  publishWorkbenchArtifact,
} from './artifact-review.ts';
import { publishBrowserObservationArtifact } from './browser-control-artifact.ts';
import { publishCloudOperationArtifacts } from './cloud-execution.ts';
import {
  createBrowserWorkspace,
  installBrowserControlGrant,
  readCurrentBrowserWorkspace,
} from './browser-control.ts';
import { captureLocalBrowserFile } from './local-browser-files.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import type * as Client from './core/client.ts';
let db: ReturnType<typeof postgres>,
  activeDb: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => activeDb,
}));
const schema = `storage_quota_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const sha = (bytes: Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
type QueryHook = (
  sql: string,
  run: () => unknown,
  transaction: number,
) => unknown;
/** Schedules real tagged SQL only; never fabricates authority, row data or lock responses. */
function instrument(hook: QueryHook) {
  let n = 0;
  return new Proxy(db, {
    get(target, key) {
      if (key !== 'begin') return Reflect.get(target, key, target);
      return (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
        target.begin((tx) => {
          const transaction = n++;
          return work(
            new Proxy(tx, {
              apply(query, self, args: unknown[]) {
                return hook(
                  Array.isArray(args[0]) ? args[0].join('?') : '',
                  () => Reflect.apply(query, self, args),
                  transaction,
                );
              },
            }),
          );
        });
    },
  });
}
const isGate = (s: string) =>
  s.includes('pg_advisory_xact_lock') && s.includes(',42)');
type Fixture = Awaited<ReturnType<typeof createLocalBrowserFixture>>;
async function used(f: Fixture) {
  const [row] = await db<
    { n: string }[]
  >`select coalesce(sum(size_bytes),0)::text as n from allrice_storage_objects
    where organization_id=${f.org} and workspace_id=${f.workspace} and state<>'deleted'`;
  return Number(row!.n);
}
async function quota(f: Fixture, bytes: number) {
  await db`insert into allrice_storage_quotas(organization_id,workspace_id,limit_bytes) values(${f.org},${f.workspace},${bytes})
    on conflict(organization_id,workspace_id) do update set limit_bytes=excluded.limit_bytes`;
}
async function sources() {
  const f = await createLocalBrowserFixture(db, storageRoot, {
    workbench: true,
  });
  const b = f.browser!,
    w = await readCurrentBrowserWorkspace(f.context, b.w.id, db);
  const bytes = Buffer.alloc(1000, 'x'),
    png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), bytes]);
  const object = (category: 'exports' | 'artifacts' = 'exports') => {
    const o = createToolBrokerExportObject({
      context: f.execution,
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      checksum: sha(bytes),
    });
    return {
      ...o,
      key: makeObjectKey({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        category,
        objectId: o.id,
      }),
    };
  };
  const uploadId = randomUUID(),
    exported = object(),
    workflowObject = object('artifacts'),
    evidenceObject = object('artifacts');
  const workflowId = randomUUID(),
    revisionId = randomUUID();
  const [employee] = await db<
    { employee_id: string }[]
  >`select employee_id from allrice_employee_assignments where user_id=${f.user} and workspace_id=${f.workspace}`;
  await db`insert into allrice_workflows(id,organization_id,workspace_id,slug,name,description,created_by)
    values(${workflowId},${f.org},${f.workspace},'quota','Quota fixture','Synthetic only',${f.user})`;
  await db`insert into allrice_workflow_revisions(id,organization_id,workspace_id,workflow_id,revision,name,description,definition,checksum,created_by,published_at)
    values(${revisionId},${f.org},${f.workspace},${workflowId},1,'Quota fixture','Synthetic only','{}',${sha(bytes)},${f.user},clock_timestamp())`;
  await db`insert into allrice_workflow_runs(organization_id,workspace_id,owner_id,run_id,employee_id,workflow_revision_id,session_id,status,definition_snapshot)
    values(${f.org},${f.workspace},${f.user},${f.run},${employee!.employee_id},${revisionId},${f.session},'running','{}')`;
  await installBrowserControlGrant(
    f.context,
    {
      targetId: f.target,
      ownerId: f.user,
      enabled: true,
      profile: { version: 1, origins: ['https://example.com'] },
    },
    db,
  );
  const [job] = await db<
    { attempt: number; lease_token: string }[]
  >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
  const cloudBrowser = await createBrowserWorkspace(
    {
      context: f.execution,
      callId: randomUUID(),
      url: 'https://example.com/',
      jobAttempt: job!.attempt,
      jobLeaseToken: job!.lease_token,
    },
    db,
  );
  const cloud = await f.create();
  await f.approve(cloud);
  const lease = await cloud.ledger.dispatch({
    scope: cloud.snapshot.binding.task.scope,
    operationId: cloud.snapshot.binding.attempt.operationId,
    leaseOwner: f.worker,
    leaseMs: 15000,
  });
  await cloud.ledger.startOperation({
    scope: cloud.snapshot.binding.task.scope,
    operationId: cloud.snapshot.binding.attempt.operationId,
    leaseToken: lease.leaseToken,
    attempt: cloud.snapshot.binding.attempt,
    receiptId: randomUUID(),
  });
  const artifacts = [
    { path: 'result.json', contentBase64: bytes.toString('base64') },
  ];
  // This is a DB quota fixture, not physical runner acceptance: only the synthetic
  // stopped-result journal is seeded. Actual publication revalidates policy and exact approval.
  await db`update allrice_cloud_execution_attempts set outcome=${db.json({ reason: 'completed', stopped: true, artifacts })}
    where operation_id=${cloud.snapshot.binding.attempt.operationId}`;
  const metadata = {
    id: uploadId,
    workspaceId: f.workspace,
    category: 'uploads',
    mediaType: 'text/plain',
    sizeBytes: bytes.length,
    checksum: sha(bytes),
    visibility: 'private',
    retentionUntil: null,
    immutable: false,
  };
  const workflowInput = {
    context: f.execution,
    ownerId: f.user,
    stepKey: 'quota',
    object: workflowObject,
    name: 'Synthetic',
  };
  const calls = {
    upload: {
      size: bytes.length,
      run: () => createStorageMetadata(f.context, metadata),
    },
    export: {
      size: bytes.length,
      run: () =>
        registerToolBrokerExport(
          {
            context: f.execution,
            sessionId: f.session,
            fileName: 'quota.txt',
            format: 'text',
            object: exported,
          },
          activeDb,
        ),
    },
    browser: {
      size: Buffer.byteLength(
        JSON.stringify({
          version: 1,
          untrustedExternalContent: true,
          browserWorkspaceId: w.id,
          observation: b.obs,
        }),
      ),
      run: () =>
        publishBrowserObservationArtifact(w, b.obs!, f.storage, activeDb),
    },
    workbench: {
      size: bytes.length,
      run: () =>
        publishWorkbenchArtifact(
          {
            context: f.execution,
            sessionId: f.session,
            callId: 'quota',
            kind: 'document',
            fileName: 'quota.txt',
            format: 'text',
            bytes,
            mediaType: 'text/plain',
          },
          f.storage,
          activeDb,
        ),
    },
    cloud: {
      size: bytes.length,
      run: () =>
        publishCloudOperationArtifacts(
          {
            context: f.execution,
            binding: cloud.snapshot.binding,
            payload: cloud.payload,
            artifacts,
          },
          f.storage,
          activeDb,
        ),
    },
    capture: {
      size: png.length,
      run: () =>
        captureLocalBrowserFile(
          f.device,
          {
            ...b.identity!,
            kind: 'screenshot',
            fence: 1,
            observationId: randomUUID(),
          },
          png,
          f.storage,
          activeDb,
        ),
    },
    managed: {
      size: bytes.length,
      run: () =>
        registerManagedBrowserEvidenceArtifact({
          context: f.execution,
          lease: { attempt: job!.attempt, leaseToken: job!.lease_token },
          taskId: cloudBrowser.task_id!,
          kind: 'content',
          name: 'Synthetic',
          object: {
            id: evidenceObject.id,
            key: evidenceObject.key,
            checksum: evidenceObject.checksum,
            mediaType: evidenceObject.mediaType,
            sizeBytes: evidenceObject.sizeBytes,
          },
        }),
    },
    workflow: {
      size: bytes.length,
      run: () => registerWorkflowArtifact(workflowInput),
    },
  };
  return { f, calls, metadata, workflowInput };
}
suite('shared storage quota: actual PostgreSQL increment entrypoints', () => {
  afterEach(async () => {
    activeDb = db;
    // These journals model stopped work only; no test creates a container.
    // Release their fixture capacity between cases without changing product limits.
    if (db)
      await db`update allrice_cloud_execution_attempts set cleanup_confirmed_at=clock_timestamp()`;
  });
  beforeAll(async () => {
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '5432' ||
      url.username !== 'a123' ||
      url.pathname !== '/allrice_b2'
    )
      throw Error('dedicated fixture DB required');
    for (const key of [
      'ALLRICE_BROWSER_CONTROL_ENABLED',
      'ALLRICE_LOCAL_BROWSER_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_CLOUD_RUNNER_ENABLED',
      'ALLRICE_WORKBENCH_ENABLED',
    ])
      vi.stubEnv(key, '1');
    admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
    await admin.unsafe(`create schema ${schema}`);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    db = postgres(url.toString(), { max: 10, onnotice: () => {} });
    activeDb = db;
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await db.unsafe(await readFile(new URL(file, dir), 'utf8'));
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-quota-test-'));
    vi.stubEnv('ALLRICE_STORAGE_ROOT', storageRoot);
  }, 60000);
  afterAll(async () => {
    await db?.end();
    if (admin) {
      if (!/^storage_quota_[a-f0-9]{32}$/.test(schema))
        throw Error('unsafe schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
    if (storageRoot?.includes('/allrice-quota-test-'))
      await rm(storageRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  it.each([
    'upload',
    'export',
    'browser',
    'workbench',
    'cloud',
    'capture',
    'managed',
    'workflow',
  ] as const)(
    '%s takes the common gate before its first transactional row lock and rejects excess bytes',
    async (name) => {
      const { f, calls } = await sources();
      const baseline = await used(f);
      await quota(f, baseline);
      const sequences = new Map<number, string[]>();
      activeDb = instrument((sql, run, n) => {
        const lines = sequences.get(n) ?? [];
        lines.push(sql);
        sequences.set(n, lines);
        return run();
      });
      try {
        await expect(calls[name].run()).rejects.toThrow(
          /quota_exceeded|local_browser_output_limit/,
        );
      } finally {
        activeDb = db;
      }
      const publishing = [...sequences.values()].filter((seq) =>
        seq.some(isGate),
      );
      expect(publishing.length).toBeGreaterThan(0);
      for (const sequence of publishing)
        expect(isGate(sequence[0]!)).toBe(true);
      expect(await used(f)).toBe(baseline);
    },
    15000,
  );
  it.each([
    ['upload', 'export'],
    ['capture', 'browser'],
    ['workbench', 'workflow'],
    ['managed', 'cloud'],
  ] as const)(
    'serializes concurrent real %s / %s increments, admitting exactly one without overspending',
    async (a, b) => {
      const { f, calls } = await sources();
      const baseline = await used(f),
        allowance = Math.max(calls[a].size, calls[b].size);
      await quota(f, baseline + allowance);
      const first = deferred(),
        second = deferred();
      let entries = 0;
      activeDb = instrument((sql, run) => {
        if (!isGate(sql)) return run();
        entries++;
        if (entries === 1)
          return Promise.resolve(run()).then(async (value) => {
            first.resolve();
            await second.promise;
            return value;
          });
        second.resolve();
        return run();
      });
      const one = calls[a].run();
      void one.catch(() => undefined);
      await first.promise;
      const two = calls[b].run();
      try {
        const results = await Promise.allSettled([one, two]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const failed = results.find(
          (r) => r.status === 'rejected',
        ) as PromiseRejectedResult;
        expect(String(failed.reason)).toMatch(
          /quota_exceeded|local_browser_output_limit/,
        );
        expect(await used(f)).toBeLessThanOrEqual(baseline + allowance);
      } finally {
        second.resolve();
        await Promise.allSettled([one, two]);
        activeDb = db;
      }
    },
    15000,
  );
  it('pending reserves bytes, ready does not double count, tombstones release, and workflow retry is idempotent', async () => {
    const { f, calls, metadata, workflowInput } = await sources();
    const baseline = await used(f);
    await quota(f, baseline + calls.upload.size);
    await calls.upload.run();
    expect(await used(f)).toBe(baseline + calls.upload.size);
    await expect(calls.workflow.run()).rejects.toThrow('quota_exceeded');
    await abandonStorageMetadata(f.context, metadata.id);
    expect(await used(f)).toBe(baseline);
    await expect(markStorageReady(f.context, metadata.id)).rejects.toThrow(
      'not_found',
    );
    const first = await calls.workflow.run();
    expect(await calls.workflow.run()).toEqual(first);
    await registerWorkflowArtifact({
      ...workflowInput,
      stepKey: 'same-object-new-link',
    });
    expect(await used(f)).toBe(baseline + calls.workflow.size);
    await quota(f, baseline + calls.workflow.size + calls.upload.size);
    const next = { ...metadata, id: randomUUID() };
    await createStorageMetadata(f.context, next);
    const pending = await used(f);
    await markStorageReady(f.context, next.id);
    expect(await used(f)).toBe(pending);
  });
  it('rollback releases the gate and an unrelated tenant can publish while it is held', async () => {
    const a = await sources(),
      b = await sources();
    const held = deferred(),
      release = deferred();
    const transaction = db.begin(async (tx) => {
      await lockWorkspaceStorageQuota(tx, a.f.org, a.f.workspace);
      held.resolve();
      await release.promise;
      throw Error('synthetic rollback');
    });
    void transaction.catch(() => undefined);
    await held.promise;
    try {
      await b.calls.upload.run();
      release.resolve();
      await expect(transaction).rejects.toThrow('synthetic rollback');
      await a.calls.upload.run();
    } finally {
      release.resolve();
      await transaction.catch(() => undefined);
    }
  });
  it('preserves organization-scoped request and visibility while charging the explicit object workspace', async () => {
    const { f, metadata } = await sources();
    await db`update allrice_memberships set workspace_id=null where organization_id=${f.org} and user_id=${f.user}`;
    const context = {
      ...f.context,
      workspaceId: null,
      memberships: f.context.memberships.map((m) => ({
        ...m,
        workspaceId: null,
      })),
    };
    const baseline = await used(f);
    await quota(f, baseline + metadata.sizeBytes);
    const object = await createStorageMetadata(context, {
      ...metadata,
      visibility: 'organization',
    });
    expect(object.object.workspaceId).toBe(f.workspace);
    expect(object.visibility).toBe('organization');
    await markStorageReady(context, metadata.id);
    expect((await getStoredFile(context, metadata.id)).object.workspaceId).toBe(
      f.workspace,
    );
    await expect(
      createStorageMetadata(context, {
        ...metadata,
        id: randomUUID(),
        visibility: 'organization',
      }),
    ).rejects.toThrow('quota_exceeded');
    await expect(
      createStorageMetadata(context, {
        ...metadata,
        id: randomUUID(),
        workspaceId: null,
      }),
    ).rejects.toThrow();
    expect(await used(f)).toBe(baseline + metadata.sizeBytes);
  });
  it('a session-locked workbench reader and browser publication cannot recreate the tenant/session lock cycle', async () => {
    const { f, calls } = await sources(),
      readerHeld = deferred(),
      publisherAtSession = deferred();
    const readerDb = instrument((sql, run) =>
      sql.includes('select id from allrice_workspaces')
        ? (readerHeld.resolve(), publisherAtSession.promise.then(run))
        : run(),
    );
    const reader = readerDb.begin((tx) =>
      assertWorkbenchSession(tx, f.context, f.session),
    );
    void reader.catch(() => undefined);
    await readerHeld.promise;
    activeDb = instrument((sql, run) => {
      if (sql.includes('select id from allrice_chat_sessions'))
        publisherAtSession.resolve();
      return run();
    });
    const publication = calls.browser.run();
    try {
      await expect(Promise.all([reader, publication])).resolves.toHaveLength(2);
    } finally {
      publisherAtSession.resolve();
      await Promise.allSettled([reader, publication]);
      activeDb = db;
    }
  }, 15000);
});
