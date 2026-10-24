import {
  classifyReviewedTestChatCloudCarry,
  observeReviewedTestChatQuiescence,
  collectReviewedTestChatRound,
  reviewedTestChatPhysicalScope,
  REVIEWED_TEST_CHAT_REVIEW_KIND,
} from './reviewed-test-chat-preserved-cloud.mjs';
import { readFileSync } from 'node:fs';
import {
  HISTORICAL_EXITED_CONTAINER as E,
  exitedContainerEvidenceDigest as factDigest,
  nativeCloudInventoryIdentity,
} from './retirement-preserved-cloud.mjs';
import { describe, expect, it } from 'vitest';
import { HISTORICAL_CLOUD as H } from './terminal-retirement-preserved-cloud.mjs';

const clone = (v) => globalThis.structuredClone(v);
const digest = 'sha256:' + 'c'.repeat(64);
const artifact =
  'sha256:76c014931795dc22967bcc5e1e44cb722f6575ce22fe6a2408d4eeae90de9998';
const zero = () => ({ jobs: 0, clouds: 0, tests: 0, leases: 0, auth: 0 });
function proof() {
  // Synthetic process identities/hashes are deliberate. The production loader
  // obtains the baseline only from the hard-pinned, root-reviewed reader/file.
  const plan = {
    schemaVersion: 1,
    kind: 'development-terminal-test-retirement',
    requestId: '11111111-1111-4111-8111-111111111111',
    digest,
    authorizationEvidenceDigest: digest,
    snapshots: [
      'd04715cd-9355-4fe4-b0e5-ae7eab360275',
      'd81a23d5-fab3-40fe-aa91-37579f1e1149',
    ].map((id) => ({
      scope: {
        contextKind: 'platform_employee_test',
        contextId: id,
        organizationId: '20f7df77-1792-4cb1-bacc-7c90e9091b45',
        workspaceId: 'd6f88c29-1579-4aab-be4f-ff379a558d83',
        ownerId: 'b5f3f49b-f188-4db1-bdad-82c94304d787',
      },
      archived: true,
      origin: { artifactId: artifact },
    })),
  };
  const identities = ['web', 'worker'].map((service, index) => ({
    service,
    sourceSha: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    manifestDigest: digest,
    environment: 'dev',
    bootId: 'synthetic-' + service,
    pid: 100 + index,
    startedAt: '2026-10-24T00:00:00.000Z',
  }));
  const healths = identities.map((identity) => ({
    identity: clone(identity),
    producerLifecycle: {
      role: identity.service,
      instance: { bootId: identity.bootId },
      releaseAdmission: 'disabled',
      unknownOutcomes: [],
      activeRoots: 0,
      pendingRoots: 0,
      unresolvedRoots: 0,
      retainedChildren: 0,
    },
  }));
  const review = {
    kind: 'allrice-dev-terminal-nonchat-retirement-review',
    enabled: true,
    terminalScopes: plan.snapshots.map((s) => clone(s.scope)),
    serviceIdentities: clone(identities),
    authorizationEvidenceDigest: digest,
    rootReviewed: true,
    reviewedBy: 'root',
    releaseSha: identities[0].sourceSha,
    sourceTree: identities[0].sourceTree,
    historicalCloudCarry: {
      kind: 'allrice-dev-terminal-nonchat-exact-cloud-v1',
      authorizationEvidenceDigest: digest,
      reviewedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      enabled: true,
      rootReviewed: true,
      requestId: plan.requestId,
      planDigest: digest,
      readerPin: clone(H.readerPin),
      baselinePin: clone(H.baselinePin),
      serviceIdentities: clone(identities),
    },
  };
  const snapshot = {
    scope: { database: 'allrice_dev', schema: 'public', readOnly: 'on' },
    uncleanedOperationIds: [H.operationId],
    attempt: {
      operationId: H.operationId,
      containerId: null,
      outcomeIsNull: true,
      cleanupConfirmedAt: null,
      rowSha256: '1'.repeat(64),
    },
    operation: {
      operationId: H.operationId,
      runId: H.runId,
      rootRunId: H.runId,
      attemptId: H.attemptId,
      status: 'unknown',
      leaseExpired: true,
      rowSha256: '2'.repeat(64),
    },
    input: {
      operationId: H.operationId,
      runId: H.runId,
      jobId: H.jobId,
      attemptId: H.attemptId,
      rowSha256: '3'.repeat(64),
    },
    job: {
      id: H.jobId,
      runId: H.runId,
      status: 'failed',
      leaseExpired: true,
      rowSha256: '4'.repeat(64),
    },
    run: {
      id: H.runId,
      state: 'failed',
      completedAt: '2026-10-23T04:13:37Z',
      rowSha256: '5'.repeat(64),
    },
    receipts: {
      count: 2,
      ids: ['receipt-1', 'receipt-2'],
      rowsSha256: '6'.repeat(64),
    },
  };
  const physical = {
    configuredSocket: '/synthetic/cloud.sock',
    realSocket: '/synthetic/cloud.sock',
    device: 1,
    inode: 2,
    dockerId: 'synthetic-docker',
    dockerVersion: '29.5.2',
    vm: {
      bootId: 'synthetic-vm',
      invocationId: '7'.repeat(32),
      mainPid: '123',
      startMonotonic: '456',
    },
    containerName: 'allrice-cloud-' + H.attemptId,
    nameProbeStatus: 404,
    labelProbeStatus: 200,
    labelMatchIds: [],
  };
  const baseline = {
    enabled: true,
    rootReviewed: true,
    historicalOutcomeKnown: false,
    cleanupClaimed: false,
    globalResourceIdleProven: false,
    scope: {
      operationId: H.operationId,
      runId: H.runId,
      jobId: H.jobId,
      attemptId: H.attemptId,
    },
    snapshot: clone(snapshot),
    physical: clone(physical),
  };
  return {
    plan,
    review,
    baseline,
    before: clone(snapshot),
    after: clone(snapshot),
    rawBefore: { ...zero(), clouds: 1 },
    rawAfter: { ...zero(), clouds: 1 },
    healthBefore: clone(healths),
    healthAfter: clone(healths),
    physicalBefore: clone(physical),
    physicalAfter: clone(physical),
    inventory: { socketPath: physical.configuredSocket, status: 200, body: [] },
  };
}

