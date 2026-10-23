import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  HISTORICAL_CLOUD as H,
  classifyRetirementCloudCarry,
  verifyRetirementBusy,
} from './retirement-preserved-cloud.mjs';

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
    kind: 'development-test-chat-retirement',
    requestId: '11111111-1111-4111-8111-111111111111',
    digest,
    snapshots: [
      'd04715cd-9355-4fe4-b0e5-ae7eab360275',
      'd81a23d5-fab3-40fe-aa91-37579f1e1149',
    ].map((id) => ({
      scope: {
        contextKind: 'chat',
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
    rootReviewed: true,
    reviewedBy: 'root',
    releaseSha: identities[0].sourceSha,
    sourceTree: identities[0].sourceTree,
    historicalCloudCarry: {
      kind: 'allrice-dev-test-chat-retirement-exact-cloud-v1',
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

describe('retirement exact historical cloud: pure observations only', () => {
  it('classifies the one exact unknown while retaining raw counts and all evidence', () => {
    const p = proof(),
      original = clone(p);
    expect(classifyRetirementCloudCarry(p)).toMatchObject({
      rawBusy: { clouds: 1 },
      finalRawBusy: { clouds: 1 },
      rawUncleanedCloudAttempts: 1,
      preservedUnresolvedCloudAttempts: 1,
      unpreservedCloudAttempts: 0,
      unclassifiedOwnedCloudContainers: 0,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
      globalResourceIdleProven: false,
      databaseWritten: false,
      modelCalls: 0,
    });
    expect(p).toEqual(original);
  });
  it('reproduces the original guard rejecting the same otherwise idle singleton', () => {
    const p = proof();
    expect(Object.values(p.rawBefore).every((n) => n === 0)).toBe(false);
    expect(classifyRetirementCloudCarry(p).unpreservedCloudAttempts).toBe(0);
  });
  it.each(['jobs', 'tests', 'leases', 'auth', 'extraCurrentProducer'])(
    'refuses %s activity at either side of the physical observation',
    (key) => {
      for (const phase of ['rawBefore', 'rawAfter']) {
        const p = proof();
        p[phase][key] = 1;
        expect(() => classifyRetirementCloudCarry(p)).toThrow(
          'NATIVE_RETIREMENT_DEV_BUSY',
        );
      }
    },
  );
  it.each([0, 2, -1, 0.5, '1', NaN])(
    'never subtracts a fixed one from raw clouds (%s)',
    (count) => {
      const p = proof();
      p.rawAfter.clouds = count;
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_DEV_BUSY',
      );
    },
  );
  it('refuses an omitted guard count', () => {
    const p = proof();
    delete p.rawBefore.auth;
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_DEV_BUSY',
    );
  });
  it.each(['attempt', 'operation', 'input', 'job', 'run'])(
    'refuses any byte-hash change to the preserved %s',
    (key) => {
      const p = proof();
      p.after[key].rowSha256 = 'f'.repeat(64);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_HISTORICAL_CLOUD_SQL_CHANGED',
      );
    },
  );
  it.each([
    (p) => p.after.receipts.ids.push('new-receipt'),
    (p) => (p.after.receipts.rowsSha256 = 'f'.repeat(64)),
    (p) => (p.after.operation.leaseExpired = false),
    (p) => (p.after.operation.status = 'running'),
    (p) => (p.after.attempt.cleanupConfirmedAt = 'claimed-cleanup'),
    (p) => p.after.uncleanedOperationIds.push('new-operation'),
    (p) => (p.before.uncleanedOperationIds = ['replacement-operation']),
  ])(
    'rejects a changed receipt, state, lease or entire uncleaned set (%#)',
    (change) => {
      const p = proof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_HISTORICAL_CLOUD_SQL_CHANGED',
      );
    },
  );
  it.each([
    (p) => (p.review.historicalCloudCarry.enabled = false),
    (p) => (p.review.rootReviewed = false),
    (p) => (p.review.reviewedBy = 'another-owner'),
    (p) => (p.review.historicalCloudCarry.requestId = 'another-request'),
    (p) =>
      (p.review.historicalCloudCarry.planDigest = 'sha256:' + 'f'.repeat(64)),
  ])('requires a current root-reviewed exact plan opt-in (%#)', (change) => {
    const p = proof();
    change(p);
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_CLOUD_CARRY_REVIEW_REQUIRED',
    );
  });
  it.each(['readerPin', 'baselinePin'])(
    'refuses an arbitrary %s path or byte pin',
    (key) => {
      for (const field of ['path', 'sha256']) {
        const p = proof();
        p.review.historicalCloudCarry[key][field] = 'arbitrary';
        expect(() => classifyRetirementCloudCarry(p)).toThrow(/PIN_CHANGED/);
      }
    },
  );
  it.each([
    (p) =>
      (p.plan.snapshots[0].scope.contextId =
        '68e76b6b-2e75-45b7-b628-951945b12044'),
    (p) => (p.plan.snapshots[0].scope.contextKind = 'platform_employee_test'),
    (p) => (p.plan.snapshots[0].scope.organizationId = 'other-tenant'),
    (p) => (p.plan.snapshots[0].scope.ownerId = 'other-user'),
    (p) => (p.plan.snapshots[0].origin.artifactId = 'other-package'),
    (p) => (p.plan.snapshots[0].archived = false),
    (p) => p.plan.snapshots.push(clone(p.plan.snapshots[0])),
  ])(
    'does not expand to real PPT, non-chat, another tenant or package (%#)',
    (change) => {
      const p = proof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_CLOUD_EXACT_SLOT5_PLAN_REQUIRED',
      );
    },
  );
  it.each([
    (p) => (p.healthAfter[1].identity.bootId = 'new-boot'),
    (p) => (p.healthBefore[0].identity.sourceSha = 'f'.repeat(40)),
    (p) =>
      (p.healthAfter[1].identity.manifestDigest = 'sha256:' + 'f'.repeat(64)),
  ])('refuses stale source, build or process identities (%#)', (change) => {
    const p = proof();
    change(p);
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_CLOUD_CURRENT_IDENTITY_CHANGED',
    );
  });
  it.each([
    (p) => (p.healthAfter[1].producerLifecycle.releaseAdmission = 'enabled'),
    (p) =>
      (p.healthAfter[1].producerLifecycle.unknownOutcomes = [
        'business_lifetime_unknown',
      ]),
    (p) => (p.healthBefore[0].producerLifecycle.retainedChildren = 1),
  ])(
    'does not carry a current boot unknown or reopen admission (%#)',
    (change) => {
      const p = proof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
      );
    },
  );
  it.each(['inode', 'dockerId', 'dockerVersion', 'configuredSocket', 'vm'])(
    'refuses a changed physical %s fence',
    (key) => {
      const p = proof();
      p.physicalAfter[key] = 'changed';
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_CLOUD_PHYSICAL_IDENTITY_CHANGED',
      );
    },
  );
  it.each([
    'created',
    'restarting',
    'running',
    'removing',
    'paused',
    'exited',
    'dead',
  ])('refuses a named AllRice container even when its state is %s', (State) => {
    const p = proof();
    p.inventory.body = [
      { Id: 'a'.repeat(64), Names: ['/allrice-cloud-new'], Labels: {}, State },
    ];
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_CLOUD_CONTAINER_OR_RESERVATION_PRESENT',
    );
  });
  it.each(['attempt', 'slot-owner', 'slot-fence', 'service'])(
    'catches renamed containers/reservations identified only by %s label',
    (suffix) => {
      const p = proof();
      p.inventory.body = [
        {
          Id: 'a'.repeat(64),
          Names: ['/renamed'],
          Labels: { ['xyz.bplabs.allrice.cloud.' + suffix]: H.attemptId },
          State: 'created',
        },
      ];
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_CLOUD_CONTAINER_OR_RESERVATION_PRESENT',
      );
    },
  );
  it.each([
    (p) => (p.inventory.status = 403),
    (p) => (p.inventory.socketPath = '/wrong-daemon.sock'),
    (p) => (p.inventory.body = { error: 'not-a-list' }),
    (p) => (p.inventory.body = [{ Id: 'malformed' }]),
  ])('fails closed on unconfirmed physical inventory (%#)', (change) => {
    const p = proof();
    change(p);
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_CLOUD_INVENTORY_UNCONFIRMED',
    );
  });
  it('preserves unrelated containers without claiming global resource idle', () => {
    const p = proof();
    p.inventory.body = [
      {
        Id: 'a'.repeat(64),
        Names: ['/user-container'],
        Labels: null,
        State: 'running',
      },
    ];
    expect(classifyRetirementCloudCarry(p).globalResourceIdleProven).toBe(
      false,
    );
  });
});

