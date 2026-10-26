/* global AbortController */
import { beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
const ports = vi.hoisted(() => ({
  read: vi.fn(),
  readOrigin: vi.fn(),
  finalize: vi.fn(),
  configure: vi.fn(),
  createRoot: vi.fn(),
  createGuard: vi.fn(),
  runtimeOptions: vi.fn(),
  authority: vi.fn(),
  tree: vi.fn(),
  closePreparation: vi.fn(),
  guard: undefined,
}));
vi.mock('@allrice/database', async (importOriginal) => ({
  ...(await importOriginal()),
  assistantRuntimeEnabled: () => true,
  createAssistantRuntime: (options) => {
    ports.runtimeOptions(options);
    return {
      configureRoot: ports.configure,
      assertCurrentAuthority: ports.authority,
      getTree: ports.tree,
      closeUndispatchedModelPreparation: ports.closePreparation,
      readFinalDeliveryEvidence: ports.read,
      readFinalDeliveryReplyOrigin: ports.readOrigin,
      finalizeRoot: ports.finalize,
      readFailureUsage: vi.fn(),
      createFinalDeliveryCommitGuard: ports.createGuard,
    };
  },
  createRuntimeOperationLedger: () => ({ createRoot: ports.createRoot }),
}));
vi.mock('../../src/harness/dsh/assistant-bridge.ts', () => ({
  createAssistantWorkerBridge: () => ({
    handle: vi.fn(),
    cancellation: vi.fn(),
    cancel: vi.fn(),
  }),
}));
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.ts';
import { runtimePolicyDigest } from '@allrice/database';

import {
  attachCheckedFinalDelivery,
  beginCheckedFinalDeliveryExecution,
  requireCheckedFinalDelivery,
  transferCheckedFinalDeliveryForExecution,
  readCheckedFinalDeliveryForExecution,
} from '../../src/final-delivery/checked-delivery.ts';
const ARTIFACT_ID = 'sha256:' + 'a'.repeat(64);
const hash = (text) =>
  'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
beforeEach(() => {
  vi.clearAllMocks();
  ports.authority.mockResolvedValue({ cancelRequested: false });
  ports.tree.mockResolvedValue({
    budgets: [
      // Same shape as getTree under the observed-usage policy.
      {
        metric: 'model_calls',
        capacity: 12,
        reserved: 1,
        spent: 2,
        enforced: false,
      },
      {
        metric: 'output_tokens',
        capacity: 4096,
        reserved: 100,
        spent: 200,
        enforced: false,
      },
    ],
  });
  ports.closePreparation.mockImplementation(async ({ callId }) => ({
    closed: true,
    callId,
    alreadyClosed: false,
  }));
  ports.guard = Object.freeze({ assertCurrent: vi.fn() });
  ports.createGuard.mockReturnValue(ports.guard);
  ports.finalize.mockResolvedValue({
    status: 'completed',
    usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 },
    usageComplete: true,
    cacheUsageKnown: false,
    costEstimateAvailable: false,
  });
});
async function fixture(options = {}) {
  const mode = Object.hasOwn(options, 'mode')
      ? options.mode
      : 'checked_native_v1',
    priorRoot = options.priorRoot ?? false;
  const scope = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
  };
  const configuration = {
    version: 1,
    mode: 'daily',
    allowAssistants: true,
    maxConcurrent: 2,
    maxDepth: 1,
    maxChildren: 4,
  };
  const worker = {
    workerId: randomUUID(),
    jobId: randomUUID(),
    leaseToken: 'private-worker-secret',
    fence: 9,
  };
  const queries = [];
  const database = async (strings, ...values) => {
    const query = strings.join('?');
    queries.push({ query, values });
    if (query.startsWith('select a.worker_lease_digest'))
      return priorRoot
        ? [
            {
              worker_lease_digest: runtimePolicyDigest(worker.leaseToken),
              generation: 7,
            },
          ]
        : [];
    if (query.includes('select r.execution_spec'))
      return [
        {
          execution_spec: { frozen: true },
          employee_version_id: randomUUID(),
          session_id: scope.sessionId,
          timeout_at: new Date(Date.now() + 300_000),
          attempt: 1,
          configuration,
          project_id: null,
          provider_snapshot: {
            provider: 'dsh',
            authMode: 'allrice_credential',
            route: 'openai-compatible',
            model: 'fixture',
            reasoningEffort: 'high',
            credentialReference: 'test:fixture',
            baseUrl: 'https://fixture.invalid/v1',
          },
        },
      ];
    throw Error('Unexpected query');
  };
  const signal = new AbortController();
  const controller = productionAssistantController({
    configuration,
    deliveryMode: mode,
    ...(mode === 'checked_native_v1'
      ? { deliveryArtifactId: ARTIFACT_ID }
      : {}),
    context: {
      runId: scope.runId,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      delegatedBy: { id: scope.ownerId },
      policySnapshot: { memberships: [] },
      startedAt: '2026-10-19T10:00:00Z',
    },
    worker,
    runLimits: {},
    tools: [{ name: 'assistant.delegate' }],
    authorize: async () => {},
    database,
    signal: signal.signal,
  });
  const bound = await controller.bind('dsh-controller-fixture', 7);
  const facts = {
    scope,
    complete: true,
    authorization: 'current',
    now: '2026-10-19T10:00:00Z',
    ownedRunIds: [scope.runId],
    explicitReferenceVersionIds: [],
    artifacts: [],
    checks: [],
    requirements: [],
  };
  ports.read.mockResolvedValue(facts);
  const candidate = {
    nativeText: '本轮结果已保留。',
    projectedText: '本轮结果已保留。',
    nativeSessionId: 'dsh-controller-fixture',
    publicMessageId: randomUUID(),
    durableSeq: 13,
    nativeBindingId: randomUUID(),
    rootRunId: scope.runId,
    attempt: 1,
    generation: 7,
  };
  const proof = (decision) => ({
    nativeSessionId: candidate.nativeSessionId,
    publicMessageId: candidate.publicMessageId,
    durableSeq: candidate.durableSeq,
    nativeBindingId: candidate.nativeBindingId,
    nativeCandidateDigest: hash(candidate.nativeText),
    candidateDigest: decision.candidateDigest,
    factSetDigest: decision.factSetDigest,
    attempt: 1,
    generation: 7,
  });
  return {
    scope,
    worker,
    bound,
    facts,
    candidate,
    proof,
    queries,
    signal,
    controller,
  };
}

