/** Real PostgreSQL and immutable local bytes; synthetic identities, no tenant/model. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';
import {
  ExecutionContextSchema,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import { LocalStorageAdapter } from '../../storage/src/index.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import { getWorkbenchArtifact, readArtifactBytes } from './artifact-review.ts';
import { publishAssistantOutput } from './assistant-output.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'P25 assistant output — real immutable storage and current authority',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let storage: LocalStorageAdapter;
    let directory: string;
    const flags = [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_WORKBENCH_ENABLED',
    ] as const;
    const originalFlags = flags.map((key) => process.env[key]);
    beforeAll(async () => {
      for (const key of flags) process.env[key] = '1';
      fixture = await createAssistantFixtureDatabase();
      directory = await mkdtemp(join(tmpdir(), 'allrice-p25-output-'));
      storage = new LocalStorageAdapter(directory);
    }, 120000);
    afterAll(async () => {
      for (const [index, key] of flags.entries()) {
        if (originalFlags[index] === undefined) delete process.env[key];
        else process.env[key] = originalFlags[index];
      }
      await fixture?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    async function setup() {
      const f = await createAssistantAuthorityFixture(fixture.db);
      const { instance: child } = await f.runtime.provision({
        ...f.base,
        scope: f.task.scope,
        rootRunId: f.rootRunId,
        parentRunId: f.rootRunId,
        delegationId: randomUUID(),
        label: 'Output helper',
        text: 'Report synthetic output',
        tools: ['assistant.report'],
      });
      const [policy] =
        await fixture.db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${f.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: f.rootRunId,
        jobId: f.worker.jobId,
        worker: { type: 'worker', id: f.worker.workerId },
        delegatedBy: { type: 'user', id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
        policySnapshot: {
          id: f.policy,
          organizationId: f.org,
          subjectId: f.user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
        startedAt: new Date().toISOString(),
      });
      const input = {
        context,
        assistant: { runId: child.runId, worker: f.worker },
        deliveryId: randomUUID(),
        output: {
          name: '分析结果',
          content: 'Synthetic generated result, not independently verified.',
        },
      };
      const publish = (
        overrides: Partial<typeof input> = {},
        port: StoragePort = storage,
      ) =>
        publishAssistantOutput(
          { ...input, ...overrides },
          { storage: port, database: fixture.db },
        );
      return { ...f, child, input, publish };
    }
    function watch(port: StoragePort = storage) {
      const objects: StorageObject[] = [];
      return {
        objects,
        port: {
          put: async (object, bytes) => {
            objects.push(object);
            await port.put(object, bytes);
          },
          get: (object) => port.get(object),
          delete: (object) => port.delete(object),
          exists: (object) => port.exists(object),
        } satisfies StoragePort,
      };
    }
    it('publishes actual bytes with private immutable ownership, root session and explicit generated provenance', async () => {
      const f = await setup();
      const { artifactId, digest, relativePath } = await f.publish();
      const artifact = await getWorkbenchArtifact(
        f.context,
        f.session,
        artifactId,
        fixture.db,
      );
      expect(artifact.provenance).toMatchObject({
        kind: 'model_proposal',
        runId: f.child.runId,
        stepId: f.input.deliveryId,
      });
      const [row] =
        await fixture.db`select o.*,v.session_id,a.run_id from allrice_storage_objects o join allrice_deliverable_versions v on v.object_id=o.id join allrice_workbench_artifacts a on a.version_id=v.id where v.id=${artifactId}`;
      expect(row).toMatchObject({
        owner_id: f.user,
        organization_id: f.org,
        workspace_id: f.workspace,
        session_id: f.session,
        run_id: f.child.runId,
        visibility: 'private',
        immutable: true,
        state: 'ready',
      });
      const object: StorageObject = {
        id: row!.id,
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        key: row!.object_key,
        mediaType: row!.media_type,
        sizeBytes: Number(row!.size_bytes),
        checksum: row!.checksum,
        immutable: true,
        retentionUntil: null,
        deletedAt: null,
      };
      const bytes = await readArtifactBytes(storage, object);
      expect(JSON.parse(Buffer.from(bytes).toString())).toMatchObject({
        kind: 'assistant_generated',
        independentlyVerified: false,
        childRunId: f.child.runId,
        content: f.input.output.content,
      });
      expect(digest).toBe(
        `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      );
      expect(relativePath).toBe(
        `outputs/${f.input.deliveryId}/${f.input.output.name}.json`,
      );
      await expect(storage.delete(object)).rejects.toThrow('immutable');
      await expect(
        getWorkbenchArtifact(
          { ...f.context, actor: { type: 'user', id: randomUUID() } },
          f.session,
          artifactId,
          fixture.db,
        ),
      ).rejects.toThrow();
      await expect(
        getWorkbenchArtifact(f.context, randomUUID(), artifactId, fixture.db),
      ).rejects.toThrow();
    });
    it('deduplicates concurrent exact reports; changed bytes/name cannot overwrite a committed version', async () => {
      const f = await setup();
      const tracked = watch();
      const results = await Promise.all([
        f.publish({}, tracked.port),
        f.publish({}, tracked.port),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(tracked.objects).toHaveLength(1);
      for (const output of [
        { ...f.input.output, content: 'different' },
        { ...f.input.output, name: 'different' },
      ])
        await expect(f.publish({ output })).rejects.toThrow(
          'assistant_output_conflict',
        );
      expect(await storage.exists(tracked.objects[0]!)).toBe(true);
    });
    it.each([
      'actor',
      'organization',
      'workspace',
      'root',
      'child',
      'job',
      'token',
      'generation',
      'fence',
    ] as const)('denies wrong %s before storage', async (kind) => {
      const f = await setup();
      const input = structuredClone(f.input);
      const tracked = watch();
      if (kind === 'actor') input.context.delegatedBy.id = randomUUID();
      if (kind === 'organization') input.context.organizationId = randomUUID();
      if (kind === 'workspace') input.context.workspaceId = randomUUID();
      if (kind === 'root') input.context.runId = randomUUID();
      if (kind === 'child') input.assistant.runId = randomUUID();
      if (kind === 'job') input.assistant.worker.jobId = randomUUID();
      if (kind === 'token') input.assistant.worker.leaseToken = randomUUID();
      if (kind === 'generation') input.assistant.worker.generation += 1;
      if (kind === 'fence')
        Object.assign(input.assistant.worker, { fence: 99 });
      await expect(f.publish(input, tracked.port)).rejects.toThrow();
      expect(tracked.objects).toHaveLength(0);
    });
    it('denies same Worker identity with a replaced live lease before output storage', async () => {
      const f = await setup();
      const tracked = watch();
      const token = randomUUID();
      await fixture.db`update allrice_jobs set lease_token=${token} where id=${f.worker.jobId}`;
      await expect(
        f.publish(
          {
            assistant: {
              ...f.input.assistant,
              worker: { ...f.worker, leaseToken: token },
            },
          },
          tracked.port,
        ),
      ).rejects.toThrow();
      expect(tracked.objects).toHaveLength(0);
    });
    it.each(['completed', 'partial', 'failed', 'canceled', 'unknown'])(
      'denies a %s child before storage',
      async (status) => {
        const f = await setup();
        const tracked = watch();
        await fixture.db`update allrice_assistant_instances set status=${status} where run_id=${f.child.runId}`;
        await expect(f.publish({}, tracked.port)).rejects.toThrow();
        expect(tracked.objects).toHaveLength(0);
      },
    );
    it('does not inherit root report permission when it was not delegated to this child', async () => {
      const f = await setup();
      const tracked = watch();
      await fixture.db`update allrice_assistant_instances set allowed_tools='[]' where run_id=${f.child.runId}`;
      await expect(f.publish({}, tracked.port)).rejects.toThrow();
      expect(tracked.objects).toHaveLength(0);
    });
    it('rejects a nested child whose parent is unknown even when root and child remain active', async () => {
      const f = await setup();
      const tracked = watch();
      await fixture.db`update allrice_assistant_instances set allowed_tools='["assistant.delegate","assistant.report"]' where run_id=${f.child.runId}`;
      const { instance } = await f.runtime.provision({
        ...f.base,
        parentRunId: f.child.runId,
        delegationId: randomUUID(),
        label: 'Nested',
        text: 'Synthetic',
        tools: ['assistant.report'],
      });
      await fixture.db`update allrice_assistant_instances set status='unknown' where run_id=${f.child.runId}`;
      await expect(
        f.publish(
          { assistant: { ...f.input.assistant, runId: instance.runId } },
          tracked.port,
        ),
      ).rejects.toThrow();
      expect(tracked.objects).toHaveLength(0);
    });
    it('gives sibling output names separate immutable identities and artifact namespaces', async () => {
      const f = await setup();
      const { instance: sibling } = await f.runtime.provision({
        ...f.base,
        parentRunId: f.rootRunId,
        delegationId: randomUUID(),
        label: 'Sibling',
        text: 'Synthetic',
        tools: ['assistant.report'],
      });
      const [a, b] = await Promise.all([
        f.publish(),
        f.publish({
          assistant: { ...f.input.assistant, runId: sibling.runId },
        }),
      ]);
      expect(a.artifactId).not.toBe(b.artifactId);
      expect(a.digest).not.toBe(b.digest);
      expect(a.relativePath).toBe(b.relativePath);
      const aa = await f.runtime.registerArtifact({
        ...f.base,
        runId: f.child.runId,
        ...a,
      });
      const bb = await f.runtime.registerArtifact({
        ...f.base,
        runId: sibling.runId,
        ...b,
      });
      expect(aa.path).not.toBe(bb.path);
    });
    it.each(flags)('denies %s OFF before storage', async (flag) => {
      const f = await setup();
      const tracked = watch();
      process.env[flag] = '0';
      try {
        await expect(f.publish({}, tracked.port)).rejects.toThrow();
        expect(tracked.objects).toHaveLength(0);
      } finally {
        process.env[flag] = '1';
      }
    });
    it('checks current revocation and explicit tool deny instead of trusting an earlier delegation', async () => {
      const f = await setup();
      const tracked = watch();
      await f.setControls({
        version: 2,
        enabled: true,
        mode: 'execute',
        rules: [
          { action: 'assistant.delegate', effect: 'allow' },
          { action: 'assistant.report', effect: 'deny' },
        ],
      });
      await expect(f.publish({}, tracked.port)).rejects.toThrow();
      expect(tracked.objects).toHaveLength(0);
    });
    it.each(['child', 'root'] as const)(
      'does not accept outputs after %s cancellation',
      async (kind) => {
        const f = await setup();
        const tracked = watch();
        if (kind === 'root')
          await f.runtime.cancelRoot(f.context, {
            runId: f.rootRunId,
            requestId: randomUUID(),
          });
        else
          await f.runtime.cancelChild(f.context, {
            runId: f.rootRunId,
            childRunId: f.child.runId,
            requestId: randomUUID(),
          });
        await expect(f.publish({}, tracked.port)).rejects.toThrow();
        expect(tracked.objects).toHaveLength(0);
      },
    );
    it('rechecks lease after real storage I/O and cleans only its own uncommitted bytes', async () => {
      const f = await setup();
      const tracked = watch();
      const port: StoragePort = {
        ...tracked.port,
        get: async (object) => {
          // Clock-only expiry: no second transaction attempts to mutate locked rows.
          await new Promise((resolve) => setTimeout(resolve, 800));
          return storage.get(object);
        },
      };
      await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '500 milliseconds' where id=${f.worker.jobId}`;
      await expect(f.publish({}, port)).rejects.toThrow();
      expect(tracked.objects).toHaveLength(1);
      expect(await storage.exists(tracked.objects[0]!)).toBe(false);
      expect(
        await fixture.db`select id from allrice_storage_objects where id=${tracked.objects[0]!.id}`,
      ).toHaveLength(0);
    });
    it('rejects tampered readback and leaves no committed version or orphaned object', async () => {
      const f = await setup();
      const tracked = watch();
      const port: StoragePort = {
        ...tracked.port,
        get: async () => new Blob(['tampered']).stream(),
      };
      await expect(f.publish({}, port)).rejects.toThrow();
      expect(tracked.objects).toHaveLength(1);
      expect(await storage.exists(tracked.objects[0]!)).toBe(false);
      expect(
        await fixture.db`select version_id from allrice_workbench_artifacts where run_id=${f.child.runId}`,
      ).toHaveLength(0);
    });
    it('rechecks stored bytes on exact retry and never removes a prior committed artifact', async () => {
      const f = await setup();
      const tracked = watch();
      await f.publish({}, tracked.port);
      const port: StoragePort = {
        ...tracked.port,
        get: async () => new Blob(['tampered']).stream(),
      };
      await expect(f.publish({}, port)).rejects.toThrow('content_changed');
      expect(tracked.objects).toHaveLength(1);
      expect(await storage.exists(tracked.objects[0]!)).toBe(true);
    });
    it('preserves committed bytes when the caller loses the COMMIT acknowledgement', async () => {
      const f = await setup();
      const tracked = watch();
      // Real PostgreSQL commits; only the response transport is fault-injected.
      const wrapped = new Proxy(fixture.db, {
        get(target, key) {
          if (key === 'begin')
            return async (
              body: (transaction: TransactionSql) => Promise<unknown>,
            ) => {
              await target.begin(body);
              throw Error('synthetic_commit_ack_lost');
            };
          return Reflect.get(target, key);
        },
      });
      await expect(
        publishAssistantOutput(f.input, {
          storage: tracked.port,
          database: wrapped,
        }),
      ).rejects.toThrow('synthetic_commit_ack_lost');
      expect(tracked.objects).toHaveLength(1);
      expect(await storage.exists(tracked.objects[0]!)).toBe(true);
      const result = await f.publish({}, tracked.port);
      expect(result.artifactId).toBeTruthy();
      expect(tracked.objects).toHaveLength(1);
    });
    it('releases PostgreSQL locks after a stalled put timeout, without racing an unacknowledged write with deletion', async () => {
      const f = await setup();
      let entered!: () => void;
      const writing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let deletes = 0;
      const port: StoragePort = {
        put: async () => {
          entered();
          await new Promise(() => {});
        },
        get: (object) => storage.get(object),
        exists: (object) => storage.exists(object),
        delete: async () => {
          deletes++;
        },
      };
      const pending = f.publish({}, port);
      pending.catch(() => {});
      await writing;
      const cancellation = f.runtime.cancelRoot(f.context, {
        runId: f.rootRunId,
        requestId: randomUUID(),
      });
      await expect(pending).rejects.toThrow('assistant_output_storage_timeout');
      await expect(cancellation).resolves.toEqual({
        cancelRequested: true,
        stopped: false,
      });
      expect(deletes).toBe(0);
      expect(
        await fixture.db`select version_id from allrice_workbench_artifacts where run_id=${f.child.runId}`,
      ).toHaveLength(0);
    }, 15000);
    it('checks Workbench OFF again after storage and before registering a version', async () => {
      const f = await setup();
      const tracked = watch();
      const port: StoragePort = {
        ...tracked.port,
        get: async (object) => {
          process.env.ALLRICE_WORKBENCH_ENABLED = '0';
          return storage.get(object);
        },
      };
      try {
        await expect(f.publish({}, port)).rejects.toThrow(
          'assistant_output_denied',
        );
        expect(tracked.objects).toHaveLength(1);
        expect(await storage.exists(tracked.objects[0]!)).toBe(false);
      } finally {
        process.env.ALLRICE_WORKBENCH_ENABLED = '1';
      }
    });
    it('enforces actual workspace quota and cleans a rejected unpublished object', async () => {
      const f = await setup();
      const tracked = watch();
      await fixture.db`insert into allrice_storage_quotas(organization_id,workspace_id,limit_bytes) values(${f.org},${f.workspace},0)`;
      await expect(f.publish({}, tracked.port)).rejects.toThrow(
        'quota_exceeded',
      );
      expect(tracked.objects).toHaveLength(1);
      expect(await storage.exists(tracked.objects[0]!)).toBe(false);
    });
    it.each([
      { name: '../outside', content: 'x' },
      { name: 'ok', content: '界'.repeat(50000) },
      { name: 'nested/file', content: 'x' },
    ])(
      'denies unbounded/path-like output before storage %#',
      async (output) => {
        const f = await setup();
        const tracked = watch();
        await expect(f.publish({ output }, tracked.port)).rejects.toThrow();
        expect(tracked.objects).toHaveLength(0);
      },
    );
  },
);
