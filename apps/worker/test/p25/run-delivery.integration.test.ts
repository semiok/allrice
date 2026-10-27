import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ExecutionContextSchema } from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { publishWorkbenchArtifact } from '../../../../packages/database/src/artifact-review.ts';
import { completeJob } from '../../../../packages/database/src/execution/queue.ts';
import { finalDeliveryTextDigest } from '../../../../packages/database/src/final-delivery-commit.ts';
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
suite('PR1a: independent Worker delivery, isolated PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
  });

  async function subject() {
    const db = fixture.db;
    // Reuse identity setup only; no assistant root/instance is configured.
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const f = await createAssistantAuthorityFixture(db, {
      configure: false,
      memberAssistants: null,
      memberRole: 'member',
      allowedTools: ['workspace.export.create', 'workspace.document.read'],
      controls: {
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'assistant.delegate', effect: 'deny' }],
      },
    });
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
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
    const publish = (name = '月报.txt') =>
      publishWorkbenchArtifact(
        {
          context,
          sessionId: f.session,
          callId: randomUUID(),
          kind: 'document',
          fileName: name,
          format: 'text',
          mediaType: 'text/plain',
          bytes: Buffer.from(prompt),
        },
        assistantFixtureStorage(db),
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
      // The future PR1b native boundary supplies these identifiers; no model is called here.
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
        guard: port.createCommitGuard(proof),
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
      port,
      publish,
      validate,
      complete,
      state,
    };
  }
  type Subject = Awaited<ReturnType<typeof subject>>;

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
      await fixture.db`select run_id from allrice_assistant_instances where root_run_id=${f.rootRunId}`,
    ).toHaveLength(0);
    // Exercise the same private receipt carrier consumed by Worker completion.
    const scope = {};
    beginCheckedFinalDeliveryExecution(scope);
    requireCheckedFinalDelivery(scope);
    bindCheckedFinalDeliveryCommitGuard(proof, guard);
    const source = { answer };
    attachCheckedFinalDelivery(source, proof);
    const result = { ...source };
    transferCheckedFinalDeliveryForExecution(scope, source, result);
    const coverage = readCheckedFinalDeliveryForExecution(scope, result);
    expect(coverage.coverage).toBe('checked_native_v1');
    if (coverage.coverage !== 'checked_native_v1')
      throw Error('missing private guard');
    await f.complete(coverage.checkedDelivery, result.answer);
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
      await fixture.db`select object_id,run_id,format from allrice_deliverable_versions where id=${artifact.version.id}`;
    expect(stored).toMatchObject({
      object_id: artifact.object.id,
      run_id: f.rootRunId,
      format: 'text',
    });
  });

  it('reads no assistant tree, even if a legacy child link is not a valid task', async () => {
    const f = await subject();
    const child = randomUUID();
    await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
      values(${child},${f.org},${f.workspace},${f.user},'running','{}','{}')`;
    await fixture.db`insert into allrice_runtime_run_links(run_id,root_run_id,parent_run_id,organization_id,workspace_id,task)
      values(${child},${f.rootRunId},${f.rootRunId},${f.org},${f.workspace},'{}')`;
    expect((await f.port.readSnapshot()).ownedRunIds).toEqual([f.rootRunId]);
  });

  it.each([
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
        await fixture.db`update allrice_policy_snapshots set expires_at=clock_timestamp()-interval '1 second' where id=${f.policy}`;
      },
    ],
    [
      'native generation changed',
      async (f: Subject) => {
        await fixture.db`update allrice_conversation_runtimes set thread_generation=thread_generation+1 where session_id=${f.session}`;
      },
    ],
    [
      'native pin wrong owner',
      async (f: Subject) => {
        await fixture.db`update allrice_native_session_bindings set owner_id=${randomUUID()} where native_session_id=${f.native}`;
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
    await expect(
      f.complete(
        f.port.createCommitGuard({
          ...proof,
          nativeSessionId: 'another-native-session',
        }),
        answer,
      ),
    ).rejects.toThrow('final_delivery_evidence_unavailable');
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