describe('original strict-zero default path', () => {
  const noExternalCalls = () => ({
    sql: vi.fn(() => {
      throw Error('NO_DB');
    }),
    readHealths: vi.fn(() => {
      throw Error('NO_HEALTH');
    }),
  });
  it('remains disabled with no CLI arguments and no credentials', () => {
    const script = fileURLToPath(
      new URL('./retire-native-test-contexts.mjs', import.meta.url),
    );
    const result = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(JSON.parse(result)).toMatchObject({
      disabled: true,
      databaseWritten: false,
    });
  });
  it('accepts all-zero without loading/probing any historical resource', async () => {
    const extra = noExternalCalls(),
      readBusy = vi.fn(async () => zero());
    expect(
      await verifyRetirementBusy({ review: {}, readBusy, ...extra }),
    ).toMatchObject({
      rawUncleanedCloudAttempts: 0,
      preservedUnresolvedCloudAttempts: 0,
      historicalCarryEnabled: false,
      databaseWritten: false,
    });
    expect(readBusy).toHaveBeenCalledTimes(1);
    expect(extra.sql).not.toHaveBeenCalled();
    expect(extra.readHealths).not.toHaveBeenCalled();
  });
  it.each(['clouds', 'jobs', 'tests', 'leases', 'auth'])(
    'rejects %s without an explicit carry review, before any probes',
    async (key) => {
      const extra = noExternalCalls();
      await expect(
        verifyRetirementBusy({
          review: {},
          ...extra,
          readBusy: async () => ({ ...zero(), [key]: 1 }),
        }),
      ).rejects.toThrow('NATIVE_RETIREMENT_DEV_BUSY');
      expect(extra.sql).not.toHaveBeenCalled();
      expect(extra.readHealths).not.toHaveBeenCalled();
    },
  );
  it('does not turn an explicitly disabled carry review into permission', async () => {
    const p = proof(),
      extra = noExternalCalls();
    p.review.historicalCloudCarry.enabled = false;
    await expect(
      verifyRetirementBusy({
        ...extra,
        review: p.review,
        plan: p.plan,
        readBusy: async () => p.rawBefore,
      }),
    ).rejects.toThrow('NATIVE_RETIREMENT_CLOUD_CARRY_REVIEW_REQUIRED');
    expect(extra.sql).not.toHaveBeenCalled();
    expect(extra.readHealths).not.toHaveBeenCalled();
  });
});