const raw = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/native-control-cloud-inventory.actual.fixture.json',
      import.meta.url,
    ),
  ),
);
const identity = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/native-control-exited-identity.actual.fixture.json',
      import.meta.url,
    ),
  ),
);
function subject(kind = 'platform_employee_test') {
  const s = proof(),
    now = Date.now();
  for (const item of s.plan.snapshots) item.scope.contextKind = kind;
  s.review.terminalScopes = clone(s.plan.snapshots.map((item) => item.scope));
  for (const v of [
    ...s.review.serviceIdentities,
    ...s.review.historicalCloudCarry.serviceIdentities,
    ...s.healthBefore.map((h) => h.identity),
    ...s.healthAfter.map((h) => h.identity),
  ])
    v.startedAt = new Date(now - 300_000).toISOString();
  s.verifierSha256 = 'e'.repeat(64);
  s.sharedVerifierSha256 = 'f'.repeat(64);
  s.inventory = {
    ...clone(raw),
    socketPath: s.physicalBefore.configuredSocket,
  };
  const target = raw.body.find((row) => row.Id === E.id);
  // Real old projection/list; the complete response is synthetic and is never
  // presented as a fresh Docker GET or an actual terminal retirement.
  const body = {
    Id: identity.id,
    Name: identity.name,
    Created: identity.created,
    State: clone(identity.state),
    Image: target.ImageID,
    Config: { Labels: clone(identity.labels) },
    HostConfig: {
      RestartPolicy: clone(identity.restartPolicy),
      AutoRemove: identity.autoRemove,
      NetworkMode: identity.networkMode,
    },
    Mounts: clone(target.Mounts),
  };
  const observedAt = new Date(now - 1000).toISOString();
  const observation = {
    observedAt,
    baseline: {
      historical: { notTouchingUnknownOtherContainer: E.attemptId },
      inspect: clone(identity),
      inventory: clone(s.inventory),
    },
    inspectBefore: {
      socketPath: s.inventory.socketPath,
      status: 200,
      body: clone(body),
    },
    inspectAfter: {
      socketPath: s.inventory.socketPath,
      status: 200,
      body: clone(body),
    },
    inventoryAfter: clone(s.inventory),
  };
  s.exitedObservation = clone(observation);
  const namespaces = ['/synthetic/one/sessions', '/synthetic/two/sessions'];
  s.physicalProof = {
    kind: 'terminal-native-physical-absence-v1',
    requestId: s.plan.requestId,
    planDigest: s.plan.digest,
    scopeDigest: digest,
    storageNamespaces: namespaces,
    nativeProcesses: [],
    writers: [],
    workerBootId: s.review.serviceIdentities[1].bootId,
    workerBootStartedAt: s.review.serviceIdentities[1].startedAt,
    sourceSha: s.review.releaseSha,
    sourceTree: s.review.sourceTree,
    observedAt,
    expiresAt: new Date(now + 60_000).toISOString(),
    artifactRoots: [{ artifactId: artifact, root: '/synthetic/artifact' }],
    writerScopes: [{ artifactId: artifact, root: '/synthetic' }],
  };
  s.recordedExitedObservation = {
    kind: 'terminal-exact-exited-cloud-observation-v1',
    requestId: s.plan.requestId,
    planDigest: s.plan.digest,
    nonce: '11111111-1111-4111-8111-111111111111',
    physicalScopeDigest: digest,
    storageNamespaces: clone(namespaces),
    observedAt,
    expiresAt: new Date(now + 60_000).toISOString(),
    physical: clone(s.physicalBefore),
    inventory: clone(s.inventory),
    observation: clone(observation),
    verifierSha256: s.verifierSha256,
    sharedVerifierSha256: s.sharedVerifierSha256,
  };
  s.review.historicalCloudCarry.preservedExitedContainer = {
    kind: 'allrice-dev-terminal-nonchat-exact-exited-container-v1',
    enabled: true,
    rootReviewed: true,
    reviewedBy: 'root',
    requestId: s.plan.requestId,
    planDigest: s.plan.digest,
    authorizationEvidenceDigest: s.plan.authorizationEvidenceDigest,
    terminalScopes: clone(s.review.terminalScopes),
    containerId: E.id,
    containerName: E.name,
    releaseSha: s.review.releaseSha,
    sourceTree: s.review.sourceTree,
    serviceIdentityDigest: factDigest(s.review.serviceIdentities),
    physicalScopeDigest: digest,
    storageNamespaces: clone(namespaces),
    artifactRootsDigest: factDigest(s.physicalProof.artifactRoots),
    writerScopesDigest: factDigest(s.physicalProof.writerScopes),
    nonce: s.recordedExitedObservation.nonce,
    verifierSha256: s.verifierSha256,
    sharedVerifierSha256: s.sharedVerifierSha256,
    observationPin: {
      path: '/synthetic/private600-observation.json',
      sha256: 'a'.repeat(64),
    },
    reviewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    inventoryDigest: factDigest(nativeCloudInventoryIdentity(s.inventory)),
    inspectDigest: factDigest(body),
    physicalIdentityDigest: factDigest(s.physicalBefore),
    historicalPin: clone(E.historicalPin),
    inspectPin: clone(E.inspectPin),
    inventoryPin: clone(E.inventoryPin),
  };
  return s;
}

