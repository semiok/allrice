/** Owned p25 schema only. Synthetic SQL facts/proofs; no SDK, model or Dev call. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, StorageObject } from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import * as client from '../core/client.ts';
import { assertRuntimeFixtureDatabase } from '../runtime-fixture-database.ts';
import { readArtifactBytes } from '../artifact-review.ts';
import {
  continueNativeQuestion,
  beginNativeTask,
} from '../task-native-wait.ts';
import { acquireConversationRuntime } from './conversation-runtime.ts';
import { nativeRootDigest } from './native-root-origin.ts';
import {
  NativeChatTerminalCutoffPlanSchema,
  NativeChatAbandonedDescendantCutoffPlanSchema,
  nativeTerminalTestPhysicalScope,
} from './native-terminal-test-retirement.ts';
import {
  previewNativeTestChatRetirement as preview,
  applyNativeTestChatRetirement as apply,
  readNativeTestChatRetirement as readback,
  readVerifiedNativeChatRetirements,
} from './native-context-retirement.ts';
import { verifyNativeArtifactReferenceCoverage } from './native-artifact-references.ts';
import {
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
  type DshRuntimeOwnedObservation,
} from '../providers/dsh-runtime-close-observations.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type Plan = ReturnType<typeof NativeChatTerminalCutoffPlanSchema.parse>;
type AbandonedPlan = ReturnType<
  typeof NativeChatAbandonedDescendantCutoffPlanSchema.parse
>;
const artifactId = nativeRootDigest('synthetic implicit legacy executor');
suite(
  'historical terminal test chat cutoff / real isolated SQL, no SDK',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let port: typeof f.db;
    let publicBefore: unknown;
    async function publicFacts() {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      assertRuntimeFixtureDatabase(url);
      const sql = postgres(url.toString(), {
        max: 1,
        connect_timeout: 5,
        connection: {
          default_transaction_read_only: true,
          statement_timeout: 5000,
        },
      });
      try {
        const [where] =
          await sql`select current_database() db,current_setting('transaction_read_only') readonly`;
        expect(where!.db).toBe(url.pathname.slice(1));
        expect(where!.readonly).toBe('on');
        const extensions = Array.from(
          await sql`select extname from pg_extension where extname in ('vector','pg_trgm') order by extname`,
        );
        expect(extensions).toEqual([
          { extname: 'pg_trgm' },
          { extname: 'vector' },
        ]);
        const [catalog] = await sql`select
        (select md5(coalesce(string_agg(c.oid::text||':'||c.relname||':'||c.relkind::text,',' order by c.oid),'')) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') classes,
        (select md5(coalesce(string_agg(p.oid::text||':'||p.proname||':'||p.prosrc,',' order by p.oid),'')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') functions`;
        return { extensions, catalog };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      for (const k of Object.keys(process.env))
        if (k.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
          vi.stubEnv(k, undefined);
      vi.stubEnv('ALLRICE_DSH_RETAINED_1_ARTIFACT_ID', artifactId);
      publicBefore = await publicFacts();
      try {
        f = await createAssistantFixtureDatabase({ ownSchemaOnly: true });
      } catch (error) {
        if (error && typeof error === 'object' && 'cleanup' in error)
          console.info(
            'CHAT_CUTOFF_INITIALIZATION_CLEANUP',
            JSON.stringify(error.cleanup),
          );
        throw error;
      }
      port = f.db;
      vi.spyOn(client, 'getDatabase').mockImplementation(() => port);
      const [where] =
        await f.db`select current_database() db,current_schema() schema,current_setting('search_path') path`;
      expect(where!.db).toBe(
        new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
      );
      expect(where!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      expect(where!.path).toBe(where!.schema);
      console.info(
        'CHAT_CUTOFF_FIXTURE_OWNER',
        JSON.stringify({ pid: process.pid, ...where }),
      );
    }, 120000);
    afterAll(async () => {
      try {
        if (f) {
          const proof = await f.close();
          console.info('CHAT_CUTOFF_FIXTURE_CLEANUP', JSON.stringify(proof));
          for (const k of [
            'schemaRemoved',
            'storageRemoved',
            'databaseClosed',
            'adminClosed',
          ] as const)
            expect(proof[k]).toBe(true);
          expect(await publicFacts()).toEqual(publicBefore);
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30000);
    type Pattern =
      | 'started'
      | 'two-started'
      | 'unknown-operation'
      | 'unknown-assistants'
      | 'parked'
      | 'unfinished'
      | 'ready';
    async function subject(pattern: Pattern = 'ready') {
      const x = await createAssistantAuthorityFixture(f.db, {
        configure: false,
      });
      await f.db`update allrice_chat_sessions set created_at=clock_timestamp()-interval '2 days' where id=${x.session}`;
      await f.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy,phase)
      values(${x.rootRunId},${x.org},${x.workspace},'{}','terminal') on conflict do nothing`;
      const terminal =
        pattern === 'unknown-operation' || pattern === 'parked'
          ? 'succeeded'
          : pattern === 'started' ||
              pattern === 'two-started' ||
              pattern === 'unknown-assistants'
            ? 'failed'
            : 'canceled';
      await f.db`update allrice_runs set state=${terminal},completed_at=clock_timestamp() where id=${x.rootRunId}`;
      await f.db`update allrice_jobs set status=${terminal},completed_at=clock_timestamp(),worker_id=null,lease_token=null,claimed_at=null,heartbeat_at=null,lease_expires_at=null where id=${x.worker.jobId}`;
      await f.db`update allrice_employee_runs set status=${terminal},completed_at=clock_timestamp() where run_id=${x.rootRunId}`;
      if (pattern !== 'ready')
        await f.db`delete from allrice_conversation_runtimes where session_id=${x.session}`;
      else {
        await f.db`update allrice_conversation_runtimes set thread_id=${'dsh-' + x.session},active_turn_id=${x.session + ':turn:1'} where session_id=${x.session}`;
        await f.db`insert into allrice_native_question_waits(run_id,question_id,checkpoint,config_checksum,generation,state)
        values(${x.rootRunId},'original-question',${f.db.json({ questionId: 'original-question', questions: [{ id: 'object', question: 'Which original input?', multiSelect: false }], sessionId: 'dsh-' + x.session, turnId: x.session + ':turn:1', sequence: 42 })},${x.snapshot.employee.definitionChecksum},1,'ready')`;
        await f.db`insert into allrice_task_questions values(${x.rootRunId},'original-question',true)`;
      }
      if (['started', 'two-started', 'parked', 'ready'].includes(pattern)) {
        await f.db`insert into allrice_native_task_dispatches values(${x.rootRunId},1,${pattern === 'parked' || pattern === 'ready' ? 'parked' : 'started'},clock_timestamp())`;
        if (pattern === 'two-started')
          await f.db`insert into allrice_native_task_dispatches values(${x.rootRunId},2,'started',clock_timestamp())`;
      }
      if (pattern === 'unknown-assistants') {
        await f.db`insert into allrice_assistant_roots(root_run_id,configuration,worker_job_id,worker_id,worker_lease_digest,generation)
        values(${x.rootRunId},'{}',${x.worker.jobId},${x.worker.workerId},${nativeRootDigest('original lease')},1)`;
        await f.db`insert into allrice_assistant_instances(run_id,root_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status)
        values(${x.rootRunId},${x.rootRunId},${'old-' + x.session},${randomUUID()},${nativeRootDigest('original assistant')},'old unknown',0,'[]',${'old/' + x.session},'unknown')`;
        const child = randomUUID();
        await f.db`insert into allrice_runs select (jsonb_populate_record(null::allrice_runs,to_jsonb(r)||${f.db.json({ id: child })})).* from allrice_runs r where r.id=${x.rootRunId}`;
        await f.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
          values(${child},${x.rootRunId},${x.rootRunId},${x.org},${x.workspace},'{}')`;
        await f.db`insert into allrice_assistant_instances(run_id,root_run_id,parent_run_id,native_session_id,delegation_id,creation_digest,label,depth,allowed_tools,artifact_namespace,status)
          values(${child},${x.rootRunId},${x.rootRunId},${'old-child-' + x.session},${randomUUID()},${nativeRootDigest('original child')},'old unknown child',1,'[]',${'old-child/' + x.session},'unknown')`;
        await f.db`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount)
          values(${randomUUID()},${x.rootRunId},${x.rootRunId},'tool_calls',1)`;
      }
      if (pattern === 'unknown-operation' || pattern === 'unknown-assistants') {
        const target = randomUUID();
        await f.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,capabilities)
        values(${target},${x.org},${x.workspace},${'old-' + target},'cloud_sandbox','synthetic offline target','[]')`;
        for (let i = 0; i < (pattern === 'unknown-assistants' ? 3 : 1); i++)
          await f.db`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot)
        values(${randomUUID()},${x.org},${x.workspace},${x.rootRunId},${x.rootRunId},${target},${randomUUID()},1,0,1,${randomUUID()},'{"status":"unknown"}','{"status":"unknown"}')`;
      }
      if (pattern === 'unfinished' || pattern === 'unknown-assistants')
        await f.db`insert into allrice_task_calls(run_id,native_session_id,call_id,kind,name)
      values(${x.rootRunId},${'dsh-' + x.session},'original-call','tool','original.tool')`;
      return x;
    }
    type Subject = Awaited<ReturnType<typeof subject>>;
    const scope = (x: Subject) => ({
      contextKind: 'chat' as const,
      contextId: x.session,
      organizationId: x.org,
      workspaceId: x.workspace,
      ownerId: x.user,
    });
    const request = (xs: Subject[]) => ({
      schemaVersion: 2 as const,
      kind: 'development-test-chat-terminal-cutoff' as const,
      requestId: randomUUID(),
      authorizationEvidenceDigest: nativeRootDigest(
        'owned synthetic QA authorization',
      ),
      scopes: xs.map(scope),
      legacyExecutors: xs.map((x) => ({
        scope: scope(x),
        artifactId,
        storageNamespace: join(
          f.storageRoot!,
          x.org,
          x.workspace,
          x.user,
          x.session,
          'sessions',
        ),
      })),
    });
    const planFor = async (xs: Subject[]) =>
      NativeChatTerminalCutoffPlanSchema.parse(await preview(request(xs)));
    const facts = async (x: Subject) => {
      const [r] =
        await f.db`select allrice_terminal_native_chat_facts(${x.session},${x.org},${x.workspace},${x.user}) facts`;
      return r!.facts;
    };
    function proof(p: Plan | AbandonedPlan) {
      const physical = nativeTerminalTestPhysicalScope(p);
      return {
        kind: 'terminal-native-physical-absence-v1',
        requestId: p.requestId,
        planDigest: p.digest,
        scopeDigest: physical.digest,
        workerBootId: randomUUID(),
        workerBootStartedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 90000).toISOString(),
        processInventoryDigest: nativeRootDigest('synthetic ps'),
        writerInventoryDigest: nativeRootDigest('synthetic lsof'),
        nativeProcesses: [],
        writers: [],
        artifactRoots: physical.artifactIds.map((id) => ({
          artifactId: id,
          root: f.storageRoot!,
          manifestSha256: 'a'.repeat(64),
        })),
        storageNamespaces: physical.storageNamespaces,
        writerScopes: physical.artifactIds.map((id) => ({
          artifactId: id,
          root: f.storageRoot!,
        })),
        evidencePath: join(f.storageRoot!, 'synthetic-proof.json'),
        evidenceSha256: 'e'.repeat(64),
        sourceSha: 'a'.repeat(40),
        sourceTree: 'b'.repeat(40),
        operatorSha256: 'c'.repeat(64),
        reviewSha256: 'd'.repeat(64),
      };
    }
    const applyPlan = (p: Plan | AbandonedPlan) =>
      apply({ plan: p, physicalProof: proof(p) });
    async function artifact(x: Subject, immutable = true) {
      const id = randomUUID(),
        version = randomUUID(),
        body = 'Original independent output ' + id;
      const object: StorageObject = {
        id,
        organizationId: x.org,
        workspaceId: x.workspace,
        ownerId: x.user,
        key: `organizations/${x.org}/workspaces/${x.workspace}/owners/${x.user}/artifacts/${id}`,
        checksum: 'sha256:' + createHash('sha256').update(body).digest('hex'),
        sizeBytes: Buffer.byteLength(body),
        mediaType: 'text/plain',
        retentionUntil: null,
        deletedAt: null,
        immutable,
      };
      await assistantFixtureStorage(f.db).put(
        object,
        new Blob([body]).stream(),
      );
      await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable)
      values(${id},${x.org},${x.workspace},${x.user},${object.key},'artifacts','text/plain',${object.sizeBytes},${object.checksum},'ready',${immutable})`;
      await f.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format)
      values(${version},${x.org},${x.workspace},${x.user},${id},${randomUUID()},1,${x.session},'original.txt','text')`;
      await f.db`insert into allrice_file_references(organization_id,workspace_id,owner_id,session_id,object_id,file_name)
      values(${x.org},${x.workspace},${x.user},${x.session},${id},'original.txt')`;
      return { object, body };
    }
    const approvals = () => [
      {
        artifactId,
        generation: 'dsh-0.1.5-rc.3-a4c74a9' as const,
        storageRoot: f.storageRoot!,
      },
    ];
    const implicitCount = async () => {
      const c = await verifyNativeArtifactReferenceCoverage(approvals());
      return (
        c.references.find((r) => r.source === 'implicit:legacy-chat')
          ?.records ?? 0
      );
    };
    async function abandonedSubject(
      shape: 'terminal' | 'running' | 'dispatched' | 'prepared' = 'terminal',
    ) {
      const x = await subject('unknown-assistants');
      const [child] =
        await f.db`select run_id,parent_run_id,delegation_id from allrice_assistant_instances where root_run_id=${x.rootRunId} and run_id<>root_run_id`;
      const runId = String(child!.run_id),
        delegationId = String(child!.delegation_id);
      await f.db`update allrice_runs set state=${shape === 'running' || shape === 'dispatched' ? 'running' : 'failed'},completed_at=null,
        input=${f.db.json({ assistant: { rootRunId: x.rootRunId, parentRunId: x.rootRunId, delegationId } })} where id=${runId}`;
      let admissionId: string | null = null;
      if (shape === 'dispatched' || shape === 'prepared') {
        admissionId = randomUUID();
        const target = shape === 'prepared' ? x.rootRunId : runId;
        await f.db`insert into allrice_assistant_model_admissions(call_id,run_id,root_run_id,requested_output_tokens,granted_output_tokens,input_tokens,request_digest,dispatched_at)
          values(${admissionId},${target},${x.rootRunId},3,2,${shape === 'dispatched' ? 1 : null},${shape === 'dispatched' ? nativeRootDigest('original uncertain provider dispatch') : null},${shape === 'dispatched' ? new Date() : null})`;
        await f.db`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount) values(${admissionId},${target},${x.rootRunId},'output_tokens',2)`;
        await f.db`update allrice_runtime_budgets set reserved=reserved+2 where root_run_id=${x.rootRunId} and metric='output_tokens'`;
      }
      return { ...x, childRunId: runId, delegationId, admissionId };
    }
    type AbandonedSubject = Awaited<ReturnType<typeof abandonedSubject>>;
    const abandonedRequest = (xs: AbandonedSubject[]) => ({
      ...request(xs),
      schemaVersion: 3 as const,
      kind: 'development-test-chat-abandoned-descendant-cutoff' as const,
      abandonedScopes: xs.map((x) => ({
        scope: scope(x),
        rootRunIds: [x.rootRunId],
        descendants: [
          {
            runId: x.childRunId,
            rootRunId: x.rootRunId,
            parentRunId: x.rootRunId,
            delegationId: x.delegationId,
          },
        ],
        preservedUnfinishedAdmissionIds: x.admissionId ? [x.admissionId] : [],
      })),
    });
    const abandonedPlanFor = async (xs: AbandonedSubject[]) =>
      NativeChatAbandonedDescendantCutoffPlanSchema.parse(
        await preview(abandonedRequest(xs)),
      );
    const abandonedFacts = async (x: Subject) => {
      const [r] =
        await f.db`select allrice_abandoned_native_chat_facts(${x.session},${x.org},${x.workspace},${x.user}) facts`;
      return r!.facts;
    };
    it('cuts off seven exact QA patterns and preserves original pending/runtime/18unknown, journals, outputs and another scope', async () => {
      const xs = [];
      for (const pattern of [
        'two-started',
        'started',
        'unknown-operation',
        'unknown-assistants',
        'parked',
        'unfinished',
        'ready',
      ] as const)
        xs.push(await subject(pattern));
      const untouched = await subject('ready'),
        other = await facts(untouched),
        outputs = [await artifact(xs[0]!), await artifact(xs[0]!)];
      const journal = join(f.storageRoot!, 'original-v3.jsonl'),
        body =
          '{"question":"ready"}\n{"dispatch":"parked"}\n{"tool":"aborted"}\n';
      await writeFile(journal, body);
      for (let i = 0; i < 18; i++)
        await f.db`insert into allrice_dev_producer_permits(id,epoch,instance_boot_id,role,producer) values(${randomUUID()},0,${randomUUID()},'worker','original_unknown')`;
      const originalPermits =
        await f.db`select to_jsonb(p) row from allrice_dev_producer_permits p order by id`;
      for (const x of xs)
        await expect(
          preview({
            requestId: randomUUID(),
            authorizationEvidenceDigest: nativeRootDigest('old idle'),
            scopes: [scope(x)],
          }),
        ).rejects.toThrow('NATIVE_RETIREMENT_CONTEXT_BUSY');
      const before = await Promise.all(xs.map(facts)),
        count = await implicitCount(),
        p = await planFor(xs);
      expect(await applyPlan(p)).toMatchObject({
        historicalClosure: 'not_reclassified',
      });
      expect(await Promise.all(xs.map(facts))).toEqual(before);
      expect(await facts(untouched)).toEqual(other);
      expect(await implicitCount()).toBe(count - 7);
      expect(
        (await f.db.begin((tx) => readVerifiedNativeChatRetirements(tx)))
          .length,
      ).toBe(7);
      expect(
        await f.db`select to_jsonb(p) row from allrice_dev_producer_permits p order by id`,
      ).toEqual(originalPermits);
      expect(await readFile(journal, 'utf8')).toBe(body);
      for (const output of outputs)
        expect(
          await readArtifactBytes(assistantFixtureStorage(f.db), output.object),
        ).toEqual(Buffer.from(output.body));
      expect(
        (
          await f.db`select state,active_run_id from allrice_conversation_runtimes where session_id=${xs[6]!.session}`
        )[0],
      ).toMatchObject({ state: 'running', active_run_id: xs[6]!.rootRunId });
      expect(
        (
          await f.db`select state from allrice_native_question_waits where run_id=${xs[6]!.rootRunId}`
        )[0]!.state,
      ).toBe('ready');
      expect((await readback(p)).status).toBe('completed');
    }, 30000);
    it('v3 fences exact abandoned descendants while preserving dispatched/prepared holds and all original states', async () => {
      const xs = [];
      for (const shape of [
        'terminal',
        'running',
        'dispatched',
        'dispatched',
        'prepared',
      ] as const)
        xs.push(await abandonedSubject(shape));
      await f.db`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount) values(${randomUUID()},${xs[1]!.childRunId},${xs[1]!.rootRunId},'tool_calls',1)`;
      const outputs = [await artifact(xs[0]!), await artifact(xs[1]!)],
        before = [];
      for (const x of xs) {
        before.push(await abandonedFacts(x));
        await expect(
          preview({
            requestId: randomUUID(),
            authorizationEvidenceDigest: nativeRootDigest('strict-v1'),
            scopes: [scope(x)],
          }),
        ).rejects.toThrow();
        await expect(planFor([x])).rejects.toThrow(
          'NATIVE_CHAT_CUTOFF_RUN_SCOPE_OR_STATE',
        );
      }
      const count = await implicitCount(),
        p = await abandonedPlanFor(xs);
      expect(p.snapshots.flatMap((s) => s.unfinishedAdmissions)).toHaveLength(
        3,
      );
      expect(
        p.snapshots.flatMap((s) => s.abandonment.descendants),
      ).toHaveLength(5);
      expect(await applyPlan(p)).toMatchObject({
        alreadyApplied: false,
        historicalClosure: 'not_reclassified',
      });
      for (let i = 0; i < xs.length; i++)
        expect(await abandonedFacts(xs[i]!)).toEqual(before[i]);
      expect(await implicitCount()).toBe(count - xs.length);
      expect((await readback(p)).status).toBe('completed');
      for (const o of outputs)
        expect(
          await readArtifactBytes(assistantFixtureStorage(f.db), o.object),
        ).toEqual(Buffer.from(o.body));
      await expect(
        f.db`update allrice_runs set state='queued' where id=${xs[1]!.childRunId}`,
      ).rejects.toThrow('NATIVE_CONTEXT_EXECUTION_RETIRED');
      await expect(
        f.db`update allrice_assistant_model_admissions set dispatched_at=clock_timestamp(),input_tokens=1,request_digest=${nativeRootDigest('late replay')} where call_id=${xs[4]!.admissionId}`,
      ).rejects.toThrow('NATIVE_CONTEXT_EXECUTION_RETIRED');
    }, 30000);
    it.each([
      'root-running',
      'root-completion-missing',
      'job-completion-missing',
      'job-queued',
    ] as const)(
      'v3 refuses %s without relaxing the root gate',
      async (reason) => {
        const x = await abandonedSubject();
        if (reason === 'root-running')
          await f.db`update allrice_runs set state='running' where id=${x.rootRunId}`;
        if (reason === 'root-completion-missing')
          await f.db`update allrice_runs set completed_at=null where id=${x.rootRunId}`;
        if (reason === 'job-completion-missing')
          await f.db`update allrice_jobs set completed_at=null where id=${x.worker.jobId}`;
        if (reason === 'job-queued')
          await f.db`update allrice_jobs set status='queued' where id=${x.worker.jobId}`;
        await expect(abandonedPlanFor([x])).rejects.toThrow(
          /NATIVE_CHAT_CUTOFF_(RUN_SCOPE_OR_STATE|LIVE_AUTHORITY)/,
        );
      },
    );
    it('v3 refuses a descendant Job even when its state is terminal', async () => {
      const x = await abandonedSubject(),
        id = randomUUID();
      await f.db`insert into allrice_jobs select (jsonb_populate_record(null::allrice_jobs,to_jsonb(j)||${f.db.json({ id, run_id: x.childRunId, idempotency_key: id })})).* from allrice_jobs j where id=${x.worker.jobId}`;
      await expect(abandonedPlanFor([x])).rejects.toThrow(
        'NATIVE_CHAT_ABANDONED_GRAPH_NOT_PROVEN',
      );
    });
    it.each(['root', 'parent', 'delegation'] as const)(
      'v3 refuses a mismatched child input %s identity',
      async (field) => {
        const x = await abandonedSubject();
        const input = {
          assistant: {
            rootRunId: x.rootRunId,
            parentRunId: x.rootRunId,
            delegationId: x.delegationId,
          },
        };
        if (field === 'root') input.assistant.rootRunId = randomUUID();
        if (field === 'parent') input.assistant.parentRunId = randomUUID();
        if (field === 'delegation') input.assistant.delegationId = randomUUID();
        await f.db`update allrice_runs set input=${f.db.json(input)} where id=${x.childRunId}`;
        await expect(abandonedPlanFor([x])).rejects.toThrow(
          'NATIVE_CHAT_ABANDONED_GRAPH_NOT_PROVEN',
        );
      },
    );
    it('v3 refuses a cyclic parent relation and any unreviewed graph/model identities', async () => {
      const cycle = await abandonedSubject();
      await f.db`update allrice_runtime_run_links set parent_run_id=${cycle.childRunId} where run_id=${cycle.childRunId}`;
      await f.db`update allrice_assistant_instances set parent_run_id=${cycle.childRunId} where run_id=${cycle.childRunId}`;
      await f.db`update allrice_runs set input=${f.db.json({ assistant: { rootRunId: cycle.rootRunId, parentRunId: cycle.childRunId, delegationId: cycle.delegationId } })} where id=${cycle.childRunId}`;
      await expect(abandonedPlanFor([cycle])).rejects.toThrow(
        'NATIVE_CHAT_ABANDONED_GRAPH_NOT_PROVEN',
      );
      const x = await abandonedSubject('prepared'),
        raw = abandonedRequest([x]);
      raw.abandonedScopes[0]!.preservedUnfinishedAdmissionIds = [];
      await expect(preview(raw)).rejects.toThrow(
        'NATIVE_CHAT_ABANDONED_DECLARATION_CHANGED',
      );
      raw.abandonedScopes[0]!.preservedUnfinishedAdmissionIds = [
        x.admissionId!,
      ];
      raw.abandonedScopes[0]!.descendants[0]!.parentRunId = randomUUID();
      await expect(preview(raw)).rejects.toThrow(
        'NATIVE_CHAT_ABANDONED_DECLARATION_CHANGED',
      );
    });
    it('v3 rejects financial drift atomically without releasing or settling the original holds', async () => {
      const x = await abandonedSubject('dispatched'),
        p = await abandonedPlanFor([x]);
      await f.db`update allrice_runtime_budgets set reserved=reserved+1 where root_run_id=${x.rootRunId} and metric='output_tokens'`;
      const before = await abandonedFacts(x);
      await expect(applyPlan(p)).rejects.toThrow('NATIVE_TERMINAL_PLAN_STALE');
      expect((await readback(p)).status).toBe('not-found');
      expect(await abandonedFacts(x)).toEqual(before);
      expect(
        (
          await f.db`select archived_at from allrice_chat_sessions where id=${x.session}`
        )[0]!.archived_at,
      ).toBeNull();
    });
    it.each(['admission', 'usage', 'reservation', 'operation'] as const)(
      'v3 refuses a reverse foreign-root %s without omitting or rewriting it',
      async (kind) => {
        const x = await abandonedSubject(),
          y = await abandonedSubject(),
          id = randomUUID();
        let readRow: () => Promise<unknown>;
        if (kind === 'admission') {
          await f.db`insert into allrice_assistant_model_admissions(call_id,run_id,root_run_id,requested_output_tokens,granted_output_tokens) values(${id},${x.childRunId},${y.rootRunId},3,2)`;
          readRow = async () =>
            Array.from(
              await f.db`select to_jsonb(t)::text value from allrice_assistant_model_admissions t where call_id=${id}`,
            );
        } else if (kind === 'usage') {
          await f.db`insert into allrice_assistant_usage(call_id,run_id,root_run_id,metric,amount) values(${id},${x.childRunId},${y.rootRunId},'tool_calls',1)`;
          readRow = async () =>
            Array.from(
              await f.db`select to_jsonb(t)::text value from allrice_assistant_usage t where call_id=${id}`,
            );
        } else if (kind === 'reservation') {
          const [op] =
            await f.db`select id from allrice_runtime_operations where root_run_id=${x.rootRunId} order by id limit 1`;
          await f.db`insert into allrice_runtime_reservations(operation_id,root_run_id,metric,accounting_id,amount) values(${op!.id},${y.rootRunId},'tool_calls',${id},1)`;
          readRow = async () =>
            Array.from(
              await f.db`select to_jsonb(t)::text value from allrice_runtime_reservations t where accounting_id=${id}`,
            );
        } else {
          const foreign = randomUUID();
          await f.db`insert into allrice_runs select (jsonb_populate_record(null::allrice_runs,to_jsonb(r)||${f.db.json({ id: foreign })})).* from allrice_runs r where id=${x.rootRunId}`;
          await f.db`insert into allrice_runtime_roots select (jsonb_populate_record(null::allrice_runtime_roots,to_jsonb(r)||${f.db.json({ root_run_id: foreign })})).* from allrice_runtime_roots r where root_run_id=${x.rootRunId}`;
          await f.db`insert into allrice_runtime_operations select (jsonb_populate_record(null::allrice_runtime_operations,to_jsonb(o)||${f.db.json({ id, root_run_id: foreign, run_id: x.childRunId, attempt_id: randomUUID(), idempotency_key: randomUUID() })})).* from allrice_runtime_operations o where root_run_id=${x.rootRunId} order by id limit 1`;
          readRow = async () =>
            Array.from(
              await f.db`select to_jsonb(t)::text value from allrice_runtime_operations t where id=${id}`,
            );
        }
        const before = await readRow();
        await expect(abandonedPlanFor([x])).rejects.toThrow(
          'NATIVE_CHAT_ABANDONED_FINANCIAL_SCOPE_CONFLICT',
        );
        expect(await readRow()).toEqual(before);
        expect(
          (
            await f.db`select archived_at from allrice_chat_sessions where id=${x.session}`
          )[0]!.archived_at,
        ).toBeNull();
      },
    );
    it('v3 rejects an active operation lease and expired physical proof', async () => {
      const x = await abandonedSubject('dispatched');
      await f.db`update allrice_runtime_operations set lease_owner=${randomUUID()},lease_token_hash=${nativeRootDigest('live')},lease_expires_at=clock_timestamp()+interval '1 minute' where root_run_id=${x.rootRunId}`;
      await expect(abandonedPlanFor([x])).rejects.toThrow(
        'NATIVE_CHAT_CUTOFF_LIVE_AUTHORITY',
      );
      await f.db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 minute' where root_run_id=${x.rootRunId}`;
      const p = await abandonedPlanFor([x]),
        q = proof(p);
      q.expiresAt = new Date(Date.now() - 1).toISOString();
      await expect(apply({ plan: p, physicalProof: q })).rejects.toThrow(
        'NATIVE_TERMINAL_PHYSICAL_PROOF_CHANGED',
      );
      expect((await readback(p)).status).toBe('not-found');
    });
    it('v3 handles a lost COMMIT acknowledgement only by independent original-request readback', async () => {
      const x = await abandonedSubject('dispatched'),
        p = await abandonedPlanFor([x]),
        before = await abandonedFacts(x);
      let writes = 0;
      port = new Proxy(f.db, {
        get(target, k, receiver) {
          if (k !== 'begin') return Reflect.get(target, k, receiver);
          return async (...args: unknown[]) => {
            writes++;
            await Reflect.apply(target.begin, target, args);
            throw Error('synthetic v3 lost COMMIT ACK');
          };
        },
      }) as typeof f.db;
      try {
        await expect(applyPlan(p)).rejects.toThrow(
          'synthetic v3 lost COMMIT ACK',
        );
      } finally {
        port = f.db;
      }
      expect(writes).toBe(1);
      expect(await readback(p)).toMatchObject({
        status: 'completed',
        historicalClosure: 'not_reclassified',
        financialClosure: 'not_claimed',
      });
      expect(await abandonedFacts(x)).toEqual(before);
    });
    it('v3 fences old RR snapshots of already archived and unarchived chats without changing child state', async () => {
      for (const archived of [false, true]) {
        const x = await abandonedSubject('dispatched');
        if (archived)
          await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${x.session}`;
        const p = await abandonedPlanFor([x]);
        await expect(
          f.db.begin('isolation level repeatable read', async (tx) => {
            await tx`select id from allrice_runs where id=${x.childRunId}`;
            await applyPlan(p);
            await tx`update allrice_runs set state='queued' where id=${x.childRunId}`;
            throw Error('V3_STALE_RR_WRITE_ACCEPTED');
          }),
        ).rejects.toMatchObject({ code: '40001' });
        expect(
          (
            await f.db`select state,completed_at from allrice_runs where id=${x.childRunId}`
          )[0],
        ).toEqual({ state: 'running', completed_at: null });
      }
    });
    it('v3 refuses an unconfirmed registered owner rather than treating historical model facts as physical absence', async () => {
      const x = await abandonedSubject('dispatched'),
        owner: DshRuntimeOwnedObservation = {
          version: 1,
          kind: 'owned',
          runtimeId: randomUUID(),
          workerBootId: randomUUID(),
          workerId: randomUUID(),
          serviceManifestDigest: nativeRootDigest('synthetic worker'),
          artifactId,
          profileId: 'restricted',
          context: { kind: 'context', ...scope(x) },
          observedAt: new Date().toISOString(),
        };
      const reserved = await reserveDshRuntimeOwner(owner);
      await expect(abandonedPlanFor([x])).rejects.toThrow(
        'NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED',
      );
      await recordDshRuntimeCloseObservation(reserved, {
        version: 1,
        kind: 'process_closed',
        runtimeId: owner.runtimeId,
        workerBootId: owner.workerBootId,
        ownerDigest: reserved.ownerDigest,
        observedAt: new Date().toISOString(),
        fact: {
          source: 'never_spawned',
          spawnAttempted: false,
          reason: 'admission_closed_before_spawn',
        },
      });
      expect((await abandonedPlanFor([x])).schemaVersion).toBe(3);
    });
    it('v3 serializes a real pending old dispatch behind cutoff and refuses it after commit', async () => {
      const x = await abandonedSubject('dispatched'),
        p = await abandonedPlanFor([x]);
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (release = r));
      port = new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (
            callback: (tx: postgres.TransactionSql) => Promise<unknown>,
          ) =>
            target.begin(async (tx) => {
              const value = await callback(tx);
              reached();
              await gate;
              return value;
            });
        },
      }) as typeof f.db;
      const cutoff = applyPlan(p);
      try {
        await Promise.race([
          ready,
          cutoff.then(() => {
            throw Error('V3_CUTOFF_DID_NOT_PAUSE');
          }),
        ]);
      } finally {
        port = f.db;
      }
      const tag = 'v3-pending-' + randomUUID();
      const writer = f.db
        .begin(async (tx) => {
          await tx`select set_config('application_name',${tag},true)`;
          await tx`insert into allrice_native_task_dispatches values(${x.childRunId},99,'started',clock_timestamp())`;
        })
        .then(
          () => ({ passed: true, error: null }),
          (error) => ({ passed: false, error }),
        );
      try {
        let witness;
        for (let i = 0; i < 100; i++) {
          const [row] =
            await f.db`select pid,wait_event_type,wait_event from pg_stat_activity where application_name=${tag} and datname=current_database()`;
          if (row?.wait_event_type === 'Lock') {
            witness = row;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(witness).toBeDefined();
        console.info('V3_CUTOFF_PENDING_WRITER', JSON.stringify(witness));
      } finally {
        release();
      }
      await cutoff;
      const observed = await writer;
      expect(observed.passed).toBe(false);
      expect(String(observed.error)).toContain(
        'NATIVE_CONTEXT_EXECUTION_RETIRED',
      );
      expect((await readback(p)).status).toBe('completed');
    });
    it('v3 refuses a real in-flight child writer before cutoff without archiving or changing its request', async () => {
      const x = await abandonedSubject('dispatched'),
        p = await abandonedPlanFor([x]);
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (release = r));
      const writer = f.db.begin(async (tx) => {
        await tx`update allrice_runs set updated_at=clock_timestamp() where id=${x.childRunId}`;
        reached();
        await gate;
      });
      await ready;
      try {
        await expect(applyPlan(p)).rejects.toThrow(
          'NATIVE_TERMINAL_CUTOFF_BUSY',
        );
      } finally {
        release();
        await writer;
      }
      expect((await readback(p)).status).toBe('not-found');
      expect(
        (
          await f.db`select archived_at from allrice_chat_sessions where id=${x.session}`
        )[0]!.archived_at,
      ).toBeNull();
      const fresh = await abandonedPlanFor([x]);
      await applyPlan(fresh);
      expect((await readback(fresh)).status).toBe('completed');
    });
    it('does not admit live Run/Job or a live operation lease', async () => {
      const x = await subject('unknown-operation');
      await f.db`update allrice_runs set state='running',completed_at=null where id=${x.rootRunId}`;
      await expect(planFor([x])).rejects.toThrow(
        'NATIVE_CHAT_CUTOFF_RUN_SCOPE_OR_STATE',
      );
      await f.db`update allrice_runs set state='succeeded',completed_at=clock_timestamp() where id=${x.rootRunId}`;
      await f.db`update allrice_runtime_operations set lease_owner=${randomUUID()},lease_token_hash=${nativeRootDigest('lease')},lease_expires_at=clock_timestamp()+interval '1 minute' where root_run_id=${x.rootRunId}`;
      await expect(planFor([x])).rejects.toThrow(
        'NATIVE_CHAT_CUTOFF_LIVE_AUTHORITY',
      );
      await f.db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 minute' where root_run_id=${x.rootRunId}`;
    });
    it.each(['Run', 'Job'])(
      'rejects a terminal %s with no recorded completion',
      async (kind) => {
        const x = await subject('parked');
        if (kind === 'Run')
          await f.db`update allrice_runs set completed_at=null where id=${x.rootRunId}`;
        else
          await f.db`update allrice_jobs set completed_at=null where id=${x.worker.jobId}`;
        await expect(planFor([x])).rejects.toThrow(
          kind === 'Run'
            ? 'NATIVE_CHAT_CUTOFF_RUN_SCOPE_OR_STATE'
            : 'NATIVE_CHAT_CUTOFF_LIVE_AUTHORITY',
        );
      },
    );
    it('refuses a physically closed registered owner with a different organization, workspace or owner', async () => {
      for (const field of [
        'organizationId',
        'workspaceId',
        'ownerId',
      ] as const) {
        const x = await subject(),
          owner: DshRuntimeOwnedObservation = {
            version: 1,
            kind: 'owned',
            runtimeId: randomUUID(),
            workerBootId: randomUUID(),
            workerId: randomUUID(),
            serviceManifestDigest: nativeRootDigest('synthetic worker'),
            artifactId,
            profileId: 'restricted',
            context: { kind: 'context', ...scope(x), [field]: randomUUID() },
            observedAt: new Date().toISOString(),
          },
          ownerDigest = nativeRootDigest(owner),
          closed = {
            version: 1,
            kind: 'process_closed',
            runtimeId: owner.runtimeId,
            workerBootId: owner.workerBootId,
            ownerDigest,
            observedAt: new Date().toISOString(),
            fact: {
              source: 'never_spawned',
              spawnAttempted: false,
              reason: 'admission_closed_before_spawn',
            },
          };
        // Model an immutable historical row written by an older DB consumer,
        // not an owner reservation that would already reject the wrong scope.
        for (const payload of [owner, closed])
          await f.db`insert into allrice_dsh_runtime_close_observations(runtime_id,worker_boot_id,observation_kind,owner_digest,payload_digest,payload)
            values(${owner.runtimeId},${owner.workerBootId},${payload.kind},${ownerDigest},${nativeRootDigest(payload)},${f.db.json(payload)})`;
        await expect(facts(x)).rejects.toThrow(
          'NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED',
        );
        await expect(planFor([x])).rejects.toThrow(
          'NATIVE_TERMINAL_REGISTERED_OWNER_UNCONFIRMED',
        );
      }
    });
    it('rejects a stale reviewed row atomically without archiving another scope', async () => {
      const a = await subject(),
        b = await subject('unfinished'),
        p = await planFor([a, b]);
      await f.db`update allrice_jobs set last_error_message='late real drift' where id=${b.worker.jobId}`;
      await expect(applyPlan(p)).rejects.toThrow('NATIVE_TERMINAL_PLAN_STALE');
      expect((await readback(p)).status).toBe('not-found');
      expect(
        (
          await f.db`select archived_at from allrice_chat_sessions where id in ${f.db([a.session, b.session])}`
        ).every((r) => r.archived_at === null),
      ).toBe(true);
    });
    it('rejects expired/foreign physical evidence and reads an uncertain committed result without extending proof', async () => {
      const x = await subject(),
        p = await planFor([x]),
        q = proof(p);
      q.expiresAt = new Date(Date.now() - 1).toISOString();
      await expect(apply({ plan: p, physicalProof: q })).rejects.toThrow(
        'NATIVE_TERMINAL_PHYSICAL_PROOF_CHANGED',
      );
      await applyPlan(p);
      expect((await readback(p)).status).toBe('completed');
      expect((await apply({ plan: p, physicalProof: q })).alreadyApplied).toBe(
        true,
      );
      const bad = { ...p, requestId: randomUUID() };
      expect(() => nativeTerminalTestPhysicalScope(bad)).toThrow(
        'NATIVE_TERMINAL_PLAN_CHANGED',
      );
    });
    it('rejects direct old-writer queue, question, dispatch, runtime, clock and root-link mutations', async () => {
      const x = await subject(),
        p = await planFor([x]);
      await applyPlan(p);
      const before = await facts(x);
      const attempts = [
        () =>
          f.db`update allrice_jobs set status='queued',completed_at=null where id=${x.worker.jobId}`,
        () =>
          f.db`update allrice_runs set state='queued',completed_at=null where id=${x.rootRunId}`,
        () =>
          f.db`update allrice_native_question_waits set state='continued',continued_at=clock_timestamp() where run_id=${x.rootRunId}`,
        () =>
          f.db`update allrice_native_task_dispatches set state='completed' where run_id=${x.rootRunId}`,
        () =>
          f.db`delete from allrice_native_question_waits where run_id=${x.rootRunId}`,
        () =>
          f.db`update allrice_conversation_runtimes set worker_id=${randomUUID()} where session_id=${x.session}`,
        () =>
          f.db`update allrice_task_clocks set changed_at=clock_timestamp() where run_id=${x.rootRunId}`,
        () =>
          f.db`delete from allrice_runtime_run_links where run_id=${x.rootRunId}`,
        () =>
          f.db`insert into allrice_task_calls(run_id,native_session_id,call_id,kind) values(${x.rootRunId},'late','late','tool')`,
      ];
      for (const attempt of attempts)
        await expect(attempt()).rejects.toThrow(
          'NATIVE_CONTEXT_EXECUTION_RETIRED',
        );
      await expect(
        f.db`delete from allrice_employee_runs where run_id=${x.rootRunId}`,
      ).rejects.toThrow('employee run evidence is append-only');
      await expect(
        f.db`update allrice_employee_runs set session_id=${randomUUID()} where run_id=${x.rootRunId}`,
      ).rejects.toThrow('employee run execution snapshots are immutable');
      await expect(
        acquireConversationRuntime({
          organizationId: x.org,
          workspaceId: x.workspace,
          sessionId: x.session,
          ownerId: x.user,
          runId: x.rootRunId,
          workerId: x.worker.workerId,
          configChecksum: nativeRootDigest('same'),
          compactThresholdTokens: 12000,
        }),
      ).rejects.toThrow('NATIVE_CONTEXT_EXECUTION_RETIRED');
      const owner = {
        context: {
          runId: x.rootRunId,
          organizationId: x.org,
          workspaceId: x.workspace,
          delegatedBy: { id: x.user },
          policySnapshot: { id: x.policy },
        } as ExecutionContext,
        worker: x.worker,
      };
      await expect(
        continueNativeQuestion({ ...owner, questionId: 'original-question' }),
      ).rejects.toThrow('NATIVE_CONTEXT_EXECUTION_RETIRED');
      await expect(beginNativeTask({ ...owner, attempt: 2 })).rejects.toThrow(
        'NATIVE_CONTEXT_EXECUTION_RETIRED',
      );
      expect(await facts(x)).toEqual(before);
    });
    it('serializes a genuine in-flight writer with the exclusive cutoff and refuses new scoped work', async () => {
      const x = await subject(),
        employee = (
          await f.db`select user_message_id,assistant_message_id from allrice_employee_runs where run_id=${x.rootRunId}`
        )[0]!;
      await f.db`insert into allrice_conversation_followups(run_id,organization_id,workspace_id,session_id,owner_id,user_message_id,assistant_message_id,client_user_message_id,mode,state)
        values(${x.rootRunId},${x.org},${x.workspace},${x.session},${x.user},${employee.user_message_id},${employee.assistant_message_id},${randomUUID()},'follow_up','canceled')`;
      const p = await planFor([x]);
      let acquired!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (acquired = r)),
        gate = new Promise<void>((r) => (release = r));
      const writer = f.db.begin(async (tx) => {
        await tx`update allrice_jobs set last_error_message='writer holds lease identity row' where id=${x.worker.jobId}`;
        acquired();
        await gate;
      });
      await ready;
      try {
        await expect(applyPlan(p)).rejects.toThrow(
          'NATIVE_TERMINAL_CUTOFF_BUSY',
        );
      } finally {
        release();
        await writer;
      }
      const fresh = await planFor([x]);
      await applyPlan(fresh);
      await expect(f.db`insert into allrice_conversation_commands(id,session_id,organization_id,workspace_id,owner_id,followup_run_id,command_type,client_user_message_id,message,expected_generation,expected_turn_id)
      values(${randomUUID()},${x.session},${x.org},${x.workspace},${x.user},${x.rootRunId},'steer',${randomUUID()},'late',1,'old-turn')`).rejects.toThrow(
        'NATIVE_CONTEXT_EXECUTION_RETIRED',
      );
    });
    it('fails independent scanner verification if an independent output changes, with rollback preserving the original', async () => {
      const x = await subject(),
        output = await artifact(x, false),
        p = await planFor([x]);
      await applyPlan(p);
      await expect(
        f.db.begin(async (tx) => {
          await tx`update allrice_storage_objects set state='deleted',deleted_at=clock_timestamp() where id=${output.object.id}`;
          await readVerifiedNativeChatRetirements(tx);
        }),
      ).rejects.toThrow('NATIVE_TERMINAL_PRESERVED_FACTS_CHANGED');
      expect(
        await readArtifactBytes(assistantFixtureStorage(f.db), output.object),
      ).toEqual(Buffer.from(output.body));
      expect((await readback(p)).status).toBe('completed');
    });
    it('blocks a real old writer waiting behind an uncommitted cutoff, then rejects it after commit', async () => {
      const x = await subject(),
        p = await planFor([x]);
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (release = r));
      port = new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (
            callback: (tx: postgres.TransactionSql) => Promise<unknown>,
          ) =>
            target.begin(async (tx) => {
              const result = await callback(tx);
              reached();
              await gate;
              return result;
            });
        },
      }) as typeof f.db;
      const cutoff = applyPlan(p);
      try {
        await Promise.race([
          ready,
          cutoff.then(() => {
            throw Error('cutoff did not pause');
          }),
        ]);
      } finally {
        port = f.db;
      }
      const tag = 'cutoff-waiting-' + randomUUID();
      const writer = f.db.begin(async (tx) => {
        await tx`select set_config('application_name',${tag},true)`;
        await tx`update allrice_jobs set status='queued',completed_at=null where id=${x.worker.jobId}`;
      });
      // Attach immediately, retain the original error and require a real PG
      // lock witness before releasing the cutoff. No timing-only race test.
      const observed = writer.then(
        () => ({ passed: true, error: null }),
        (error) => ({ passed: false, error }),
      );
      try {
        let witness;
        for (let i = 0; i < 100; i++) {
          const [row] =
            await f.db`select pid,wait_event_type,wait_event from pg_stat_activity where application_name=${tag} and datname=current_database()`;
          if (row?.wait_event_type === 'Lock') {
            witness = row;
            break;
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(witness).toBeDefined();
        console.info('CHAT_CUTOFF_PENDING_WRITER', JSON.stringify(witness));
      } finally {
        release();
      }
      await cutoff;
      const result = await observed;
      expect(result.passed).toBe(false);
      expect(String(result.error)).toContain(
        'NATIVE_CONTEXT_EXECUTION_RETIRED',
      );
      expect((await readback(p)).status).toBe('completed');
      expect(
        (
          await f.db`select status from allrice_jobs where id=${x.worker.jobId}`
        )[0]!.status,
      ).toBe('canceled');
    });
    it('refuses an old REPEATABLE READ snapshot after cutoff, including already archived chats', async () => {
      for (const archived of [false, true])
        for (const target of ['Run', 'Job', 'wait'] as const) {
          const x = await subject();
          if (archived)
            await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${x.session}`;
          const p = await planFor([x]);
          await expect(
            f.db.begin('isolation level repeatable read', async (tx) => {
              await tx`select id from allrice_runs where id=${x.rootRunId}`;
              await applyPlan(p);
              if (target === 'Run')
                await tx`update allrice_runs set state='queued',completed_at=null where id=${x.rootRunId}`;
              else if (target === 'Job')
                await tx`update allrice_jobs set status='queued',completed_at=null where id=${x.worker.jobId}`;
              else
                await tx`insert into allrice_native_task_dispatches values(${x.rootRunId},99,'started',clock_timestamp())`;
              throw Error('STALE_RR_WRITE_WAS_ACCEPTED');
            }),
          ).rejects.toMatchObject({ code: '40001' });
          expect((await readback(p)).status).toBe('completed');
        }
    });
    it('fails closed without waiting when an old writer holds the chat source row', async () => {
      const x = await subject();
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (release = r));
      const sourceWriter = f.db.begin(async (tx) => {
        await tx`select id from allrice_chat_sessions where id=${x.session} for update`;
        reached();
        await gate;
      });
      await ready;
      try {
        await expect(
          f.db.begin('isolation level repeatable read', async (tx) => {
            await tx`update allrice_runs set state='queued',completed_at=null where id=${x.rootRunId}`;
          }),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        release();
        await sourceWriter;
      }
      expect(
        (await f.db`select state from allrice_runs where id=${x.rootRunId}`)[0]!
          .state,
      ).toBe('canceled');
    });
    it('preserves ordinary READ COMMITTED Job writes while an unretired chat title row is locked', async () => {
      const x = await subject();
      let reached!: () => void, release!: () => void;
      const ready = new Promise<void>((r) => (reached = r)),
        gate = new Promise<void>((r) => (release = r));
      const titleWriter = f.db.begin(async (tx) => {
        await tx`select id from allrice_chat_sessions where id=${x.session} for update`;
        reached();
        await gate;
      });
      await ready;
      try {
        await f.db`update allrice_jobs set last_error_message='ordinary committed heartbeat information' where id=${x.worker.jobId}`;
      } finally {
        release();
        await titleWriter;
      }
      expect(
        (
          await f.db`select last_error_message from allrice_jobs where id=${x.worker.jobId}`
        )[0]!.last_error_message,
      ).toBe('ordinary committed heartbeat information');
    });
  },
);
