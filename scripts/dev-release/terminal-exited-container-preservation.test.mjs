import { readFileSync } from 'node:fs';
import {
  HISTORICAL_EXITED_CONTAINER as E,
  exitedContainerEvidenceDigest as factDigest,
  nativeCloudInventoryIdentity,
} from './retirement-preserved-cloud.mjs';
import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_CLOUD as H,
  classifyRetirementCloudCarry,
} from './terminal-retirement-preserved-cloud.mjs';

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
describe('independent terminal exact stopped preservation; no live I/O', () => {
  it.each([
    'platform_employee_test',
    'experience_consolidation',
    'platform_technical',
  ])(
    'accepts only reviewed %s full raw6 and preserves historical unknown',
    (kind) => {
      const s = subject(kind),
        original = clone(s);
      expect(classifyRetirementCloudCarry(s)).toMatchObject({
        preservedExitedContainer: {
          containerId: E.id,
          pid: 0,
          historicalOutcomeKnown: false,
          cleanupClaimed: false,
          containerRemoved: false,
        },
      });
      expect(s.inventory.body).toHaveLength(6);
      expect(s).toEqual(original);
    },
  );
  it.each([
    (s, p) => (p.enabled = false),
    (s, p) => delete p.observationPin,
    (s, p) => (p.observationPin.path = 'relative.json'),
    (s, p) => (p.observationPin.sha256 = 'changed'),
    (s, p) =>
      (p.kind = 'allrice-dev-test-chat-retirement-exact-exited-container-v1'),
    (s, p) =>
      (p.kind = 'native-control-exact-exited-container-preservation-v1'),
    (s, p) => (p.requestId = 'other'),
    (s, p) => (p.planDigest = 'sha256:' + '0'.repeat(64)),
    (s, p) => (p.authorizationEvidenceDigest = 'sha256:' + '0'.repeat(64)),
    (s, p) => (p.terminalScopes[0].contextId = 'other'),
    (s, p) => (p.nonce = '22222222-2222-4222-8222-222222222222'),
    (s, p) => (p.verifierSha256 = '0'.repeat(64)),
    (s, p) => (p.sharedVerifierSha256 = '0'.repeat(64)),
    (s, p) => (p.releaseSha = '0'.repeat(40)),
    (s, p) => (p.sourceTree = '0'.repeat(40)),
    (s, p) => (p.serviceIdentityDigest = 'sha256:' + '0'.repeat(64)),
    (s, p) => (p.physicalScopeDigest = 'sha256:' + '0'.repeat(64)),
    (s, p) => p.storageNamespaces.pop(),
    (s, p) => (p.writerScopesDigest = 'sha256:' + '0'.repeat(64)),
    (s, p) => (p.artifactRootsDigest = 'sha256:' + '0'.repeat(64)),
    (s, p) => (p.expiresAt = '2000-01-01T00:00:00.000Z'),
    (s) => s.physicalProof.writers.push({ pid: 123 }),
    (s) => s.physicalProof.nativeProcesses.push({ pid: 123 }),
    (s) => (s.physicalProof.workerBootId = 'other'),
    (s) => (s.physicalProof.sourceTree = '0'.repeat(40)),
    (s) => (s.recordedExitedObservation.nonce = 'other'),
    (s) => s.recordedExitedObservation.storageNamespaces.pop(),
    (s) => (s.exitedObservation.inspectAfter.body.State.Pid = 1),
    (s) => (s.exitedObservation.inspectAfter.body.State.Paused = true),
    (s) =>
      (s.exitedObservation.inspectAfter.body.HostConfig.RestartPolicy.Name =
        'always'),
    (s) => (s.exitedObservation.inspectAfter.body.HostConfig.AutoRemove = true),
    (s) =>
      (s.exitedObservation.inspectAfter.body.Config.Labels.changed = 'true'),
    (s) => (s.exitedObservation.inspectAfter.body.Mounts[0].RW = false),
    (s) => (s.rawAfter.clouds = 2),
    (s) => (s.rawAfter.runtimes = 1),
    (s) => (s.after.operation.status = 'running'),
    (s) => (s.physicalAfter.dockerId = 'other'),
    (s) => (s.plan.snapshots[0].scope.contextKind = 'chat'),
    (s) =>
      (s.plan.snapshots[0].scope.contextId =
        '68e76b6b-2e75-45b7-b628-951945b12044'),
  ])(
    'rejects authority, current state or evidence substitution (%#)',
    (mutate) => {
      const s = subject();
      mutate(s, s.review.historicalCloudCarry.preservedExitedContainer);
      expect(() => classifyRetirementCloudCarry(s)).toThrow();
    },
  );
  it('does not preserve the stopped container without the independent terminal review', () => {
    const s = subject();
    delete s.review.historicalCloudCarry.preservedExitedContainer;
    expect(() => classifyRetirementCloudCarry(s)).toThrow(
      'CONTAINER_OR_RESERVATION_PRESENT',
    );
  });
  it.each(['running', 'paused', 'created', 'exited'])(
    'rejects another %s cloud even with an otherwise matching reviewed inventory',
    (State) => {
      const s = subject();
      s.inventory.body.push({
        ...clone(s.inventory.body.find((r) => r.Id === E.id)),
        Id: '0'.repeat(64),
        Names: ['/renamed-reservation'],
        Labels: { 'xyz.bplabs.allrice.cloud.slot-owner': 'current' },
        State,
      });
      expect(() => classifyRetirementCloudCarry(s)).toThrow();
    },
  );
});