function chatSubject() {
  const s = subject();
  s.plan.kind = 'development-test-chat-retirement';
  for (const [i, item] of s.plan.snapshots.entries()) {
    item.scope.contextKind = 'chat';
    item.scope.contextId = '00000000-0000-4000-8000-0000000000' + (11 + i);
    item.origin = {
      ...item.origin,
      contextKind: 'chat',
      contextId: item.scope.contextId,
    };
    item.bindings = [];
  }
  s.review.kind = REVIEWED_TEST_CHAT_REVIEW_KIND;
  s.review.requestId = s.plan.requestId;
  s.review.planDigest = s.plan.digest;
  s.review.developmentTestScopesApproved = true;
  s.review.historicalCloudCarry.kind =
    'allrice-dev-reviewed-test-chat-exact-cloud-v1';
  s.review.historicalCloudCarry.reviewedBy = 'root';
  s.review.historicalCloudCarry.observationNonce =
    s.recordedExitedObservation.nonce;
  s.review.exactDevelopmentTestChats = s.plan.snapshots.map((item, i) => ({
    kind: 'reviewed-development-test-chat-v1',
    classification: 'development_test',
    scope: clone(item.scope),
    authorizationEvidenceDigest: s.plan.authorizationEvidenceDigest,
    scopeEvidenceDigest: digest,
    snapshotDigest: factDigest(item),
    oldArtifactIds: [artifact],
    storageNamespaces: [s.physicalProof.storageNamespaces[i]],
  }));
  s.review.oldArtifactIds = [artifact];
  delete s.review.terminalScopes;
  const scope = reviewedTestChatPhysicalScope(s.review, s.plan);
  s.physicalProof.scopeDigest = scope.digest;
  s.recordedExitedObservation.physicalScopeDigest = scope.digest;
  s.recordedExitedObservation.kind =
    'reviewed-test-chat-exact-exited-cloud-observation-v1';
  s.physicalVerifierSha256 = 'b'.repeat(64);
  s.recordedExitedObservation.physicalVerifierSha256 = s.physicalVerifierSha256;
  const p = s.review.historicalCloudCarry.preservedExitedContainer;
  p.kind = 'allrice-dev-reviewed-test-chat-exact-exited-container-v1';
  p.testChatScopes = clone(scope.scopes);
  p.oldArtifactIds = clone(scope.artifactIds);
  p.physicalScopeDigest = scope.digest;
  p.physicalVerifierSha256 = s.physicalVerifierSha256;
  delete p.terminalScopes;
  return s;
}
describe('future exact reviewed test chats, isolated from the sealed slot5 authority', () => {
  it('accepts explicitly reviewed archived chat IDs outside slot5 while preserving raw6 and unknown', () => {
    const s = chatSubject(),
      original = clone(s);
    expect(classifyReviewedTestChatCloudCarry(s)).toMatchObject({
      exactTestChatScopes: s.plan.snapshots.map((item) => item.scope),
      oldArtifactIds: [artifact],
      preservedExitedContainer: {
        containerId: E.id,
        pid: 0,
        cleanupClaimed: false,
        historicalOutcomeKnown: false,
      },
      databaseWritten: false,
      modelCalls: 0,
    });
    expect(s).toEqual(original);
    expect(s.inventory.body).toHaveLength(6);
  });
  it.each([
    (s) => (s.review.kind = 'allrice-dev-test-chat-retirement-review'),
    (s) => (s.review.kind = 'allrice-dev-terminal-nonchat-retirement-review'),
    (s) => (s.review.kind = 'allrice-dev-native-control-upgrade-review-v1'),
    (s) => (s.review.enabled = false),
    (s) =>
      (s.review.historicalCloudCarry.kind =
        'allrice-dev-test-chat-exact-cloud-v1'),
    (s) => (s.review.exactDevelopmentTestChats[0].classification = 'business'),
    (s) => delete s.review.exactDevelopmentTestChats[0].scopeEvidenceDigest,
    (s) =>
      (s.review.exactDevelopmentTestChats[0].snapshotDigest =
        'sha256:' + '0'.repeat(64)),
    (s) => s.review.exactDevelopmentTestChats.pop(),
    (s) =>
      (s.review.exactDevelopmentTestChats[0].scope.ownerId =
        '00000000-0000-4000-8000-000000000099'),
    (s) => (s.review.oldArtifactIds = ['sha256:' + '0'.repeat(64)]),
    (s) =>
      delete s.review.historicalCloudCarry.preservedExitedContainer
        .observationPin,
    (s) =>
      (s.review.historicalCloudCarry.preservedExitedContainer.observationPin.path =
        'relative.json'),
    (s) =>
      (s.review.historicalCloudCarry.preservedExitedContainer.observationPin.sha256 =
        'changed'),
    (s) =>
      (s.review.exactDevelopmentTestChats[0].oldArtifactIds = [
        'sha256:' + '0'.repeat(64),
      ]),
    (s) =>
      (s.review.exactDevelopmentTestChats[0].storageNamespaces = [
        '/outside/sessions',
      ]),
    (s) => (s.plan.snapshots[0].archived = false),
    (s) => (s.plan.snapshots[0].scope.contextKind = 'platform_employee_test'),
    (s) => (s.plan.authorizationEvidenceDigest = 'sha256:' + '0'.repeat(64)),
    (s) =>
      (s.review.historicalCloudCarry.preservedExitedContainer.kind =
        'allrice-dev-test-chat-retirement-exact-exited-container-v1'),
    (s) =>
      (s.review.historicalCloudCarry.preservedExitedContainer.kind =
        'allrice-dev-terminal-nonchat-exact-exited-container-v1'),
    (s) =>
      (s.review.historicalCloudCarry.preservedExitedContainer.kind =
        'native-control-exact-exited-container-preservation-v1'),
    (s) =>
      (s.review.historicalCloudCarry.preservedExitedContainer.nonce =
        '00000000-0000-4000-8000-000000000099'),
    (s) =>
      s.review.historicalCloudCarry.preservedExitedContainer.testChatScopes.pop(),
    (s) =>
      (s.review.historicalCloudCarry.preservedExitedContainer.physicalVerifierSha256 =
        '0'.repeat(64)),
    (s) =>
      (s.recordedExitedObservation.kind =
        'terminal-exact-exited-cloud-observation-v1'),
    (s) => s.physicalProof.nativeProcesses.push({ pid: 123 }),
    (s) => s.physicalProof.writers.push({ pid: 123 }),
    (s) => (s.physicalProof.workerBootId = 'other'),
    (s) => (s.physicalProof.sourceTree = '0'.repeat(40)),
    (s) => (s.rawAfter.clouds = 2),
    (s) => (s.rawAfter.runtimes = 1),
    (s) => (s.after.operation.status = 'succeeded'),
    (s) => (s.physicalAfter.dockerId = 'other'),
    (s) => (s.exitedObservation.inspectAfter.body.State.Pid = 1),
    (s) =>
      (s.exitedObservation.inspectAfter.body.HostConfig.RestartPolicy.Name =
        'always'),
    (s) => (s.exitedObservation.inspectAfter.body.Mounts[0].RW = false),
  ])(
    'rejects missing authority, mixed role or actual-state drift (%#)',
    (change) => {
      const s = chatSubject();
      change(s);
      expect(() => classifyReviewedTestChatCloudCarry(s)).toThrow();
    },
  );
  it('fixed protected PPT exclusion wins even if submitted root metadata is internally rebound', () => {
    const s = chatSubject(),
      item = s.plan.snapshots[0];
    item.scope.contextId = '68e76b6b-2e75-45b7-b628-951945b12044';
    item.origin.contextId = item.scope.contextId;
    s.review.exactDevelopmentTestChats[0].scope = clone(item.scope);
    s.review.exactDevelopmentTestChats[0].snapshotDigest = factDigest(item);
    expect(() => reviewedTestChatPhysicalScope(s.review, s.plan)).toThrow(
      'EXACT_ARCHIVED_TEST_EVIDENCE_REQUIRED',
    );
  });
  it('the stopped c059 row still blocks this role without its own preservation review', () => {
    const s = chatSubject();
    delete s.review.historicalCloudCarry.preservedExitedContainer;
    expect(() => classifyReviewedTestChatCloudCarry(s)).toThrow(
      'CONTAINER_OR_RESERVATION_PRESENT',
    );
  });
});

