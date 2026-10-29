import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cloudPythonImageV1, cloudToolchainImageV1 } from '@allrice/contracts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { publishCloudOperationArtifacts } from './cloud-execution.ts';
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import { completeStorageDelete, prepareStorageDelete } from './data.ts';
import {
  getWorkbenchArtifact,
  listWorkbenchArtifacts,
} from './artifact-review.ts';
import {
  createToolBrokerExportObject,
  getToolBrokerFile,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';
import {
  CloudRunnerBackend,
  type CloudRunResult,
} from '../../../apps/worker/src/cloud-runner/backend.js';
import { runCloudCommandOperation } from '../../../apps/worker/src/cloud-runner/executor.js';
import type * as Client from './core/client.ts';

let db: ReturnType<typeof postgres>;
let isolated: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
let storageRoot: string;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const revisedPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const sha = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const checksum = sha(png);
const artifact: CloudRunResult['artifacts'][number] = {
  path: 'chart.png',
  contentBase64: png.toString('base64'),
  png: { checker: 'pillow-11.3.0', width: 1, height: 1, checksum },
};
const args = {
  language: 'python',
  script: 'synthetic decoder result; never executed',
  outputs: [{ path: 'chart.png', fileName: '中文图表.png', format: 'png' }],
};

/** DB-only fixture reports stopped bytes. Full trusted Pillow decoding is tested
 * independently in python-charts.integration.test.ts against the fixed image. */
class CapturedBackend extends CloudRunnerBackend {
  executions = 0;
  constructor(readonly artifacts = [artifact]) {
    super();
  }
  override async inspect() {
    return null;
  }
  override async cleanup() {}
  override async execute(): Promise<CloudRunResult> {
    this.executions++;
    return {
      containerId: '1'.repeat(64),
      exitCode: 0,
      stopped: true,
      reason: 'completed',
      output: 'synthetic',
      elapsedMs: 1,
      artifacts: this.artifacts,
    };
  }
}
suite(
  'Python PNG uses the existing governed storage and version lifecycle',
  () => {
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      isolated = await createRuntimeFixtureDatabase();
      db = isolated.db;
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-met166-cloud-'));
    }, 60000);
    afterAll(async () => {
      try {
        if (isolated)
          console.info('Cloud Python fixture cleanup', await isolated.close());
      } finally {
        if (storageRoot)
          await rm(storageRoot, { recursive: true, force: true });
        console.info('Cloud Python output storage cleanup', { storageRoot });
        vi.unstubAllEnvs();
      }
    });
    const fixture = () => createCloudExecutionFixture(db, storageRoot);
    type F = Awaited<ReturnType<typeof fixture>>;
    const seedOutputParent = async (
      f: F,
      options: {
        sessionId?: string;
        ownerId?: string;
        format?: 'png' | 'text';
        immutable?: boolean;
      } = {},
    ) => {
      const format = options.format ?? 'text',
        bytes = format === 'png' ? png : Buffer.from('amountCents\n100\n'),
        context = {
          ...f.execution,
          policySnapshot: {
            ...f.execution.policySnapshot,
            subjectId: options.ownerId ?? f.user,
          },
        },
        object = {
          ...createToolBrokerExportObject({
            context,
            mediaType: format === 'png' ? 'image/png' : 'text/csv',
            sizeBytes: bytes.length,
            checksum: sha(bytes),
          }),
          immutable: options.immutable ?? true,
        };
      await f.storage.put(object, new Blob([bytes]).stream());
      const version = await registerToolBrokerExport(
        {
          context,
          sessionId: options.sessionId ?? f.session,
          fileName: format === 'png' ? 'chart.png' : 'metrics.csv',
          format,
          object,
        },
        db,
      );
      return { object, version };
    };

    it.each(['deadline', 'output_limit'] as const)(
      'settles a stopped finite %s as failed with its cause, without replay',
      async (reason) => {
        const f = await fixture();
        const created = await f.create(`failed-${reason}`, {
          ...args,
          outputs: [],
        });
        await f.approve(created);
        const backend = new CapturedBackend([]);
        const execute = vi.spyOn(backend, 'execute').mockResolvedValue({
          containerId: '1'.repeat(64),
          exitCode: reason === 'deadline' ? 137 : 122,
          stopped: true,
          reason,
          output: '',
          elapsedMs: 1,
          artifacts: [],
        });
        const options = { storage: f.storage, backend, database: db };
        const result = await runCloudCommandOperation(created, options);
        expect(result).toMatchObject({
          status: 'failed',
          reason,
          stopped: true,
          cleanupConfirmed: true,
          artifacts: [],
        });
        const repeated = await runCloudCommandOperation(created, options);
        expect(repeated).toMatchObject({ status: 'failed', reason });
        expect(execute).toHaveBeenCalledTimes(1);
        const [run] =
          await db`select state from allrice_runs where id=${f.run}`;
        expect(run?.state).not.toBe('canceled');
      },
    );

    it('freezes Python image/language without changing existing grant profiles, Node payloads or replay authority', async () => {
      const f = await fixture();
      const node = await f.create('old-node');
      expect(node.payload.arguments).not.toHaveProperty('language');
      expect(node.payload.imageDigest).toBe(cloudToolchainImageV1);
      const python = await f.create('python', args);
      expect(python.payload.imageDigest).toBe(cloudPythonImageV1);
      expect((await f.create('python', args)).snapshot.binding).toEqual(
        python.snapshot.binding,
      );
      await expect(
        f.create('python', { ...args, language: 'javascript', outputs: [] }),
      ).rejects.toThrow('idempotency_conflict');
      const [grant] =
        await db`select profile from allrice_cloud_execution_grants where id=${f.grant.id}`;
      expect(grant!.profile).toEqual(f.grant.profile);
      const views = await listCloudRuntimeOperations(f.context, f.run, db);
      expect(
        views.find(
          (v) =>
            v.snapshot.binding.attempt.operationId ===
            node.snapshot.binding.attempt.operationId,
        )?.proposal,
      ).not.toHaveProperty('language');
      expect(
        views.find(
          (v) =>
            v.snapshot.binding.attempt.operationId ===
            python.snapshot.binding.attempt.operationId,
        )?.proposal,
      ).toMatchObject({ kind: 'cloud', language: 'python' });
    });

    it('publishes captured binary PNG with authorized object, checksum and immutable version in the existing file lifecycle; retry does not execute twice', async () => {
      const f = await fixture();
      const created = await f.create('png-publish', args);
      await f.approve(created);
      const backend = new CapturedBackend();
      const result = await runCloudCommandOperation(created, {
        storage: f.storage,
        backend,
        database: db,
      });
      expect(result.status).toBe('succeeded');
      expect(result.artifacts).toHaveLength(1);
      const published = result.artifacts[0]!;
      const { object } = await getToolBrokerFile(
        f.execution,
        published.objectId,
      );
      expect(object).toMatchObject({
        mediaType: 'image/png',
        checksum,
        sizeBytes: png.length,
        immutable: true,
        ownerId: f.user,
      });
      expect(published.objectId).not.toBe(published.versionId);
      expect(published.checksum).toBe(checksum);
      const stored = await f.storage.get(object);
      expect(Buffer.from(await new Response(stored).arrayBuffer())).toEqual(
        png,
      );
      const [version] =
        await db`select format,file_name,object_id from allrice_deliverable_versions where id=${published.versionId}`;
      expect(version).toMatchObject({
        format: 'png',
        file_name: '中文图表.png',
        object_id: published.objectId,
      });
      const [image] =
        await db`select kind from allrice_workbench_artifacts where version_id=${published.versionId}`;
      expect(image!.kind).toBe('file');
      const displayed = await getWorkbenchArtifact(
        f.context,
        f.session,
        published.versionId,
        db,
      );
      expect(displayed).toMatchObject({
        kind: 'file',
        version: {
          id: published.versionId,
          objectId: published.objectId,
          format: 'png',
        },
        object: { id: published.objectId, checksum, mediaType: 'image/png' },
      });
      expect(
        (await listWorkbenchArtifacts(f.context, f.session, undefined, db))
          .artifacts,
      ).toContainEqual(displayed);
      expect(
        await getToolBrokerFile(f.execution, published.objectId),
      ).toMatchObject({ object: { id: published.objectId } });
      const retry = await runCloudCommandOperation(created, {
        storage: f.storage,
        backend,
        database: db,
      });
      expect(retry.artifacts).toEqual(result.artifacts);
      expect(backend.executions).toBe(1);
      const [count] =
        await db`select count(*)::int as n from allrice_deliverable_versions where object_id=${published.objectId}`;
      expect(count!.n).toBe(1);
      const other = await fixture();
      await expect(
        getToolBrokerFile(other.execution, published.objectId),
      ).rejects.toThrow();
      const altered = [
        {
          ...artifact,
          contentBase64: Buffer.from('different').toString('base64'),
        },
      ];
      await expect(
        publishCloudOperationArtifacts(
          {
            context: f.execution,
            binding: created.snapshot.binding,
            payload: created.payload,
            artifacts: altered,
          },
          f.storage,
          db,
        ),
      ).rejects.toThrow('cloud_result_unconfirmed');
    });

    it.each(['png', 'csv'] as const)(
      'continues a cloud %s output in its original series with exact names, old bytes and idempotent publication',
      async (format) => {
        const f = await fixture(),
          oldBytes = format === 'png' ? png : Buffer.from('amountCents\n100\n'),
          newBytes =
            format === 'png' ? revisedPng : Buffer.from('amountCents\n250\n'),
          output = {
            path: `metrics.${format}`,
            fileName: `指标 v1.${format}`,
            format,
          };
        const capture = (
          bytes: Buffer,
        ): CloudRunResult['artifacts'][number] => ({
          path: output.path,
          contentBase64: bytes.toString('base64'),
          ...(format === 'png'
            ? { png: { ...artifact.png!, checksum: sha(bytes) } }
            : {}),
        });
        const first = await f.create(`revision-v1-${format}`, {
          ...args,
          outputs: [output],
        });
        await f.approve(first);
        const firstBackend = new CapturedBackend([capture(oldBytes)]),
          firstResult = await runCloudCommandOperation(first, {
            storage: f.storage,
            backend: firstBackend,
            database: db,
          }),
          v1 = firstResult.artifacts[0]!;
        expect(firstResult.status).toBe('succeeded');
        const revisedArgs = {
          ...args,
          outputs: [
            {
              ...output,
              fileName: `指标 v2.${format}`,
              parentObjectId: v1.objectId,
            },
          ],
        };
        const second = await f.create(`revision-v2-${format}`, revisedArgs);
        expect(second.payload.arguments.inputs).toEqual([]);
        expect(second.snapshot.binding.dataScope).not.toContainEqual(
          expect.objectContaining({
            content: expect.objectContaining({ id: v1.objectId }),
          }),
        );
        await f.approve(second);
        const backend = new CapturedBackend([capture(newBytes)]),
          options = { storage: f.storage, backend, database: db },
          current = await runCloudCommandOperation(second, options),
          v2 = current.artifacts[0]!;
        expect(current.status).toBe('succeeded');
        expect(current.artifacts).toHaveLength(1);
        expect(v2).toMatchObject({
          fileName: `指标 v2.${format}`,
          checksum: sha(newBytes),
        });
        expect(v2.objectId).not.toBe(v1.objectId);
        const [original] =
          await db`select series_id,version,parent_version_id from allrice_deliverable_versions where id=${v1.versionId}`;
        expect(original).toMatchObject({ version: 1, parent_version_id: null });
        const [revised] =
          await db`select series_id,version,parent_version_id,file_name,format,object_id from allrice_deliverable_versions where id=${v2.versionId}`;
        expect(revised).toMatchObject({
          series_id: original!.series_id,
          version: 2,
          parent_version_id: v1.versionId,
          file_name: `指标 v2.${format}`,
          format: format === 'png' ? 'png' : 'text',
          object_id: v2.objectId,
        });
        for (const [published, bytes] of [
          [v1, oldBytes],
          [v2, newBytes],
        ] as const) {
          const { object } = await getToolBrokerFile(
            f.execution,
            published.objectId,
          );
          expect(object).toMatchObject({
            immutable: true,
            mediaType: format === 'png' ? 'image/png' : 'text/csv',
            checksum: sha(bytes),
          });
          const stored = Buffer.from(
            await new Response(await f.storage.get(object)).arrayBuffer(),
          );
          expect(stored).toEqual(bytes);
          expect(sha(stored)).toBe(published.checksum);
        }
        expect(
          (await runCloudCommandOperation(second, options)).artifacts,
        ).toEqual(current.artifacts);
        expect(backend.executions).toBe(1);
        expect(firstBackend.executions).toBe(1);
        expect(
          await db`select id from allrice_deliverable_versions where series_id=${original!.series_id}`,
        ).toHaveLength(2);
        await expect(
          f.create(`revision-v2-${format}`, {
            ...revisedArgs,
            outputs: [
              { ...revisedArgs.outputs[0]!, parentObjectId: v2.objectId },
            ],
          }),
        ).rejects.toThrow('idempotency_conflict');
      },
    );

    it.each([
      'wrong-session',
      'other-owner',
      'deleted',
      'not-deliverable',
      'wrong-format',
    ] as const)(
      'rejects a cloud %s parent before creating an operation or an unlinked replacement',
      async (kind) => {
        const f = await fixture();
        let ownerId = f.user,
          sessionId = f.session;
        if (kind === 'other-owner') ownerId = (await fixture()).user;
        if (kind === 'wrong-session' || kind === 'other-owner') {
          sessionId = randomUUID();
          await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
            select ${sessionId},organization_id,workspace_id,${ownerId},'Parent isolation',employee_assignment_id,employee_version_id from allrice_chat_sessions where id=${f.session}`;
        }
        const parent =
          kind === 'not-deliverable'
            ? await f.upload(Buffer.from('amountCents\n100\n'), 'text/csv')
            : (
                await seedOutputParent(f, {
                  ownerId,
                  sessionId,
                  format: kind === 'wrong-format' ? 'png' : 'text',
                  immutable: kind !== 'deleted',
                })
              ).object;
        if (kind === 'deleted') {
          const file = await prepareStorageDelete(f.context, parent.id);
          await f.storage.delete(file.object);
          await completeStorageDelete(f.context, parent.id);
        }
        const before =
          await db`select id from allrice_deliverable_versions where organization_id=${f.org} order by id`;
        await expect(
          f.create(`invalid-parent-${kind}`, {
            ...args,
            outputs: [
              {
                path: 'metrics.csv',
                fileName: 'metrics-v2.csv',
                format: 'csv',
                parentObjectId: parent.id,
              },
            ],
          }),
        ).rejects.toThrow();
        expect(
          await db`select id from allrice_deliverable_versions where organization_id=${f.org} order by id`,
        ).toEqual(before);
        expect(
          await db`select id from allrice_runtime_operations where run_id=${f.run}`,
        ).toHaveLength(0);
      },
    );

    it.each(['parent-deleted', 'grant-revoked'] as const)(
      'does not publish a cloud revision when %s after the captured compute stopped',
      async (reason) => {
        const f = await fixture(),
          // Deletion races use a legacy mutable export, preserving the normal
          // immutable-object guard for captured Python outputs.
          parent = await seedOutputParent(f, {
            immutable: reason !== 'parent-deleted',
          }),
          created = await f.create(`late-${reason}`, {
            ...args,
            outputs: [
              {
                path: 'metrics.csv',
                fileName: 'metrics-v2.csv',
                format: 'csv',
                parentObjectId: parent.object.id,
              },
            ],
          });
        await f.approve(created);
        const backend = new CapturedBackend([
            {
              path: 'metrics.csv',
              contentBase64:
                Buffer.from('amountCents\n250\n').toString('base64'),
            },
          ]),
          execute = backend.execute.bind(backend);
        vi.spyOn(backend, 'execute').mockImplementationOnce(async () => {
          const stopped = await execute();
          if (reason === 'parent-deleted') {
            const file = await prepareStorageDelete(
              f.context,
              parent.object.id,
            );
            await f.storage.delete(file.object);
            await completeStorageDelete(f.context, parent.object.id);
          } else
            await db`update allrice_cloud_execution_grants set revoked_at=clock_timestamp() where id=${f.grant.id}`;
          return stopped;
        });
        await expect(
          runCloudCommandOperation(created, {
            storage: f.storage,
            backend,
            database: db,
          }),
        ).rejects.toThrow();
        expect(backend.executions).toBe(1);
        expect(
          await db`select id from allrice_deliverable_versions where organization_id=${f.org}`,
        ).toHaveLength(1);
        expect(
          await db`select version_id from allrice_workbench_artifacts where run_id=${f.run}`,
        ).toHaveLength(0);
      },
    );

    it('rejects a changed parent against the recorded payload before returning a cached publication, and fences root cancellation', async () => {
      const f = await fixture(),
        parent = await seedOutputParent(f),
        otherParent = await seedOutputParent(f),
        created = await f.create('cached-lineage', {
          ...args,
          outputs: [
            {
              path: 'metrics.csv',
              fileName: 'metrics-v2.csv',
              format: 'csv',
              parentObjectId: parent.object.id,
            },
          ],
        });
      await f.approve(created);
      const backend = new CapturedBackend([
        {
          path: 'metrics.csv',
          contentBase64: Buffer.from('amountCents\n250\n').toString('base64'),
        },
      ]);
      const result = await runCloudCommandOperation(created, {
        storage: f.storage,
        backend,
        database: db,
      });
      expect(result.status).toBe('succeeded');
      if ('kind' in created.payload) throw Error('command payload required');
      const payload = {
        ...created.payload,
        arguments: {
          ...created.payload.arguments,
          outputs: created.payload.arguments.outputs.map((output) => ({
            ...output,
            parentObjectId: otherParent.object.id,
          })),
        },
      };
      const publish = (candidate = created.payload) =>
        publishCloudOperationArtifacts(
          {
            context: f.execution,
            binding: created.snapshot.binding,
            payload: candidate,
            artifacts: backend.artifacts,
          },
          f.storage,
          db,
        );
      await expect(publish(payload)).rejects.toThrow('cloud_binding_changed');
      const cached = await publish();
      const cachedObject = cached[0]!.object.id;
      await db`update allrice_storage_objects set retention_until=created_at+interval '1 microsecond' where id=${cachedObject}`;
      await expect(publish()).rejects.toThrow();
      await db`update allrice_storage_objects set retention_until=null where id=${cachedObject}`;
      await db`update allrice_cloud_execution_grants set enabled=false where id=${f.grant.id}`;
      await expect(publish()).rejects.toThrow();
      await db`update allrice_cloud_execution_grants set enabled=true where id=${f.grant.id}`;
      expect(cached.map((a) => a.versionId)).toEqual(
        result.artifacts.map((a) => a.versionId),
      );
      expect(
        await db`select id from allrice_deliverable_versions where organization_id=${f.org}`,
      ).toHaveLength(3);
      await created.ledger.cancelRoot(
        created.snapshot.binding.task.scope,
        f.run,
        randomUUID(),
      );
      await expect(publish()).rejects.toThrow('cloud_publication_revoked');
      expect(
        await db`select id from allrice_deliverable_versions where organization_id=${f.org}`,
      ).toHaveLength(3);
    });

    it('delivers a Python Markdown report directly, preserving bytes, other formats and immutable replay', async () => {
      const f = await fixture();
      const reports = [
        {
          path: 'report.md',
          fileName: '报告.md',
          format: 'txt',
          mediaType: 'text/markdown',
          versionFormat: 'markdown',
          content: '# 对账结果\n\n差额 **0.00 元**。\n',
        },
        {
          path: 'script.txt',
          fileName: 'reconcile.py.txt',
          format: 'txt',
          mediaType: 'text/plain',
          versionFormat: 'text',
          content: "print('0.00')\n",
        },
        {
          path: 'metrics.json',
          fileName: 'metrics.md',
          format: 'json',
          mediaType: 'application/json',
          versionFormat: 'json',
          content: '{"difference":"0.00"}',
        },
      ];
      const created = await f.create('markdown-publish', {
        ...args,
        outputs: reports.map(({ path, fileName, format }) => ({
          path,
          fileName,
          format,
        })),
      });
      await f.approve(created);
      const backend = new CapturedBackend(
        reports.map(({ path, content }) => ({
          path,
          contentBase64: Buffer.from(content).toString('base64'),
        })),
      );
      const options = { storage: f.storage, backend, database: db };
      const result = await runCloudCommandOperation(created, options);
      expect(result.status).toBe('succeeded');
      expect(result.artifacts).toHaveLength(reports.length);
      for (const [index, report] of reports.entries()) {
        const published = result.artifacts[index]!;
        const displayed = await getWorkbenchArtifact(
          f.context,
          f.session,
          published.versionId,
          db,
        );
        const bytes = Buffer.from(report.content);
        expect(displayed).toMatchObject({
          kind: 'file',
          version: { format: report.versionFormat, fileName: report.fileName },
          object: {
            mediaType: report.mediaType,
            checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            sizeBytes: bytes.length,
          },
        });
        expect(
          Buffer.from(
            await new Response(
              await f.storage.get(displayed.object),
            ).arrayBuffer(),
          ),
        ).toEqual(bytes);
      }
      expect(
        (await runCloudCommandOperation(created, options)).artifacts,
      ).toEqual(result.artifacts);
      expect(backend.executions).toBe(1);
      expect(
        await db`select id from allrice_deliverable_versions where session_id=${f.session}`,
      ).toHaveLength(reports.length);
      const other = await fixture();
      await expect(
        getToolBrokerFile(other.execution, result.artifacts[0]!.objectId),
      ).rejects.toThrow();
    });

    it('refuses absent or changed decoder proof before creating any storage object or version', async () => {
      for (const invalid of [
        { path: artifact.path, contentBase64: artifact.contentBase64 },
        {
          ...artifact,
          png: { ...artifact.png!, checksum: `sha256:${'0'.repeat(64)}` },
        },
      ]) {
        const f = await fixture();
        const created = await f.create(randomUUID(), args);
        await f.approve(created);
        await expect(
          runCloudCommandOperation(created, {
            storage: f.storage,
            backend: new CapturedBackend([invalid]),
            database: db,
          }),
        ).rejects.toThrow('cloud_artifact_invalid');
        const [row] =
          await db`select count(*)::int as n from allrice_deliverable_versions where session_id=${f.session}`;
        expect(row!.n).toBe(0);
        const [objects] =
          await db`select count(*)::int as n from allrice_storage_objects where organization_id=${f.org} and category='exports'`;
        expect(objects!.n).toBe(0);
      }
    });

    it('retains exact input owner, tenant and checksum authorization for Python', async () => {
      const f = await fixture(),
        other = await fixture();
      await expect(
        f.create('cross-tenant', {
          ...args,
          inputs: [
            {
              path: 'data.csv',
              objectId: other.object.id,
              checksum: other.object.checksum,
            },
          ],
        }),
      ).rejects.toThrow();
      await db`update allrice_storage_objects set owner_id=${other.user} where id=${f.object.id}`;
      await expect(
        f.create('cross-user', {
          ...args,
          inputs: [
            {
              path: 'data.csv',
              objectId: f.object.id,
              checksum: f.object.checksum,
            },
          ],
        }),
      ).rejects.toThrow('authorization_denied');
      await db`update allrice_storage_objects set owner_id=${f.user} where id=${f.object.id}`;
      await expect(
        f.create('changed-checksum', {
          ...args,
          inputs: [
            {
              path: 'data.csv',
              objectId: f.object.id,
              checksum: `sha256:${'0'.repeat(64)}`,
            },
          ],
        }),
      ).rejects.toThrow('cloud_input_changed');
    });
  },
);
