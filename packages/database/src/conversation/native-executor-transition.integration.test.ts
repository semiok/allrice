/** SQL-only synthetic approval/closure facts. No artifact is installed, no SDK
 * history is read and no native/model process starts. Not a live upgrade permit. */
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  snapshotDiagnosticSql,
} from '../execution/native-run-diagnostics-transition.fixture.ts';
import { acquireConversationRuntime } from './conversation-runtime.ts';
import {
  nativeRootDigest,
  newNativeGeneration,
} from './current-execution-binding.ts';
import {
  applyReviewedChatExecutorTransition,
  readAppliedChatExecutorTransition,
  readChatExecutorTransition,
  verifiedChatExecutorTransitions,
} from './native-executor-transition.ts';
import { verifyNativeArtifactReferenceCoverage } from './native-artifact-references.ts';
import {
  reserveDshRuntimeOwner,
  recordDshRuntimeCloseObservation,
} from '../providers/dsh-runtime-close-observations.ts';
import type { NativeSessionLeaseInput } from './native-session-binding.ts';
import { executorTransitionRef } from './native-executor-transition-contract.ts';
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
suite('U1 exact-chat transition, actual isolated SQL only', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const pending: { f: Subject; runId: string }[] = [];
  beforeAll(async () => {
    for (const k of Object.keys(process.env))
      if (k.startsWith('ALLRICE_DSH_ORIGIN_READER_')) vi.stubEnv(k, undefined);
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', a);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', a);
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
        console.info('u1_sql_cleanup', JSON.stringify(proof));
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
  async function subject() {
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
  type Subject = Awaited<ReturnType<typeof subject>>;
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
  async function ready() {
    const f = await subject(),
      runId = await send(f),
      input = await lease(f, runId);
    await bindJobNativeSession(input);
    await failJob({
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      code: 'SYNTHETIC_NO_EXECUTOR',
      message: 'SQL-only completion; no model or Host started',
      retryable: false,
    });
    pending.splice(
      pending.findIndex((r) => r.runId === runId),
      1,
    );
    const owned = await reserveDshRuntimeOwner({
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
    const [idle] =
      await fixture.db`select allrice_native_chat_executor_idle(${f.chat}) idle`;
    expect(idle!.idle).toBe(true);
    return { f, runId, input };
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
  async function insertRaw(
    r: Record<string, unknown> & {
      requestId: string;
      scope: ReturnType<typeof scope>;
      sequence: number;
      digest: string;
    },
    approval: unknown,
  ) {
    await fixture.db`insert into allrice_native_chat_executor_transitions(request_id,context_id,organization_id,workspace_id,owner_id,sequence,receipt,digest,approval) values(${r.requestId},${r.scope.contextId},${r.scope.organizationId},${r.scope.workspaceId},${r.scope.ownerId},${r.sequence},${fixture.db.json(r as never)},${r.digest},${fixture.db.json(approval as never)})`;
  }
  it('validates many exact-chat transition chains in a bounded number of relation reads', async () => {
    const expected = [];
    for (let n = 0; n < 6; n++) {
      const { f } = await ready();
      const receipt = await apply(await review(f));
      expected.push({ f, receipt });
    }
    const statements: string[] = [];
    const measured = new Proxy(fixture.db, {
      apply(target, that, args) {
        if (Array.isArray(args[0])) statements.push(args[0].join(' ? '));
        return Reflect.apply(target, that, args);
      },
    });
    const references = await verifiedChatExecutorTransitions(measured);
    for (const { f, receipt } of expected) {
      const reference = references.find((r) => r.scope.contextId === f.chat);
      expect(reference).toMatchObject({
        requestId: receipt.requestId,
        digest: receipt.digest,
        target: receipt.target,
      });
      const direct = await readChatExecutorTransition(
        fixture.db,
        { ...scope(f), sessionId: f.chat },
        await raw(f),
      );
      expect(direct?.digest).toBe(reference?.digest);
    }
    console.info(
      'u1_batch_scan_queries',
      JSON.stringify({
        contexts: expected.length,
        statements: statements.length,
        modelCalls: 0,
        nativeHosts: 0,
      }),
    );
    // This ceiling is independent of the six contexts and all earlier test data.
    // It fails the original scanner's repeated per-chat/per-pin round trips.
    expect(statements.length).toBeLessThanOrEqual(5);
  });
  it('A→B→C stays append-only and diagnostics retain exact frozen Runs in read-only SQL', async () => {
    const { f, runId: oldRun, input: oldInput } = await ready();
    await appendDiagnosticReceipt(fixture.db, f, {
      runId: oldRun,
      nativeSessionId: oldInput.descriptor.nativeSessionId,
      attempt: oldInput.attempt,
      generation: oldInput.subject.generation,
      turn: 1,
      seq: 7,
    });
    const origin = await raw(f);
    const [oldRow] =
      await fixture.db`select to_jsonb(e) value from allrice_employee_runs e where run_id=${oldRun}`;
    const [oldPin] =
      await fixture.db`select to_jsonb(b) value from allrice_native_session_bindings b where native_session_id=${oldInput.descriptor.nativeSessionId}`;
    expect(oldRow!.value.native_execution_binding.schemaVersion).toBe(1);
    const first = await review(f),
      stale = await review(f, c),
      r1 = await apply(first);
    await expect(apply(stale)).rejects.toThrow('FACTS_OR_APPROVAL_CHANGED');

    // Normal SQL admission/lease/bind is fixture setup, never done by diagnostics.
    async function executedFixture(turn: number, seq: number) {
      const runId = await send(f),
        input = await lease(f, runId),
        prepared = await prepare(input);
      if (!('effectiveDescriptor' in prepared) || !prepared.effectiveDescriptor)
        throw Error('Expected normal transition effective descriptor');
      const bound = await bindJobNativeSession({
        ...input,
        descriptor: prepared.effectiveDescriptor,
      });
      await appendDiagnosticReceipt(fixture.db, f, {
        runId,
        nativeSessionId: bound.binding.nativeSessionId,
        attempt: input.attempt,
        generation: input.subject.generation,
        turn,
        seq,
      });
      await failJob({
        workerId: input.workerId,
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        code: 'SYNTHETIC_NO_EXECUTOR',
        message: 'SQL only; no native/model',
        retryable: false,
      });
      pending.splice(
        pending.findIndex((item) => item.runId === runId),
        1,
      );
      return { runId, descriptor: prepared.effectiveDescriptor };
    }
    const afterT1 = await executedFixture(2, 17);
    const r2 = await apply(await review(f, c));
    expect(r2).toMatchObject({
      sequence: 2,
      previousDigest: r1.digest,
      from: tuple(b),
      target: tuple(c),
    });
    const afterT2 = await executedFixture(3, 27);

    const targets = await diagnosticReadOnly(fixture.db, f, async (tx) => {
      const targets = [];
      for (const runId of [oldRun, afterT1.runId, afterT2.runId])
        targets.push(
          await getRunNativeDiagnosticTarget(f.context, f.workspace, runId),
        );
      const exact = executorTransitionRef(r1),
        input = { ...scope(f), sessionId: f.chat };
      expect(
        await readChatExecutorTransition(tx, input, origin, exact),
      ).toEqual(r1);
      expect(await readChatExecutorTransition(tx, input, origin)).toEqual(r2);
      await expect(
        readChatExecutorTransition(tx, input, origin, {
          ...exact,
          digest: c,
        }),
      ).rejects.toThrow('REFERENCE_CONFLICT');
      await expect(
        readChatExecutorTransition(tx, input, origin, {
          ...exact,
          requestId: randomUUID(),
        }),
      ).rejects.toThrow('REFERENCE_MISSING');
      await expect(
        readChatExecutorTransition(
          tx,
          {
            ...input,
            ownerId: randomUUID(),
          },
          origin,
          exact,
        ),
      ).rejects.toThrow('CHAIN_INVALID');
      return targets;
    });
    for (const [index, target] of targets.entries()) {
      expect(target.slices).toHaveLength(1);
      expect(target.slices[0]).toMatchObject({
        binding: { artifactId: a, firstRunId: oldRun },
        reasons: [],
        verifiedTurns: [index + 1],
      });
      expect(JSON.stringify(target)).not.toContain(
        'SYNTHETIC_PRIVATE_DIAGNOSTIC_TEXT',
      );
    }
    expect(targets[0]!.slices[0]!.execution).toEqual(oldInput.descriptor);
    expect(
      targets[0]!.slices[0]!.execution!.executorTransitionDigest,
    ).toBeUndefined();
    expect(targets[1]!.slices[0]!.execution).toEqual(afterT1.descriptor);
    expect(targets[1]!.slices[0]!.execution).toMatchObject({
      artifactId: b,
      distributionGeneration: newNativeGeneration,
      executorTransitionDigest: r1.digest,
      storageNamespace: r1.storageNamespace,
    });
    expect(targets[2]!.slices[0]!.execution).toEqual(afterT2.descriptor);
    expect(targets[2]!.slices[0]!.execution).toMatchObject({
      artifactId: c,
      executorTransitionDigest: r2.digest,
    });
    expect(await raw(f)).toEqual(origin);
    expect(
      (
        await fixture.db`select to_jsonb(e) value from allrice_employee_runs e where run_id=${oldRun}`
      )[0],
    ).toEqual(oldRow);
    expect(
      (
        await fixture.db`select to_jsonb(b) value from allrice_native_session_bindings b where native_session_id=${oldInput.descriptor.nativeSessionId}`
      )[0],
    ).toEqual(oldPin);
    expect(
      await readAppliedChatExecutorTransition({
        db: fixture.db,
        scope: scope(f),
        requestId: r1.requestId,
        approvalDigest: r1.approvalDigest,
      }),
    ).toEqual(r1);

    // A real same-tenant member cannot use the native diagnostic to read this owner.
    const peer = randomUUID();
    await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${peer},${`${peer}@example.test`},'diagnostic peer','not-login')`;
    await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${f.org},${f.workspace},${peer},'member')`;
    const login = await createSession(peer),
      peerContext = await authenticateSession(login.token, {
        organizationId: f.org,
        workspaceId: f.workspace,
      });
    if (!peerContext) throw Error('Peer fixture authentication failed');
    await diagnosticReadOnly(fixture.db, f, async () => {
      await expect(
        getRunNativeDiagnosticTarget(peerContext, f.workspace, afterT1.runId),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    // Frozen authority cannot be rewritten merely to make a diagnostic resolvable.
    const protectedState = await snapshotDiagnosticSql(fixture.db, f);
    await expect(
      fixture.db`update allrice_employee_runs set native_execution_binding=null where run_id=${afterT1.runId}`,
    ).rejects.toThrow('employee execution binding is immutable');
    expect(await snapshotDiagnosticSql(fixture.db, f)).toEqual(protectedState);
  });

  it('two separately approved contenders serialize on exact chat; only one CAS can commit', async () => {
    const { f } = await ready();
    const left = await review(f),
      right = await review(f, c);
    const attempts = await Promise.allSettled([apply(left), apply(right)]);
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(
      (
        await fixture.db`select count(*)::int n from allrice_native_chat_executor_transitions where context_id=${f.chat}`
      )[0]!.n,
    ).toBe(1);
  });
  it('revoked membership denies operator commit with zero new transition/Run', async () => {
    const { f } = await ready(),
      r = await review(f);
    const [before] =
      await fixture.db`select count(*)::int n from allrice_employee_runs where session_id=${f.chat}`;
    await fixture.db`update allrice_memberships set active=false where user_id=${f.user}`;
    await expect(apply(r)).rejects.toThrow();
    expect(
      (
        await fixture.db`select count(*)::int n from allrice_native_chat_executor_transitions where context_id=${f.chat}`
      )[0]!.n,
    ).toBe(0);
    expect(
      (
        await fixture.db`select count(*)::int n from allrice_employee_runs where session_id=${f.chat}`
      )[0]!.n,
    ).toBe(before!.n);
  });
  it('queued work invalidates offline CAS and leaves its original binding', async () => {
    const { f } = await ready(),
      r = await review(f),
      runId = await send(f);
    await expect(apply(r)).rejects.toThrow();
    const [row] =
      await fixture.db`select native_execution_binding from allrice_employee_runs where run_id=${runId}`;
    expect(row!.native_execution_binding.schemaVersion).toBe(1);
    expect(row!.native_execution_binding.execution.artifactId).toBe(a);
  });
  it('unknown owned close observation refuses transition rather than treating absence as semantic shutdown', async () => {
    const { f } = await ready();
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
    const r = await review(f);
    await expect(apply(r)).rejects.toThrow('CLOSE_UNCONFIRMED');
  });
  it('SQL guard rejects a missing target field even with recomputed document digests', async () => {
    const { f } = await ready(),
      r = await review(f);
    const now = new Date().toISOString();
    const target = { artifactId: b, profileId: 'restricted' };
    const approval = { ...r.approval, target };
    const body = {
      schemaVersion: 1,
      kind: 'chat-executor-transition',
      requestId: approval.requestId,
      sequence: 1,
      previousDigest: null,
      scope: scope(f),
      originDigest: nativeRootDigest(await raw(f)),
      from: tuple(a),
      target,
      storageNamespace: approval.storageNamespace,
      factsDigest: nativeRootDigest(r.facts),
      facts: r.facts,
      approvalDigest: nativeRootDigest(approval),
      historyEvidenceDigest: a,
      closeEvidenceDigest: a,
      appliedAt: now,
    };
    await expect(
      insertRaw({ ...body, digest: nativeRootDigest(body) }, approval),
    ).rejects.toThrow('EXECUTOR_TRANSITION_FACTS_CHANGED');
  });
  it('NULL origin and zero pin remain implicit legacy dependencies; an approved current tuple does not hide them', async () => {
    await subject();
    vi.stubEnv('ALLRICE_DSH_RETAINED_1_ARTIFACT_ID', c);
    await expect(
      verifyNativeArtifactReferenceCoverage([
        {
          artifactId: a,
          generation: newNativeGeneration,
          storageRoot: '/isolated-native',
        },
        {
          artifactId: b,
          generation: newNativeGeneration,
          storageRoot: '/isolated-native',
        },
        {
          artifactId: c,
          generation: newNativeGeneration,
          storageRoot: '/isolated-native',
        },
      ]),
    ).rejects.toThrow('implicit:legacy-chat');
  });
});
