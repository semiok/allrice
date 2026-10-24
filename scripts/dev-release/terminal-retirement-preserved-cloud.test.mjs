import { describe, expect, it, vi } from 'vitest';
import {
  HISTORICAL_CLOUD as H,
  classifyRetirementCloudCarry,
  verifyRetirementBusy,
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

describe('independent nonchat exact historical carry / no physical probe', () => {
  it('keeps the raw singleton and original unknown unchanged under this exact nonchat plan', () => {
    const p = proof(),
      before = clone(p);
    expect(classifyRetirementCloudCarry(p)).toMatchObject({
      rawUncleanedCloudAttempts: 1,
      preservedUnresolvedCloudAttempts: 1,
      unpreservedCloudAttempts: 0,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
      databaseWritten: false,
    });
    expect(p).toEqual(before);
  });
  it.each(['attempt', 'operation', 'input', 'job', 'run'])(
    'rejects any changed %s row',
    (key) => {
      const p = proof();
      p.after[key].rowSha256 = 'f'.repeat(64);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(/SQL_CHANGED/);
    },
  );
  it.each(['jobs', 'tests', 'leases', 'auth', 'runtimes'])(
    'rejects active %s on either side',
    (key) => {
      for (const side of ['rawBefore', 'rawAfter']) {
        const p = proof();
        p[side][key] = 1;
        expect(() => classifyRetirementCloudCarry(p)).toThrow(/DEV_BUSY/);
      }
    },
  );
  it.each([0, 2, -1, '1'])(
    'does not subtract from a different raw count %s',
    (count) => {
      const p = proof();
      p.rawAfter.clouds = count;
      expect(() => classifyRetirementCloudCarry(p)).toThrow(/DEV_BUSY/);
    },
  );
  it.each([
    (p) => (p.review.terminalScopes[0].contextId = 'another-source'),
    (p) => (p.plan.snapshots[0].scope.contextKind = 'chat'),
    (p) =>
      (p.review.historicalCloudCarry.kind =
        'allrice-dev-test-chat-retirement-exact-cloud-v1'),
    (p) =>
      (p.review.historicalCloudCarry.planDigest = 'sha256:' + 'e'.repeat(64)),
    (p) =>
      (p.review.historicalCloudCarry.expiresAt = '2000-01-01T00:00:00.000Z'),
    (p) => (p.review.historicalCloudCarry.readerPin.sha256 = '0'.repeat(64)),
    (p) => (p.review.historicalCloudCarry.baselinePin.sha256 = '0'.repeat(64)),
  ])(
    'rejects borrowed chat authority, different scope/TTL/pins (%#)',
    (change) => {
      const p = proof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow();
    },
  );
  it.each([
    (p) =>
      p.inventory.body.push({
        Id: 'a'.repeat(64),
        Names: ['/allrice-cloud-new'],
        Labels: {},
        State: 'running',
      }),
    (p) =>
      p.inventory.body.push({
        Id: 'a'.repeat(64),
        Names: ['/innocent-name'],
        Labels: { 'xyz.bplabs.allrice.backend': 'cloud-gvisor-v1' },
        State: 'exited',
      }),
    (p) =>
      p.inventory.body.push({
        Id: 'a'.repeat(64),
        Names: ['/reservation'],
        Labels: { 'xyz.bplabs.allrice.cloud.operation': 'other' },
        State: 'created',
      }),
    (p) => (p.physicalAfter.vm.bootId = 'replacement-vm'),
    (p) => (p.healthAfter[1].producerLifecycle.releaseAdmission = 'enabled'),
    (p) => p.after.uncleanedOperationIds.push('other-row'),
  ])(
    'refuses real containers/reservations, changed VM, resumed writer or new row (%#)',
    (change) => {
      const p = proof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow();
    },
  );
  it('has no zero-count or JSON-rootReviewed bypass for the known raw singleton', async () => {
    const p = proof(),
      readBusy = vi.fn(async () => p.rawBefore);
    await expect(
      verifyRetirementBusy({
        review: { rootReviewed: true },
        plan: p.plan,
        readBusy,
      }),
    ).rejects.toThrow(/DEV_BUSY/);
  });
});
