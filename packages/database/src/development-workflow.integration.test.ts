/** Production permissions/storage/ledger over isolated PostgreSQL. Device
 * receipts here are synthetic; the separate VM suite tests physical execution. */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
  type DevelopmentArtifactRef,
} from '@allrice/contracts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { publishWorkbenchChangesetProposal } from './artifact-review.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { localCommandCandidateEvidence } from './local-command-candidate.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import { assertAssistantAuthority } from './assistant-authority.ts';
import {
  inspectTenantDevelopment,
  inspectDevelopmentTestEvidence,
} from './tenant-development-inspection.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const hash = (v: string) =>
  `sha256:${createHash('sha256').update(v).digest('hex')}`;
suite('MET-144 real attributed development workflow', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    for (const name of [
      'ASSISTANTS',
      'WORKBENCH',
      'CHANGESET',
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'LOCAL_COMMAND',
    ])
      vi.stubEnv(`ALLRICE_${name}_ENABLED`, '1');
    database = await createAssistantFixtureDatabase();
  }, 120000);
  afterAll(async () => {
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function setup() {
    const f = await createAssistantLocalCommandFixture(
      database.db,
      'ask',
      false,
      { development: true, skipChild: true },
    );
    const storage = assistantFixtureStorage(f.db);
    await reportLocalCommandProfile(
      f.device,
      {
        contractVersion: 1,
        backend: 'local-vm-container-v1',
        imageDigest: localCommandToolchainImageV1,
        architecture: 'amd64',
        available: true,
        features: ['changeset_candidate'],
      },
      f.db,
    );
    const original = 'console.log("baseline");';
    const seedArtifact = await publishWorkbenchChangesetProposal(
      {
        context: f.context,
        sessionId: f.task.chatSessionId!,
        callId: randomUUID(),
        fileName: 'seed.json',
        proposal: {
          files: [{ path: 'test.mjs', before: original, after: original }],
        },
      },
      storage,
      f.db,
    );
    const seed = {
      artifactId: seedArtifact.id,
      digest: seedArtifact.object.checksum!,
    };
    const work = (runId: string, args: unknown, requestId = randomUUID()) =>
      f.runtime.development.workflow(
        { ...f.base, runId, context: f.context, arguments: args, requestId },
        storage,
      );
    await work(f.rootRunId, { action: 'initialize', seed });
    const child = async (label: string, extra: string[] = []) =>
      (
        await f.runtime.provision({
          ...f.base,
          parentRunId: f.rootRunId,
          delegationId: randomUUID(),
          label,
          text: 'Synthetic isolated task',
          tools: ['assistant.development', 'assistant.report', ...extra],
        })
      ).instance;
    const writer = await child('writer');
    const assignmentId = randomUUID();
    await work(
      f.rootRunId,
      {
        action: 'assign',
        role: 'edit',
        ownerRunId: writer.runId,
        expectedHead: seed,
        paths: ['test.mjs'],
      },
      assignmentId,
    );
    const propose = async (
      text = 'console.log("candidate");',
      previous: DevelopmentArtifactRef | null = null,
      requestId = randomUUID(),
    ) =>
      work(
        writer.runId,
        {
          action: 'publish',
          assignmentId,
          previous,
          proposal: {
            files: [{ path: 'test.mjs', before: original, after: text }],
          },
        },
        requestId,
      ) as Promise<DevelopmentArtifactRef>;
    const complete = async (
      runId: string,
      evidence: DevelopmentArtifactRef,
    ) => {
      // Settle the fixture's reserved launch with a real API call vector; no model was called.
      const [hold] = await f.db<
        { call_id: string }[]
      >`select call_id from allrice_assistant_usage where run_id=${runId} and settled_amount is null limit 1`;
      if (hold)
        await f.runtime.settleUsage({
          ...f.base,
          runId,
          callId: hold.call_id,
          amounts: { model_calls: 0 },
        });
      return f.runtime.recordResult({
        ...f.base,
        runId,
        result: {
          deliveryId: randomUUID(),
          status: 'completed',
          summary: 'synthetic result',
          evidence: [{ id: evidence.artifactId, digest: evidence.digest }],
          incomplete: [],
          usageComplete: true,
        },
      });
    };
    const merge = async (proposal: DevelopmentArtifactRef) =>
      work(f.rootRunId, {
        action: 'merge',
        expectedHead: seed,
        proposals: [proposal],
      }) as Promise<{ head: DevelopmentArtifactRef }>;
    const prepare = async () => {
      const proposal = await propose();
      await complete(writer.runId, proposal);
      const { head } = await merge(proposal);
      const tester = await child('tester', ['local.process.execute']);
      const reviewer = await child('reviewer');
      await work(f.rootRunId, {
        action: 'assign',
        role: 'test',
        ownerRunId: tester.runId,
        expectedHead: head,
      });
      await work(f.rootRunId, {
        action: 'assign',
        role: 'review',
        ownerRunId: reviewer.runId,
        expectedHead: head,
      });
      return { proposal, head, tester, reviewer };
    };
    const command = async (runId: string, head: DevelopmentArtifactRef) =>
      createLocalCommandOperation(
        {
          context: f.context,
          callId: randomUUID(),
          assistant: { runId, worker: f.worker },
          storage,
          arguments: {
            ...f.args,
            files: [{ path: 'test.mjs', sha256: hash(original) }],
            candidate: { artifactId: head.artifactId, checksum: head.digest },
          },
        },
        f.db,
      );
    const receipt = async (
      created: Awaited<ReturnType<typeof command>>,
      exitCode = 0,
    ) => {
      const operationId = created.snapshot.binding.attempt.operationId;
      await f.approve(await f.approvalFor(operationId));
      const ledger = f.freshLedger();
      const lease = await ledger.dispatch({
        scope: f.task.scope,
        operationId,
        leaseOwner: randomUUID(),
        leaseMs: 30000,
      });
      const payload = RuntimeLocalCommandSchema.parse(lease.bridgePayload);
      const output = {
        backend: 'local-vm-container-v1',
        containerId: 'a'.repeat(64),
        imageDigest: localCommandToolchainImageV1,
        stopped: true,
        exitCode,
        reason: 'exited',
        stdout: 'synthetic device test',
        stderr: '',
        truncated: false,
        workCopy: 'local_isolated_copy',
        sourceDirectoryModified: false,
        candidate: localCommandCandidateEvidence(payload),
      };
      await ledger.recordReceipt({
        scope: f.task.scope,
        operationId,
        leaseToken: lease.leaseToken,
        attempt: lease.snapshot.binding.attempt,
        receiptId: randomUUID(),
        signal: {
          type: 'operation.outcome',
          result: {
            status: exitCode === 0 ? 'succeeded' : 'failed',
            effects: 'none',
            evidence: {
              id: randomUUID(),
              recordedAt: new Date().toISOString(),
              digest: hash(JSON.stringify(output)),
            },
          },
        },
        evidence: { output },
      });
      return operationId;
    };
    return {
      ...f,
      storage,
      seed,
      work,
      writer,
      assignmentId,
      propose,
      merge,
      prepare,
      child,
      command,
      receipt,
      original,
    };
  }
  it('publishes actual child-owned bytes, tests the merged version and requires another reviewer before delivery', async () => {
    const f = await setup(),
      p = await f.prepare();
    const [author] =
      await f.db`select run_id from allrice_workbench_artifacts where version_id=${p.proposal.artifactId}`;
    expect(author!.run_id).toBe(f.writer.runId);
    const cmd = await f.command(p.tester.runId, p.head);
    expect(cmd.snapshot.agentInstanceId).toBe(p.tester.runId);
    expect(cmd.snapshot.status).toBe('waiting_user');
    await expect(
      f.work(p.reviewer.runId, {
        action: 'review',
        candidate: p.head,
        operationId: cmd.snapshot.binding.attempt.operationId,
        verdict: 'accept',
        summary: 'Reviewed',
      }),
    ).rejects.toThrow('test_evidence_required');
    const operationId = await f.receipt(cmd),
      reviewId = randomUUID();
    await f.work(
      p.reviewer.runId,
      {
        action: 'review',
        candidate: p.head,
        operationId,
        verdict: 'accept',
        summary: 'Reviewed exact changes',
      },
      reviewId,
    );
    await expect(
      f.work(f.rootRunId, { action: 'deliver', candidate: p.head, reviewId }),
    ).resolves.toMatchObject({
      verification: 'tested_and_reviewed',
      applied: false,
      test: { testerRunId: p.tester.runId, operationId },
    });
    const target = { ...f.task.scope, subjectId: f.context.delegatedBy.id };
    const inspected = await inspectTenantDevelopment(
      target,
      f.rootRunId,
      (text) => text,
      f.db,
    );
    expect(inspected).toMatchObject({
      candidateId: p.head.artifactId,
      digest: p.head.digest,
      revision: 1,
      truncated: false,
    });
    expect(inspected?.proposals[0]).toMatchObject({
      authorRunId: f.writer.runId,
      accepted: true,
    });
    expect(inspected?.tests[0]).toMatchObject({
      operationId,
      testerRunId: p.tester.runId,
      evidenceMatched: true,
      exitCode: 0,
    });
    expect(inspected?.reviews[0]).toMatchObject({
      reviewerRunId: p.reviewer.runId,
      verdict: 'accept',
    });
    expect(inspected?.deliveries[0]).toMatchObject({
      candidateId: p.head.artifactId,
      reviewId,
    });
    expect(
      await inspectTenantDevelopment(
        { ...target, subjectId: randomUUID() },
        f.rootRunId,
        (text) => text,
        f.db,
      ),
    ).toBeNull();
    expect(
      await inspectTenantDevelopment(
        { ...target, workspaceId: randomUUID() },
        f.rootRunId,
        (text) => text,
        f.db,
      ),
    ).toBeNull();
    const [op] =
      await f.db`select snapshot,bridge_payload from allrice_runtime_operations where id=${operationId}`;
    const [receipt] =
      await f.db`select payload->'evidence'->'output' as output from allrice_runtime_operation_receipts where operation_id=${operationId} and disposition='applied' limit 1`;
    const identity = {
      testerRunId: p.tester.runId,
      candidateId: p.head.artifactId,
      digest: p.head.digest,
    };
    expect(
      inspectDevelopmentTestEvidence(
        op!.snapshot,
        op!.bridge_payload,
        receipt!.output,
        { ...identity, digest: hash('other') },
      ).evidenceMatched,
    ).toBe(false);
    expect(
      inspectDevelopmentTestEvidence(
        op!.snapshot,
        op!.bridge_payload,
        undefined,
        identity,
      ).exitCode,
    ).toBeNull();
  });
  it('rejects forged identity, widening, parent/sibling publication, and tool fields', async () => {
    const f = await setup();
    await expect(
      f.work(f.writer.runId, {
        action: 'inspect',
        assignmentId: f.assignmentId,
      }),
    ).resolves.toMatchObject({ paths: ['test.mjs'] });
    await expect(
      f.work(f.writer.runId, { action: 'inspect', candidate: f.seed }),
    ).rejects.toThrow('verification_assignment_required');
    await expect(
      f.work(f.rootRunId, {
        action: 'publish',
        assignmentId: f.assignmentId,
        previous: null,
        proposal: {
          files: [{ path: 'test.mjs', before: f.original, after: 'x' }],
        },
      }),
    ).rejects.toThrow('forbidden');
    await expect(
      f.work(f.writer.runId, {
        action: 'publish',
        assignmentId: f.assignmentId,
        previous: null,
        proposal: { files: [{ path: 'other.mjs', before: null, after: 'x' }] },
      }),
    ).rejects.toThrow('scope_mismatch');
    await expect(
      f.work(f.writer.runId, {
        action: 'inspect',
        assignmentId: f.assignmentId,
        runId: f.rootRunId,
      }),
    ).rejects.toThrow();
    await expect(
      f.runtime.development.workflow(
        {
          ...f.base,
          runId: f.writer.runId,
          worker: { ...f.worker, leaseToken: randomUUID() },
          context: f.context,
          arguments: { action: 'inspect', assignmentId: f.assignmentId },
          requestId: randomUUID(),
        },
        f.storage,
      ),
    ).rejects.toThrow();
  });
  it('retries publication/merge idempotently and supersedes old proposal versions', async () => {
    const f = await setup(),
      id = randomUUID(),
      proposal = await f.propose(undefined, null, id);
    expect(await f.propose(undefined, null, id)).toEqual(proposal);
    const corrected = await f.propose('console.log("corrected");', proposal);
    await expect(f.merge(proposal)).rejects.toThrow('artifact_mismatch');
    const mergeId = randomUUID(),
      args = { action: 'merge', expectedHead: f.seed, proposals: [corrected] };
    const first = await f.work(f.rootRunId, args, mergeId);
    expect(await f.work(f.rootRunId, args, mergeId)).toEqual(first);
    await expect(f.propose('again', corrected)).rejects.toThrow('forbidden');
  });
  it('a failed test cannot be accepted and a revise decision blocks delivery even with another accept', async () => {
    const f = await setup(),
      p = await f.prepare();
    const failedId = await f.receipt(
      await f.command(p.tester.runId, p.head),
      1,
    );
    await expect(
      f.work(p.reviewer.runId, {
        action: 'review',
        candidate: p.head,
        operationId: failedId,
        verdict: 'accept',
        summary: 'Trust me',
      }),
    ).rejects.toThrow('test_evidence_required');
    await f.work(p.reviewer.runId, {
      action: 'review',
      candidate: p.head,
      operationId: failedId,
      verdict: 'revise',
      summary: 'Test failed',
    });
    const passedId = await f.receipt(await f.command(p.tester.runId, p.head)),
      reviewId = randomUUID();
    await f.work(
      p.reviewer.runId,
      {
        action: 'review',
        candidate: p.head,
        operationId: passedId,
        verdict: 'accept',
        summary: 'Second run passes',
      },
      reviewId,
    );
    await expect(
      f.work(f.rootRunId, { action: 'deliver', candidate: p.head, reviewId }),
    ).rejects.toThrow('revision_required');
  });
  it('test assignment cannot be borrowed by a sibling or used for a different version', async () => {
    const f = await setup(),
      p = await f.prepare();
    await expect(f.command(p.reviewer.runId, p.head)).rejects.toThrow(
      'assistant_authority_changed',
    );
    await expect(f.command(p.tester.runId, f.seed)).rejects.toThrow(
      'bridge_authority_changed',
    );
    await expect(
      f.work(f.rootRunId, {
        action: 'assign',
        role: 'review',
        ownerRunId: p.tester.runId,
        expectedHead: p.head,
      }),
    ).resolves.toMatchObject({ assigned: true });
    const op = await f.receipt(await f.command(p.tester.runId, p.head));
    await expect(
      f.work(p.tester.runId, {
        action: 'review',
        candidate: p.head,
        operationId: op,
        verdict: 'accept',
        summary: 'My own test',
      }),
    ).rejects.toThrow('independent_reviewer_required');
  });
  it('rolls a failed pre-dispatch assignment back with its child, message and launch budget', async () => {
    const f = await setup();
    const before =
      await f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`;
    const delegationId = randomUUID();
    await expect(
      f.runtime.provision({
        ...f.base,
        parentRunId: f.rootRunId,
        delegationId,
        label: 'invalid assignment',
        text: 'Never dispatch',
        tools: ['assistant.development', 'assistant.report'],
        prepare: async (tx, runId) => {
          await f.runtime.development.workflow(
            {
              ...f.base,
              runId: f.rootRunId,
              context: f.context,
              requestId: delegationId,
              arguments: {
                action: 'assign',
                role: 'test',
                ownerRunId: runId,
                expectedHead: { ...f.seed, digest: hash('stale') },
              },
            },
            f.storage,
            tx,
          );
        },
      }),
    ).rejects.toThrow('head_conflict');
    expect(
      await f.db`select run_id from allrice_assistant_instances where delegation_id=${delegationId}`,
    ).toHaveLength(0);
    expect(
      await f.db`select input_id from allrice_assistant_messages where input_id=${delegationId}`,
    ).toHaveLength(0);
    expect(
      await f.db`select metric,spent,reserved from allrice_runtime_budgets where root_run_id=${f.rootRunId} order by metric`,
    ).toEqual(before);
  });
  it('retains review and delivery evidence after rebuilding the runtime, without permitting resumed completed writers', async () => {
    const f = await setup(),
      p = await f.prepare(),
      operationId = await f.receipt(await f.command(p.tester.runId, p.head)),
      reviewId = randomUUID();
    await f.work(
      p.reviewer.runId,
      {
        action: 'review',
        candidate: p.head,
        operationId,
        verdict: 'accept',
        summary: 'Exact version',
      },
      reviewId,
    );
    const runtime = createAssistantRuntime({
      database: f.db,
      authorize: assertAssistantAuthority,
    });
    const args = {
      ...f.base,
      runId: f.rootRunId,
      context: f.context,
      requestId: randomUUID(),
      arguments: { action: 'deliver', candidate: p.head, reviewId },
    };
    const first = await runtime.development.workflow(args, f.storage);
    expect(await runtime.development.workflow(args, f.storage)).toEqual(first);
    expect(
      await f.db`select artifact_id from allrice_development_deliveries where root_run_id=${f.rootRunId}`,
    ).toHaveLength(1);
    await expect(f.propose()).rejects.toThrow();
    await expect(
      f.db`update allrice_development_reviews set verdict='revise' where id=${reviewId}`,
    ).rejects.toThrow('immutable');
  });
  it('revocation and cancellation invalidate new commands and final delivery, not the historical receipts', async () => {
    const f = await setup(),
      p = await f.prepare(),
      operationId = await f.receipt(await f.command(p.tester.runId, p.head)),
      reviewId = randomUUID();
    await f.work(
      p.reviewer.runId,
      {
        action: 'review',
        candidate: p.head,
        operationId,
        verdict: 'accept',
        summary: 'Exact version',
      },
      reviewId,
    );
    await f.runtime.cancelChild(f.requestContext, {
      runId: f.rootRunId,
      childRunId: p.reviewer.runId,
      requestId: randomUUID(),
    });
    await expect(
      f.work(f.rootRunId, { action: 'deliver', candidate: p.head, reviewId }),
    ).rejects.toThrow('canceled');
    expect(
      await f.db`select id from allrice_development_reviews where id=${reviewId}`,
    ).toHaveLength(1);
    await f.db`update allrice_memberships set active=false where user_id=${f.user}`;
    await expect(f.work(f.rootRunId, { action: 'inspect' })).rejects.toThrow(
      'authority_denied',
    );
  });
  it('a corrected head cannot reuse the old review or command and an unverified head cannot finish successfully', async () => {
    const f = await setup(),
      p = await f.prepare(),
      operationId = await f.receipt(await f.command(p.tester.runId, p.head)),
      reviewId = randomUUID();
    await f.work(
      p.reviewer.runId,
      {
        action: 'review',
        candidate: p.head,
        operationId,
        verdict: 'accept',
        summary: 'Exact version',
      },
      reviewId,
    );
    const assignmentId = randomUUID();
    await f.work(
      f.rootRunId,
      {
        action: 'assign',
        role: 'edit',
        ownerRunId: f.rootRunId,
        expectedHead: p.head,
        paths: ['test.mjs'],
      },
      assignmentId,
    );
    const proposal = (await f.work(f.rootRunId, {
      action: 'publish',
      assignmentId,
      previous: null,
      proposal: {
        files: [
          {
            path: 'test.mjs',
            before: 'console.log("candidate");',
            after: 'console.log("corrected head");',
          },
        ],
      },
    })) as DevelopmentArtifactRef;
    const merged = (await f.work(f.rootRunId, {
      action: 'merge',
      expectedHead: p.head,
      proposals: [proposal],
    })) as { head: DevelopmentArtifactRef };
    await expect(
      f.work(f.rootRunId, { action: 'deliver', candidate: p.head, reviewId }),
    ).rejects.toThrow('head_conflict');
    await expect(
      f.work(f.rootRunId, {
        action: 'deliver',
        candidate: merged.head,
        reviewId,
      }),
    ).rejects.toThrow('accepted_review_required');
    await expect(f.command(p.tester.runId, merged.head)).rejects.toThrow(
      'unavailable',
    );
    await f.work(f.rootRunId, {
      action: 'assign',
      role: 'review',
      ownerRunId: p.reviewer.runId,
      expectedHead: merged.head,
    });
    await expect(
      f.work(p.reviewer.runId, {
        action: 'review',
        candidate: merged.head,
        operationId,
        verdict: 'accept',
        summary: 'reuse old test',
      }),
    ).rejects.toThrow('test_evidence_required');
    await expect(f.runtime.finalizeRoot(f.base)).resolves.not.toMatchObject({
      status: 'completed',
    });
  });
});