it('uses actual controller/policy with bound root/Job/fence and forwards the identical private proof', async () => {
  const h = await fixture();
  const decision = await h.bound.finalDelivery.check(h.candidate);
  expect(decision.status).toBe('valid');
  expect(ports.read).toHaveBeenCalledExactlyOnceWith({
    scope: {
      organizationId: h.scope.organizationId,
      workspaceId: h.scope.workspaceId,
      projectId: null,
    },
    rootRunId: h.scope.runId,
    worker: { ...h.worker, generation: 7 },
  });
  const proof = h.proof(decision);
  await expect(h.bound.finish(proof)).resolves.toMatchObject({
    status: 'completed',
  });
  expect(ports.finalize).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      rootRunId: h.scope.runId,
      worker: { ...h.worker, generation: 7 },
      finalDelivery: proof,
    }),
  );
  expect(
    runtimePolicyDigest(ports.finalize.mock.calls[0][0].finalDelivery),
  ).toBe(runtimePolicyDigest(proof));
  await expect(h.bound.finish(proof)).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(ports.finalize).toHaveBeenCalledOnce();
});

it.each([
  { nativeSessionId: 'other' },
  { rootRunId: randomUUID() },
  { generation: 8 },
  { attempt: 2 },
  { publicMessageId: undefined },
  { durableSeq: undefined },
  { nativeBindingId: undefined },
  { projectedText: 'rewritten output' },
])(
  'rejects stale or absent identity before evidence read %j',
  async (change) => {
    const h = await fixture();
    await expect(
      h.bound.finalDelivery.check({ ...h.candidate, ...change }),
    ).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
    expect(ports.read).not.toHaveBeenCalled();
    expect(ports.finalize).not.toHaveBeenCalled();
  },
);

