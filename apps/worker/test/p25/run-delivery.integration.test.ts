import { createRuntimeOperationLedger } from '../../../../packages/database/src/runtime-ledger/ledger.ts';
// @ts-expect-error Native test host is JavaScript and runs the production DSH module unchanged.
import { host, text } from '../native-subagent/fixture.mjs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExecutionContextSchema } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { publishWorkbenchArtifact } from '../../../../packages/database/src/artifact-review.ts';
import {
  assertEmployeeInstanceAdmission,
  lockEmployeeInstanceAdmissionIdentity,
  prepareEmployeeInstanceSnapshot,
} from '../../../../packages/database/src/employees/employee-instances.ts';
import { completeJob } from '../../../../packages/database/src/execution/queue.ts';
import { saveContextCheckpoint } from '../../../../packages/database/src/conversation/conversation-checkpoint.ts';
import { releaseConversationRuntime } from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import {
  finalDeliveryTextDigest,
  registerJobCompletionGuard,
} from '../../../../packages/database/src/final-delivery-commit.ts';
import { createRunDeliveryPort } from '../../src/final-delivery/run-delivery.js';
import { checkFinalDelivery } from '../../src/final-delivery/policy.js';
import { createDeliveryMarkup } from '../../src/final-delivery/markup.js';
import {
  attachCheckedFinalDelivery,
  bindCheckedFinalDeliveryCommitGuard,
  beginCheckedFinalDeliveryExecution,
  requireCheckedFinalDelivery,
  transferCheckedFinalDeliveryForExecution,
  readCheckedFinalDeliveryForExecution,
} from '../../src/final-delivery/checked-delivery.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('Run-scoped independent Worker delivery, isolated PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  async function subject() {
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    const db = fixture.db;
    // Reuse identity setup only; no assistant root/instance is configured.
    const f = await createRunAuthorityFixture(db, {
      configure: false,

      memberRole: 'member',
      allowedTools: ['workspace.export.create', 'workspace.document.read'],
      controls: {
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'assistant.delegate', effect: 'deny' }],
      },
    });
    const native = `dsh-${f.session}`;
    const prompt = '请把这份月报整理成文件，把下载链接给我。';
    await db`update allrice_messages set content=${db.json({ text: prompt, citations: [] })} where session_id=${f.session} and role='user'`;
    await db`update allrice_runs set input=${db.json({ message: prompt })} where id=${f.rootRunId}`;
    await db`update allrice_jobs set attempt=1 where id=${f.worker.jobId}`;
    await db`update allrice_conversation_runtimes set thread_id=${native} where session_id=${f.session}`;
    // Native pin's first run/attempt is historical, not this run's identity.
    await db`insert into allrice_native_session_bindings(native_session_id,organization_id,workspace_id,owner_id,context_kind,context_id,
      storage_context_key,storage_namespace,artifact_id,artifact_manifest_digest,distribution_generation,profile_id,
      first_run_id,first_job_id,first_attempt,binding_basis)
      values(${native},${f.org},${f.workspace},${f.user},'chat',${f.session},${f.session},${'/synthetic/' + f.session},
      ${'sha256:' + 'a'.repeat(64)},${'sha256:' + 'a'.repeat(64)},'fixture','restricted',${randomUUID()},${randomUUID()},7,'approved_compatibility_reader')`;
    const [policy] =
      await db`select * from allrice_policy_snapshots where id=${f.policy}`;
    const context = ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId: f.rootRunId,
      jobId: f.worker.jobId,
      worker: { type: 'worker', id: f.worker.workerId },
      delegatedBy: { type: 'user', id: f.user },
      organizationId: f.org,
      workspaceId: f.workspace,
      startedAt: new Date().toISOString(),
      policySnapshot: {
        id: f.policy,
        organizationId: f.org,
        subjectId: f.user,
        version: 1,
        issuedAt: policy!.issued_at.toISOString(),
        expiresAt: policy!.expires_at.toISOString(),
        ...policy!.payload,
      },
    });
    const authority = {
      scope: f.task.scope,
      rootRunId: f.rootRunId,
      worker: { ...f.worker, attempt: 1 },
    };
    const port = createRunDeliveryPort(authority);
    const turnId = `${native}:turn:1`;
    await db`update allrice_conversation_runtimes set active_turn_id=${turnId} where session_id=${f.session}`;
    await db`insert into allrice_run_events(run_id,organization_id,workspace_id,sequence,event_type,payload)
      values(${f.rootRunId},${f.org},${f.workspace},1,'turn.started',${db.json({ source: 'dsh', threadId: native, turnId, generation: 1 })})`;
    const origin = (await port.readOrigin())!;
    const publish = (
      name = '月报.txt',
      kind: 'document' | 'plan' = 'document',
    ) =>
      publishWorkbenchArtifact(
        {
          context,
          sessionId: f.session,
          callId: randomUUID(),
          kind,
          fileName: name,
          format: 'text',
          mediaType: 'text/plain',
          bytes: Buffer.from(prompt),
        },
        runtimeFixtureStorage(db),
        db,
      );
    const validate = async (answer: string) => {
      const snapshot = await port.readSnapshot();
      const decision = checkFinalDelivery({
        candidate: answer,
        expectedScope: snapshot.scope,
        snapshot,
        markup: createDeliveryMarkup(),
        managedOrigins: [],
      });
      expect(decision.status).toBe('valid');
      // Synthetic identifiers isolate the database commit guard from native execution.
      const proof = {
        nativeSessionId: native,
        publicMessageId: randomUUID(),
        durableSeq: 55,
        nativeBindingId: randomUUID(),
        nativeCandidateDigest: finalDeliveryTextDigest(answer),
        candidateDigest: decision.candidateDigest,
        factSetDigest: decision.factSetDigest,
        attempt: 1,
        generation: f.worker.generation,
      };
      return {
        snapshot,
        decision,
        proof,
        guard: port.createCommitGuard(proof, origin),
      };
    };
    const complete = (
      guard: ReturnType<typeof port.createCommitGuard>,
      answer: string,
    ) =>
      completeJob({
        workerId: f.worker.workerId,
        jobId: f.worker.jobId,
        leaseToken: f.worker.leaseToken,
        result: { answer },
        checkedDelivery: guard,
      });
    const state = async () =>
      (
        await db`select j.status,r.state,r.result,m.content->>'text' text,
      (select count(*)::int from allrice_run_events ev where ev.run_id=r.id and event_type='run.succeeded') successes
      from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs e on e.run_id=r.id
      join allrice_messages m on m.id=e.assistant_message_id where j.id=${f.worker.jobId}`
      )[0];
    return {
      ...f,
      native,
      authority,
      origin,
      port,
      publish,
      validate,
      complete,
      state,
    };
  }
  type Subject = Awaited<ReturnType<typeof subject>>;

  it.each([
    'current',
    'replaced-lease',
    'replaced-worker',
    'expired-during-save',
  ] as const)(
    '保留 turn 的检查点以完成守卫复核 %s，失租不能写入或清除来源',
    async (mode) => {
      const f = await subject();
      const answer = '本轮没有导出文件。';
      const { guard } = await f.validate(answer);
      const db = fixture.db;
      const [runtime] =
        await db`select * from allrice_conversation_runtimes where session_id=${f.session}`;
      const [message] =
        await db`select id from allrice_messages where session_id=${f.session} and role='user' limit 1`;
      const input = {
        organizationId: f.org,
        workspaceId: f.workspace,
        sessionId: f.session,
        ownerId: f.user,
        runId: f.rootRunId,
        workerId: f.worker.workerId,
        harness: 'dsh' as const,
        threadId: f.native,
        generation: 1,
        coveredThroughMessageId: message!.id,
        summary: 'Synthetic checkpoint',
        configChecksum: runtime!.config_checksum,
        estimatedTokens: 100,
        messageCount: 1,
        checkedDelivery: { guard, result: { answer }, jobId: f.worker.jobId },
      };
      if (mode === 'replaced-lease')
        await db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.worker.jobId}`;
      // Token-only replacement does not exercise stale handler cleanup. Give
      // the same Run a new Worker and turn, then invoke the old lifecycle APIs.
      const replacementWorker = randomUUID();
      const replacementTurn = `${f.native}:turn:2`;
      if (mode === 'replaced-worker') {
        await db`update allrice_jobs set worker_id=${replacementWorker},lease_token=${randomUUID()} where id=${f.worker.jobId}`;
        await db`update allrice_conversation_runtimes set worker_id=${replacementWorker},active_turn_id=${replacementTurn} where session_id=${f.session}`;
      }
      if (mode === 'expired-during-save')
        await db.unsafe(`create function checkpoint_expire_lease() returns trigger language plpgsql as $$
          begin update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id='${f.worker.jobId}'::uuid; return new; end $$;
          create trigger checkpoint_expire_lease before insert on allrice_context_checkpoints for each row execute function checkpoint_expire_lease()`);
      try {
        if (mode === 'current') {
          // Ordinary callers still cannot checkpoint an active turn.
          await expect(
            saveContextCheckpoint({ ...input, checkedDelivery: undefined }),
          ).rejects.toThrow('context_checkpoint_unsafe_boundary');
          await saveContextCheckpoint(input);
        } else {
          await expect(saveContextCheckpoint(input)).rejects.toMatchObject({
            code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
          });
        }
        if (mode === 'replaced-worker') {
          await expect(f.complete(guard, answer)).rejects.toMatchObject({
            code: 'lease_lost',
          });
          await expect(
            releaseConversationRuntime({
              organizationId: f.org,
              workspaceId: f.workspace,
              sessionId: f.session,
              runId: f.rootRunId,
              workerId: f.worker.workerId,
              outcome: 'error',
            }),
          ).rejects.toMatchObject({ code: 'conversation_ownership_lost' });
          expect(await f.state()).toMatchObject({
            status: 'running',
            state: 'running',
            successes: 0,
          });
        }
        const [retained] =
          await db`select active_turn_id,active_run_id,worker_id from allrice_conversation_runtimes where session_id=${f.session}`;
        expect(retained).toEqual({
          active_turn_id:
            mode === 'replaced-worker'
              ? replacementTurn
              : runtime!.active_turn_id,
          active_run_id: f.rootRunId,
          worker_id:
            mode === 'replaced-worker' ? replacementWorker : f.worker.workerId,
        });
        expect(
          await db`select id from allrice_context_checkpoints where session_id=${f.session}`,
        ).toHaveLength(mode === 'current' ? 1 : 0);
      } finally {
        if (mode === 'expired-during-save') {
          await db`drop trigger checkpoint_expire_lease on allrice_context_checkpoints`;
          await db`drop function checkpoint_expire_lease()`;
        }
      }
    },
  );

  async function withRuntimeRoot(f: Subject) {
    await createRuntimeOperationLedger({
      database: fixture.db,
      admission: async () => {},
    }).createRoot({
      task: f.task,
      deadlineAt: new Date(Date.now() + 600000).toISOString(),
      budgets: [
        {
          metric: 'model_calls',
          unit: 'calls',
          currency: null,
          capacity: 5,
          source: { kind: 'worker', sourceId: 'delivery-test' },
        },
      ],
    });
  }

  it.each(['snapshot', 'commit'] as const)(
    'serializes %s with admission holding the user lock before requesting the Session',
    async (phase) => {
      const f = await subject();
      const identity = {
        actor: { type: 'user' as const, id: f.user },
        organizationId: f.org,
        workspaceId: f.workspace,
      };
      const instance = await prepareEmployeeInstanceSnapshot(
        identity,
        f.session,
        f.assignment,
        f.version,
        fixture.db,
      );
      const answer = '本轮没有导出文件。';
      const { guard } = await f.validate(answer);
      const gate = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        return { promise, resolve };
      };
      const identityLocked = gate();
      const deliveryAtUser = gate();
      const admission = fixture.db.begin(async (tx) => {
        await tx`set local lock_timeout='5s'`;
        await lockEmployeeInstanceAdmissionIdentity(tx, identity);
        identityLocked.resolve();
        await deliveryAtUser.promise;
        await assertEmployeeInstanceAdmission(
          tx,
          identity,
          f.session,
          instance,
        );
      });
      await Promise.race([identityLocked.promise, admission]);
      let userLockObserved = false;
      const debug = fixture.db.options.debug;
      fixture.db.options.debug = (_connection, query) => {
        if (/from allrice_users\b[\s\S]*for share/.test(query)) {
          // Admission already owns NO KEY UPDATE. Let it request the Session
          // only when delivery requests user SHARE. Session-first deadlocks.
          userLockObserved = true;
          deliveryAtUser.resolve();
        }
      };
      try {
        const delivery = (
          phase === 'snapshot'
            ? f.port.readSnapshot()
            : f.complete(guard, answer)
        ).finally(deliveryAtUser.resolve);
        expect(await Promise.allSettled([admission, delivery])).toEqual([
          expect.objectContaining({ status: 'fulfilled' }),
          expect.objectContaining({ status: 'fulfilled' }),
        ]);
        expect(userLockObserved).toBe(true);
        expect(await f.state()).toMatchObject(
          phase === 'snapshot'
            ? { status: 'running', state: 'running', successes: 0 }
            : { status: 'succeeded', state: 'succeeded', successes: 1 },
        );
      } finally {
        deliveryAtUser.resolve();
        fixture.db.options.debug = debug;
      }
    },
  );

  it('用户要下载月报：真实 DSH 回复来源经过 Worker 检查和原子提交，旧助手表不参与', async () => {
    const f = await subject();
    const artifact = await f.publish();
    const answer = `[月报](/api/v1/files/${artifact.object.id}/download)`;
    const native = await host({
      rootId: f.native,
      model: async () => text(answer),
      bridge: async (method: string) => {
        expect(method).toBe('allrice/final-delivery-origin');
        return { origin: await f.port.readOrigin() };
      },
    });
    // host fixture changes only its native flags; restore the SaaS workbench gate.
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    await native.server.handleRequest('allrice/final-delivery/bind', {
      sessionId: f.native,
      rootRunId: f.rootRunId,
    });
    await native.prompt('请把这份月报整理成文件，把下载链接给我。');
    const candidate = await native.server.handleRequest(
      'allrice/final-delivery/candidate',
      { sessionId: f.native },
    );
    const decision = await f.port.check({
      nativeText: candidate.answer,
      projectedText: candidate.answer,
      nativeSessionId: f.native,
      publicMessageId: candidate.publicMessageId,
      durableSeq: candidate.durableSeq,
      nativeBindingId: candidate.rootBinding.bindingId,
      rootRunId: f.rootRunId,
      attempt: 1,
      generation: 1,
    });
    expect(decision.status).toBe('valid');
    const proof = {
      nativeSessionId: f.native,
      publicMessageId: candidate.publicMessageId,
      durableSeq: candidate.durableSeq,
      nativeBindingId: candidate.rootBinding.bindingId,
      nativeCandidateDigest: candidate.textDigest,
      candidateDigest: decision.candidateDigest,
      factSetDigest: decision.factSetDigest,
      attempt: 1,
      generation: 1,
    };
    expect(() =>
      f.port.finish({ ...proof, publicMessageId: randomUUID() }),
    ).toThrow();
    await native.server.handleRequest('allrice/final-delivery/finish', {
      sessionId: f.native,
      completionToken: candidate.completionToken,
      candidateDigest: candidate.textDigest,
      factSetDigest: decision.factSetDigest,
    });
    f.port.finish(proof);
    const execution = {},
      result = { answer };
    beginCheckedFinalDeliveryExecution(execution);
    requireCheckedFinalDelivery(execution);
    attachCheckedFinalDelivery(result, proof);
    transferCheckedFinalDeliveryForExecution(execution, result, result);
    const coverage = readCheckedFinalDeliveryForExecution(execution, result);
    if (coverage.coverage !== 'checked_native_v1')
      throw Error('missing checked proof');
    await f.complete(coverage.checkedDelivery, answer);
    expect(await f.state()).toMatchObject({
      status: 'succeeded',
      text: answer,
      successes: 1,
    });
    expect(
      (
        await fixture.db`select to_regclass('allrice_assistant_roots') as relation`
      )[0]!.relation,
    ).toBeNull();
    expect(
      await fixture.db`select run_id from allrice_runtime_run_links where root_run_id=${f.rootRunId}`,
    ).toHaveLength(0);
  });

  it('第二次检查失败后不能消费上一份有效候选 proof', async () => {
    const f = await subject();
    const answer = '本轮没有导出文件。';
    const { proof } = await f.validate(answer);
    const candidate = {
      nativeText: answer,
      projectedText: answer,
      rootRunId: f.rootRunId,
      nativeSessionId: f.native,
      publicMessageId: proof.publicMessageId,
      durableSeq: proof.durableSeq,
      nativeBindingId: proof.nativeBindingId,
      attempt: 1,
      generation: 1,
    };
    expect((await f.port.check(candidate)).status).toBe('valid');
    await expect(
      f.port.check({ ...candidate, generation: 2 }),
    ).rejects.toThrow();
    expect(() => f.port.finish(proof)).toThrow();
    expect(await f.state()).toMatchObject({ status: 'running', successes: 0 });
  });

  it('文字修正检查不能用缺少 Run 来源的候选', async () => {
    const f = await subject();
    await fixture.db`delete from allrice_run_events where run_id=${f.rootRunId} and event_type='turn.started'`;
    expect(await f.port.readOrigin()).toBeNull();
    await expect(
      f.port.inspect({
        nativeSessionId: f.native,
        turn: 1,
        publicMessageId: randomUUID(),
        durableSeq: 55,
        text: '缺少链接',
        candidateDigest: finalDeliveryTextDigest('缺少链接'),
        provider: 'fixture',
        model: 'fixture',
      }),
    ).rejects.toThrow();
    expect(await f.state()).toMatchObject({ status: 'running', successes: 0 });
  });

  it('来源只读且绑定当前 Run；新的 turn 起点不能复用此前的提交 proof', async () => {
    const f = await subject();
    const answer = '本轮没有导出文件。';
    const { guard } = await f.validate(answer);
    const queries: string[] = [],
      debug = fixture.db.options.debug;
    fixture.db.options.debug = (_connection, query) => {
      queries.push(query);
    };
    try {
      expect(await f.port.readOrigin()).toEqual(f.origin);
    } finally {
      fixture.db.options.debug = debug;
    }
    expect(
      queries.filter((q) =>
        /allrice_assistant_|allrice_runtime_run_links/.test(q),
      ),
    ).toEqual([]);
    expect(
      queries.filter((q) => /^\s*(insert|update|delete)\b/i.test(q)),
    ).toEqual([]);
    await fixture.db`update allrice_conversation_runtimes set active_turn_id=${`${f.native}:turn:2`} where session_id=${f.session}`;
    await fixture.db`insert into allrice_run_events(run_id,organization_id,workspace_id,sequence,event_type,payload)
      values(${f.rootRunId},${f.org},${f.workspace},2,'turn.started',${fixture.db.json({ source: 'dsh', threadId: f.native, turnId: `${f.native}:turn:2`, generation: 1 })})`;
    await expect(f.complete(guard, answer)).rejects.toThrow(
      'final_delivery_evidence_unavailable',
    );
    // Restoring an older pointer must not make a newer durable turn disappear.
    await fixture.db`update allrice_conversation_runtimes set active_turn_id=${`${f.native}:turn:1`} where session_id=${f.session}`;
    await expect(f.port.readOrigin()).rejects.toThrow(
      'final_delivery_evidence_unavailable',
    );
    await expect(f.complete(guard, answer)).rejects.toThrow(
      'final_delivery_evidence_unavailable',
    );
    expect(await f.state()).toMatchObject({ status: 'running', successes: 0 });
  });

  it('用户要月报下载链接：无助手配置也能经新 Worker 端口检查并原子落库', async () => {
    const f = await subject();
    const artifact = await f.publish();
    const answer = `[月报](/api/v1/files/${artifact.object.id}/download)`;
    const { snapshot, decision, proof, guard } = await f.validate(answer);
    expect(snapshot.ownedRunIds).toEqual([f.rootRunId]);
    expect(decision.linked).toEqual([
      {
        objectId: artifact.object.id,
        versionId: artifact.version.id,
        checksum: artifact.object.checksum,
      },
    ]);
    expect(
      (
        await fixture.db`select to_regclass('allrice_assistant_instances') as relation`
      )[0]!.relation,
    ).toBeNull();
    const queries: string[] = [];
    const guardQueries: string[] = [];
    const captureGuardQueries = async <T>(operation: () => Promise<T>) => {
      const start = queries.length;
      try {
        return await operation();
      } finally {
        guardQueries.push(...queries.slice(start));
      }
    };
    const observedGuard = registerJobCompletionGuard(async (...args) => {
      const check = await captureGuardQueries(() =>
        guard.assertCurrent(...args),
      );
      return {
        assertCommitted: () =>
          captureGuardQueries(() => check.assertCommitted()),
      };
    });
    // Exercise the same private receipt carrier consumed by Worker completion.
    const scope = {};
    beginCheckedFinalDeliveryExecution(scope);
    requireCheckedFinalDelivery(scope);
    bindCheckedFinalDeliveryCommitGuard(proof, observedGuard);
    const source = { answer };
    attachCheckedFinalDelivery(source, proof);
    const result = { ...source };
    transferCheckedFinalDeliveryForExecution(scope, source, result);
    const coverage = readCheckedFinalDeliveryForExecution(scope, result);
    expect(coverage.coverage).toBe('checked_native_v1');
    if (coverage.coverage !== 'checked_native_v1')
      throw Error('missing private guard');
    const debug = fixture.db.options.debug;
    fixture.db.options.debug = (_connection, query) => {
      queries.push(query);
    };
    try {
      await f.complete(coverage.checkedDelivery, result.answer);
      expect(guardQueries.length).toBeGreaterThan(0);
      expect(
        queries.filter((q) =>
          /allrice_assistant_|allrice_runtime_run_links/.test(q),
        ),
      ).toEqual([]);
      // Generic terminal cleanup probes runtime_roots; the independent guard
      // must not, including the post-write assertCommitted callback.
      expect(
        guardQueries.filter((q) =>
          /allrice_assistant_|allrice_runtime_run_links|allrice_runtime_roots/.test(
            q,
          ),
        ),
      ).toEqual([]);
    } finally {
      fixture.db.options.debug = debug;
    }
    expect(await f.state()).toEqual({
      status: 'succeeded',
      state: 'succeeded',
      result: { answer },
      text: answer,
      successes: 1,
    });
    const [runtime] =
      await fixture.db`select active_run_id from allrice_conversation_runtimes where session_id=${f.session}`;
    expect(runtime!.active_run_id).toBeNull();
    const [stored] =
      await fixture.db`select v.object_id,a.run_id,v.format from allrice_deliverable_versions v
        join allrice_workbench_artifacts a on a.version_id=v.id where v.id=${artifact.version.id}`;
    expect(stored).toMatchObject({
      object_id: artifact.object.id,
      run_id: f.rootRunId,
      format: 'text',
    });
  });

  it('reads no assistant tree, even if a legacy child link is not a valid task', async () => {
    const f = await subject();
    await withRuntimeRoot(f);
    const child = randomUUID();
    await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${child},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
    await fixture.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
      values(${child},${f.rootRunId},${f.rootRunId},${f.org},${f.workspace},'{}')`;
    expect((await f.port.readSnapshot()).ownedRunIds).toEqual([f.rootRunId]);
  });

  it('checks frozen references without querying any assistant identity or run links', async () => {
    const f = await subject();
    const artifact = await f.publish('计划.txt', 'plan');
    await fixture.db`insert into allrice_review_continuations(response_id,organization_id,workspace_id,session_id,actor_id,artifact_id,checksum,kind,run_id)
      values(${randomUUID()},${f.org},${f.workspace},${f.session},${f.user},${artifact.id},${artifact.object.checksum},'plan_review',${f.rootRunId})`;
    const queries: string[] = [];
    const debug = fixture.db.options.debug;
    fixture.db.options.debug = (_connection, query) => {
      queries.push(query);
    };
    try {
      const snapshot = await f.port.readSnapshot();
      expect(snapshot.explicitReferenceVersionIds).toEqual([artifact.id]);
      expect(snapshot.artifacts).toMatchObject([
        { objectId: artifact.object.id, versionId: artifact.id },
      ]);
      expect(queries.length).toBeGreaterThan(0);
      expect(
        queries.filter((q) =>
          /allrice_assistant_|allrice_runtime_run_links|allrice_runtime_roots/.test(
            q,
          ),
        ),
      ).toEqual([]);
    } finally {
      fixture.db.options.debug = debug;
    }
  });

  it.each([
    [
      'worker lease expires after proof creation',
      async (f: Subject) => {
        await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      },
    ],
    [
      'control origin is replaced while text and turn remain unchanged',
      async (f: Subject) => {
        await fixture.db`update allrice_run_events set id=${randomUUID()} where run_id=${f.rootRunId} and event_type='turn.started'`;
      },
    ],
    [
      'active turn is cleared after proof creation',
      async (f: Subject) => {
        await fixture.db`update allrice_conversation_runtimes set active_turn_id=null where session_id=${f.session}`;
      },
    ],
    [
      'member revoked',
      async (f: Subject) => {
        await fixture.db`update allrice_memberships set active=false where id=${f.membership}`;
      },
    ],
    [
      'employee inactive',
      async (f: Subject) => {
        await fixture.db`update allrice_employees set status='archived' where id=${f.employee}`;
      },
    ],
    [
      'assignment revoked',
      async (f: Subject) => {
        await fixture.db`update allrice_employee_assignments set active=false where id=${f.assignment}`;
      },
    ],
    [
      'policy disabled',
      async (f: Subject) => {
        await f.setControls({
          version: 2,
          enabled: false,
          mode: 'execute',
          rules: [],
        });
      },
    ],
    [
      'policy expired',
      async (f: Subject) => {
        await fixture.db`update allrice_policy_snapshots set issued_at=clock_timestamp()-interval '1 hour', expires_at=clock_timestamp()-interval '1 second' where id=${f.policy}`;
      },
    ],
    [
      'native generation changed',
      async (f: Subject) => {
        await fixture.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
      },
    ],
    [
      'native pin belongs to another owner/context',
      async (f: Subject) => {
        const other = await subject();
        await fixture.db`update allrice_conversation_runtimes set thread_id=null where session_id=${other.session}`;
        await fixture.db`update allrice_conversation_runtimes set thread_id=${other.native} where session_id=${f.session}`;
      },
    ],
    [
      'job attempt changed',
      async (f: Subject) => {
        await fixture.db`update allrice_jobs set attempt=2 where id=${f.worker.jobId}`;
      },
    ],
  ])('rechecks %s between validation and commit', async (_name, revoke) => {
    const f = await subject();
    const { guard } = await f.validate('本轮没有导出文件。');
    await revoke(f);
    await expect(f.complete(guard, '本轮没有导出文件。')).rejects.toThrow();
    expect(await f.state()).toMatchObject({
      status: 'running',
      state: 'running',
      successes: 0,
    });
  });

  it('does not accept another scope, lease, generation or attempt', async () => {
    const f = await subject();
    for (const change of [
      { leaseToken: randomUUID() },
      { workerId: randomUUID() },
      { attempt: 2 },
      { generation: 2 },
    ]) {
      const port = createRunDeliveryPort({
        ...f.authority,
        worker: { ...f.authority.worker, ...change },
      });
      await expect(port.readSnapshot()).rejects.toThrow();
    }
    await expect(
      createRunDeliveryPort({
        ...f.authority,
        scope: { ...f.authority.scope, workspaceId: randomUUID() },
      }).readSnapshot(),
    ).rejects.toThrow();
  });

  it.each(['cancel', 'timeout'] as const)(
    '%s after proof creation retains queue stop semantics and never publishes success',
    async (mode) => {
      const f = await subject();
      const answer = '本轮没有导出文件。';
      const { guard } = await f.validate(answer);
      if (mode === 'cancel')
        await fixture.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.worker.jobId}`;
      else
        await fixture.db`update allrice_jobs set created_at=clock_timestamp()-interval '1 hour',timeout_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
      await expect(f.port.readOrigin()).rejects.toMatchObject({
        code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      });
      await f.complete(guard, answer);
      const terminal = mode === 'cancel' ? 'canceled' : 'failed';
      expect(await f.state()).toMatchObject({
        status: terminal,
        state: terminal,
        successes: 0,
      });
      const [event] =
        await fixture.db`select payload from allrice_run_events where run_id=${f.rootRunId} and event_type=${mode === 'cancel' ? 'run.canceled' : 'run.failed'}`;
      expect(event).toBeDefined();
      if (mode === 'timeout') expect(event!.payload.code).toBe('JOB_TIMEOUT');
      const [released] =
        await fixture.db`select active_turn_id,active_run_id,worker_id from allrice_conversation_runtimes where session_id=${f.session}`;
      expect(released).toEqual({
        active_turn_id: null,
        active_run_id: null,
        worker_id: null,
      });
    },
  );

  it('rejects changed facts and changed answer, without writing a terminal result', async () => {
    const f = await subject();
    const answer = '本轮没有导出文件。';
    const { guard } = await f.validate(answer);
    await expect(f.complete(guard, '另一个答复')).rejects.toThrow(
      'final_delivery_evidence_unavailable',
    );
    await f.publish();
    await expect(f.complete(guard, answer)).rejects.toThrow(
      'final_delivery_evidence_unavailable',
    );
    expect(await f.state()).toMatchObject({
      status: 'running',
      state: 'running',
      successes: 0,
    });
  });

  it('rejects a proof for another native session', async () => {
    const f = await subject();
    const answer = '本轮没有导出文件。';
    const { proof } = await f.validate(answer);
    expect(() =>
      f.port.createCommitGuard(
        { ...proof, nativeSessionId: 'another-native-session' },
        f.origin,
      ),
    ).toThrow('final_delivery_evidence_unavailable');
  });

  it('does not require a runtime root, budget or run link', async () => {
    const f = await subject();
    await fixture.db`delete from allrice_runtime_run_links where root_run_id=${f.rootRunId}`;
    await fixture.db`delete from allrice_runtime_budgets where root_run_id=${f.rootRunId}`;
    await fixture.db`delete from allrice_runtime_roots where root_run_id=${f.rootRunId}`;
    const answer = '本轮没有导出文件。';
    const { guard } = await f.validate(answer);
    await f.complete(guard, answer);
    expect(await f.state()).toMatchObject({
      status: 'succeeded',
      successes: 1,
    });
  });

  it('blocks unfinished operations and accepts their terminal receipt', async () => {
    const f = await subject();
    await withRuntimeRoot(f);
    const target = randomUUID(),
      operation = randomUUID();
    await fixture.db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities)
      values(${target},${f.org},${f.workspace},${'test.' + target},'rice_bridge','Synthetic target','offline','[]')`;
    await fixture.db`insert into allrice_runtime_operations(id,organization_id,workspace_id,run_id,root_run_id,target_id,
      attempt_id,attempt_number,generation,fence,idempotency_key,initial_snapshot,snapshot)
      values(${operation},${f.org},${f.workspace},${f.rootRunId},${f.rootRunId},${target},${randomUUID()},1,0,1,${randomUUID()},'{}','{"status":"running"}')`;
    const answer = '本轮没有导出文件。';
    const { guard } = await f.validate(answer);
    await expect(f.complete(guard, answer)).rejects.toThrow(
      'final_delivery_evidence_unavailable',
    );
    expect(await f.state()).toMatchObject({ status: 'running', successes: 0 });
    await fixture.db`update allrice_runtime_operations set snapshot='{"status":"succeeded"}' where id=${operation}`;
    await f.complete(guard, answer);
    expect(await f.state()).toMatchObject({
      status: 'succeeded',
      successes: 1,
    });
  });

  it('rolls back terminal writes when the stored reply differs from the checked body', async () => {
    const f = await subject();
    const answer = '本轮没有导出文件。';
    const { guard } = await f.validate(answer);
    await fixture.db
      .unsafe(`create function delivery_mutate_reply() returns trigger language plpgsql as $$
      begin if new.session_id='${f.session}'::uuid and new.role='assistant' then
        new.content=jsonb_set(new.content,'{text}','"changed after validation"'::jsonb); end if; return new; end $$;
      create trigger delivery_mutate_reply before update on allrice_messages for each row execute function delivery_mutate_reply()`);
    try {
      await expect(f.complete(guard, answer)).rejects.toThrow(
        'final_delivery_evidence_unavailable',
      );
      expect(await f.state()).toMatchObject({
        status: 'running',
        state: 'running',
        successes: 0,
        text: 'synthetic',
      });
    } finally {
      await fixture.db`drop trigger delivery_mutate_reply on allrice_messages`;
      await fixture.db`drop function delivery_mutate_reply()`;
    }
  });
});
