/** Explicit 3.x gateway migration fixture with real PostgreSQL business
 * services. No model/VM is started; this does not certify a 4.0 carrier. */
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ExecutionContextSchema,
  ReferenceReadsSchema,
  RunMemoryContextV2StateSchema,
  renderMemoryDetailV2,
  type RequestContext,
  type StoragePort,
} from '@allrice/contracts';
import * as database from '../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../packages/database/src/runtime.fixture.ts';
import { referenceToolFixture } from '../../../packages/database/src/reference-tool.fixture.ts';
import { createRunAuthorityFixture } from '../../../packages/database/src/run-authority.fixture.ts';
import { ensureGeneralEmployeeInstance } from '../../../packages/database/src/employees/employee-instances.ts';
import { freezeEmployeeMemoryIndexV2 } from '../../../packages/database/src/employees/employee-documents.ts';
import { changeReferencePublication } from '../../../packages/database/src/reference-library.ts';
import { readWorkbenchFile } from '../../../packages/database/src/workbench-files.ts';
import {
  authenticateSession,
  createSession,
} from '../../../packages/database/src/identity.ts';
import { releaseConversationRuntime } from '../../../packages/database/src/conversation/conversation-runtime.ts';
import { cancelRun } from '../../../packages/database/src/execution/queue.ts';
import {
  createLegacyAllriceMcpServices,
  prepareInlineMcpDeliverable,
  type LegacyMcpCallAuthority,
} from '../src/mcp/allrice-legacy-services.js';
import {
  createAllriceMcpServer,
  type AllriceMcpScope,
} from '../src/mcp/allrice-server.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const hash = (bytes: string | Uint8Array) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function text(result: Awaited<ReturnType<Client['callTool']>>) {
  return (result.content as { type: string; text: string }[])
    .map((block) => block.text)
    .join('\n');
}
function storageWithPut(storage: StoragePort, put: StoragePort['put']) {
  return {
    get: storage.get.bind(storage),
    delete: storage.delete.bind(storage),
    exists: storage.exists.bind(storage),
    put,
  };
}
suite(
  'AllRice SDK MCP → public M1 owner subsets → real legacy business carriers',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let references: Awaited<ReturnType<typeof referenceToolFixture>>;
    const connections: (() => Promise<void>)[] = [];
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(database, 'getDatabase').mockReturnValue(f.db);
      references = await referenceToolFixture(f);
    }, 120000);
    afterEach(async () => {
      for (const close of connections.splice(0).reverse()) await close();
      // Existing fixture-only cleanup. No native process or shared Dev is used.
      const running =
        await f.db`select organization_id,workspace_id,session_id,active_run_id,worker_id
      from allrice_conversation_runtimes where state='running'`;
      for (const row of running)
        await releaseConversationRuntime({
          organizationId: row.organization_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          runId: row.active_run_id,
          workerId: row.worker_id,
          outcome: 'idle',
        });
      await f.db`update allrice_jobs set status='canceled',completed_at=clock_timestamp() where status='running'`;
      await f.db`update allrice_runs set state='canceled',completed_at=clock_timestamp() where state='running'`;
      await f.db`update allrice_employee_runs set status='canceled',completed_at=clock_timestamp() where status='running'`;
    }, 30000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);

    async function connect(
      context: RequestContext,
      authority: LegacyMcpCallAuthority,
      storage: StoragePort = runtimeFixtureStorage(f.db),
      onSignal?: (signal: AbortSignal) => void,
      prepareDelivery?: Parameters<
        typeof createLegacyAllriceMcpServices
      >[0]['prepareDelivery'],
    ) {
      const scope: AllriceMcpScope = {
        personId: context.actor.id,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        employeeInstanceId: authority.employeeInstanceId,
        allriceThreadRef: authority.sessionId,
        nativeSessionRef: authority.nativeSessionRef,
        executionGeneration: '3.x',
        requestContext: context,
        enabledModules: [
          'enterprise-materials',
          'employee-memory',
          'deliverables',
        ],
        moduleConfigRevisionRef: 'explicit-migration-fixture-only',
        nativeCallRef: authority.nativeCallRef,
      };
      let resolved = authority;
      const services = createLegacyAllriceMcpServices({
        storage,
        prepareDelivery,
        resolveExecution: async (_scope, signal) => {
          onSignal?.(signal);
          return resolved;
        },
      });
      const controller = createAllriceMcpServer({
        host: { binding: structuredClone(scope), current: async () => scope },
        services,
      });
      const client = new Client({
        name: 'explicit-legacy-gateway-fixture',
        version: '1',
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await controller.server.connect(serverTransport);
      await client.connect(clientTransport);
      connections.push(async () => {
        await controller.close();
        await client.close();
      });
      return {
        client,
        controller,
        scope,
        replaceAuthority(value: LegacyMcpCallAuthority) {
          resolved = value;
        },
      };
    }
    async function referenceAuthority(
      run: Awaited<ReturnType<typeof references.run>>,
    ) {
      const [session] =
        await f.db`select coalesce(employee_instance_id,employee_assignment_id) instance_id
      from allrice_chat_sessions where id=${run.scope.sessionId}`;
      return {
        executionGeneration: '3.x' as const,
        context: run.execution.context,
        sessionId: run.scope.sessionId,
        employeeInstanceId: session!.instance_id as string,
        nativeSessionRef: {
          instanceId: 'migration-fixture',
          profileId: session!.instance_id as string,
          sessionId: run.scope.sessionId,
        },
        nativeCallRef: randomUUID(),
        contentGenerationId: run.runtime.generationId,
        worker: { ...run.worker, attempt: run.execution.job.attempt },
      };
    }
    const receipts = async (runId: string) =>
      ReferenceReadsSchema.parse(
        (
          await f.db`select reference_reads from allrice_employee_runs where run_id=${runId}`
        )[0]!.reference_reads ?? [],
      );

    it('“读差旅上限并列出处” returns real bytes, exact manifest/file pins and the committed receipt identity', async () => {
      const body = '差旅上限九百元。';
      const saved = await references.publish(body);
      const run = await references.run();
      const { client } = await connect(
        references.context,
        await referenceAuthority(run),
      );
      const result = await client.callTool({
        name: 'reference_read',
        arguments: saved.pin,
      });
      expect(result.isError).not.toBe(true);
      const page = JSON.parse(text(result));
      expect(page).toMatchObject({
        content: body,
        sourceId: saved.sourceId,
        revisionId: saved.revisionId,
        digest: saved.pin.digest,
        checksum: saved.pin.checksum,
      });
      const reads = await receipts(run.scope.runId);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({
        receiptId: page.citation.id,
        runId: run.scope.runId,
        generationId: run.runtime.generationId,
        jobId: run.worker.jobId,
        workerId: run.worker.workerId,
        contentChecksum: hash(body),
        citation: {
          reference: saved.pin,
          locator: { start: 0, end: body.length },
        },
      });
      await client.callTool({ name: 'reference_read', arguments: saved.pin });
      expect(await receipts(run.scope.runId)).toEqual(reads);
    }, 120000);

    it('keeps real private-source, changed-pin and revoked-membership refusals as module errors', async () => {
      const saved = await references.publish('可见差旅规则。');
      const privateSource = await references.publish('发布者私有资料。', {
        audience: { scope: 'personal', departmentIds: [] },
      });
      const run = await references.run();
      const { client } = await connect(
        references.context,
        await referenceAuthority(run),
      );
      for (const pin of [
        privateSource.pin,
        { ...saved.pin, digest: hash('wrong manifest') },
        { ...saved.pin, checksum: hash('wrong bytes') },
      ]) {
        const result = await client.callTool({
          name: 'reference_read',
          arguments: pin,
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(text(result)).code).toBe('REFERENCE_UNAVAILABLE');
      }
      expect(await receipts(run.scope.runId)).toEqual([]);
      await client.callTool({ name: 'reference_read', arguments: saved.pin });
      const before = await receipts(run.scope.runId);
      await changeReferencePublication(references.publisher, saved.sourceId, {
        workspaceId: references.publisher.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'delete',
      });
      expect(
        (
          await client.callTool({
            name: 'reference_read',
            arguments: saved.pin,
          })
        ).isError,
      ).toBe(true);
      expect(await receipts(run.scope.runId)).toEqual(before);
      await f.db`update allrice_memberships set active=false where organization_id=${run.scope.organizationId} and user_id=${run.scope.ownerId}`;
      expect(
        (
          await client.callTool({
            name: 'reference_read',
            arguments: saved.pin,
          })
        ).isError,
      ).toBe(true);
      // Restore only fixture identity for later independent cases.
      await f.db`update allrice_memberships set active=true where organization_id=${run.scope.organizationId} and user_id=${run.scope.ownerId}`;
    }, 120000);

    async function memoryDeliveryFixture() {
      const pair = {
        summary: '日报先给风险和下一步',
        details: '只用于当前员工的日报。',
      };
      let projection!: Awaited<ReturnType<typeof freezeEmployeeMemoryIndexV2>>;
      let memoryId!: string;
      const x = await createRunAuthorityFixture(f.db, {
        memberRole: 'member',
        toolNames: ['workspace.memory.read', 'workspace.export.create'],
        allowedTools: ['workspace.memory.read', 'workspace.export.create'],
        memoryContextStateV2: () => projection.memoryContextStateV2,
        preparePrompt: async (transaction, who) => {
          const tx = transaction;
          await ensureGeneralEmployeeInstance(tx, who.employeeAssignmentId);
          const [assignment] =
            await tx`select employee_id from allrice_employee_assignments where id=${who.employeeAssignmentId}`;
          memoryId = randomUUID();
          await tx`insert into allrice_memories(id,organization_id,workspace_id,owner_id,instance_id,employee_id,
          content,summary,details,visibility,source_type,lifecycle_state,trust_level)
          values(${memoryId},${who.organizationId},${who.workspaceId},${who.userId},${who.employeeAssignmentId},${assignment!.employee_id},
          ${pair.summary},${pair.summary},${pair.details},'private','user','durable','user_confirmed')`;
          await tx`insert into allrice_memory_revisions(organization_id,workspace_id,memory_id,revision,content,summary,details,
          trust_level,lifecycle_state,memory_class,confidence,reason,changed_by)
          values(${who.organizationId},${who.workspaceId},${memoryId},1,${pair.summary},${pair.summary},${pair.details},
          'user_confirmed','durable','work_note',1,'synthetic confirmed owner fixture',${who.userId})`;
          projection = await freezeEmployeeMemoryIndexV2(
            tx,
            {
              organizationId: who.organizationId,
              workspaceId: who.workspaceId,
              ownerId: who.userId,
              instanceId: who.employeeAssignmentId,
              employeeId: assignment!.employee_id as string,
            },
            {},
          );
          return {
            systemPrompt: 'Synthetic memory fixture',
            conversation: [],
            memories: [],
            employeeDocuments: projection.employeeDocuments,
            userRequest: '按记忆里的格式交付日报。',
          };
        },
      });
      await f.db`update allrice_employee_runs set status='running' where run_id=${x.rootRunId}`;
      const [job] =
        await f.db`select attempt from allrice_jobs where id=${x.worker.jobId}`;
      const [policy] =
        await f.db`select payload,issued_at,expires_at from allrice_policy_snapshots where id=${x.policy}`;
      const context = ExecutionContextSchema.parse({
        executionId: randomUUID(),
        runId: x.rootRunId,
        jobId: x.worker.jobId,
        worker: { type: 'worker', id: x.worker.workerId },
        delegatedBy: { type: 'user', id: x.user },
        organizationId: x.org,
        workspaceId: x.workspace,
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: x.policy,
          organizationId: x.org,
          subjectId: x.user,
          version: 1,
          issuedAt: policy!.issued_at.toISOString(),
          expiresAt: policy!.expires_at.toISOString(),
          ...policy!.payload,
        },
      });
      const requestContext = (await authenticateSession(
        (await createSession(x.user)).token,
        {
          organizationId: x.org,
          workspaceId: x.workspace,
        },
      ))!;
      const authority: LegacyMcpCallAuthority = {
        executionGeneration: '3.x',
        context,
        sessionId: x.session,
        employeeInstanceId: x.assignment,
        nativeSessionRef: {
          instanceId: 'migration-fixture',
          profileId: x.assignment,
          sessionId: x.session,
        },
        nativeCallRef: randomUUID(),
        worker: { ...x.worker, attempt: job!.attempt as number },
      };
      return { ...x, pair, memoryId, projection, authority, requestContext };
    }
    const memoryState = async (runId: string) =>
      RunMemoryContextV2StateSchema.parse(
        (
          await f.db`select memory_context_state from allrice_employee_runs where run_id=${runId}`
        )[0]!.memory_context_state,
      );
    async function publicationEffects(scope: {
      org: string;
      workspace: string;
    }) {
      const [counts] = await f.db`select
        (select count(*)::int from allrice_deliverable_versions where organization_id=${scope.org} and workspace_id=${scope.workspace}) versions,
        (select count(*)::int from allrice_workbench_artifacts where organization_id=${scope.org} and workspace_id=${scope.workspace}) artifacts,
        (select count(*)::int from allrice_storage_objects where organization_id=${scope.org} and workspace_id=${scope.workspace}) objects,
        (select count(*)::int from allrice_audit_events where organization_id=${scope.org} and workspace_id=${scope.workspace} and action='artifact.published') publications`;
      return counts;
    }

    it('reads the actual issued memory ordinal, accounts real bytes and denies withdrawn details', async () => {
      const x = await memoryDeliveryFixture();
      const { client } = await connect(x.requestContext, x.authority);
      const before = await memoryState(x.rootRunId);
      const result = await client.callTool({
        name: 'memory_read',
        arguments: { number: 1 },
      });
      const detail = renderMemoryDetailV2(1, x.pair);
      expect(result.isError).not.toBe(true);
      expect(text(result)).toBe(detail);
      const after = await memoryState(x.rootRunId);
      expect(after.pins).toEqual(before.pins);
      expect(after.toolReads).toBe(before.toolReads + 1);
      expect(after.spentBytes).toBe(
        before.spentBytes + Buffer.byteLength(detail),
      );
      expect(result).not.toHaveProperty('structuredContent');
      await f.db`update allrice_memories set archived_at=clock_timestamp() where id=${x.memoryId}`;
      const denied = await client.callTool({
        name: 'memory_read',
        arguments: { number: 1 },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(text(denied)).code).toBe('MEMORY_CONTEXT_UNAVAILABLE');
      expect(await memoryState(x.rootRunId)).toEqual(after);
    }, 120000);

    it('rejects the actual old memory lease and cross-owner gateway association without new spend', async () => {
      const x = await memoryDeliveryFixture();
      const connected = await connect(x.requestContext, x.authority);
      const before = await memoryState(x.rootRunId);
      connected.replaceAuthority({
        ...x.authority,
        worker: { ...x.authority.worker, leaseToken: randomUUID() },
      });
      const stale = await connected.client.callTool({
        name: 'memory_read',
        arguments: { number: 1 },
      });
      expect(stale.isError).toBe(true);
      expect(JSON.parse(text(stale)).code).toBe('MEMORY_CONTEXT_UNAVAILABLE');
      connected.replaceAuthority({
        ...x.authority,
        context: {
          ...x.authority.context,
          policySnapshot: {
            ...x.authority.context.policySnapshot,
            subjectId: randomUUID(),
          },
        },
      });
      const foreign = await connected.client.callTool({
        name: 'memory_read',
        arguments: { number: 1 },
      });
      expect(foreign.isError).toBe(true);
      expect(JSON.parse(text(foreign)).error.code).toBe('AUTHORIZATION_DENIED');
      for (const change of [
        { employeeInstanceId: randomUUID() },
        { sessionId: randomUUID() },
        { nativeCallRef: randomUUID() },
        {
          nativeSessionRef: {
            ...x.authority.nativeSessionRef,
            instanceId: 'different-instance',
          },
        },
        {
          nativeSessionRef: {
            ...x.authority.nativeSessionRef,
            profileId: 'different-profile',
          },
        },
        {
          nativeSessionRef: {
            ...x.authority.nativeSessionRef,
            sessionId: 'different-session',
          },
        },
        { context: { ...x.authority.context, organizationId: randomUUID() } },
        { context: { ...x.authority.context, workspaceId: randomUUID() } },
      ]) {
        connected.replaceAuthority({ ...x.authority, ...change });
        const mismatch = await connected.client.callTool({
          name: 'memory_read',
          arguments: { number: 1 },
        });
        expect(mismatch.isError).toBe(true);
        expect(JSON.parse(text(mismatch)).error.code).toBe(
          'AUTHORIZATION_DENIED',
        );
      }
      expect(await memoryState(x.rootRunId)).toEqual(before);
    }, 120000);

    it('publishes real generated bytes as an immutable business artifact and replays its actual version receipt', async () => {
      const x = await memoryDeliveryFixture();
      const connected = await connect(x.requestContext, x.authority);
      const { client } = connected;
      const input = {
        fileName: '日报.txt',
        format: 'text',
        content: '风险：无。\n下一步：复核。',
      };
      const first = await client.callTool({
        name: 'deliverable_create',
        arguments: input,
      });
      expect(first.isError).not.toBe(true);
      const published = JSON.parse(text(first));
      const file = await readWorkbenchFile(
        x.requestContext,
        published.objectId,
      );
      const stream = await runtimeFixtureStorage(f.db).get(file.object);
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(Buffer.from(bytes).toString('utf8')).toBe(input.content);
      expect(published.digest).toBe(hash(bytes));
      expect(published.sizeBytes).toBe(bytes.byteLength);
      expect(file.object.immutable).toBe(true);
      const rows =
        await f.db`select version_id,request_id from allrice_workbench_artifacts
      where run_id=${x.rootRunId} and request_id=${x.authority.nativeCallRef}`;
      expect(rows).toEqual([
        {
          version_id: published.artifactId,
          request_id: x.authority.nativeCallRef,
        },
      ]);
      const replay = await client.callTool({
        name: 'deliverable_create',
        arguments: input,
      });
      expect(JSON.parse(text(replay))).toEqual(published);
      const conflict = await client.callTool({
        name: 'deliverable_create',
        arguments: { ...input, content: 'different' },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.parse(text(conflict)).code).toBe('idempotency_conflict');
      expect(
        await f.db`select version_id from allrice_workbench_artifacts where run_id=${x.rootRunId}`,
      ).toHaveLength(1);
      const committed = await publicationEffects(x);
      await f.db`update allrice_jobs set lease_token=${randomUUID()},attempt=attempt+1 where id=${x.worker.jobId}`;
      await cancelRun(x.requestContext, x.workspace, x.rootRunId, {
        reason: 'isolated MCP receipt recovery after commit',
      });
      const recovered = await client.callTool({
        name: 'deliverable_create',
        arguments: input,
      });
      expect(recovered.isError).not.toBe(true);
      expect(JSON.parse(text(recovered))).toEqual(published);
      expect(await publicationEffects(x)).toEqual(committed);
      const changed = await client.callTool({
        name: 'deliverable_create',
        arguments: { ...input, content: 'different after cancellation' },
      });
      expect(changed.isError).toBe(true);
      expect(JSON.parse(text(changed)).code).toBe('idempotency_conflict');
      const newCall = { ...x.authority, nativeCallRef: randomUUID() };
      connected.scope.nativeCallRef = newCall.nativeCallRef;
      connected.replaceAuthority(newCall);
      const late = await client.callTool({
        name: 'deliverable_create',
        arguments: input,
      });
      expect(late.isError).toBe(true);
      expect(JSON.parse(text(late)).code).toBe('run_unavailable');
      connected.scope.nativeCallRef = x.authority.nativeCallRef;
      connected.replaceAuthority(x.authority);
      await f.db`update allrice_memberships set active=false where id=${x.membership}`;
      const revoked = await client.callTool({
        name: 'deliverable_create',
        arguments: input,
      });
      expect(revoked.isError).toBe(true);
      expect(JSON.parse(text(revoked)).code).toBe('identity_denied');
      expect(await publicationEffects(x)).toEqual(committed);
    }, 120000);

    it('rejects same-worker lease rotation, a wrong attempt and malformed captured leases before storage', async () => {
      const x = await memoryDeliveryFixture();
      const base = runtimeFixtureStorage(f.db);
      const put = vi.fn(base.put.bind(base));
      const connected = await connect(
        x.requestContext,
        x.authority,
        storageWithPut(base, put),
      );
      const before = await publicationEffects(x);
      await f.db`update allrice_jobs set lease_token=${randomUUID()} where id=${x.worker.jobId}`;
      const input = { fileName: 'stale', format: 'text', content: 'bytes' };
      const stale = await connected.client.callTool({
        name: 'deliverable_create',
        arguments: input,
      });
      expect(stale.isError).toBe(true);
      expect(JSON.parse(text(stale)).code).toBe('run_unavailable');
      await f.db`update allrice_jobs set lease_token=${x.authority.worker.leaseToken} where id=${x.worker.jobId}`;
      for (const change of [
        { attempt: x.authority.worker.attempt + 1 },
        { attempt: -1 },
        { leaseToken: '' },
        { leaseToken: 'not-a-uuid' },
      ]) {
        connected.replaceAuthority({
          ...x.authority,
          worker: { ...x.authority.worker, ...change },
        });
        const denied = await connected.client.callTool({
          name: 'deliverable_create',
          arguments: input,
        });
        expect(denied.isError).toBe(true);
        expect(JSON.parse(text(denied)).code).toBe('run_unavailable');
      }
      for (const change of [
        { workerId: randomUUID() },
        { jobId: randomUUID() },
      ]) {
        connected.replaceAuthority({
          ...x.authority,
          worker: { ...x.authority.worker, ...change },
        });
        const denied = await connected.client.callTool({
          name: 'deliverable_create',
          arguments: input,
        });
        expect(denied.isError).toBe(true);
        expect(JSON.parse(text(denied)).error.code).toBe(
          'AUTHORIZATION_DENIED',
        );
      }
      expect(put).not.toHaveBeenCalled();
      expect(await publicationEffects(x)).toEqual(before);
    }, 120000);

    it('keeps the originating authority when real generated bytes wait across a lease rotation', async () => {
      const x = await memoryDeliveryFixture();
      const base = runtimeFixtureStorage(f.db);
      const put = vi.fn(base.put.bind(base));
      const preparing = gate(),
        release = gate();
      const connected = await connect(
        x.requestContext,
        x.authority,
        storageWithPut(base, put),
        undefined,
        async (input, _authority, signal) => {
          const prepared = await prepareInlineMcpDeliverable(input, signal);
          preparing.resolve();
          await release.promise;
          return prepared;
        },
      );
      const before = await publicationEffects(x);
      const pending = connected.client.callTool({
        name: 'deliverable_create',
        arguments: {
          fileName: 'waiting',
          format: 'text',
          content: 'real bytes',
        },
      });
      void pending.catch(() => {});
      try {
        await preparing.promise;
        const leaseToken = randomUUID();
        await f.db`update allrice_jobs set lease_token=${leaseToken},attempt=attempt+1 where id=${x.worker.jobId}`;
        connected.replaceAuthority({
          ...x.authority,
          worker: {
            ...x.authority.worker,
            leaseToken,
            attempt: x.authority.worker.attempt + 1,
          },
        });
        release.resolve();
        const denied = await pending;
        expect(denied.isError).toBe(true);
        expect(JSON.parse(text(denied)).code).toBe('run_unavailable');
        expect(put).not.toHaveBeenCalled();
        expect(await publicationEffects(x)).toEqual(before);
      } finally {
        release.resolve();
        await pending;
        await connected.controller.whenIdle();
      }
    }, 120000);

    it('rolls back versions and publication audit when the locked lease expires during real storage IO', async () => {
      const x = await memoryDeliveryFixture();
      const base = runtimeFixtureStorage(f.db);
      const written = gate(),
        release = gate();
      const put = vi.fn(async (...args: Parameters<StoragePort['put']>) => {
        await base.put(...args);
        written.resolve();
        await release.promise;
      });
      const connected = await connect(
        x.requestContext,
        x.authority,
        storageWithPut(base, put),
      );
      const before = await publicationEffects(x);
      await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '5 seconds' where id=${x.worker.jobId}`;
      const pending = connected.client.callTool({
        name: 'deliverable_create',
        arguments: {
          fileName: 'expired',
          format: 'text',
          content: 'real bytes',
        },
      });
      void pending.catch(() => {});
      try {
        await written.promise;
        // Keep the real FOR SHARE locks. Time can expire while they are held;
        // an UPDATE that rotates the lease would correctly wait until commit.
        await f.db`select pg_sleep(greatest(0,extract(epoch from (lease_expires_at-clock_timestamp())))+0.05)
          from allrice_jobs where id=${x.worker.jobId}`;
        release.resolve();
        const denied = await pending;
        expect(denied.isError).toBe(true);
        expect(JSON.parse(text(denied)).code).toBe('run_unavailable');
        expect(put).toHaveBeenCalledTimes(1);
        expect(await publicationEffects(x)).toEqual(before);
        expect(await base.exists(put.mock.calls[0]![0])).toBe(false);
      } finally {
        release.resolve();
        await pending;
        await connected.controller.whenIdle();
      }
    }, 120000);

    it('keeps real publication current-membership refusal and leaves no artifact', async () => {
      const x = await memoryDeliveryFixture();
      const { client } = await connect(x.requestContext, x.authority);
      await f.db`update allrice_memberships set active=false where id=${x.membership}`;
      const denied = await client.callTool({
        name: 'deliverable_create',
        arguments: { fileName: '日报', format: 'text', content: 'bytes' },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(text(denied)).code).toBe('identity_denied');
      expect(
        await f.db`select version_id from allrice_workbench_artifacts where run_id=${x.rootRunId}`,
      ).toHaveLength(0);
    }, 120000);

    it('native cancellation drains real storage/publication and does not misreport or replay a committed version', async () => {
      const x = await memoryDeliveryFixture();
      const base = runtimeFixtureStorage(f.db),
        written = gate(),
        release = gate(),
        cancelled = gate();
      let writes = 0;
      const storage: StoragePort = {
        get: base.get.bind(base),
        delete: base.delete.bind(base),
        exists: base.exists.bind(base),
        put: async (object, stream) => {
          writes++;
          await base.put(object, stream);
          written.resolve();
          await release.promise;
        },
      };
      const connected = await connect(
        x.requestContext,
        x.authority,
        storage,
        (signal) =>
          signal.addEventListener('abort', () => cancelled.resolve(), {
            once: true,
          }),
      );
      const abort = new AbortController();
      const pending = connected.client.callTool(
        {
          name: 'deliverable_create',
          arguments: {
            fileName: '日报',
            format: 'text',
            content: 'stored despite lost acknowledgement',
          },
        },
        undefined,
        { signal: abort.signal },
      );
      const rejection = expect(pending).rejects.toThrow();
      try {
        await written.promise;
        abort.abort();
        await rejection;
        await cancelled.promise;
        let idle = false;
        const waiting = connected.controller.whenIdle().then(() => {
          idle = true;
        });
        await Promise.resolve();
        expect(idle).toBe(false);
        release.resolve();
        await waiting;
        const artifacts =
          await f.db`select version_id from allrice_workbench_artifacts
        where run_id=${x.rootRunId} and request_id=${x.authority.nativeCallRef}`;
        expect(artifacts).toHaveLength(1);
        expect(writes).toBe(1);
      } finally {
        release.resolve();
        abort.abort();
        await rejection;
        await connected.controller.whenIdle();
      }
    }, 120000);
  },
);
