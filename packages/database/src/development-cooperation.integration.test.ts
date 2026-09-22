import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  composeDevelopmentChangesets,
  type ChangesetDocument,
  type DevelopmentArtifactRef,
  type RuntimeExecutionScope,
} from '@allrice/contracts';
import {
  assistantFixture,
  assistantFixtureStorage,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import { createAssistantAuthorityFixture } from './assistant-authority.fixture.ts';
import type { DevelopmentCaller } from './development-cooperation.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const side = (text: string | null) =>
  text === null
    ? null
    : {
        text,
        checksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      };
const file = (path: string, before: string | null, after: string | null) => ({
  path,
  before: side(before),
  after: side(after),
});
integration(
  'MET-144 ownership/version ledger — isolated real PostgreSQL, synthetic artifacts',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      database = await createAssistantFixtureDatabase();
    }, 120000);
    afterAll(async () => {
      await database?.close();
      vi.unstubAllEnvs();
    });
    afterEach(() => vi.restoreAllMocks());
    async function setup(productionAuthority = false) {
      const db = database.db;
      const f = productionAuthority
        ? await createAssistantAuthorityFixture(db, {
            allowedTools: [
              'assistant.delegate',
              'assistant.report',
              'workspace.export.create',
            ],
          })
        : await assistantFixture(db);
      // Synthetic identity fixture: explicit tool grant; production hook deny is
      // separately exercised below. No Dev tenant/model/device is used.
      if (!productionAuthority)
        await db`update allrice_assistant_instances set allowed_tools=${db.json(['assistant.delegate', 'assistant.report', 'workspace.export.create'])} where run_id=${f.task.runId}`;
      const storage = assistantFixtureStorage(db);
      const base: DevelopmentCaller = { ...f.base, runId: f.task.runId };
      const execution: RuntimeExecutionScope = {
        targetId: randomUUID(),
        targetKind: 'rice_bridge',
        deviceId: randomUUID(),
        grantId: randomUUID(),
        grantVersion: 1,
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        workCopy: { id: randomUUID(), kind: 'in_place' },
      };
      const doc = (
        files: ChangesetDocument['files'],
        target = execution,
      ): ChangesetDocument => ({
        contractVersion: 1,
        comparisonScope: 'changeset',
        execution: target,
        files,
      });
      async function publish(
        runId: string,
        document: ChangesetDocument,
        parent?: DevelopmentArtifactRef,
        artifactOwner?: string,
      ) {
        const artifactId = randomUUID(),
          objectId = randomUUID();
        const owner = artifactOwner ?? f.context.actor.id;
        const { organizationId, workspaceId } = base.scope;
        const bytes = Buffer.from(JSON.stringify(document));
        const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        const key = `organizations/${organizationId}/workspaces/${workspaceId}/owners/${owner}/artifacts/${objectId}`;
        const [previous] = parent
          ? await db<
              { series_id: string; version: number }[]
            >`select series_id,version from allrice_deliverable_versions where id=${parent.artifactId}`
          : [];
        await storage.put(
          {
            id: objectId,
            organizationId,
            workspaceId,
            ownerId: owner,
            key,
            checksum,
            sizeBytes: bytes.length,
            mediaType: 'application/json',
            retentionUntil: null,
            deletedAt: null,
            immutable: true,
          },
          new Blob([bytes]).stream(),
        );
        await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable) values(${objectId},${organizationId},${workspaceId},${owner},${key},'artifacts','application/json',${bytes.length},${checksum},'ready',true)`;
        await db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format,parent_version_id) values(${artifactId},${organizationId},${workspaceId},${owner},${objectId},${previous?.series_id ?? randomUUID()},${previous ? previous.version + 1 : 1},${f.task.chatSessionId},'proposal.json','json',${parent?.artifactId ?? null})`;
        await db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,execution,request_id,request_digest) values(${artifactId},${organizationId},${workspaceId},${owner},${runId},'changeset',${db.json({ kind: 'model_proposal', runId, operationId: null, stepId: null })},${db.json(document.execution)},${randomUUID()},${checksum})`;
        return { artifactId, digest: checksum };
      }
      const seedDoc = doc([
        file('src/a.ts', 'old a', 'old a'),
        file('src/b.ts', 'old b', 'old b'),
      ]);
      const seed = await publish(f.task.runId, seedDoc);
      const dev = f.runtime.development;
      await dev.initialize({ ...base, seed }, storage);
      const child = async (parentRunId: string = f.task.runId) =>
        (
          await f.runtime.provision({
            ...f.base,
            delegationId: randomUUID(),
            label: 'Synthetic developer',
            text: 'Propose synthetic changes',
            parentRunId,
            tools: ['workspace.export.create', 'assistant.delegate'],
          })
        ).instance;
      const assign = (
        ownerRunId: string,
        paths = ['src/a.ts'],
        target = execution,
        expectedHead = seed,
        assignmentId = randomUUID(),
        callerRunId = base.runId,
      ) =>
        dev.assign({
          ...base,
          runId: callerRunId,
          assignmentId,
          ownerRunId,
          expectedHead,
          execution: target,
          paths,
        });
      async function proposal(
        ownerRunId: string,
        path: string,
        before: string | null,
        after: string | null,
        target = execution,
      ) {
        const claim = await assign(ownerRunId, [path], target);
        const document = doc([file(path, before, after)], target);
        const value = await publish(ownerRunId, document);
        await dev.propose(
          {
            ...base,
            runId: ownerRunId,
            assignmentId: claim.assignmentId,
            proposal: value,
          },
          storage,
        );
        return { value, document, claim };
      }
      return {
        f,
        db,
        storage,
        base,
        execution,
        doc,
        publish,
        seedDoc,
        seed,
        dev,
        child,
        assign,
        proposal,
      };
    }
    it('uses the real production authority hook and blocks a later policy revocation', async () => {
      const t = await setup(true),
        a = await t.child();
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A');
      const result = await t.publish(
        t.base.runId,
        composeDevelopmentChangesets(t.seedDoc, [p.document]),
        t.seed,
      );
      const input = {
        ...t.base,
        requestId: randomUUID(),
        expectedHead: t.seed,
        proposals: [p.value],
        result,
      };
      expect(await t.dev.merge(input, t.storage)).toMatchObject({
        revision: 1,
        verification: 'unverified',
      });
      await t.db`update allrice_runtime_policy_controls set version=2,controls=${t.db.json({ version: 2, enabled: true, mode: 'execute', rules: [{ action: 'assistant.delegate', effect: 'deny' }] })} where organization_id=${t.base.scope.organizationId} and workspace_id=${t.base.scope.workspaceId}`;
      await expect(t.dev.merge(input, t.storage)).rejects.toThrow(
        'assistant_authority_denied',
      );
    });
    it('retains immutable assignment and version provenance in PostgreSQL', async () => {
      const t = await setup(),
        a = await t.child();
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A');
      await expect(
        t.db`update allrice_development_assignments set paths='["elsewhere"]' where id=${p.claim.assignmentId}`,
      ).rejects.toThrow('immutable');
      await expect(
        t.db`update allrice_development_proposals set digest=${`sha256:${'0'.repeat(64)}`} where artifact_id=${p.value.artifactId}`,
      ).rejects.toThrow('immutable');
      await expect(
        t.db`update allrice_development_heads set revision=1 where root_run_id=${t.base.rootRunId}`,
      ).rejects.toThrow('verified merge');
    });
    it('recovers from a rejected published candidate without overwriting history or accepting its content', async () => {
      const t = await setup(),
        a = await t.child();
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A');
      const candidate = await t.publish(
        t.base.runId,
        t.doc([file('src/a.ts', 'old a', 'unwanted')]),
        t.seed,
      );
      const input = {
        ...t.base,
        requestId: randomUUID(),
        expectedHead: t.seed,
        proposals: [p.value],
      };
      await expect(
        t.dev.merge({ ...input, result: candidate }, t.storage),
      ).rejects.toThrow('result_mismatch');
      const corrected = await t.publish(
        t.base.runId,
        composeDevelopmentChangesets(t.seedDoc, [p.document]),
        candidate,
      );
      expect(
        await t.dev.merge({ ...input, result: corrected }, t.storage),
      ).toEqual({ head: corrected, revision: 1, verification: 'unverified' });
      expect(
        await t.db`select id from allrice_deliverable_versions where id=${candidate.artifactId}`,
      ).toHaveLength(1);
    });
    it('rolls back registration if the worker lease expires during artifact reads', async () => {
      const t = await setup(),
        a = await t.child();
      const claim = await t.assign(a.runId);
      const proposal = await t.publish(
        a.runId,
        t.doc([file('src/a.ts', 'old a', 'A')]),
      );
      const get = t.storage.get.bind(t.storage);
      vi.spyOn(t.storage, 'get').mockImplementation(async (object) => {
        await new Promise((resolve) => setTimeout(resolve, 350));
        return get(object);
      });
      await t.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '500 milliseconds' where id=${t.base.worker.jobId}`;
      await expect(
        t.dev.propose(
          {
            ...t.base,
            runId: a.runId,
            assignmentId: claim.assignmentId,
            proposal,
          },
          t.storage,
        ),
      ).rejects.toThrow('lease_lost');
      expect(
        await t.db`select * from allrice_development_proposals where root_run_id=${t.base.rootRunId}`,
      ).toHaveLength(0);
    });
    it('does not adopt an older proposal after its author publishes a corrected version', async () => {
      const t = await setup(),
        a = await t.child();
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A');
      await t.publish(
        a.runId,
        t.doc([file('src/a.ts', 'old a', 'correction')]),
        p.value,
      );
      const result = await t.publish(
        t.base.runId,
        composeDevelopmentChangesets(t.seedDoc, [p.document]),
        t.seed,
      );
      await expect(
        t.dev.merge(
          {
            ...t.base,
            requestId: randomUUID(),
            expectedHead: t.seed,
            proposals: [p.value],
            result,
          },
          t.storage,
        ),
      ).rejects.toThrow('artifact_mismatch');
    });
    it('serializes concurrent same-copy claims, including parent/child and sibling prefix conflicts', async () => {
      const t = await setup(),
        a = await t.child(),
        b = await t.child();
      const results = await Promise.allSettled([
        t.assign(a.runId, ['src']),
        t.assign(b.runId, ['src/a.ts']),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      await expect(t.assign(t.base.runId, ['SRC/a.ts'])).rejects.toThrow(
        'path_conflict',
      );
      expect(
        await t.db`select * from allrice_development_assignments where root_run_id=${t.base.rootRunId}`,
      ).toHaveLength(1);
    });
    it('persists idempotency and ownership across reconstructed runtime instances; altered requests conflict', async () => {
      const t = await setup(),
        a = await t.child(),
        id = randomUUID();
      const request = {
        ...t.base,
        assignmentId: id,
        ownerRunId: a.runId,
        expectedHead: t.seed,
        execution: t.execution,
        paths: ['src/a.ts'],
      };
      const [one, two] = await Promise.all([
        t.dev.assign(request),
        t.dev.assign(request),
      ]);
      expect(one).toEqual(two);
      const cold = createAssistantRuntime({
        database: t.db,
        authorize: async () => {},
      }).development;
      expect(await cold.assign(request)).toEqual(one);
      await expect(
        cold.assign({ ...request, paths: ['src/b.ts'] }),
      ).rejects.toThrow('conflict');
      await expect(
        cold.assign({
          ...request,
          assignmentId: randomUUID(),
          paths: ['SRC/a.ts'],
        }),
      ).rejects.toThrow('path_conflict');
    });
    it('cannot widen a parent file assignment through nested delegation or a fresh copy ID', async () => {
      const t = await setup(),
        parent = await t.child(),
        child = await t.child(parent.runId);
      const copy = () => ({
        ...t.execution,
        workCopy: { id: randomUUID(), kind: 'local_copy' as const },
      });
      await expect(
        t.assign(
          parent.runId,
          ['private.txt'],
          copy(),
          t.seed,
          randomUUID(),
          parent.runId,
        ),
      ).rejects.toThrow('scope_mismatch');
      await t.assign(parent.runId, ['src/a.ts']);
      await expect(
        t.assign(
          child.runId,
          ['src/b.ts'],
          copy(),
          t.seed,
          randomUUID(),
          parent.runId,
        ),
      ).rejects.toThrow('scope_mismatch');
      await expect(
        t.assign(
          parent.runId,
          ['private.txt'],
          copy(),
          t.seed,
          randomUUID(),
          parent.runId,
        ),
      ).rejects.toThrow('scope_mismatch');
      await expect(
        t.assign(
          child.runId,
          ['src/a.ts'],
          copy(),
          t.seed,
          randomUUID(),
          parent.runId,
        ),
      ).resolves.toMatchObject({ active: true });
    });
    it('allows parallel isolated proposals but denies overlapping adoption into the final target', async () => {
      const t = await setup(),
        a = await t.child(),
        b = await t.child();
      const copy = () => ({
        ...t.execution,
        workCopy: { id: randomUUID(), kind: 'local_copy' as const },
      });
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A', copy());
      const q = await t.proposal(b.runId, 'src/a.ts', 'old a', 'B', copy());
      const result = await t.publish(
        t.base.runId,
        composeDevelopmentChangesets(t.seedDoc, [p.document]),
        t.seed,
      );
      await expect(
        t.dev.merge(
          {
            ...t.base,
            requestId: randomUUID(),
            expectedHead: t.seed,
            proposals: [p.value, q.value],
            result,
          },
          t.storage,
        ),
      ).rejects.toThrow();
      expect(
        await t.db`select * from allrice_development_merges where root_run_id=${t.base.rootRunId}`,
      ).toHaveLength(0);
    });
    it('adopts disjoint proposals as a new immutable version, without granting approval or test success', async () => {
      const t = await setup(),
        a = await t.child(),
        b = await t.child();
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A');
      const q = await t.proposal(b.runId, 'src/b.ts', 'old b', 'B');
      // Completed reports can be adopted, but no further proposal from that actor.
      await t.db`update allrice_assistant_instances set status='completed',stopped_at=clock_timestamp() where run_id=${a.runId}`;
      const result = await t.publish(
        t.base.runId,
        composeDevelopmentChangesets(t.seedDoc, [p.document, q.document]),
        t.seed,
      );
      const request = {
        ...t.base,
        requestId: randomUUID(),
        expectedHead: t.seed,
        proposals: [p.value, q.value],
        result,
      };
      const merged = await t.dev.merge(request, t.storage);
      expect(merged).toEqual({
        head: result,
        revision: 1,
        verification: 'unverified',
      });
      const cold = createAssistantRuntime({
        database: t.db,
        authorize: async () => {},
      }).development;
      expect(await cold.merge(request, t.storage)).toEqual(merged);
      expect(
        await cold.initialize({ ...t.base, seed: t.seed }, t.storage),
      ).toEqual({ head: result, revision: 1 });
      expect(
        await t.db`select * from allrice_development_merge_sources where request_id=${request.requestId}`,
      ).toHaveLength(2);
      expect(
        await t.db`select * from allrice_runtime_operations where root_run_id=${t.base.rootRunId}`,
      ).toHaveLength(0);
      await expect(
        t.dev.propose(
          {
            ...t.base,
            runId: b.runId,
            assignmentId: q.claim.assignmentId,
            proposal: q.value,
          },
          t.storage,
        ),
      ).rejects.toThrow('forbidden');
    });
    it('rejects stale-head concurrent merges and requires rebasing an overlapping later proposal', async () => {
      const t = await setup(),
        a = await t.child(),
        b = await t.child();
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A');
      const q = await t.proposal(b.runId, 'src/a.ts', 'old a', 'B', {
        ...t.execution,
        workCopy: { kind: 'local_copy', id: randomUUID() },
      });
      const result = await t.publish(
        t.base.runId,
        composeDevelopmentChangesets(t.seedDoc, [p.document]),
        t.seed,
      );
      const input = {
        ...t.base,
        expectedHead: t.seed,
        proposals: [p.value],
        result,
      };
      const attempts = await Promise.allSettled([
        t.dev.merge({ ...input, requestId: randomUUID() }, t.storage),
        t.dev.merge({ ...input, requestId: randomUUID() }, t.storage),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await expect(
        t.dev.merge(
          {
            ...t.base,
            requestId: randomUUID(),
            expectedHead: result,
            proposals: [q.value],
            result: { artifactId: randomUUID(), digest: result.digest },
          },
          t.storage,
        ),
      ).rejects.toThrow('baseline_conflict');
      await expect(t.assign(b.runId, ['new.ts'], t.execution)).rejects.toThrow(
        'head_conflict',
      );
    });
    it.each([
      'foreign-scope',
      'foreign-child',
      'foreign-owner',
      'sibling',
      'missing-tool',
      'no-hook',
      'production-deny',
      'revoked',
      'old-lease',
      'canceled',
    ] as const)('rejects %s without creating an assignment', async (mode) => {
      const t = await setup(),
        a = await t.child(),
        other = await setup();
      let dev = t.dev;
      const input = {
        ...t.base,
        assignmentId: randomUUID(),
        ownerRunId: a.runId,
        expectedHead: t.seed,
        execution: t.execution,
        paths: ['src/a.ts'],
      };
      if (mode === 'foreign-scope') input.scope = other.base.scope;
      if (mode === 'foreign-child') input.ownerRunId = other.base.runId;
      if (mode === 'foreign-owner') {
        const foreign = await t.publish(
          t.base.runId,
          t.seedDoc,
          undefined,
          other.f.context.actor.id,
        );
        await expect(
          t.dev.initialize({ ...t.base, seed: foreign }, t.storage),
        ).rejects.toThrow();
        return;
      }
      if (mode === 'sibling') input.runId = (await t.child()).runId;
      if (mode === 'missing-tool')
        await t.db`update allrice_assistant_instances set allowed_tools='[]' where run_id=${a.runId}`;
      if (mode === 'no-hook')
        dev = createAssistantRuntime({ database: t.db }).development;
      if (mode === 'production-deny')
        dev = createAssistantRuntime({
          database: t.db,
          authorize: assertAssistantAuthority,
        }).development;
      if (mode === 'revoked') t.f.revoke();
      if (mode === 'old-lease')
        input.worker = { ...input.worker, leaseToken: randomUUID() };
      if (mode === 'canceled')
        await t.f.runtime.cancelChild(t.f.context, {
          runId: t.base.rootRunId,
          childRunId: a.runId,
          requestId: randomUUID(),
        });
      await expect(dev.assign(input)).rejects.toThrow();
      expect(
        await t.db`select * from allrice_development_assignments where root_run_id=${t.base.rootRunId}`,
      ).toHaveLength(0);
    });
    it.each([
      'wrong-path',
      'wrong-baseline',
      'wrong-target',
      'wrong-author',
      'bad-checksum',
      'tampered-bytes',
      'late-canceled',
    ] as const)('rejects %s proposal before registration', async (mode) => {
      const t = await setup(),
        a = await t.child(),
        b = await t.child();
      const claim = await t.assign(a.runId);
      const document = t.doc([
        file(
          mode === 'wrong-path' ? 'src/b.ts' : 'src/a.ts',
          mode === 'wrong-baseline' ? 'invented' : 'old a',
          'new',
        ),
      ]);
      if (mode === 'wrong-target')
        document.execution = { ...t.execution, grantVersion: 2 };
      const p = await t.publish(
        mode === 'wrong-author' ? b.runId : a.runId,
        document,
      );
      if (mode === 'bad-checksum') p.digest = `sha256:${'0'.repeat(64)}`;
      if (mode === 'tampered-bytes') {
        const get = t.storage.get.bind(t.storage);
        vi.spyOn(t.storage, 'get').mockImplementation((object) =>
          object.checksum === p.digest
            ? Promise.resolve(new Blob(['corrupted synthetic object']).stream())
            : get(object),
        );
      }
      if (mode === 'late-canceled')
        await t.f.runtime.cancelChild(t.f.context, {
          runId: t.base.rootRunId,
          childRunId: a.runId,
          requestId: randomUUID(),
        });
      await expect(
        t.dev.propose(
          {
            ...t.base,
            runId: a.runId,
            assignmentId: claim.assignmentId,
            proposal: p,
          },
          t.storage,
        ),
      ).rejects.toThrow();
      vi.restoreAllMocks();
      expect(
        await t.db`select * from allrice_development_proposals where root_run_id=${t.base.rootRunId}`,
      ).toHaveLength(0);
    });
    it.each([
      'not-child-version',
      'edited-result',
      'canceled-source',
      'foreign-source',
      'changed-request',
    ] as const)('does not adopt %s result', async (mode) => {
      const t = await setup(),
        a = await t.child();
      const p = await t.proposal(a.runId, 'src/a.ts', 'old a', 'A');
      const composed = composeDevelopmentChangesets(t.seedDoc, [p.document]);
      if (mode === 'edited-result')
        composed.files[0] = file('src/a.ts', 'old a', 'unexpected');
      const result = await t.publish(
        t.base.runId,
        composed,
        mode === 'not-child-version' ? undefined : t.seed,
      );
      const input = {
        ...t.base,
        requestId: randomUUID(),
        expectedHead: t.seed,
        proposals: [p.value],
        result,
      };
      if (mode === 'canceled-source')
        await t.f.runtime.cancelChild(t.f.context, {
          runId: t.base.rootRunId,
          childRunId: a.runId,
          requestId: randomUUID(),
        });
      if (mode === 'foreign-source') input.proposals = [(await setup()).seed];
      if (mode === 'changed-request') {
        await t.dev.merge(input, t.storage);
        input.result = t.seed;
      }
      await expect(t.dev.merge(input, t.storage)).rejects.toThrow();
      expect(
        await t.db`select * from allrice_development_merges where root_run_id=${t.base.rootRunId}`,
      ).toHaveLength(mode === 'changed-request' ? 1 : 0);
    });
  },
);