it('allows one deterministic validation and refuses a substituted finalization digest', async () => {
  const h = await fixture();
  const decision = await h.bound.finalDelivery.check(h.candidate);
  await expect(h.bound.finalDelivery.check(h.candidate)).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  await expect(
    h.bound.finish({
      ...h.proof(decision),
      factSetDigest: 'sha256:' + '0'.repeat(64),
    }),
  ).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(ports.read).toHaveBeenCalledOnce();
  expect(ports.finalize).not.toHaveBeenCalled();
});

it('checks original and normalized text against the same exact object facts', async () => {
  const h = await fixture(),
    objectId = randomUUID(),
    versionId = randomUUID();
  h.facts.artifacts = [
    {
      objectId,
      versionId,
      checksum: 'a'.repeat(64),
      scope: {
        organizationId: h.scope.organizationId,
        workspaceId: h.scope.workspaceId,
        ownerId: h.scope.ownerId,
        sessionId: h.scope.sessionId,
      },
      originRunId: h.scope.runId,
      fileName: 'data.csv',
      state: 'ready',
      immutable: true,
      deletedAt: null,
      retentionUntil: null,
    },
  ];
  h.candidate.nativeText = `[data.csv](sandbox:/api/v1/files/${objectId})`;
  h.candidate.projectedText = `[data.csv](/api/v1/files/${objectId})`;
  const decision = await h.bound.finalDelivery.check(h.candidate);
  expect(decision.status).toBe('valid');
  expect(decision.linked).toEqual([
    { objectId, versionId, checksum: 'sha256:' + 'a'.repeat(64) },
  ]);
  await h.bound.finish(h.proof(decision));
  expect(ports.finalize.mock.calls[0][0].finalDelivery).toMatchObject({
    nativeCandidateDigest: hash(h.candidate.nativeText),
    candidateDigest: hash(h.candidate.projectedText),
  });
});

it('keeps invalid original text and artifacts while refusing finalization', async () => {
  const h = await fixture();
  h.candidate.nativeText = '[file](/api/v1/files/not-an-id)';
  h.candidate.projectedText = h.candidate.nativeText;
  const frozen = JSON.stringify(h.facts),
    original = h.candidate.nativeText;
  const decision = await h.bound.finalDelivery.check(h.candidate);
  expect(decision.status).toBe('invalid_response');
  await expect(h.bound.finish(h.proof(decision))).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(JSON.stringify(h.facts)).toBe(frozen);
  expect(h.candidate.nativeText).toBe(original);
  expect(ports.finalize).not.toHaveBeenCalled();
});

it('signal cancellation between policy and controller finish prevents any finalization', async () => {
  const h = await fixture();
  const decision = await h.bound.finalDelivery.check(h.candidate),
    reason = Error('explicit cancellation');
  h.signal.abort(reason);
  await expect(h.bound.finish(h.proof(decision))).rejects.toBe(reason);
  expect(ports.finalize).not.toHaveBeenCalled();
});

