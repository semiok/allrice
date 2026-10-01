import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cloudPythonImageV1, cloudToolchainImageV1 } from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { publishCloudOperationArtifacts } from './cloud-execution.ts';
import { listCloudRuntimeOperations } from './cloud-operation-view.ts';
import {
  getWorkbenchArtifact,
  listWorkbenchArtifacts,
} from './artifact-review.ts';
import { getToolBrokerFile } from './execution/tool-broker.ts';
import {
  CloudRunnerBackend,
  type CloudRunResult,
} from '../../../apps/worker/src/cloud-runner/backend.js';
import { runCloudCommandOperation } from '../../../apps/worker/src/cloud-runner/executor.js';
import type * as Client from './core/client.ts';

let db: ReturnType<typeof postgres>;
let isolated: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
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
const checksum = `sha256:${createHash('sha256').update(png).digest('hex')}`;
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
      isolated = await createAssistantFixtureDatabase();
      db = isolated.db;
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-met166-cloud-'));
    }, 60000);
    afterAll(async () => {
      try {
        await isolated?.close();
      } finally {
        if (storageRoot)
          await rm(storageRoot, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    });
    const fixture = () => createCloudExecutionFixture(db, storageRoot);

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
