/** Isolated real PostgreSQL authority tests. Policy evidence/artifact IDs are
 * synthetic fixtures, not production approval or proof of journal compatibility.
 * No native code, credentials, model, shared schema or Dev service is used. */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlatformEmployeeRuntimeProfileSchema,
  type EmployeeRuntimePackage,
  type EmployeeRuntimePolicy,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { buildEmployeeRuntimePackage } from '../platform-employees/runtime-package.ts';
import { queuePlatformEmployeeTestRun } from '../employees/platform-employees.ts';
import {
  bindJobNativeSession,
  prepareJobNativeSession,
} from '../execution/queue.ts';
import { selectCheckedFinalDeliveryArtifact } from '../final-delivery-rollout.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { resolveTaskRuntimePolicy } from '../task-runtime-policy.ts';
import { releaseConversationRuntimeTransaction } from './conversation-runtime.ts';
import type {
  NativeSessionDescriptor,
  NativeSessionLeaseInput,
} from './native-session-binding.ts';
import {
  NativeRootOriginV1Schema,
  nativeRootDigest,
  newNativeGeneration,
} from './native-root-origin.ts';
import {
  configuredNativeOriginReaders,
  inspectNativeOriginReaderStates,
} from './native-origin-reader.ts';
import { verifyNativeArtifactReferenceCoverage } from './native-artifact-references.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const source = 'sha256:' + 'b'.repeat(64);
const target = 'sha256:' + 'a'.repeat(64);
const secondSource = 'sha256:' + 'c'.repeat(64);
const secondTarget = 'sha256:' + 'd'.repeat(64);
const thirdSource = 'sha256:' + 'e'.repeat(64);
const sha256 = (bytes: string | Buffer) =>
  'sha256:' + createHash('sha256').update(bytes).digest('hex');