it('actual controller selects checked runtime and binds the exact returned guard after finalize resolves', async () => {
  const h = await fixture(),
    decision = await h.bound.finalDelivery.check(h.candidate),
    proof = h.proof(decision);
  await h.bound.finish(proof);
  expect(ports.runtimeOptions).toHaveBeenCalledWith(
    expect.objectContaining({ checkedDelivery: true }),
  );
  expect(ports.createGuard).toHaveBeenCalledExactlyOnceWith(
    ports.finalize.mock.calls[0][0],
  );
  expect(ports.finalize.mock.invocationCallOrder[0]).toBeLessThan(
    ports.createGuard.mock.invocationCallOrder[0],
  );
  const scope = {},
    source = { answer: h.candidate.projectedText },
    output = { ...source };
  beginCheckedFinalDeliveryExecution(scope);
  requireCheckedFinalDelivery(scope);
  attachCheckedFinalDelivery(source, proof);
  transferCheckedFinalDeliveryForExecution(scope, source, output);
  const delivery = readCheckedFinalDeliveryForExecution(scope, output);
  expect(delivery.checkedDelivery).toBe(ports.guard);
  expect(JSON.stringify(output)).not.toContain('checkedDelivery');
  expect(JSON.stringify(output)).not.toContain(proof.nativeBindingId);
});
it('actual controller cannot mint a guard before finalize resolves', async () => {
  const h = await fixture(),
    decision = await h.bound.finalDelivery.check(h.candidate),
    proof = h.proof(decision);
  let release;
  ports.finalize.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = h.bound.finish(proof);
  await vi.waitFor(() => expect(ports.finalize).toHaveBeenCalledOnce());
  expect(ports.createGuard).not.toHaveBeenCalled();
  release({ status: 'completed' });
  await pending;
  expect(ports.createGuard).toHaveBeenCalledOnce();
});
it.each(['factory-throws', 'factory-undefined', 'factory-accessor'])(
  'actual controller rejects unavailable commit guard without legacy success: %s',
  async (kind) => {
    const h = await fixture(),
      decision = await h.bound.finalDelivery.check(h.candidate);
    if (kind === 'factory-throws')
      ports.createGuard.mockImplementationOnce(() => {
        throw Error('private-factory-failure');
      });
    if (kind === 'factory-undefined')
      ports.createGuard.mockReturnValueOnce(undefined);
    if (kind === 'factory-accessor')
      ports.createGuard.mockReturnValueOnce(
        Object.defineProperty({}, 'assertCurrent', {
          get() {
            throw Error('getter must not run');
          },
        }),
      );
    await expect(h.bound.finish(h.proof(decision))).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
    expect(ports.finalize).toHaveBeenCalledOnce();
  },
);
it('actual controller leaves a partial outcome without a commit guard', async () => {
  const h = await fixture(),
    decision = await h.bound.finalDelivery.check(h.candidate);
  ports.finalize.mockResolvedValueOnce({ status: 'partial' });
  await expect(h.bound.finish(h.proof(decision))).resolves.toMatchObject({
    status: 'partial',
  });
  expect(ports.createGuard).not.toHaveBeenCalled();
});

