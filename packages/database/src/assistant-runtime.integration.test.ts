import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('P25 governed assistant ledger — isolated real PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
    fixture = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    delete process.env.ALLRICE_ASSISTANTS_ENABLED;
    await fixture?.close();
  });
  it('persists real Run identity, parentage, isolated outputs and idempotent provisioning', async () => {
    const f = await assistantFixture(fixture.db);
    const delegationId = randomUUID();
    const [a, b] = await Promise.all([
      f.delegate({ delegationId }),
      f.delegate({ delegationId }),
    ]);
    expect(a.instance.runId).toBe(b.instance.runId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(
      await fixture.db`select id from allrice_runs where id=${a.instance.runId}`,
    ).toHaveLength(1);
    await expect(f.delegate({ delegationId, text: 'changed' })).rejects.toThrow(
      'conflict',
    );
    const sibling = (await f.delegate()).instance;
    const artifact = async (runId: string) =>
      f.runtime.registerArtifact({
        ...f.base,
        runId,
        relativePath: 'result.md',
        ...(await f.artifact(runId)),
      });
    expect((await artifact(a.instance.runId)).path).not.toBe(
      (await artifact(sibling.runId)).path,
    );
    await expect(artifact(a.instance.runId)).rejects.toThrow('conflict');
    await expect(
      f.runtime.registerArtifact({
        ...f.base,
        runId: sibling.runId,
        relativePath: '../result.md',
        artifactId: randomUUID(),
        digest: `sha256:${'b'.repeat(64)}`,
      }),
    ).rejects.toThrow('forbidden');
  });
  it('narrows tools across recursion, checks live authority and never trusts foreign IDs', async () => {
    const f = await assistantFixture(fixture.db),
      other = await assistantFixture(fixture.db);
    const child = (await f.delegate()).instance;
    await expect(
      f.delegate({ parentRunId: child.runId, tools: ['proposal'] }),
    ).rejects.toThrow('forbidden');
    await expect(
      f.runtime.getTree(other.context, { runId: f.task.runId }),
    ).rejects.toThrow('not_found');
    await expect(
      f.runtime.requestMessage(other.context, {
        runId: f.task.runId,
        childRunId: child.runId,
        inputId: randomUUID(),
        text: 'foreign',
      }),
    ).rejects.toThrow('not_found');
    f.revoke();
    await expect(f.delegate()).rejects.toThrow('revoked');
    await expect(
      createAssistantRuntime({ database: fixture.db }).provision({
        ...f.base,
        parentRunId: f.task.runId,
        delegationId: randomUUID(),
        label: 'no auth',
        text: 'no auth',
        tools: [],
      }),
    ).rejects.toThrow('forbidden');
  });
  it('rejects sibling artifacts and mismatched storage owner even in the same workspace', async () => {
    const f = await assistantFixture(fixture.db),
      a = (await f.delegate()).instance,
      b = (await f.delegate()).instance;
    const artifact = await f.artifact(a.runId);
    await expect(
      f.runtime.registerArtifact({
        ...f.base,
        runId: b.runId,
        relativePath: 'foreign.md',
        ...artifact,
      }),
    ).rejects.toThrow('forbidden');
    const foreign = randomUUID();
    await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${foreign},${`${foreign}@example.test`},'Foreign artifact owner','not-login')`;
    const foreignArtifact = await f.artifact(
      a.runId,
      'Foreign-owned actual bytes',
      foreign,
    );
    await expect(
      f.runtime.registerArtifact({
        ...f.base,
        runId: a.runId,
        relativePath: 'wrong-owner.md',
        ...foreignArtifact,
      }),
    ).rejects.toThrow('forbidden');
  });
  it('enforces depth, concurrent and lifetime child count atomically', async () => {
    const f = await assistantFixture(fixture.db);
    const a = (await f.delegate()).instance;
    const b = (await f.delegate({ parentRunId: a.runId })).instance;
    const c = (await f.delegate({ parentRunId: b.runId })).instance;
    await expect(f.delegate({ parentRunId: c.runId })).rejects.toThrow(
      'limit_exceeded',
    );
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => f.delegate()),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('reserves parent/child model calls in one shared budget under parallel load; restarts cannot reset it', async () => {
    const f = await assistantFixture(fixture.db, 3),
      child = (await f.delegate()).instance;
    const calls = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        f.runtime.reserveUsage({
          ...f.base,
          runId: i % 2 ? child.runId : f.task.runId,
          kind: 'model',
          callId: randomUUID(),
          amounts: {
            model_calls: 1,
            tool_calls: 0,
            input_tokens: 100,
            output_tokens: 100,
          },
        }),
      ),
    );
    expect(calls.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const tree = await f.runtime.getTree(f.context, { runId: f.task.runId });
    expect(tree.budgets.find((b) => b.metric === 'model_calls')?.reserved).toBe(
      3,
    );
    await expect(f.delegate()).rejects.toThrow('budget_exhausted');
    const rows = await fixture.db<
      { call_id: string }[]
    >`select distinct call_id from allrice_assistant_usage where root_run_id=${f.task.runId} and metric='model_calls' and settled_amount is null`;
    await f.runtime.settleUsage({
      ...f.base,
      callId: rows[0]!.call_id,
      amounts: { model_calls: 1 },
    });
    await f.runtime.settleUsage({
      ...f.base,
      callId: rows[0]!.call_id,
      amounts: { model_calls: 1 },
    });
    const budget = (
      await f.runtime.getTree(f.context, { runId: f.task.runId })
    ).budgets.find((b) => b.metric === 'model_calls');
    expect(budget).toMatchObject({
      reserved: 2,
      spent: 1,
      usageComplete: false,
    });
  });
  it('keeps ACK, durable checkpoint and adoption separate; unknown dispatch is never replayed', async () => {
    const f = await assistantFixture(fixture.db);
    const id = randomUUID();
    await f.delegate({ delegationId: id });
    expect(
      (await f.runtime.claimMessage({ ...f.base, inputId: id })).dispatch,
    ).toBe(true);
    expect(
      (await f.runtime.claimMessage({ ...f.base, inputId: id })).dispatch,
    ).toBe(false);
    const nativeMessageId = randomUUID();
    expect(
      (
        await f.runtime.checkpointMessage({
          ...f.base,
          inputId: id,
          nativeMessageId,
        })
      ).status,
    ).toBe('accepted');
    expect(
      (
        await f.runtime.checkpointMessage({
          ...f.base,
          inputId: id,
          nativeMessageId,
          durableSeq: 3,
        })
      ).status,
    ).toBe('durable');
    expect(
      (
        await f.runtime.checkpointMessage({
          ...f.base,
          inputId: id,
          nativeMessageId,
          adoptedSeq: 4,
        })
      ).status,
    ).toBe('adopted');
    await expect(
      f.runtime.checkpointMessage({
        ...f.base,
        inputId: id,
        nativeMessageId: randomUUID(),
      }),
    ).rejects.toThrow('conflict');
  });
  it('single child cancellation drains its subtree but keeps unrelated cloud sibling admissible', async () => {
    const f = await assistantFixture(fixture.db),
      a = (await f.delegate()).instance,
      b = (await f.delegate()).instance,
      c = (await f.delegate({ parentRunId: a.runId })).instance;
    expect(
      await f.runtime.cancelChild(f.context, {
        runId: f.task.runId,
        childRunId: a.runId,
        requestId: randomUUID(),
      }),
    ).toEqual({ cancelRequested: true, stopped: false });
    await expect(
      f.runtime.reserveUsage({
        ...f.base,
        runId: c.runId,
        kind: 'model',
        callId: randomUUID(),
        amounts: {
          model_calls: 1,
          tool_calls: 0,
          input_tokens: 100,
          output_tokens: 100,
        },
      }),
    ).rejects.toThrow('canceled');
    await f.runtime.reserveUsage({
      ...f.base,
      runId: b.runId,
      kind: 'model',
      callId: randomUUID(),
      amounts: {
        model_calls: 1,
        tool_calls: 0,
        input_tokens: 100,
        output_tokens: 100,
      },
    });
    await f.runtime.confirmStopped({ ...f.base, runId: c.runId });
    expect(
      (
        await f.runtime.getTree(f.context, { runId: f.task.runId })
      ).instances.find((i) => i.runId === c.runId),
    ).toMatchObject({ status: 'canceled', stoppedAt: expect.any(String) });
  });
  it('commits root tombstone before drain, admits late result evidence without waking parent', async () => {
    const f = await assistantFixture(fixture.db),
      child = (await f.delegate()).instance;
    const result = {
      deliveryId: randomUUID(),
      status: 'partial' as const,
      summary: 'Partial evidence',
      evidence: [],
      incomplete: ['Stopped'],
      usageComplete: false,
    };
    await f.runtime.cancelRoot(f.context, {
      runId: f.task.runId,
      requestId: randomUUID(),
    });
    await expect(f.delegate()).rejects.toThrow('canceled');
    expect(
      await f.runtime.recordResult({ ...f.base, runId: child.runId, result }),
    ).toMatchObject({ wakeParent: false });
    expect(
      (
        await f.runtime.getTree(f.context, { runId: f.task.runId })
      ).instances.find((i) => i.runId === child.runId)?.status,
    ).toBe('cancel_requested');
    await expect(
      f.runtime.adoptResult({
        ...f.base,
        parentRunId: f.task.runId,
        deliveryId: result.deliveryId,
        nativeMessageId: randomUUID(),
        adoptedSeq: 2,
      }),
    ).rejects.toThrow('canceled');
  });
  it('records evidence-backed delivery independently from parent adoption', async () => {
    const f = await assistantFixture(fixture.db),
      child = (await f.delegate()).instance;
    const { artifactId, digest } = await f.artifact(child.runId);
    await f.runtime.registerArtifact({
      ...f.base,
      runId: child.runId,
      relativePath: 'evidence.json',
      artifactId,
      digest,
    });
    const result = {
      deliveryId: randomUUID(),
      status: 'completed' as const,
      summary: 'Checked result',
      evidence: [{ id: artifactId, digest }],
      incomplete: [],
      usageComplete: true,
    };
    expect(
      await f.runtime.recordResult({ ...f.base, runId: child.runId, result }),
    ).toMatchObject({ wakeParent: true });
    const tree = await f.runtime.getTree(f.context, { runId: f.task.runId });
    expect(tree.results[0]?.parentAdoptedSeq).toBeNull();
    expect(tree.results[0]).toMatchObject({
      status: 'partial',
      usageComplete: false,
    });
    expect(tree.results[0]!.incomplete.join(' ')).toContain(
      'usage remains unresolved',
    );
    await f.runtime.adoptResult({
      ...f.base,
      parentRunId: f.task.runId,
      deliveryId: result.deliveryId,
      nativeMessageId: randomUUID(),
      adoptedSeq: 12,
    });
    expect(
      (await f.runtime.getTree(f.context, { runId: f.task.runId })).results[0]
        ?.parentAdoptedSeq,
    ).toBe(12);
  });
  it('generic command ledger root cutoff also tombstones the native tree before drain', async () => {
    const f = await assistantFixture(fixture.db);
    await f.delegate();
    await f.ledger.cancelRoot(f.task.scope, f.task.runId, randomUUID());
    const tree = await f.runtime.getTree(f.context, { runId: f.task.runId });
    expect(tree.cancelRequested).toBe(true);
    expect(
      tree.instances.every(
        (instance) =>
          instance.cancelRequestedAt !== null && instance.stoppedAt === null,
      ),
    ).toBe(true);
    expect(
      tree.messages.every((message) => message.status === 'canceled'),
    ).toBe(true);
  });
  it('binds a real child tool audit to immutable native call, arguments and returned result digests', async () => {
    const f = await assistantFixture(fixture.db),
      child = (await f.delegate()).instance;
    const call = {
      ...f.base,
      runId: child.runId,
      callId: randomUUID(),
      kind: 'tool' as const,
      tool: 'read',
      nativeCall: {
        id: 'native-call-1',
        argumentsDigest: runtimePolicyDigest({
          query: 'synthetic bounded query',
        }),
      },
      amounts: {
        tool_calls: 1,
        model_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
      },
    };
    await f.runtime.reserveUsage(call);
    await expect(
      f.runtime.reserveUsage({
        ...call,
        nativeCall: { ...call.nativeCall, id: 'different-call' },
      }),
    ).rejects.toThrow('conflict');
    await expect(
      f.runtime.reserveUsage({
        ...call,
        nativeCall: {
          ...call.nativeCall,
          argumentsDigest: runtimePolicyDigest({ query: 'changed' }),
        },
      }),
    ).rejects.toThrow('conflict');
    const resultDigest = runtimePolicyDigest({
      modelContent: 'synthetic returned value',
      summary: 'one result',
    });
    await f.runtime.settleUsage({
      ...f.base,
      runId: child.runId,
      callId: call.callId,
      amounts: call.amounts,
      resultDigest,
    });
    await expect(
      f.runtime.settleUsage({
        ...f.base,
        runId: child.runId,
        callId: call.callId,
        amounts: call.amounts,
        resultDigest: runtimePolicyDigest('changed'),
      }),
    ).rejects.toThrow('conflict');
    const rows =
      await fixture.db`select run_id,tool_name,native_call_id,arguments_digest,result_digest from allrice_assistant_usage where call_id=${call.callId}`;
    expect(rows).toHaveLength(4);
    expect(
      rows.every(
        (row) =>
          row.run_id === child.runId &&
          row.tool_name === 'read' &&
          row.native_call_id === 'native-call-1' &&
          row.arguments_digest === call.nativeCall.argumentsDigest &&
          row.result_digest === resultDigest,
      ),
    ).toBe(true);
  });
  it('derives delivery usage inside the child ledger, never from a sibling or caller flag', async () => {
    const f = await assistantFixture(fixture.db);
    const delegationId = randomUUID();
    const child = (await f.delegate({ delegationId })).instance;
    await f.delegate({ delegationId: randomUUID() }); // sibling retains its startup reservation
    const callId = randomUUID();
    await f.runtime.reserveUsage({
      ...f.base,
      runId: child.runId,
      callId,
      kind: 'model',
      amounts: {
        model_calls: 1,
        tool_calls: 0,
        input_tokens: 100,
        output_tokens: 10,
      },
    });
    await f.runtime.settleUsage({
      ...f.base,
      runId: child.runId,
      callId,
      amounts: {
        model_calls: 1,
        tool_calls: 0,
        input_tokens: 20,
        output_tokens: 5,
      },
    });
    await f.runtime.recordResult({
      ...f.base,
      runId: child.runId,
      result: {
        deliveryId: randomUUID(),
        status: 'partial',
        summary: 'Known usage for this child',
        evidence: [],
        incomplete: [],
        usageComplete: false,
      },
    });
    const tree = await f.runtime.getTree(f.context, { runId: f.task.runId });
    expect(tree.results[0]!.usageComplete).toBe(true);
    expect(tree.budgets.find((b) => b.metric === 'model_calls')!.reserved).toBe(
      1,
    );
  });
  it('fences old worker after lease loss and does not replay possibly executed work', async () => {
    const f = await assistantFixture(fixture.db),
      id = randomUUID();
    await f.delegate({ delegationId: id });
    await f.runtime.claimMessage({ ...f.base, inputId: id });
    await fixture.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.worker.jobId}`;
    expect(await f.runtime.quarantineExpired(f.base)).toEqual({
      replay: false,
      requiresReconciliation: true,
    });
    await expect(
      f.runtime.checkpointMessage({
        ...f.base,
        inputId: id,
        nativeMessageId: randomUUID(),
      }),
    ).rejects.toThrow('lease_lost');
    expect(
      (await f.runtime.getTree(f.context, { runId: f.task.runId })).messages[0]
        ?.status,
    ).toBe('unknown');
  });
  it('a new lease on the same worker/job cannot assume the previous native incarnation', async () => {
    const f = await assistantFixture(fixture.db);
    const leaseToken = randomUUID();
    await fixture.db`update allrice_jobs set lease_token=${leaseToken} where id=${f.worker.jobId}`;
    await expect(
      f.runtime.configureRoot({
        task: f.task,
        configuration: f.config,
        nativeSessionId: f.nativeSessionId,
        worker: { ...f.worker, leaseToken },
        allowedTools: [
          'read',
          'proposal',
          'assistant.delegate',
          'assistant.report',
        ],
      }),
    ).rejects.toThrow('conflict');
    await expect(
      f.delegate({ worker: { ...f.worker, leaseToken } }),
    ).rejects.toThrow('lease_lost');
    expect(
      await f.runtime.quarantineExpired({
        scope: f.task.scope,
        rootRunId: f.task.runId,
      }),
    ).toMatchObject({ replay: false });
    expect(
      (await f.runtime.getTree(f.context, { runId: f.task.runId })).instances[0]
        ?.status,
    ).toBe('unknown');
  });
  it('feature OFF blocks new execution but preserves history and cancellation', async () => {
    const f = await assistantFixture(fixture.db);
    await f.delegate();
    delete process.env.ALLRICE_ASSISTANTS_ENABLED;
    try {
      await expect(f.delegate()).rejects.toThrow('disabled');
      expect(
        (await f.runtime.getTree(f.context, { runId: f.task.runId })).instances,
      ).toHaveLength(2);
      await f.runtime.cancelRoot(f.context, {
        runId: f.task.runId,
        requestId: randomUUID(),
      });
    } finally {
      process.env.ALLRICE_ASSISTANTS_ENABLED = '1';
    }
  });
});
