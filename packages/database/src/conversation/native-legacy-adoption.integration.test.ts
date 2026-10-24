/** SQL-only synthetic approval/closure facts. No artifact is installed, no SDK
 * history is read and no native/model process starts. Not a live upgrade permit. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { EmployeeExecutionSnapshotSchema } from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../assistant-authority.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  createAssignedChatSession,
  ensureDefaultEmployee,
  sendChatMessage,
} from '../workspace/service.ts';
import {
  bindJobNativeSession,
  cancelRun,
  claimNextJob,
  failJob,
  prepareJobNativeSession,
  startClaimedJob,
} from '../execution/queue.ts';
import { nativeBindingDescriptor } from '../native-session-binding.fixture.ts';
import { getRunNativeDiagnosticTarget } from '../execution/native-run-diagnostics.ts';
import {
  appendDiagnosticReceipt,
  diagnosticReadOnly,
  snapshotDiagnosticFiles,
} from '../execution/native-run-diagnostics-transition.fixture.ts';
import { acquireConversationRuntime } from './conversation-runtime.ts';
import { selectCheckedFinalDeliveryArtifact } from '../final-delivery-rollout.ts';
import { resolveEmployeeExecution } from '../employees/employeehub.ts';
import {
  nativeRootDigest,
  newNativeGeneration,
} from './current-execution-binding.ts';
import {
  applyReviewedChatExecutorTransition,
  readAppliedChatExecutorTransition,
  readChatExecutorTransition,
} from './native-executor-transition.ts';
import { verifyNativeArtifactReferenceCoverage } from './native-artifact-references.ts';
import {
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
} from '../providers/dsh-runtime-close-observations.ts';
import { applyReviewedLegacyChatAdoption } from './native-legacy-adoption.ts';
import {
  CurrentEmployeeChatOriginSchema,
  validateEmployeeExecutionSource,
} from './current-execution-binding.ts';
import { readChatNativeRootOrigin } from './native-session-binding.ts';
import type { NativeSessionLeaseInput } from './native-session-binding.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const a = 'sha256:' + 'a'.repeat(64),
  b = 'sha256:' + 'b'.repeat(64),
  c = 'sha256:' + 'c'.repeat(64);
const tuple = (artifactId: string) => ({
  artifactId,
  generation: newNativeGeneration,
  profileId: 'restricted' as const,
});
suite(
  'U2 NULL adoption, actual isolated SQL; all byte/SDK receipts SYNTHETIC',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    const pending: { f: Subject; runId: string }[] = [];
    beforeAll(async () => {
      for (const k of Object.keys(process.env))
        if (k.startsWith('ALLRICE_DSH_ORIGIN_READER_'))
          vi.stubEnv(k, undefined);
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', a);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', a);
      vi.stubEnv(
        'ALLRICE_DSH_RETAINED_1_ARTIFACT_ID',
        'sha256:' + 'd'.repeat(64),
      );
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', '[]');
      for (const flag of [
        'ALLRICE_ASSISTANTS_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
      ])
        vi.stubEnv(flag, '1');
      fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(Error('No external calls in U1 SQL'));
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const [s] =
        await fixture.db`select current_schema() schema,current_database() database`;
      expect(s!.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      expect(s!.database).toBe(
        new URL(process.env.ALLRICE_TEST_DATABASE_URL!).pathname.slice(1),
      );
    }, 120000);
    afterEach(async () => {
      for (const { f, runId } of pending.splice(0))
        await cancelRun(f.context, f.workspace, runId, {
          reason: 'Own SQL-only cleanup; no executor started',
        });
    });
    afterAll(async () => {
      const calls = fetchSpy?.mock.calls.length ?? 0;
      try {
        if (fixture) {
          const proof = await fixture.close();
          console.info('u2_adoption_sql_cleanup', JSON.stringify(proof));
          expect(
            proof.schemaRemoved &&
              proof.storageRemoved &&
              proof.databaseClosed &&
              proof.adminClosed,
          ).toBe(true);
        }
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        expect(calls).toBe(0);
      }
    }, 30000);
    const scope = (f: Subject) => ({
      contextKind: 'chat' as const,
      contextId: f.chat,
      organizationId: f.org,
      workspaceId: f.workspace,
      ownerId: f.user,
    });
    async function currentSubject() {
      const f = await createAssistantAuthorityFixture(fixture.db, {
        configure: false,
        memberRole: 'member',
        allowedTools: ['workspace.export.create'],
      });
      const login = await createSession(f.user);
      const context = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
      if (!context) throw Error('fixture login missing');
      await ensureDefaultEmployee(context, f.workspace);
      const [assignment] =
        await fixture.db`select a.id from allrice_employee_assignments a join allrice_employees e on e.id=a.employee_id where a.organization_id=${f.org} and a.workspace_id=${f.workspace} and a.user_id=${f.user} and a.active and e.employee_key='default-assistant'`;
      const chat = (
        await createAssignedChatSession(context, {
          workspaceId: f.workspace,
          employeeAssignmentId: assignment!.id,
          title: 'SYNTHETIC U1; no model',
        })
      ).id;
      return { ...f, context, chat };
    }
    type Subject = Awaited<ReturnType<typeof currentSubject>>;
    async function send(f: Subject) {
      const r = await sendChatMessage(f.context, f.workspace, f.chat, {
        text: 'Synthetic no-model transition chain',
        clientMessageId: randomUUID(),
        deliveryMode: 'follow_up',
        assistantPreference: { mode: 'daily', allowAssistants: false },
      });
      if (!r.run) throw Error('missing run');
      pending.push({ f, runId: r.run.id });
      return r.run.id;
    }
    async function lease(f: Subject, runId: string) {
      const job = await claimNextJob(f.worker.workerId, 120000);
      expect(job).not.toBeNull();
      expect(
        (
          await fixture.db`select run_id from allrice_jobs where id=${job!.id}`
        )[0]!.run_id,
      ).toBe(runId);
      expect(
        await startClaimedJob(f.worker.workerId, job!.id, job!.lease!.token),
      ).not.toBeNull();
      const [r] =
        await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${runId}`;
      const snapshot = EmployeeExecutionSnapshotSchema.parse(
        r!.execution_snapshot,
      );
      const runtime = await acquireConversationRuntime({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        sessionId: f.chat,
        runId,
        workerId: f.worker.workerId,
        configChecksum: snapshot.employee.definitionChecksum,
        compactThresholdTokens: 10000,
      });
      const descriptor = nativeBindingDescriptor({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        contextKey: f.chat,
        distributionGeneration: newNativeGeneration,
      });
      return {
        workerId: f.worker.workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
        subject: {
          kind: 'chat',
          id: f.chat,
          configChecksum: runtime.configChecksum,
          generation: runtime.generation,
          expectedThreadId: runtime.threadId,
        },
        descriptor,
      } satisfies NativeSessionLeaseInput;
    }
    const prepare = (i: NativeSessionLeaseInput) => {
      const { descriptor, ...rest } = i;
      return prepareJobNativeSession({
        ...rest,
        nativeSessionId: descriptor.nativeSessionId,
        storageContextKey: descriptor.storageContextKey,
      });
    };
    async function confirmedClose(f: Subject) {
      const owned = await reserveDshRuntimeOwner({
        version: 1,
        kind: 'owned',
        runtimeId: randomUUID(),
        workerBootId: randomUUID(),
        workerId: f.worker.workerId,
        serviceManifestDigest: a,
        artifactId: b,
        profileId: 'restricted',
        context: { kind: 'context', ...scope(f) },
        observedAt: new Date().toISOString(),
      });
      const base = {
        version: 1 as const,
        runtimeId: owned.owner.runtimeId,
        workerBootId: owned.owner.workerBootId,
        ownerDigest: owned.ownerDigest,
        observedAt: new Date().toISOString(),
      };
      await recordDshRuntimeCloseObservation(owned, {
        ...base,
        kind: 'close_started',
      });
      await recordDshRuntimeCloseObservation(owned, {
        ...base,
        kind: 'close_request',
        acknowledged: true,
        wrapper: {
          version: 1,
          sdkShutdown: true,
          rootDisposed: true,
          priorFramesFlushed: true,
        },
      });
      await recordDshRuntimeCloseObservation(owned, {
        ...base,
        kind: 'process_closed',
        fact: {
          source: 'child_close',
          stdioClosed: true,
          exitCode: 0,
          signal: null,
          terminationAttempted: null,
        },
      });
    }
    async function pin(value: unknown) {
      const bytes = Buffer.from(JSON.stringify(value));
      const path = join(
        fixture.storageRoot,
        randomUUID() + '.SYNTHETIC-NOT-NATIVE.json',
      );
      await writeFile(path, bytes);
      return {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      };
    }
    async function review(f: Subject, target = b) {
      const [row] =
        await fixture.db`select allrice_native_chat_executor_facts(${f.chat},null) facts`;
      const facts = row!.facts;
      const [previous] =
        await fixture.db`select receipt from allrice_native_chat_executor_transitions where context_id=${f.chat} order by sequence desc limit 1`;
      const from = previous?.receipt.target ?? tuple(a),
        storageNamespace = facts.bindings[0].storage_namespace;
      const requestId = randomUUID(),
        expectedFactsDigest = nativeRootDigest(facts);
      const approval = {
        kind: 'reviewed-chat-executor-transition-v1',
        requestId,
        scope: scope(f),
        expectedFactsDigest: nativeRootDigest(facts),
        from,
        target: tuple(target),
        storageNamespace,
        previousDigest: previous?.receipt.digest ?? null,
        reviewedBy: 'SYNTHETIC SQL-ONLY reviewer; no production evidence',
        reviewedAtMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 60000,
        artifactProof: await pin({
          kind: 'verified-native-artifact-v1',
          ...tuple(target),
          manifestDigest: target,
          verified: true,
          measurementDigest: nativeRootDigest({ synthetic: true }),
        }),
        historyProof: await pin({
          kind: 'full-native-chat-history-read-v1',
          requestId,
          expectedFactsDigest,
          scope: scope(f),
          targetArtifactId: target,
          storageNamespace,
          complete: true,
          missing: 0,
          privateFactsVerified: true,
          nativeSessionIds: facts.bindings.map(
            (p: { native_session_id: string }) => p.native_session_id,
          ),
        }),
        closeProof: await pin({
          kind: 'reviewed-native-chat-offline-v1',
          requestId,
          expectedFactsDigest,
          scope: scope(f),
          webStoppedNormally: true,
          workerStoppedNormally: true,
          allOwnedProcessesAbsent: true,
          unconfirmedOwners: 0,
          deploymentLockVerified: true,
          qaLockVerified: true,
        }),
      };
      return { approval, approvalFile: await pin(approval), facts };
    }
    const apply = (r: Awaited<ReturnType<typeof review>>) =>
      applyReviewedChatExecutorTransition({
        db: fixture.db,
        approvalFile: r.approvalFile,
      });
    async function raw(f: Subject) {
      const [r] =
        await fixture.db`select native_root_origin from allrice_chat_sessions where id=${f.chat}`;
      return r!.native_root_origin;
    }
    const legacy = 'sha256:' + 'd'.repeat(64);
    async function subject() {
      const f = await currentSubject(),
        chat = randomUUID();
      await fixture.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_instance_id,employee_version_id,native_root_origin)
      select ${chat},organization_id,workspace_id,owner_id,'SYNTHETIC initial NULL legacy',employee_assignment_id,employee_instance_id,employee_version_id,null from allrice_chat_sessions where id=${f.chat}`;
      const n = { ...f, chat };
      const oldRun = await send(n),
        job = await claimNextJob(f.worker.workerId, 120000);
      expect(
        (
          await fixture.db`select run_id from allrice_jobs where id=${job!.id}`
        )[0]!.run_id,
      ).toBe(oldRun);
      await startClaimedJob(f.worker.workerId, job!.id, job!.lease!.token);
      await failJob({
        workerId: f.worker.workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        code: 'SYNTHETIC_OLD_RUN',
        message: 'No Native or model; SQL-only history',
        retryable: false,
      });
      pending.splice(
        pending.findIndex((x) => x.runId === oldRun),
        1,
      );
      const [er] =
        await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${oldRun}`;
      const checksum = EmployeeExecutionSnapshotSchema.parse(
        er!.execution_snapshot,
      ).employee.definitionChecksum;
      await fixture.db`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,provider,thread_id,thread_generation,config_checksum,state)
      values(${n.org},${n.workspace},${chat},${n.user},'dsh',${'dsh-' + chat},0,${checksum},'idle') on conflict(session_id) do update set thread_id=excluded.thread_id,config_checksum=excluded.config_checksum`;
      return { ...n, oldRun };
    }
    async function legacyReview(f: Subject) {
      const s = scope(f),
        suffix = `/${f.org}/${f.workspace}/${f.user}/${f.chat}/sessions`;
      const sourceNamespace = fixture.storageRoot + '/old' + suffix,
        targetNamespace = fixture.storageRoot + '/new' + suffix;
      await mkdir(sourceNamespace, { recursive: true });
      await mkdir(targetNamespace, { recursive: true });
      const mk = async (root: string, name: string, text: string) => {
        const path = join(root, name),
          bytes = Buffer.from(text);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, bytes);
        return {
          path,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      };
      const blobBytes = 'synthetic native image bytes';
      const blobHash = createHash('sha256').update(blobBytes).digest('hex');
      const blobRelative = join(
        '..',
        'attachments',
        'v1',
        'objects',
        blobHash.slice(0, 2),
        blobHash,
      );
      const sourcePin = await mk(
          sourceNamespace,
          'session.v3.jsonl',
          'SYNTHETIC V3 BYTES, NO SDK\n',
        ),
        targetPin = await mk(
          targetNamespace,
          'session.v4.jsonl',
          'SYNTHETIC V4 BYTES, NO SDK\n',
        ),
        sourceBlob = await mk(sourceNamespace, blobRelative, blobBytes),
        targetBlob = await mk(targetNamespace, blobRelative, blobBytes);
      const id = 'dsh-' + f.chat;
      const businessObjects = [];
      for (let n = 0; n < 6; n++) {
        const objectId = randomUUID(),
          p = await mk(
            fixture.storageRoot,
            objectId + '.txt',
            'independent output ' + n,
          );
        await fixture.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state) values(${objectId},${f.org},${f.workspace},${f.user},${p.path},'exports','text/plain',${p.bytes},${'sha256:' + p.sha256},'ready')`;
        await fixture.db`insert into allrice_deliverable_versions(organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format) values(${f.org},${f.workspace},${f.user},${objectId},${randomUUID()},1,${f.chat},${'output-' + n + '.txt'},'text')`;
        businessObjects.push({ objectId, pin: p });
      }
      const facts = (
        await fixture.db`select allrice_native_chat_adoption_facts(${f.chat},null) facts`
      )[0]!.facts;
      const [v] =
        await fixture.db`select id,manifest,config_checksum from allrice_employee_versions where id=${facts.sourceVersionId}`;
      const source = validateEmployeeExecutionSource({
        employeeVersionId: v!.id,
        manifest: v!.manifest,
        configChecksum: v!.config_checksum,
      });
      const effective = CurrentEmployeeChatOriginSchema.parse({
        schemaVersion: 2,
        contextKind: 'chat',
        contextId: f.chat,
        rootSeed: f.chat,
        distributionGeneration: newNativeGeneration,
        profileId: 'restricted',
        artifactId: b,
        scope: {
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
        },
        birthSource: source.source,
        sourcePolicy: source.sourcePolicy,
      });
      const byteFacts = {
        kind: 'reviewed-legacy-chat-byte-facts-v1',
        scope: s,
        sourceNamespace,
        targetNamespace,
        source: [
          { role: 'journal', nativeSessionId: id, pin: sourcePin },
          { role: 'native_attachment', nativeSessionId: id, pin: sourceBlob },
        ],
        target: [
          { role: 'journal', nativeSessionId: id, pin: targetPin },
          { role: 'native_attachment', nativeSessionId: id, pin: targetBlob },
        ],
        businessObjects,
      };
      const privateEvents = [0, 1, 2, 3].map((n) => ({
        type: n === 1 ? 'allrice/input/answered' : 'allrice/input/request',
        seq: n,
        dataSha256: createHash('sha256')
          .update(JSON.stringify({ n }))
          .digest('hex'),
        time: n,
      }));
      const conversion = {
        kind: 'allrice-v3-input-pure-conversion-v1',
        sourceFormat: 3,
        targetFormat: 4,
        nativeSessionId: id,
        source: { sha256: sourcePin.sha256, bytes: sourcePin.bytes },
        target: { sha256: targetPin.sha256, bytes: targetPin.bytes },
        currentDetachedValidationPassed: true,
        privateEvents,
        references: [
          {
            sourceSeq: 0,
            path: '/data/content/0/attachmentId',
            value: 'sha256:' + sourceBlob.sha256,
          },
        ],
        eventCount: 177,
        synthetic: true,
      };
      const requestId = randomUUID(),
        expectedFactsDigest = nativeRootDigest(facts);
      const adoption = {
        kind: 'null-origin-legacy-v1',
        originalOrigin: null,
        effectiveOrigin: effective,
        sourceVersionId: v!.id,
        sourceManifestDigest: nativeRootDigest(v!.manifest),
        sourceNamespace,
        sourceByteFactsDigest: nativeRootDigest(byteFacts),
        conversionEvidenceDigest: nativeRootDigest(conversion),
        nativeSessionIds: [id],
      };
      const artifact = {
        kind: 'verified-native-artifact-v1',
        ...tuple(b),
        manifestDigest: b,
        verified: true,
        measurementDigest: nativeRootDigest({ synthetic: true }),
      };
      const history = {
        kind: 'full-native-chat-adoption-read-v1',
        scope: s,
        requestId,
        expectedFactsDigest,
        targetArtifactId: b,
        storageNamespace: targetNamespace,
        nativeSessionIds: [id],
        conversionEvidenceDigest: nativeRootDigest(conversion),
        byteFactsDigest: nativeRootDigest(byteFacts),
        complete: true,
        missing: 0,
        publicPersistenceWritePassed: true,
        freshPublicFullReadPassed: true,
        fullSessionRestorePassed: true,
        privateFactsVerified: true,
        privateEventDigest: nativeRootDigest(privateEvents),
        privateEventCount: 4,
        eventCount: 177,
        publicHandleClosed: true,
        backendDisposed: true,
        originalUnchanged: true,
        deliverablesUnchanged: true,
        synthetic: true,
      };
      const close = {
        kind: 'reviewed-native-chat-offline-v1',
        scope: s,
        requestId,
        expectedFactsDigest,
        webStoppedNormally: true,
        workerStoppedNormally: true,
        allOwnedProcessesAbsent: true,
        unconfirmedOwners: 0,
        deploymentLockVerified: true,
        qaLockVerified: true,
        targetReadHandleClosed: true,
        targetPersistenceFlushed: true,
        targetPersistenceDisposed: true,
        synthetic: true,
      };
      const approval = {
        kind: 'reviewed-chat-legacy-adoption-v1',
        scope: s,
        requestId,
        expectedFactsDigest,
        from: {
          artifactId: legacy,
          generation: 'dsh-0.1.5-rc.3-a4c74a9',
          profileId: 'restricted',
        },
        target: tuple(b),
        storageNamespace: targetNamespace,
        previousDigest: null,
        reviewedBy: 'SYNTHETIC SQL reviewer: NOT A REAL ADOPTION PERMIT',
        reviewedAtMs: Date.now() - 1000,
        expiresAtMs: Date.now() + 60000,
        adoption,
        artifactProof: await pin(artifact),
        historyProof: await pin(history),
        closeProof: await pin(close),
        byteFactsProof: await pin(byteFacts),
        conversionProof: await pin(conversion),
      };
      return {
        approval,
        approvalFile: await pin(approval),
        facts,
        byteFacts,
        history,
        close,
        conversion,
      };
    }
    const adopt = (r: Awaited<ReturnType<typeof legacyReview>>) =>
      applyReviewedLegacyChatAdoption({
        enabled: true,
        db: fixture.db,
        approvalFile: r.approvalFile,
      });
    async function refreeze(r: Awaited<ReturnType<typeof legacyReview>>) {
      r.approvalFile = await pin(r.approval);
      return r;
    }
    async function count(f: Subject) {
      return Number(
        (
          await fixture.db`select count(*) n from allrice_native_chat_executor_transitions where context_id=${f.chat}`
        )[0]!.n,
      );
    }
    it('keeps old origin/Run/six files immutable, admits new binding, binds same native ID, delivery/scanner and next U1 upgrade agree', async () => {
      const f = await subject();
      await appendDiagnosticReceipt(fixture.db, f, {
        runId: f.oldRun,
        nativeSessionId: 'dsh-' + f.chat,
        attempt: 1,
        generation: 0,
        turn: 1,
        seq: 7,
      });
      const r = await legacyReview(f);
      const bytePins = [
        ...r.byteFacts.source.map((item) => item.pin),
        ...r.byteFacts.target.map((item) => item.pin),
        ...r.byteFacts.businessObjects.map((item) => item.pin),
      ];
      const beforeReadFiles = await snapshotDiagnosticFiles(bytePins);
      const preAdoption = await diagnosticReadOnly(fixture.db, f, () =>
        getRunNativeDiagnosticTarget(f.context, f.workspace, f.oldRun),
      );
      expect(preAdoption.slices).toHaveLength(1);
      expect(preAdoption.slices[0]).toMatchObject({
        binding: null,
        execution: null,
        reasons: ['binding_unavailable'],
      });
      expect(await snapshotDiagnosticFiles(bytePins)).toEqual(beforeReadFiles);
      const [before] =
        await fixture.db`select to_jsonb(e) value from allrice_employee_runs e where run_id=${f.oldRun}`;
      const receipt = await adopt(r);
      expect(await raw(f)).toBeNull();
      expect(
        (
          await fixture.db`select to_jsonb(e) value from allrice_employee_runs e where run_id=${f.oldRun}`
        )[0],
      ).toEqual(before);
      for (const o of r.byteFacts.businessObjects)
        expect(
          createHash('sha256')
            .update(await readFile(o.pin.path))
            .digest('hex'),
        ).toBe(o.pin.sha256);
      expect(
        await readAppliedChatExecutorTransition({
          db: fixture.db,
          scope: scope(f),
          requestId: receipt.requestId,
          approvalDigest: receipt.approvalDigest,
        }),
      ).toEqual(receipt);
      await expect(adopt(r)).rejects.toThrow('ALREADY_APPLIED_READBACK_ONLY');
      expect(await count(f)).toBe(1);
      // Before any new pin, the committed adoption keeps its target referenced.
      // Two unrelated authority-fixture NULL chats still need the legacy code.
      const zeroPinCoverage = await verifyNativeArtifactReferenceCoverage([
        {
          artifactId: a,
          generation: newNativeGeneration,
          storageRoot: '/isolated-native',
        },
        {
          artifactId: b,
          generation: newNativeGeneration,
          storageRoot: fixture.storageRoot + '/new',
        },
        {
          artifactId: legacy,
          generation: 'dsh-0.1.5-rc.3-a4c74a9',
          storageRoot: '/synthetic-legacy',
        },
      ]);
      expect(zeroPinCoverage.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: 'origin:chat',
            artifactId: b,
            covered: true,
          }),
          expect.objectContaining({
            source: 'implicit:legacy-chat',
            artifactId: legacy,
            records: 2,
            covered: true,
          }),
        ]),
      );
      const runId = await send(f);
      await resolveEmployeeExecution({
        organizationId: f.org,
        workspaceId: f.workspace,
        ownerId: f.user,
        runId,
      });
      const input = await lease(f, runId),
        prepared = await prepare(input);
      expect(prepared.executionBinding).toMatchObject({
        execution: tuple(b),
        transition: { digest: receipt.digest },
      });
      const bound = await bindJobNativeSession({
        ...input,
        descriptor: {
          ...input.descriptor,
          artifactId: b,
          artifactManifestDigest: b,
          storageNamespace: receipt.storageNamespace,
          executorTransitionDigest: receipt.digest,
        },
      });
      expect(bound.binding.nativeSessionId).toBe('dsh-' + f.chat);
      await appendDiagnosticReceipt(fixture.db, f, {
        runId,
        nativeSessionId: bound.binding.nativeSessionId,
        attempt: input.attempt,
        generation: input.subject.generation,
        turn: 2,
        seq: 17,
      });
      const [preU2AfterPin, postU2] = await diagnosticReadOnly(
        fixture.db,
        f,
        async () => [
          await getRunNativeDiagnosticTarget(f.context, f.workspace, f.oldRun),
          await getRunNativeDiagnosticTarget(f.context, f.workspace, runId),
        ],
      );
      // The new pin is known, but cannot grant an old Run the adopted namespace.
      expect(preU2AfterPin!.slices[0]!.binding).toMatchObject({
        firstRunId: runId,
      });
      expect(preU2AfterPin!.slices[0]!.execution).toBeNull();
      expect(preU2AfterPin!.slices[0]!.reasons).toContain(
        'binding_unavailable',
      );
      expect(postU2!.slices[0]).toMatchObject({
        reasons: [],
        verifiedTurns: [2],
        binding: { firstRunId: runId, artifactId: b },
        execution: {
          nativeSessionId: 'dsh-' + f.chat,
          artifactId: b,
          artifactManifestDigest: b,
          distributionGeneration: newNativeGeneration,
          storageNamespace: receipt.storageNamespace,
          executorTransitionDigest: receipt.digest,
        },
      });
      expect(postU2!.slices[0]!.execution!.storageNamespace).not.toBe(
        receipt.adoption!.sourceNamespace,
      );
      expect(await snapshotDiagnosticFiles(bytePins)).toEqual(beforeReadFiles);
      await failJob({
        workerId: input.workerId,
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        code: 'SQL_ONLY',
        message: 'No native or model',
        retryable: false,
      });
      pending.splice(
        pending.findIndex((x) => x.runId === runId),
        1,
      );
      vi.stubEnv('ALLRICE_CHECKED_DELIVERY_ARTIFACT_IDS', JSON.stringify([b]));
      expect(
        await fixture.db.begin((tx) =>
          selectCheckedFinalDeliveryArtifact(tx, {
            organizationId: f.org,
            workspaceId: f.workspace,
            ownerId: f.user,
            sessionId: f.chat,
          }),
        ),
      ).toBe(b);
      await confirmedClose(f);
      const next = await apply(await review(f, c));
      expect(next.sequence).toBe(2);
      expect(next.from).toEqual(tuple(b));
      const [oldAfterT2, u2AfterT2] = await diagnosticReadOnly(
        fixture.db,
        f,
        async () => [
          await getRunNativeDiagnosticTarget(f.context, f.workspace, f.oldRun),
          await getRunNativeDiagnosticTarget(f.context, f.workspace, runId),
        ],
      );
      expect(oldAfterT2!.slices[0]!.execution).toBeNull();
      expect(u2AfterT2!.slices[0]!.execution).toEqual(
        postU2!.slices[0]!.execution,
      );
      expect(u2AfterT2!.slices[0]!.execution!.executorTransitionDigest).toBe(
        receipt.digest,
      );
      expect(await snapshotDiagnosticFiles(bytePins)).toEqual(beforeReadFiles);
      expect(
        (
          await fixture.db`select to_jsonb(e) value from allrice_employee_runs e where run_id=${f.oldRun}`
        )[0],
      ).toEqual(before);
      const id2 = await send(f);
      const [newer] =
        await fixture.db`select native_execution_binding from allrice_employee_runs where run_id=${id2}`;
      expect(newer!.native_execution_binding.execution).toEqual(tuple(c));
      expect(
        (
          await readChatExecutorTransition(
            fixture.db,
            { ...scope(f), sessionId: f.chat },
            null,
          )
        )?.digest,
      ).toBe(next.digest);
      expect(await raw(f)).toBeNull();
      const refs = await verifyNativeArtifactReferenceCoverage([
        {
          artifactId: legacy,
          generation: 'dsh-0.1.5-rc.3-a4c74a9',
          storageRoot: '/synthetic-legacy',
        },
        {
          artifactId: a,
          generation: newNativeGeneration,
          storageRoot: '/isolated-native',
        },
        {
          artifactId: b,
          generation: newNativeGeneration,
          storageRoot: fixture.storageRoot + '/new',
        },
        {
          artifactId: c,
          generation: newNativeGeneration,
          storageRoot: fixture.storageRoot + '/new',
        },
      ]);
      expect(refs.verified).toBe(true);
      expect(
        refs.references.find((x) => x.source === 'implicit:legacy-chat'),
      ).toMatchObject({ artifactId: legacy, records: 2, covered: true });
      await expect(
        fixture.db`update allrice_native_chat_executor_transitions set digest=digest where request_id=${receipt.requestId}`,
      ).rejects.toThrow();
      await expect(
        fixture.db`update allrice_chat_sessions set native_root_origin=${fixture.db.json(receipt.adoption!.effectiveOrigin as never)} where id=${f.chat}`,
      ).rejects.toThrow();
    });
    it('does not adopt without explicit enable or public persistence/full-read/close proof', async () => {
      const f = await subject(),
        r = await legacyReview(f);
      await expect(
        applyReviewedLegacyChatAdoption({
          db: fixture.db,
          approvalFile: r.approvalFile,
        }),
      ).rejects.toThrow('DISABLED');
      r.approval.historyProof = await pin({
        ...r.history,
        freshPublicFullReadPassed: false,
      });
      await refreeze(r);
      await expect(adopt(r)).rejects.toThrow('HISTORY_PROOF');
      expect(await count(f)).toBe(0);
      expect(await raw(f)).toBeNull();
    });
    it.each(['source', 'target', 'business'] as const)(
      'rejects %s byte drift with zero receipt and zero new Run',
      async (which) => {
        const f = await subject(),
          r = await legacyReview(f),
          p =
            which === 'business'
              ? r.byteFacts.businessObjects[0]!.pin
              : r.byteFacts[which][0]!.pin;
        await writeFile(p.path, 'changed');
        await expect(adopt(r)).rejects.toThrow('BYTE_DRIFT');
        expect(await count(f)).toBe(0);
        expect(
          Number(
            (
              await fixture.db`select count(*) n from allrice_employee_runs where session_id=${f.chat}`
            )[0]!.n,
          ),
        ).toBe(1);
      },
    );
    it('CAS rejects additional history after review and preserves both old records', async () => {
      const f = await subject(),
        r = await legacyReview(f);
      await fixture.db`insert into allrice_messages(organization_id,workspace_id,session_id,owner_id,role,content) values(${f.org},${f.workspace},${f.chat},${f.user},'user','{"text":"new independent history"}')`;
      await expect(adopt(r)).rejects.toThrow('FACTS_OR_APPROVAL_CHANGED');
      expect(await count(f)).toBe(0);
    });
    it('rejects another owner, expired review and false close proof', async () => {
      const f = await subject(),
        r = await legacyReview(f);
      r.approval.scope = { ...r.approval.scope, ownerId: randomUUID() };
      await refreeze(r);
      await expect(adopt(r)).rejects.toThrow('EFFECTIVE_SCOPE');
      r.approval.scope = scope(f);
      r.approval.expiresAtMs = Date.now() - 5000;
      await refreeze(r);
      await expect(adopt(r)).rejects.toThrow('FACTS_OR_APPROVAL_CHANGED');
      r.approval.expiresAtMs = Date.now() + 60000;
      r.approval.closeProof = await pin({
        ...r.close,
        targetPersistenceFlushed: false,
      });
      await refreeze(r);
      await expect(adopt(r)).rejects.toThrow('CLOSE_PROOF');
      expect(await count(f)).toBe(0);
    });
    it('actual membership revocation rejects at commit, without changing original NULL', async () => {
      const f = await subject(),
        r = await legacyReview(f);
      await fixture.db`update allrice_memberships set active=false where organization_id=${f.org} and user_id=${f.user}`;
      await expect(adopt(r)).rejects.toThrow(
        'EXECUTOR_TRANSITION_SCOPE_DENIED',
      );
      expect(await count(f)).toBe(0);
      expect(await raw(f)).toBeNull();
    });
    it('does not reinterpret unadopted NULL as current executor or trust target env', async () => {
      const f = await subject();
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', b);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', b);
      expect(
        await readChatNativeRootOrigin(fixture.db, {
          organizationId: f.org,
          workspaceId: f.workspace,
          ownerId: f.user,
          sessionId: f.chat,
        }),
      ).toBeNull();
      expect(
        await readChatExecutorTransition(
          fixture.db,
          { ...scope(f), sessionId: f.chat },
          null,
        ),
      ).toBeNull();
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', a);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', a);
    });

    it('serializes duplicate reviewed adoption and exposes one readback receipt', async () => {
      const f = await subject(),
        r = await legacyReview(f);
      const results = await Promise.allSettled([adopt(r), adopt(r)]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
      expect(await count(f)).toBe(1);
      const receipt = results.find((x) => x.status === 'fulfilled');
      if (receipt?.status !== 'fulfilled')
        throw Error('missing committed receipt');
      expect(
        await readAppliedChatExecutorTransition({
          db: fixture.db,
          scope: scope(f),
          requestId: receipt.value.requestId,
          approvalDigest: receipt.value.approvalDigest,
        }),
      ).toEqual(receipt.value);
    });
    it('rejects a C owner with missing close evidence without treating physical absence as semantic close', async () => {
      const f = await subject();
      await reserveDshRuntimeOwner({
        version: 1,
        kind: 'owned',
        runtimeId: randomUUID(),
        workerBootId: randomUUID(),
        workerId: f.worker.workerId,
        serviceManifestDigest: a,
        artifactId: a,
        profileId: 'restricted',
        context: { kind: 'context', ...scope(f) },
        observedAt: new Date().toISOString(),
      });
      const r = await legacyReview(f);
      await expect(adopt(r)).rejects.toThrow('CLOSE_UNCONFIRMED');
      expect(await count(f)).toBe(0);
    });
    it('database idle fence rejects queued work even when the review pins fresh facts', async () => {
      const f = await subject();
      await send(f);
      const r = await legacyReview(f);
      await expect(adopt(r)).rejects.toThrow(
        'EXECUTOR_TRANSITION_FACTS_CHANGED',
      );
      expect(await count(f)).toBe(0);
      expect(await raw(f)).toBeNull();
    });
    it.each(['missing-byte-fact', 'unreviewed-child-reference'] as const)(
      'rejects %s even when review hashes consistently repeat the incomplete proof',
      async (kind) => {
        const f = await subject(),
          r = await legacyReview(f);
        r.conversion.references.push({
          sourceSeq: 2,
          path:
            kind === 'missing-byte-fact'
              ? '/data/attachmentId'
              : '/data/childId',
          value: 'sha256:' + 'e'.repeat(64),
        });
        r.approval.adoption.conversionEvidenceDigest = nativeRootDigest(
          r.conversion,
        );
        r.approval.conversionProof = await pin(r.conversion);
        r.history.conversionEvidenceDigest = nativeRootDigest(r.conversion);
        r.approval.historyProof = await pin(r.history);
        await expect(adopt(await refreeze(r))).rejects.toThrow(
          kind === 'missing-byte-fact'
            ? 'ATTACHMENT_REFERENCE_CLOSURE'
            : 'REFERENCE_SCOPE',
        );
        expect(await count(f)).toBe(0);
        expect(await raw(f)).toBeNull();
      },
    );
    it('SQL forbids a second adoption branch even with recomputed document hashes', async () => {
      const f = await subject(),
        r = await legacyReview(f),
        first = await adopt(r),
        requestId = randomUUID();
      const approval = {
        ...r.approval,
        requestId,
        previousDigest: first.digest,
      };
      const { digest: priorReceiptDigest, ...body } = first;
      expect(priorReceiptDigest).toBe(nativeRootDigest(body));
      const changed = {
        ...body,
        requestId,
        sequence: 2,
        previousDigest: first.digest,
        approvalDigest: nativeRootDigest(approval),
      };
      const receipt = { ...changed, digest: nativeRootDigest(changed) };
      await expect(
        fixture.db`insert into allrice_native_chat_executor_transitions(request_id,context_id,organization_id,workspace_id,owner_id,sequence,receipt,digest,approval) values(${requestId},${f.chat},${f.org},${f.workspace},${f.user},2,${fixture.db.json(receipt as never)},${receipt.digest},${fixture.db.json(approval as never)})`,
      ).rejects.toThrow();
      expect(await count(f)).toBe(1);
      expect(await raw(f)).toBeNull();
    });
  },
);