suite(
  'MET195 exact unbound-origin first reader: isolated real PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let runtimePackage: EmployeeRuntimePackage;
    let assistantRuntimePackage: EmployeeRuntimePackage;
    let assistantRuntimePolicy: EmployeeRuntimePolicy;
    let temporary: string | undefined;
    let storageRoot: string;
    let secondStorageRoot: string;
    let thirdStorageRoot: string;
    let policyPath: string;

    // assistantFixture creates a separate NULL-origin, unpinned seed chat.
    // It is not covered by an exact U1 origin-reader approval for f.session.
    const legacySeed = {
      artifactId: 'sha256:' + '0'.repeat(64),
      generation: 'dsh-0.1.5-rc.3-a4c74a9' as const,
      storageRoot: '/synthetic-legacy-seed',
    };
    const clearPolicy = () => {
      for (const key of Object.keys(process.env))
        if (key.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
          vi.stubEnv(key, undefined);
    };

    beforeEach(async () => {
      clearPolicy();
      vi.stubEnv('ALLRICE_DSH_RETAINED_1_ARTIFACT_ID', legacySeed.artifactId);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', target);
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', target);
      vi.stubEnv(
        'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS',
        JSON.stringify([target]),
      );
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const [schema] = await fixture.db`select current_schema() name`;
      expect(schema!.name).toMatch(/^p25_[a-f0-9]{32}$/);
      // macOS /var is a symlink; use the real path required by the actual parser.
      temporary = await realpath(
        await mkdtemp(join(tmpdir(), 'met195-reader-')),
      );
      storageRoot = join(temporary, 'source-data');
      secondStorageRoot = join(temporary, 'second-source-data');
      thirdStorageRoot = join(temporary, 'third-source-data');
      policyPath = join(temporary, 'approved-reader.json');
      await mkdir(storageRoot, { mode: 0o700 });
      await mkdir(secondStorageRoot, { mode: 0o700 });
      await mkdir(thirdStorageRoot, { mode: 0o700 });
      const employee = await createEmployeeAdministrationFixture(fixture.db);
      const assistantDefinition = {
        ...employee.definition,
        capabilities: {
          ...employee.definition.capabilities,
          nativeSkillIds: [],
          toolNames: ['assistant.delegate', 'assistant.report', 'web.fetch'],
        },
      };
      assistantRuntimePackage = buildEmployeeRuntimePackage({
        revision: 1,
        definition: assistantDefinition,
        skills: [],
      });
      assistantRuntimePolicy = {
        ...assistantDefinition.modelPolicy,
        harness: 'dsh',
      };
      const queued = await queuePlatformEmployeeTestRun(employee.employeeId, {
        environment: 'company',
        workspaceId: employee.workspaceId,
        ownerId: employee.ownerId,
        prompt: 'Synthetic package freeze only; no model',
      });
      expect(queued.queued).toBe(true);
      const [row] = await fixture.db`select frozen_runtime_profile
      from allrice_platform_employee_test_runs where id=${queued.testRun!.id}`;
      runtimePackage = PlatformEmployeeRuntimeProfileSchema.parse(
        row!.frozen_runtime_profile,
      ).runtimePackage!;
      expect(runtimePackage.runtimeManifest.distributionGeneration).toBe(
        newNativeGeneration,
      );
    }, 120_000);

    afterEach(async () => {
      try {
        if (fixture) {
          const cleanup = await fixture.close();
          expect(cleanup.schemaRemoved).toBe(true);
          expect(cleanup.storageRemoved).toBe(true);
          expect(cleanup.databaseClosed).toBe(true);
          expect(cleanup.adminClosed).toBe(true);
          console.info(
            'native_origin_reader_pg_cleanup',
            JSON.stringify(cleanup),
          );
        }
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
        temporary = undefined;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30_000);

    async function subject(
      withAssistantAuthority = false,
      original = { artifactId: source, storageRoot },
    ) {
      clearPolicy();
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', original.artifactId);
      const selectedPackage = withAssistantAuthority
        ? assistantRuntimePackage
        : runtimePackage;
      const f = await createAssistantAuthorityFixture(fixture.db, {
        configure: false,
        runtimePackage: selectedPackage,
        ...(withAssistantAuthority
          ? { runtimePolicy: assistantRuntimePolicy }
          : {}),
        businessCreationOrigin: true,
      });
      await fixture.db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
      const [birth] = await fixture.db`select native_root_origin
      from allrice_chat_sessions where id=${f.session}`;
      const origin = NativeRootOriginV1Schema.parse(birth!.native_root_origin);
      expect(origin).toMatchObject({
        artifactId: original.artifactId,
        contextId: f.session,
        rootSeed: f.session,
        frozenIdentity: {
          checksum: selectedPackage.checksum,
          sourceId: f.version,
        },
      });
      expect(configuredNativeOriginReaders()).toEqual([]);
      const [conversation] =
        await fixture.db`select * from allrice_conversation_runtimes
      where session_id=${f.session}`;
      const descriptor = nativeBindingDescriptor({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        contextKey: f.session,
        distributionGeneration: newNativeGeneration,
      });
      descriptor.artifactId = descriptor.artifactManifestDigest =
        original.artifactId;
      descriptor.storageNamespace = join(
        original.storageRoot,
        f.org,
        f.workspace,
        f.user,
        f.session,
        'sessions',
      );
      const input: NativeSessionLeaseInput = {
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        attempt: 1,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: conversation!.config_checksum,
          generation: conversation!.thread_generation,
          expectedThreadId: conversation!.thread_id,
        },
        descriptor,
      };
      return { ...f, origin, input };
    }
    type Subject = Awaited<ReturnType<typeof subject>>;

    async function approve(f: Subject, group: 1 | 2 | 3 = 1) {
      // Independent sources may share an already approved target; a third
      // policy must not require a third executable artifact.
      const readerTarget = group === 2 ? secondTarget : target;
      const readerPath =
        group === 1
          ? policyPath
          : join(temporary!, `approved-reader-${group}.json`);
      const readerStorage =
        group === 3
          ? thirdStorageRoot
          : group === 2
            ? secondStorageRoot
            : storageRoot;
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', readerTarget);
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', readerTarget);
      if (group === 2)
        vi.stubEnv(
          'ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS',
          JSON.stringify([target, secondTarget]),
        );
      const policy = {
        schemaVersion: 1,
        mode: 'unbound_chat_first_writer',
        sourceArtifactId: f.origin.artifactId,
        targetArtifactId: readerTarget,
        generation: newNativeGeneration,
        profileId: 'restricted',
        sessionFormat: 4,
        prerequisites: {
          nodeMajor: Number(process.versions.node.split('.')[0]),
          platform: process.platform,
          arch: process.arch,
          modules: process.versions.modules,
        },
        evidenceDigest: sha256(
          group === 3
            ? 'isolated SQL third-reader regression, not real journal proof'
            : group === 2
              ? 'isolated SQL second-reader regression, not real journal proof'
              : 'isolated SQL regression, not real journal proof',
        ),
        contexts: [
          {
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
            origin: f.origin,
          },
        ],
      };
      const bytes = JSON.stringify(policy);
      await writeFile(readerPath, bytes, { mode: 0o600 });
      const prefix =
        group === 1
          ? 'ALLRICE_DSH_ORIGIN_READER_'
          : `ALLRICE_DSH_ORIGIN_READER_${group}_`;
      vi.stubEnv(prefix + 'APPROVAL_PATH', readerPath);
      vi.stubEnv(prefix + 'APPROVAL_SHA256', sha256(bytes));
      vi.stubEnv(prefix + 'STORAGE_ROOT', readerStorage);
      const entries = configuredNativeOriginReaders();
      expect(entries).toHaveLength(group);
      const approval = entries.find((entry) => entry.contextId === f.session)!;
      expect(approval).toBeDefined();
      expect(approval.originDigest).toBe(nativeRootDigest(f.origin));
      const descriptor: NativeSessionDescriptor = {
        ...f.input.descriptor,
        artifactId: readerTarget,
        artifactManifestDigest: readerTarget,
        storageNamespace: approval.storageNamespace,
        originReaderApprovalDigest: approval.approvalDigest,
      };
      return { approval, input: { ...f.input, descriptor } };
    }

    const preparation = (input: NativeSessionLeaseInput) => ({
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      attempt: input.attempt,
      subject: input.subject,
      nativeSessionId: input.descriptor.nativeSessionId,
      storageContextKey: input.descriptor.storageContextKey,
    });
    const scope = (f: Subject) => ({
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
      sessionId: f.session,
    });
    const targetCoverage = (
      additional: { artifactId: string; storageRoot: string }[] = [],
    ) =>
      verifyNativeArtifactReferenceCoverage([
        legacySeed,
        {
          artifactId: target,
          generation: newNativeGeneration,
          storageRoot: join(temporary!, 'current-data'),
        },
        ...additional.map((entry) => ({
          ...entry,
          generation: newNativeGeneration,
        })),
      ]);
    const pinRows = (
      f: Subject,
    ) => fixture.db`select * from allrice_native_session_bindings
    where context_kind='chat' and context_id=${f.session} order by native_session_id`;

    async function finishSubjectWork(f: Subject) {
      await fixture.db.begin(async (tx) => {
        await tx`update allrice_runs set state='succeeded' where id=${f.rootRunId}`;
        await tx`update allrice_jobs set status='succeeded' where id=${f.worker.jobId}`;
        await tx`update allrice_assistant_instances
          set status='completed',stopped_at=clock_timestamp()
          where root_run_id=${f.rootRunId}`;
        await releaseConversationRuntimeTransaction(tx, {
          organizationId: f.org,
          workspaceId: f.workspace,
          sessionId: f.session,
          runId: f.rootRunId,
          workerId: f.worker.workerId,
          outcome: 'idle',
        });
      });
    }

    it('inspects an idle unadopted archived origin without creating a pin or reviving the context', async () => {
      const f = await subject();
      const { approval } = await approve(f);
      await finishSubjectWork(f);
      await fixture.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.session}`;
      const [before] = await fixture.db`select native_root_origin,archived_at
        from allrice_chat_sessions where id=${f.session}`;
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toEqual([{ approval, adopted: false, nativeSessionIds: [] }]);
      expect(await pinRows(f)).toHaveLength(0);
      const [after] = await fixture.db`select native_root_origin,archived_at
        from allrice_chat_sessions where id=${f.session}`;
      expect(after).toEqual(before);
    }, 30_000);

    it('rejects active conversation ownership and unfinished root or child Runs and Jobs independently at prestop', async () => {
      const f = await subject();
      await approve(f);
      await finishSubjectWork(f);
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);
      await fixture.db`update allrice_conversation_runtimes
        set state='running',active_run_id=${f.rootRunId},worker_id=${f.worker.workerId}
        where session_id=${f.session}`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db.begin((tx) =>
        releaseConversationRuntimeTransaction(tx, {
          organizationId: f.org,
          workspaceId: f.workspace,
          sessionId: f.session,
          runId: f.rootRunId,
          workerId: f.worker.workerId,
          outcome: 'idle',
        }),
      );
      await fixture.db`update allrice_runs set state='waiting_approval' where id=${f.rootRunId}`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_runs set state='succeeded' where id=${f.rootRunId}`;
      await fixture.db`update allrice_jobs set status='retry_wait' where id=${f.worker.jobId}`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_jobs set status='succeeded' where id=${f.worker.jobId}`;

      const childRunId = randomUUID();
      const childJobId = randomUUID();
      await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state)
        values(${childRunId},${f.org},${f.workspace},${f.user},'running')`;
      await fixture.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
        values(${childRunId},${f.rootRunId},${f.rootRunId},${f.org},${f.workspace},
          ${fixture.db.json({ ...f.task, runId: childRunId, parentRunId: f.rootRunId })})`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_runs set state='succeeded' where id=${childRunId}`;
      await fixture.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
        values(${childJobId},${f.org},${f.workspace},${f.user},${childRunId},'queued',${randomUUID()},
          clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}')`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_jobs set status='dead_letter' where id=${childJobId}`;
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);
    }, 30_000);

    it('allows startup inspection of an adopted busy reader while prestop still requires idle', async () => {
      const f = await subject();
      const approved = await approve(f);
      const bound = await bindJobNativeSession(approved.input);
      const before = await pinRows(f);
      const expected = [
        {
          approval: approved.approval,
          adopted: true,
          nativeSessionIds: [approved.input.descriptor.nativeSessionId],
        },
      ];
      expect(await inspectNativeOriginReaderStates()).toEqual(expected);
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: false }),
      ).toEqual(expected);
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      expect(
        (await prepareJobNativeSession(preparation(approved.input))).binding,
      ).toEqual(bound.binding);
      await finishSubjectWork(f);
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toEqual(expected);
      expect(await pinRows(f)).toEqual(before);
    }, 30_000);

    it('rejects approved but nonexistent contexts and a forged origin against actual chat metadata', async () => {
      const f = await subject();
      const missing = randomUUID();
      await approve({
        ...f,
        session: missing,
        origin: { ...f.origin, contextId: missing, rootSeed: missing },
      });
      await expect(inspectNativeOriginReaderStates()).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await approve({
        ...f,
        origin: {
          ...f.origin,
          frozenIdentity: {
            ...f.origin.frozenIdentity,
            checksum: sha256('not the actual frozen employee'),
          },
        },
      });
      await expect(inspectNativeOriginReaderStates()).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await approve(f);
      expect(await inspectNativeOriginReaderStates()).toHaveLength(1);
      expect(await pinRows(f)).toHaveLength(0);
    }, 30_000);

    it('rejects unknown operations, live leases, unfinished model admissions and unadopted messages after Run completion', async () => {
      const f = await subject(true);
      // Configure the real fixture authority/assistant rows; no model call or
      // external operation is dispatched by this SQL-only regression.
      await f.configure();
      await approve(f);
      await finishSubjectWork(f);
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);
      const targetId = randomUUID();
      const operationId = randomUUID();
      await fixture.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
        values(${targetId},${f.org},${f.workspace},${`test.${targetId}`},'cloud_sandbox','Synthetic metadata only','online','["process.execute"]')`;
      await fixture.db`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,
        attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot)
        values(${operationId},${f.org},${f.workspace},${f.rootRunId},${f.rootRunId},${targetId},
          ${randomUUID()},1,1,1,${randomUUID()},'{"status":"unknown"}','{"status":"unknown"}')`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_runtime_operations set snapshot='{"status":"succeeded"}' where id=${operationId}`;
      await fixture.db`update allrice_runtime_operations set lease_owner=${randomUUID()},
        lease_token_hash=${sha256('synthetic operation lease')},lease_expires_at=clock_timestamp()+interval '5 minutes'
        where id=${operationId}`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_runtime_operations set lease_expires_at=clock_timestamp()-interval '1 second'
        where id=${operationId}`;
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);

      const callId = randomUUID();
      await fixture.db`insert into allrice_assistant_model_admissions(call_id,run_id,root_run_id,requested_output_tokens,granted_output_tokens)
        values(${callId},${f.rootRunId},${f.rootRunId},1,1)`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_assistant_model_admissions set dispatched_at=clock_timestamp(),
        input_tokens=1,request_digest=${sha256('synthetic completed admission')},finished_at=clock_timestamp()
        where call_id=${callId}`;
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);

      const inputId = randomUUID();
      await fixture.db`insert into allrice_assistant_messages(input_id,root_run_id,sender_run_id,recipient_run_id,
        content,content_digest,status) values(${inputId},${f.rootRunId},${f.rootRunId},${f.rootRunId},
          'Synthetic metadata message',${sha256('Synthetic metadata message')},'pending')`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_assistant_messages set status='adopted',
        native_message_id=${`synthetic-${inputId}`},durable_seq=1,adopted_seq=1 where input_id=${inputId}`;
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);
    }, 30_000);

    it('keeps unfinished native questions and dispatches busy after the parent Run is terminal', async () => {
      const f = await subject();
      const approved = await approve(f);
      await finishSubjectWork(f);
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);
      const questionId = `synthetic-${randomUUID()}`;
      const chatSubject = f.input.subject;
      if (chatSubject.kind !== 'chat') throw Error('chat_fixture_required');
      await fixture.db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy,phase)
        values(${f.rootRunId},${f.org},${f.workspace},${fixture.db.json({ ...resolveTaskRuntimePolicy([]) })},'terminal')`;
      await fixture.db`insert into allrice_native_question_waits(run_id,question_id,checkpoint,config_checksum,generation,state)
        values(${f.rootRunId},${questionId},${fixture.db.json({
          sessionId: approved.input.descriptor.nativeSessionId,
          questionId,
          turnId: 'synthetic-turn',
          sequence: 1,
          questions: [
            {
              id: 'choice',
              question: 'Synthetic fixture?',
              multiSelect: false,
              options: [{ label: 'Continue' }],
            },
          ],
        })},${chatSubject.configChecksum},${chatSubject.generation},'ready')`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_native_question_waits set state='continued',continued_at=clock_timestamp()
        where run_id=${f.rootRunId} and question_id=${questionId}`;
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);
      await fixture.db`insert into allrice_native_task_dispatches(run_id,attempt,state) values(${f.rootRunId},1,'parked')`;
      await expect(
        inspectNativeOriginReaderStates({ requireIdle: true }),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_CONTEXT_BUSY');
      await fixture.db`update allrice_native_task_dispatches set state='completed' where run_id=${f.rootRunId} and attempt=1`;
      expect(
        await inspectNativeOriginReaderStates({ requireIdle: true }),
      ).toHaveLength(1);
    }, 30_000);

    it('binds the actual first reader, preserves origin/proof, cold-prepares and admits later content generations', async () => {
      const f = await subject();
      expect(await pinRows(f)).toHaveLength(0);
      const approved = await approve(f);
      expect(
        await prepareJobNativeSession(preparation(approved.input)),
      ).toMatchObject({
        binding: null,
        origin: f.origin,
        originReaderAdopted: false,
        requiresRecovery: false,
      });
      const bound = await bindJobNativeSession(approved.input);
      expect(bound.binding).toMatchObject({
        artifactId: target,
        artifactManifestDigest: target,
        originReaderApprovalDigest: approved.approval.approvalDigest,
        storageNamespace: approved.approval.storageNamespace,
        rootOriginDigest: nativeRootDigest(f.origin),
        firstRunId: f.rootRunId,
        firstJobId: f.worker.jobId,
      });
      const first = (await pinRows(f))[0]!;
      expect(first.artifact_id).toBe(target);
      expect(first.origin_reader_approval_digest).toBe(
        approved.approval.approvalDigest,
      );
      const prepared = await prepareJobNativeSession(
        preparation(approved.input),
      );
      expect(prepared.binding).toEqual(bound.binding);
      expect(prepared).toMatchObject({
        origin: f.origin,
        originReaderAdopted: true,
        requiresRecovery: true,
      });
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(f)),
        ),
      ).toBe(target);
      const [implicit] =
        await fixture.db`select count(*)::int n from allrice_chat_sessions c
        where c.organization_id=${f.org} and c.native_root_origin is null and not exists(
          select 1 from allrice_native_session_bindings b where b.context_kind='chat' and b.context_id=c.id)`;
      expect(implicit!.n).toBe(1);
      // A current reader proof must not silently authorize the separate legacy
      // seed. Explicit inventory is required even after f.session first-binds.
      await expect(
        verifyNativeArtifactReferenceCoverage([
          {
            artifactId: target,
            generation: newNativeGeneration,
            storageRoot: join(temporary!, 'current-data'),
          },
        ]),
      ).rejects.toThrow('implicit:legacy-chat');
      const coverage = await targetCoverage();
      expect(coverage.compatibleOrigins).toEqual([
        {
          contextId: f.session,
          sourceArtifactId: source,
          targetArtifactId: target,
          approvalDigest: approved.approval.approvalDigest,
        },
      ]);
      expect(coverage.references).toContainEqual({
        source: 'origin:chat',
        historicalArtifactIds: [source],
        artifactId: source,
        generation: newNativeGeneration,
        profileId: 'restricted',
        records: 1,
        covered: true,
      });
      expect(coverage.references).toContainEqual({
        source: 'binding',
        historicalArtifactIds: [target],
        artifactId: target,
        generation: newNativeGeneration,
        profileId: 'restricted',
        records: 1,
        covered: true,
      });
      await expect(fixture.db`update allrice_native_session_bindings
      set origin_reader_approval_digest=${sha256('forged')} where native_session_id=${first.native_session_id}`).rejects.toThrow(
        'native session binding is immutable',
      );
      await expect(fixture.db`update allrice_native_session_bindings
      set artifact_id=${source},artifact_manifest_digest=${source} where native_session_id=${first.native_session_id}`).rejects.toThrow(
        'native session binding is immutable',
      );
      await expect(
        fixture.db`update allrice_chat_sessions set native_root_origin=null where id=${f.session}`,
      ).rejects.toThrow('native root origin is immutable');

      const [current] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
      const next: NativeSessionLeaseInput = {
        ...approved.input,
        subject: {
          kind: 'chat',
          id: f.session,
          configChecksum: current!.config_checksum,
          generation: current!.thread_generation,
          expectedThreadId: current!.thread_id,
        },
        descriptor: {
          ...approved.input.descriptor,
          nativeSessionId: `dsh-${f.session}-content-${randomUUID()}`,
        },
      };
      expect(await prepareJobNativeSession(preparation(next))).toMatchObject({
        binding: null,
        originReaderAdopted: true,
        requiresRecovery: false,
      });
      const second = await bindJobNativeSession(next);
      expect(second.binding.artifactId).toBe(target);
      expect(second.binding.originReaderApprovalDigest).toBe(
        approved.approval.approvalDigest,
      );
      expect(await pinRows(f)).toHaveLength(2);
      expect(
        (await pinRows(f)).find(
          (row) => row.native_session_id === first.native_session_id,
        ),
      ).toEqual(first);
      expect(
        (
          await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.session}`
        )[0]!.native_root_origin,
      ).toEqual(f.origin);
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(f)),
        ),
      ).toBe(target);
      expect((await targetCoverage()).verified).toBe(true);
    }, 30_000);

    it('rejects missing approval, forged proof/namespace and a mismatched independently approved file digest before binding', async () => {
      const f = await subject();
      const approved = await approve(f);
      const bytes = await readFile(policyPath);
      clearPolicy();
      await expect(bindJobNativeSession(approved.input)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
      await approve(f);
      for (const descriptor of [
        { ...approved.input.descriptor, originReaderApprovalDigest: undefined },
        {
          ...approved.input.descriptor,
          originReaderApprovalDigest: sha256('wrong proof'),
        },
        {
          ...approved.input.descriptor,
          storageNamespace: `/wrong-base/${f.org}/${f.workspace}/${f.user}/${f.session}/sessions`,
        },
      ]) {
        await expect(
          bindJobNativeSession({ ...approved.input, descriptor }),
        ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
        expect(await pinRows(f)).toHaveLength(0);
      }
      vi.stubEnv(
        'ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256',
        sha256('not these bytes'),
      );
      await expect(bindJobNativeSession(approved.input)).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      vi.stubEnv('ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256', sha256(bytes));
      expect(
        (await bindJobNativeSession(approved.input)).binding.artifactId,
      ).toBe(target);
      clearPolicy();
      await expect(
        prepareJobNativeSession(preparation(approved.input)),
      ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
      await expect(targetCoverage()).rejects.toThrow(
        'DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED',
      );
      expect((await pinRows(f))[0]!.origin_reader_approval_digest).toBe(
        approved.approval.approvalDigest,
      );
    }, 30_000);

    it('does not cover another same-source context or a target absent from the verified-code input', async () => {
      const first = await subject();
      const other = await subject();
      const approved = await approve(first);
      const unrelated: NativeSessionLeaseInput = {
        ...other.input,
        descriptor: {
          ...other.input.descriptor,
          artifactId: target,
          artifactManifestDigest: target,
          originReaderApprovalDigest: approved.approval.approvalDigest,
        },
      };
      await expect(bindJobNativeSession(unrelated)).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(
        prepareJobNativeSession(preparation(unrelated)),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(
        fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(other)),
        ),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(targetCoverage()).rejects.toThrow(
        'DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED',
      );
      await expect(
        verifyNativeArtifactReferenceCoverage([
          {
            artifactId: source,
            generation: newNativeGeneration,
            storageRoot,
          },
        ]),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_TARGET_UNVERIFIED');
      expect(await pinRows(first)).toHaveLength(0);
      expect(await pinRows(other)).toHaveLength(0);
      expect(
        (await bindJobNativeSession(approved.input)).binding.artifactId,
      ).toBe(target);
    }, 30_000);

    it('refuses an existing real old-reader pin even when both code IDs are supplied, without changing its source', async () => {
      const f = await subject();
      const original = await bindJobNativeSession(f.input);
      expect(original.binding.artifactId).toBe(source);
      expect(original.binding).not.toHaveProperty('originReaderApprovalDigest');
      const oldRows = await pinRows(f);
      const approved = await approve(f);
      await expect(inspectNativeOriginReaderStates()).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(bindJobNativeSession(approved.input)).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(
        prepareJobNativeSession(preparation(approved.input)),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(
        fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(f)),
        ),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(
        verifyNativeArtifactReferenceCoverage([
          { artifactId: source, generation: newNativeGeneration, storageRoot },
          {
            artifactId: target,
            generation: newNativeGeneration,
            storageRoot: join(temporary!, 'current-data'),
          },
        ]),
      ).rejects.toThrow('DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED');
      expect(await pinRows(f)).toEqual(oldRows);
      expect(
        (
          await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.session}`
        )[0]!.native_root_origin,
      ).toEqual(f.origin);
    }, 30_000);

    it('keeps an adopted original reader unchanged while a second target first-binds and cold-prepares later generations', async () => {
      const first = await subject();
      const next = await subject(false, {
        artifactId: secondSource,
        storageRoot: secondStorageRoot,
      });
      const firstApproved = await approve(first);
      const firstBound = await bindJobNativeSession(firstApproved.input);
      const firstRows = await pinRows(first);
      const firstBytes = await readFile(policyPath);
      const nextApproved = await approve(next, 2);
      expect(configuredNativeOriginReaders()).toEqual([
        firstApproved.approval,
        nextApproved.approval,
      ]);
      expect(await readFile(policyPath)).toEqual(firstBytes);
      expect(process.env.ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256).toBe(
        sha256(firstBytes),
      );
      expect(
        await prepareJobNativeSession(preparation(firstApproved.input)),
      ).toMatchObject({
        binding: firstBound.binding,
        originReaderAdopted: true,
        requiresRecovery: true,
      });
      expect(
        await prepareJobNativeSession(preparation(nextApproved.input)),
      ).toMatchObject({
        binding: null,
        origin: next.origin,
        originReaderAdopted: false,
        requiresRecovery: false,
      });
      const nextBound = await bindJobNativeSession(nextApproved.input);
      expect(nextBound.binding).toMatchObject({
        artifactId: secondTarget,
        artifactManifestDigest: secondTarget,
        storageNamespace: nextApproved.approval.storageNamespace,
        originReaderApprovalDigest: nextApproved.approval.approvalDigest,
        rootOriginDigest: nativeRootDigest(next.origin),
        firstRunId: next.rootRunId,
        firstJobId: next.worker.jobId,
      });
      const nextFirstRow = (await pinRows(next))[0]!;
      expect(
        await prepareJobNativeSession(preparation(nextApproved.input)),
      ).toMatchObject({
        binding: nextBound.binding,
        originReaderAdopted: true,
        requiresRecovery: true,
      });
      const [current] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${next.session}`;
      const later: NativeSessionLeaseInput = {
        ...nextApproved.input,
        subject: {
          kind: 'chat',
          id: next.session,
          configChecksum: current!.config_checksum,
          generation: current!.thread_generation,
          expectedThreadId: current!.thread_id,
        },
        descriptor: {
          ...nextApproved.input.descriptor,
          nativeSessionId: `dsh-${next.session}-content-${randomUUID()}`,
        },
      };
      expect(await prepareJobNativeSession(preparation(later))).toMatchObject({
        binding: null,
        originReaderAdopted: true,
        requiresRecovery: false,
      });
      const laterBound = await bindJobNativeSession(later);
      expect(laterBound.binding).toMatchObject({
        artifactId: secondTarget,
        originReaderApprovalDigest: nextApproved.approval.approvalDigest,
        storageNamespace: nextApproved.approval.storageNamespace,
      });
      expect(
        (await prepareJobNativeSession(preparation(later))).binding,
      ).toEqual(laterBound.binding);
      const nextRows = await pinRows(next);
      expect(nextRows).toHaveLength(2);
      expect(
        nextRows.find(
          (row) => row.native_session_id === nextFirstRow.native_session_id,
        ),
      ).toEqual(nextFirstRow);
      expect(await pinRows(first)).toEqual(firstRows);
      for (const [f, expectedTarget] of [
        [first, target],
        [next, secondTarget],
      ] as const) {
        const [row] =
          await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.session}`;
        expect(row!.native_root_origin).toEqual(f.origin);
        expect(
          await fixture.db.begin((tx) =>
            selectCheckedFinalDeliveryArtifact(tx, scope(f)),
          ),
        ).toBe(expectedTarget);
      }
      const coverage = await targetCoverage([
        {
          artifactId: secondTarget,
          storageRoot: join(temporary!, 'second-current-data'),
        },
      ]);
      expect(coverage.compatibleOrigins).toEqual([
        {
          contextId: first.session,
          sourceArtifactId: source,
          targetArtifactId: target,
          approvalDigest: firstApproved.approval.approvalDigest,
        },
        {
          contextId: next.session,
          sourceArtifactId: secondSource,
          targetArtifactId: secondTarget,
          approvalDigest: nextApproved.approval.approvalDigest,
        },
      ]);
    }, 30_000);

    it('rejects cross-policy scope and proof, unlisted second-source contexts and an unverified second target', async () => {
      const first = await subject();
      const next = await subject(false, {
        artifactId: secondSource,
        storageRoot: secondStorageRoot,
      });
      const unlisted = await subject(false, {
        artifactId: secondSource,
        storageRoot: secondStorageRoot,
      });
      const firstApproved = await approve(first);
      await bindJobNativeSession(firstApproved.input);
      const firstRows = await pinRows(first);
      const nextApproved = await approve(next, 2);
      const crossScope: NativeSessionLeaseInput = {
        ...nextApproved.input,
        workerId: first.input.workerId,
        jobId: first.input.jobId,
        leaseToken: first.input.leaseToken,
        attempt: first.input.attempt,
      };
      await expect(bindJobNativeSession(crossScope)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
      await expect(
        prepareJobNativeSession(preparation(crossScope)),
      ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
      for (const change of [
        { originReaderApprovalDigest: firstApproved.approval.approvalDigest },
        { artifactId: target, artifactManifestDigest: target },
        { storageNamespace: firstApproved.approval.storageNamespace },
      ])
        await expect(
          bindJobNativeSession({
            ...nextApproved.input,
            descriptor: { ...nextApproved.input.descriptor, ...change },
          }),
        ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
      await expect(bindJobNativeSession(unlisted.input)).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(
        prepareJobNativeSession(preparation(unlisted.input)),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(targetCoverage()).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_TARGET_UNVERIFIED',
      );
      await expect(
        targetCoverage([
          {
            artifactId: secondTarget,
            storageRoot: join(temporary!, 'second-current-data'),
          },
          { artifactId: secondSource, storageRoot: secondStorageRoot },
        ]),
      ).rejects.toThrow('DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED');
      expect(await pinRows(first)).toEqual(firstRows);
      expect(await pinRows(next)).toHaveLength(0);
      expect(await pinRows(unlisted)).toHaveLength(0);
      expect(
        (await bindJobNativeSession(nextApproved.input)).binding.artifactId,
      ).toBe(secondTarget);
    }, 30_000);

    it('refuses an existing second-source writer without migrating it or changing the adopted original reader', async () => {
      const first = await subject();
      const written = await subject(false, {
        artifactId: secondSource,
        storageRoot: secondStorageRoot,
      });
      const original = await bindJobNativeSession(written.input);
      expect(original.binding.artifactId).toBe(secondSource);
      expect(original.binding).not.toHaveProperty('originReaderApprovalDigest');
      const writtenRows = await pinRows(written);
      const firstApproved = await approve(first);
      await bindJobNativeSession(firstApproved.input);
      const firstRows = await pinRows(first);
      const approved = await approve(written, 2);
      await expect(inspectNativeOriginReaderStates()).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(bindJobNativeSession(approved.input)).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(
        prepareJobNativeSession(preparation(approved.input)),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(
        targetCoverage([
          {
            artifactId: secondTarget,
            storageRoot: join(temporary!, 'second-current-data'),
          },
          { artifactId: secondSource, storageRoot: secondStorageRoot },
        ]),
      ).rejects.toThrow('DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED');
      expect(await pinRows(written)).toEqual(writtenRows);
      expect(await pinRows(first)).toEqual(firstRows);
      const [row] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${written.session}`;
      expect(row!.native_root_origin).toEqual(written.origin);
      expect(configuredNativeOriginReaders()[0]).toEqual(
        firstApproved.approval,
      );
    }, 30_000);

    it('first-binds a third source to a shared target and preserves all three proofs across later content generations', async () => {
      const first = await subject();
      const second = await subject(false, {
        artifactId: secondSource,
        storageRoot: secondStorageRoot,
      });
      const third = await subject(false, {
        artifactId: thirdSource,
        storageRoot: thirdStorageRoot,
      });
      const firstApproved = await approve(first);
      const firstBound = await bindJobNativeSession(firstApproved.input);
      const secondApproved = await approve(second, 2);
      const secondBound = await bindJobNativeSession(secondApproved.input);
      const firstRows = await pinRows(first);
      const secondRows = await pinRows(second);
      const firstBytes = await readFile(policyPath);
      const secondPath = join(temporary!, 'approved-reader-2.json');
      const secondBytes = await readFile(secondPath);
      const previousApprovals = configuredNativeOriginReaders();
      const approved = await approve(third, 3);
      expect(configuredNativeOriginReaders()).toEqual([
        ...previousApprovals,
        approved.approval,
      ]);
      expect(approved.approval.sourceArtifactId).toBe(thirdSource);
      expect(approved.approval.targetArtifactId).toBe(target);
      expect(approved.approval.storageNamespace).toBe(
        join(
          thirdStorageRoot,
          third.org,
          third.workspace,
          third.user,
          third.session,
          'sessions',
        ),
      );
      expect(
        await prepareJobNativeSession(preparation(approved.input)),
      ).toMatchObject({
        binding: null,
        origin: third.origin,
        originReaderAdopted: false,
        requiresRecovery: false,
      });
      const bound = await bindJobNativeSession(approved.input);
      expect(bound.binding).toMatchObject({
        artifactId: target,
        artifactManifestDigest: target,
        storageNamespace: approved.approval.storageNamespace,
        originReaderApprovalDigest: approved.approval.approvalDigest,
        rootOriginDigest: nativeRootDigest(third.origin),
        firstRunId: third.rootRunId,
        firstJobId: third.worker.jobId,
      });
      const originalThirdRow = (await pinRows(third))[0]!;
      expect(originalThirdRow).toMatchObject({
        artifact_id: target,
        artifact_manifest_digest: target,
        origin_reader_approval_digest: approved.approval.approvalDigest,
        root_origin_digest: nativeRootDigest(third.origin),
      });
      expect(
        await prepareJobNativeSession(preparation(approved.input)),
      ).toMatchObject({
        binding: bound.binding,
        origin: third.origin,
        originReaderAdopted: true,
        requiresRecovery: true,
      });
      const [current] =
        await fixture.db`select * from allrice_conversation_runtimes where session_id=${third.session}`;
      const later: NativeSessionLeaseInput = {
        ...approved.input,
        subject: {
          kind: 'chat',
          id: third.session,
          configChecksum: current!.config_checksum,
          generation: current!.thread_generation,
          expectedThreadId: current!.thread_id,
        },
        descriptor: {
          ...approved.input.descriptor,
          nativeSessionId: `dsh-${third.session}-content-${randomUUID()}`,
        },
      };
      expect(await prepareJobNativeSession(preparation(later))).toMatchObject({
        binding: null,
        originReaderAdopted: true,
        requiresRecovery: false,
      });
      const nextBound = await bindJobNativeSession(later);
      expect(nextBound.binding).toMatchObject({
        artifactId: target,
        originReaderApprovalDigest: approved.approval.approvalDigest,
        storageNamespace: approved.approval.storageNamespace,
      });
      expect(
        (await prepareJobNativeSession(preparation(later))).binding,
      ).toEqual(nextBound.binding);
      const thirdRows = await pinRows(third);
      expect(thirdRows).toHaveLength(2);
      expect(
        thirdRows.find(
          (row) => row.native_session_id === originalThirdRow.native_session_id,
        ),
      ).toEqual(originalThirdRow);
      for (const [f, input, binding, rows] of [
        [first, firstApproved.input, firstBound.binding, firstRows],
        [second, secondApproved.input, secondBound.binding, secondRows],
      ] as const) {
        expect(
          (await prepareJobNativeSession(preparation(input))).binding,
        ).toEqual(binding);
        expect(await pinRows(f)).toEqual(rows);
      }
      expect(await readFile(policyPath)).toEqual(firstBytes);
      expect(await readFile(secondPath)).toEqual(secondBytes);
      expect(process.env.ALLRICE_DSH_ORIGIN_READER_APPROVAL_SHA256).toBe(
        sha256(firstBytes),
      );
      expect(process.env.ALLRICE_DSH_ORIGIN_READER_2_APPROVAL_SHA256).toBe(
        sha256(secondBytes),
      );
      for (const [f, expectedTarget] of [
        [first, target],
        [second, secondTarget],
        [third, target],
      ] as const) {
        const [row] =
          await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.session}`;
        expect(row!.native_root_origin).toEqual(f.origin);
        expect(
          await fixture.db.begin((tx) =>
            selectCheckedFinalDeliveryArtifact(tx, scope(f)),
          ),
        ).toBe(expectedTarget);
      }
      const coverage = await targetCoverage([
        {
          artifactId: secondTarget,
          storageRoot: join(temporary!, 'second-current-data'),
        },
      ]);
      expect(coverage.verified).toBe(true);
      expect(coverage.compatibleOrigins).toEqual(
        [...previousApprovals, approved.approval].map((entry) => ({
          contextId: entry.contextId,
          sourceArtifactId: entry.sourceArtifactId,
          targetArtifactId: entry.targetArtifactId,
          approvalDigest: entry.approvalDigest,
        })),
      );
    }, 30_000);

    it('rejects third-policy foreign scope, cross-policy proofs and an unlisted same-source context', async () => {
      const first = await subject();
      const second = await subject(false, {
        artifactId: secondSource,
        storageRoot: secondStorageRoot,
      });
      const third = await subject(false, {
        artifactId: thirdSource,
        storageRoot: thirdStorageRoot,
      });
      const unlisted = await subject(false, {
        artifactId: thirdSource,
        storageRoot: thirdStorageRoot,
      });
      const firstApproved = await approve(first);
      await bindJobNativeSession(firstApproved.input);
      const secondApproved = await approve(second, 2);
      await bindJobNativeSession(secondApproved.input);
      const firstRows = await pinRows(first);
      const secondRows = await pinRows(second);
      const approved = await approve(third, 3);
      for (const foreign of [first.input, second.input]) {
        const crossScope: NativeSessionLeaseInput = {
          ...approved.input,
          workerId: foreign.workerId,
          jobId: foreign.jobId,
          leaseToken: foreign.leaseToken,
          attempt: foreign.attempt,
        };
        await expect(bindJobNativeSession(crossScope)).rejects.toMatchObject({
          code: 'NATIVE_SESSION_ADMISSION_DENIED',
        });
        await expect(
          prepareJobNativeSession(preparation(crossScope)),
        ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
      }
      for (const change of [
        { originReaderApprovalDigest: firstApproved.approval.approvalDigest },
        { originReaderApprovalDigest: secondApproved.approval.approvalDigest },
        { artifactId: secondTarget, artifactManifestDigest: secondTarget },
        { storageNamespace: firstApproved.approval.storageNamespace },
      ])
        await expect(
          bindJobNativeSession({
            ...approved.input,
            descriptor: { ...approved.input.descriptor, ...change },
          }),
        ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
      const notApproved: NativeSessionLeaseInput = {
        ...unlisted.input,
        descriptor: {
          ...unlisted.input.descriptor,
          artifactId: target,
          artifactManifestDigest: target,
          originReaderApprovalDigest: approved.approval.approvalDigest,
        },
      };
      await expect(bindJobNativeSession(notApproved)).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(
        prepareJobNativeSession(preparation(notApproved)),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(
        fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(unlisted)),
        ),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      expect(await pinRows(third)).toHaveLength(0);
      expect(await pinRows(unlisted)).toHaveLength(0);
      expect(await pinRows(first)).toEqual(firstRows);
      expect(await pinRows(second)).toEqual(secondRows);
      expect(
        (await bindJobNativeSession(approved.input)).binding,
      ).toMatchObject({
        artifactId: target,
        originReaderApprovalDigest: approved.approval.approvalDigest,
      });
    }, 30_000);

    it('refuses a real third-source writer while both previously adopted policy bindings remain unchanged', async () => {
      const first = await subject();
      const second = await subject(false, {
        artifactId: secondSource,
        storageRoot: secondStorageRoot,
      });
      const written = await subject(false, {
        artifactId: thirdSource,
        storageRoot: thirdStorageRoot,
      });
      const original = await bindJobNativeSession(written.input);
      expect(original.binding.artifactId).toBe(thirdSource);
      expect(original.binding).not.toHaveProperty('originReaderApprovalDigest');
      const writtenRows = await pinRows(written);
      const firstApproved = await approve(first);
      await bindJobNativeSession(firstApproved.input);
      const secondApproved = await approve(second, 2);
      await bindJobNativeSession(secondApproved.input);
      const firstRows = await pinRows(first);
      const secondRows = await pinRows(second);
      const oldApprovals = configuredNativeOriginReaders();
      const approved = await approve(written, 3);
      await expect(inspectNativeOriginReaderStates()).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(bindJobNativeSession(approved.input)).rejects.toThrow(
        'DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID',
      );
      await expect(
        prepareJobNativeSession(preparation(approved.input)),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(
        fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, scope(written)),
        ),
      ).rejects.toThrow('DSH_NATIVE_ORIGIN_READER_APPROVAL_INVALID');
      await expect(
        targetCoverage([
          {
            artifactId: secondTarget,
            storageRoot: join(temporary!, 'second-current-data'),
          },
          { artifactId: thirdSource, storageRoot: thirdStorageRoot },
        ]),
      ).rejects.toThrow('DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED');
      expect(await pinRows(written)).toEqual(writtenRows);
      expect(await pinRows(first)).toEqual(firstRows);
      expect(await pinRows(second)).toEqual(secondRows);
      expect(configuredNativeOriginReaders().slice(0, 2)).toEqual(oldApprovals);
      const [row] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${written.session}`;
      expect(row!.native_root_origin).toEqual(written.origin);
    }, 30_000);

    it('re-admits actual Job authority on cold prepare: foreign owner, revoked membership and lost lease are denied', async () => {
      const f = await subject();
      const foreign = await subject();
      const approved = await approve(f);
      const bound = await bindJobNativeSession(approved.input);
      const before = await pinRows(f);
      const crossAccount: NativeSessionLeaseInput = {
        ...approved.input,
        workerId: foreign.input.workerId,
        jobId: foreign.input.jobId,
        leaseToken: foreign.input.leaseToken,
        attempt: foreign.input.attempt,
      };
      await expect(bindJobNativeSession(crossAccount)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
      await expect(
        prepareJobNativeSession(preparation(crossAccount)),
      ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
      await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      await expect(bindJobNativeSession(approved.input)).rejects.toMatchObject({
        code: 'NATIVE_SESSION_ADMISSION_DENIED',
      });
      await expect(
        prepareJobNativeSession(preparation(approved.input)),
      ).rejects.toMatchObject({ code: 'NATIVE_SESSION_ADMISSION_DENIED' });
      await fixture.db`update allrice_memberships set active=true where id=${f.membership}`;
      expect(
        (await prepareJobNativeSession(preparation(approved.input))).binding,
      ).toEqual(bound.binding);
      await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${approved.input.jobId}`;
      await expect(bindJobNativeSession(approved.input)).rejects.toThrow();
      await expect(
        prepareJobNativeSession(preparation(approved.input)),
      ).rejects.toThrow();
      expect(await pinRows(f)).toEqual(before);
      expect(await pinRows(foreign)).toHaveLength(0);
    }, 30_000);
  },
);