it('explicit legacy keeps runtime and finalization legacy; no checked key or capability is synthesized', async () => {
  const h = await fixture({ mode: 'legacy', priorRoot: true });
  expect(h.controller.deliveryMode).toBe('legacy');
  expect(h.bound.hasPriorRoot).toBe(true);
  expect(h.bound.finalDelivery).toBeUndefined();
  await expect(h.bound.finish()).resolves.toMatchObject({
    status: 'completed',
  });
  expect(ports.runtimeOptions).toHaveBeenCalledWith(
    expect.objectContaining({ checkedDelivery: false }),
  );
  expect(Object.hasOwn(ports.finalize.mock.calls[0][0], 'finalDelivery')).toBe(
    false,
  );
  expect(ports.createGuard).not.toHaveBeenCalled();
  await expect(
    Promise.resolve().then(() => h.bound.readFinalDeliveryReplyOrigin()),
  ).rejects.toMatchObject({ code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE' });
  expect(ports.readOrigin).not.toHaveBeenCalled();
});
it('absence or unknown mode cannot silently select legacy for an assistant root', async () => {
  for (const mode of [undefined, null, 'checked_native_v0'])
    await expect(fixture({ mode })).rejects.toMatchObject({
      code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
      retryable: false,
    });
});
it('same-lease prior root is admitted and its origin reader binds actual native identity, attempt and fence', async () => {
  const h = await fixture({ priorRoot: true });
  expect(h.bound.hasPriorRoot).toBe(true);
  const origin = {
    schemaVersion: 1,
    rootRunId: h.scope.runId,
    nativeSessionId: h.candidate.nativeSessionId,
    starts: [],
  };
  ports.readOrigin.mockResolvedValue(origin);
  await expect(h.bound.readFinalDeliveryReplyOrigin()).resolves.toBe(origin);
  expect(ports.readOrigin).toHaveBeenCalledExactlyOnceWith({
    scope: {
      organizationId: h.scope.organizationId,
      workspaceId: h.scope.workspaceId,
      projectId: null,
    },
    rootRunId: h.scope.runId,
    worker: { ...h.worker, generation: 7 },
    nativeSessionId: h.candidate.nativeSessionId,
    attempt: 1,
  });
  expect(ports.finalize).not.toHaveBeenCalled();
});
it('checked repair uses the real frozen provider and calls current authority and root budgets', async () => {
  const h = await fixture({ priorRoot: true });
  expect(h.controller.deliveryArtifactId).toBe(ARTIFACT_ID);
  const candidate = {
    nativeSessionId: h.candidate.nativeSessionId,
    turn: 1,
    publicMessageId: h.candidate.publicMessageId,
    durableSeq: h.candidate.durableSeq,
    text: h.candidate.nativeText,
    candidateDigest: hash(h.candidate.nativeText),
    provider: 'openai-compatible',
    model: 'fixture',
  };
  expect(await h.bound.deliveryRepair.inspect(candidate)).toMatchObject({
    decision: 'pass',
  });
  expect(
    await h.bound.deliveryRepair.authorize({ phase: 'propose', candidate }),
  ).toMatchObject({
    allowed: true,
    runId: h.scope.runId,
    generation: 7,
    attempt: 1,
    workerLeaseDigest: hash(h.worker.leaseToken),
    provider: 'openai-compatible',
    model: 'fixture',
    remainingModelCalls: 12,
    remainingOutputTokens: 4096,
  });
  expect(ports.authority).toHaveBeenCalledTimes(4);
  expect(ports.authority).toHaveBeenCalledWith({
    scope: {
      organizationId: h.scope.organizationId,
      workspaceId: h.scope.workspaceId,
      projectId: null,
    },
    rootRunId: h.scope.runId,
    worker: { ...h.worker, generation: 7 },
  });
  expect(ports.tree).toHaveBeenCalledExactlyOnceWith(expect.any(Object), {
    runId: h.scope.runId,
  });
  const callId = randomUUID();
  expect(
    await h.bound.deliveryRepair.closePreparation({
      nativeSessionId: h.candidate.nativeSessionId,
      callId,
    }),
  ).toEqual({ closed: true, callId, alreadyClosed: false });
  expect(ports.closePreparation).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      rootRunId: h.scope.runId,
      runId: h.scope.runId,
      callId,
      worker: { ...h.worker, generation: 7 },
    }),
  );
});
it('checked repair does not bypass a current canceled authority response', async () => {
  const h = await fixture({ priorRoot: true });
  ports.authority.mockResolvedValueOnce({ cancelRequested: true });
  await expect(
    h.bound.deliveryRepair.inspect({
      nativeSessionId: h.candidate.nativeSessionId,
      turn: 1,
      publicMessageId: h.candidate.publicMessageId,
      durableSeq: h.candidate.durableSeq,
      text: h.candidate.nativeText,
      candidateDigest: hash(h.candidate.nativeText),
      provider: 'openai-compatible',
      model: 'fixture',
    }),
  ).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(ports.read).not.toHaveBeenCalled();
  expect(ports.tree).not.toHaveBeenCalled();
});
it('checked mode cannot finalize without a fresh validated proof even for an existing root', async () => {
  const h = await fixture({ priorRoot: true });
  await expect(h.bound.finish()).rejects.toMatchObject({
    code: 'FINAL_DELIVERY_EVIDENCE_UNAVAILABLE',
    retryable: false,
  });
  expect(ports.finalize).not.toHaveBeenCalled();
});