function chatRoundSubject() {
  const s = chatSubject();
  for (const list of [s.healthBefore, s.healthAfter])
    for (const h of list) h.status = 'ready';
  s.targetPhysicalBefore = {
    physicalProof: clone(s.physicalProof),
    healthBefore: clone(s.healthBefore),
    healthAfter: clone(s.healthAfter),
  };
  s.targetPhysicalAfter = clone(s.targetPhysicalBefore);
  return s;
}
async function runChatObserver(subject, change = () => {}, settings = {}) {
  let tick = 0,
    rounds = 0;
  const order = [];
  const observations = [];
  const result = await observeReviewedTestChatQuiescence({
    review: subject.review,
    plan: subject.plan,
    timeoutMs: 100,
    intervalMs: 10,
    now: () => tick,
    sleep: async (ms) => {
      tick += ms;
    },
    readObservation: async (step) => {
      const s = clone(subject);
      change(s, ++rounds);
      let busyReads = 0,
        healthReads = 0,
        snapshotReads = 0,
        vmReads = 0,
        targetReads = 0;
      const record = (name, value) => {
        order.push([rounds, name]);
        return clone(value);
      };
      const observation = await collectReviewedTestChatRound(
        {
          review: s.review,
          plan: s.plan,
          attempt: rounds,
          baseline: s.baseline,
          recordedExitedObservation: s.recordedExitedObservation,
          verifierSha256: s.verifierSha256,
          sharedVerifierSha256: s.sharedVerifierSha256,
          physicalVerifierSha256: s.physicalVerifierSha256,
          readBusy: async () =>
            record(
              'raw' + ++busyReads,
              busyReads === 1 ? s.rawBefore : s.rawAfter,
            ),
          readHealths: async () =>
            record(
              'health' + ++healthReads,
              healthReads === 1 ? s.healthBefore : s.healthAfter,
            ),
          reader: {
            readSnapshot: async () =>
              record(
                'history' + ++snapshotReads,
                snapshotReads === 1 ? s.before : s.after,
              ),
            physicalAbsence: async () =>
              record(
                'vm' + ++vmReads,
                vmReads === 1 ? s.physicalBefore : s.physicalAfter,
              ),
          },
          collectPhysicalObservation: async (suffix) =>
            record(
              'target' + ++targetReads + suffix,
              targetReads === 1
                ? s.targetPhysicalBefore
                : s.targetPhysicalAfter,
            ),
          readInventory: async () => record('inventory', s.inventory),
          readExited: async () => record('full-inspect', s.exitedObservation),
        },
        step,
      );
      observations.push(observation);
      return observation;
    },
    ...settings,
  });
  return { result, rounds, order, observations };
}
describe('reviewed-chat complete bounded observation uses separate authority', () => {
  it('repeats the actual full production read wiring, retaining only one complete idle round', async () => {
    const s = chatRoundSubject();
    const r = await runChatObserver(s, (p, attempt) => {
      if (attempt === 1) {
        p.healthBefore[0].producerLifecycle.activeRoots = 1;
        p.targetPhysicalAfter.healthAfter[1].producerLifecycle.pendingRoots = 1;
      }
    });
    expect(r.rounds).toBe(2);
    expect(r.result.quiescenceObservation).toMatchObject({
      attempts: 2,
      completeReadOnlyAttempts: true,
      mutationRetried: false,
    });
    expect(r.result.observation).toEqual(r.observations[1]);
    expect(r.result.observation).not.toEqual(r.observations[0]);
    for (const i of [1, 2])
      expect(r.order.filter(([n]) => n === i).map(([, name]) => name)).toEqual([
        'raw1',
        'health1',
        'history1',
        'target1.attempt-' + i + '.target-before.json',
        'vm1',
        'inventory',
        'full-inspect',
        'vm2',
        'target2.attempt-' + i + '.target-after.json',
        'history2',
        'raw2',
        'health2',
      ]);
    expect(r.result.classification.exactTestChatScopes).toEqual(
      s.plan.snapshots.map((v) => v.scope),
    );
    expect(r.result.classification.rawUncleanedCloudAttempts).toBe(1);
    expect(r.result.classification.cleanupClaimed).toBe(false);
  });
  it('bounds continuous target-bracket activity without any mutation or generic error retry', async () => {
    let rounds = 0;
    await expect(
      runChatObserver(chatRoundSubject(), (p) => {
        rounds++;
        p.targetPhysicalBefore.healthAfter[0].producerLifecycle.retainedChildren = 1;
      }),
    ).rejects.toThrow('NATIVE_RETIREMENT_QUIESCENCE_TIMEOUT');
    expect(rounds).toBe(10);
  });
  it.each([
    [
      'identity',
      (s) => {
        s.healthAfter[1].identity.bootId = 'changed';
      },
    ],
    [
      'unknown',
      (s) => {
        s.targetPhysicalAfter.healthAfter[1].producerLifecycle.unknownOutcomes =
          ['unknown'];
      },
    ],
    [
      'unresolved',
      (s) => {
        s.targetPhysicalBefore.healthBefore[1].producerLifecycle.unresolvedRoots = 1;
      },
    ],
    [
      'negative root',
      (s) => {
        s.healthAfter[1].producerLifecycle.activeRoots = -1;
      },
    ],
    [
      'fractional root',
      (s) => {
        s.healthAfter[1].producerLifecycle.pendingRoots = 0.5;
      },
    ],
    [
      'not ready',
      (s) => {
        s.targetPhysicalAfter.healthAfter[1].status = 'starting';
      },
    ],
    [
      'new raw job',
      (s) => {
        s.rawAfter.jobs = 1;
      },
    ],
    [
      'live runtime',
      (s) => {
        s.rawAfter.runtimes = 1;
      },
    ],
    [
      'changed history',
      (s) => {
        s.after.receipts.ids.push('new-row');
      },
    ],
    [
      'changed VM',
      (s) => {
        s.physicalAfter.vmState = 'changed';
      },
    ],
    [
      'running container',
      (s) => {
        s.exitedObservation.inspectAfter.body.State.Pid = 123;
      },
    ],
    [
      'target writer',
      (s) => {
        s.targetPhysicalAfter.physicalProof.writers.push({ pid: 1 });
      },
    ],
    [
      'target native process',
      (s) => {
        s.targetPhysicalBefore.physicalProof.nativeProcesses.push({ pid: 1 });
      },
    ],
    [
      'changed target scope',
      (s) => {
        s.targetPhysicalAfter.physicalProof.scopeDigest =
          'sha256:' + 'f'.repeat(64);
      },
    ],
    [
      'protected PPT',
      (s) => {
        s.plan.snapshots[0].scope.contextId =
          '68e76b6b-2e75-45b7-b628-951945b12044';
      },
    ],
    [
      'wrong authority',
      (s) => {
        s.review.kind = 'allrice-dev-test-chat-retirement-review';
      },
    ],
  ])(
    'does not retry %s even alongside transient activity',
    async (_name, change) => {
      let rounds = 0;
      await expect(
        runChatObserver(chatRoundSubject(), (s) => {
          rounds++;
          s.healthBefore[0].producerLifecycle.activeRoots = 1;
          change(s);
        }),
      ).rejects.toThrow();
      expect(rounds).toBe(1);
    },
  );
  it('does not convert a thrown lifecycle-shaped read error into a retry', async () => {
    let reads = 0;
    await expect(
      observeReviewedTestChatQuiescence({
        review: chatRoundSubject().review,
        plan: chatRoundSubject().plan,
        readObservation: async () => {
          reads++;
          throw Error('NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY');
        },
      }),
    ).rejects.toThrow('NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY');
    expect(reads).toBe(1);
  });
});
