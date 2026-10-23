import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  HISTORICAL_CLOUD as H,
  classifyRetirementCloudCarry,
  verifyRetirementBusy,
  observeRetirementQuiescence,
  HISTORICAL_EXITED_CONTAINER as E,
  exitedContainerEvidenceDigest,
  readHistoricalExitedContainer,
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

// Deliberately synthetic Docker responses. Production loads the three fixed
// original evidence files, then performs real GET inspect twice on that daemon.
function exitedProof() {
  const p = proof();
  p.plan.authorizationEvidenceDigest = digest;
  const mounts = [
    {
      Type: 'volume',
      Name: 'synthetic-retained-work',
      Source: '/synthetic/work',
      Destination: '/tmp/work',
      RW: true,
    },
  ];
  const labels = {
    'xyz.bplabs.allrice.backend': 'cloud-gvisor-v1',
    'xyz.bplabs.allrice.cloud.attempt': E.attemptId,
  };
  const body = {
    Id: E.id,
    Name: E.name,
    Created: '2026-10-04T02:24:40.086837435Z',
    Image: 'sha256:' + '8'.repeat(64),
    State: {
      Status: 'exited',
      Running: false,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: 0,
      ExitCode: 124,
      Error: '',
      StartedAt: '2026-10-04T02:24:40.454070212Z',
      FinishedAt: '2026-10-04T02:24:45.291475245Z',
    },
    Config: { Labels: clone(labels), Env: ['SYNTHETIC=1'] },
    HostConfig: {
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      NetworkMode: 'none',
    },
    Mounts: clone(mounts),
  };
  const c = {
    Id: E.id,
    Names: [E.name],
    ImageID: body.Image,
    Image: body.Image,
    Labels: clone(labels),
    Mounts: clone(mounts),
    State: 'exited',
    Status: 'Exited (124) 2 weeks ago',
  };
  const unrelated = {
    Id: '9'.repeat(64),
    Names: ['/synthetic-existing-office'],
    Labels: {},
    Mounts: [],
    State: 'running',
    Status: 'Up 3 days',
  };
  p.inventory.body = [c, unrelated];
  const inspect = {
    status: 200,
    id: body.Id,
    name: body.Name,
    created: body.Created,
    state: clone(body.State),
    labels: clone(labels),
    restartPolicy: clone(body.HostConfig.RestartPolicy),
    autoRemove: false,
    mounts: clone(mounts),
    networkMode: 'none',
  };
  p.exitedObservation = {
    observedAt: new Date().toISOString(),
    baseline: {
      historical: { notTouchingUnknownOtherContainer: E.attemptId },
      inspect,
      inventory: clone(p.inventory),
    },
    inventoryAfter: clone(p.inventory),
    inspectBefore: {
      socketPath: p.physicalBefore.configuredSocket,
      status: 200,
      body: clone(body),
    },
    inspectAfter: {
      socketPath: p.physicalBefore.configuredSocket,
      status: 200,
      body: clone(body),
    },
  };
  p.review.historicalCloudCarry.preservedExitedContainer = {
    kind: 'allrice-dev-test-chat-retirement-exact-exited-container-v1',
    enabled: true,
    rootReviewed: true,
    reviewedBy: 'root',
    requestId: p.plan.requestId,
    planDigest: p.plan.digest,
    authorizationEvidenceDigest: digest,
    containerId: E.id,
    containerName: E.name,
    releaseSha: p.review.releaseSha,
    sourceTree: p.review.sourceTree,
    serviceIdentityDigest: exitedContainerEvidenceDigest(
      p.review.historicalCloudCarry.serviceIdentities,
    ),
    physicalIdentityDigest: exitedContainerEvidenceDigest(p.physicalBefore),
    inspectDigest: exitedContainerEvidenceDigest(body),
    reviewedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    historicalPin: clone(E.historicalPin),
    inspectPin: clone(E.inspectPin),
    inventoryPin: clone(E.inventoryPin),
  };
  return p;
}

describe('one exact historical exited container is preserved, never cleaned or closed', () => {
  it('reproduces the live refusal without the new explicit preservation branch', () => {
    const p = exitedProof();
    delete p.review.historicalCloudCarry.preservedExitedContainer;
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_CLOUD_CONTAINER_OR_RESERVATION_PRESENT',
    );
  });
  it('preserves the fixed stopped container and all raw unknown facts; existing unrelated office remains outside cloud ownership', () => {
    const p = exitedProof(),
      original = clone(p);
    const result = classifyRetirementCloudCarry(p);
    expect(result).toMatchObject({
      rawUncleanedCloudAttempts: 1,
      preservedUnresolvedCloudAttempts: 1,
      unpreservedCloudAttempts: 0,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
      globalResourceIdleProven: false,
      databaseWritten: false,
      historicalExitedContainerPreservation: {
        containerId: E.id,
        rawOwnedCloudContainers: 1,
        preservedExitedContainers: 1,
        unclassifiedOwnedCloudContainers: 0,
        pid: 0,
        historicalOutcomeKnown: false,
        cleanupClaimed: false,
        containerRemoved: false,
      },
    });
    expect(p).toEqual(original);
  });
  it.each([
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.enabled = false),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.rootReviewed = false),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.requestId =
        'other-request'),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.planDigest =
        'sha256:' + 'f'.repeat(64)),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.authorizationEvidenceDigest =
        'sha256:' + 'f'.repeat(64)),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.containerId =
        'f'.repeat(64)),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.containerName =
        '/renamed'),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.releaseSha =
        'f'.repeat(40)),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.sourceTree =
        'f'.repeat(40)),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.serviceIdentityDigest =
        'sha256:' + 'f'.repeat(64)),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.reviewedAt =
        new Date(Date.now() + 60_000).toISOString()),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.expiresAt =
        new Date(Date.now() - 1000).toISOString()),
    (p) =>
      (p.review.historicalCloudCarry.preservedExitedContainer.expiresAt =
        new Date(Date.now() + 31 * 60_000).toISOString()),
  ])(
    'rejects an inexact, disabled or stale authority before accepting any JSON observation (%#)',
    (change) => {
      const p = exitedProof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_EXITED_CONTAINER_EXACT_REVIEW_REQUIRED',
      );
    },
  );
  it.each(['historicalPin', 'inspectPin', 'inventoryPin'])(
    'requires exact original %s path and bytes',
    (key) => {
      const p = exitedProof();
      p.review.historicalCloudCarry.preservedExitedContainer[key].sha256 =
        'f'.repeat(64);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_EXITED_CONTAINER_EVIDENCE_PIN_CHANGED',
      );
    },
  );
  it('refuses a disabled preservation branch before loading files, SQL or Docker', async () => {
    const p = exitedProof();
    p.review.historicalCloudCarry.preservedExitedContainer.enabled = false;
    const sql = vi.fn(() => {
        throw Error('NO_SQL');
      }),
      readHealths = vi.fn(() => {
        throw Error('NO_HEALTH');
      });
    await expect(
      verifyRetirementBusy({
        review: p.review,
        plan: p.plan,
        sql,
        readBusy: async () => p.rawBefore,
        healths: p.healthBefore,
        readHealths,
      }),
    ).rejects.toThrow(
      'NATIVE_RETIREMENT_EXITED_CONTAINER_EXACT_REVIEW_REQUIRED',
    );
    expect(sql).not.toHaveBeenCalled();
    expect(readHealths).not.toHaveBeenCalled();
  });
  it.each([
    (p) => delete p.exitedObservation,
    (p) =>
      (p.exitedObservation.observedAt = new Date(
        Date.now() - 121_000,
      ).toISOString()),
    (p) =>
      (p.exitedObservation.observedAt = new Date(
        Date.now() + 1000,
      ).toISOString()),
  ])('does not accept absent/stale/future physical evidence (%#)', (change) => {
    const p = exitedProof();
    change(p);
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_EXITED_CONTAINER_FRESH_INSPECT_REQUIRED',
    );
  });
  it.each(['inspectBefore', 'inspectAfter'])(
    'requires an actual successful same-socket %s',
    (key) => {
      for (const change of [
        (o) => (o.status = 404),
        (o) => (o.socketPath = '/other.sock'),
      ]) {
        const p = exitedProof();
        change(p.exitedObservation[key]);
        expect(() => classifyRetirementCloudCarry(p)).toThrow(
          'NATIVE_RETIREMENT_EXITED_CONTAINER_INSPECT_UNCONFIRMED',
        );
      }
    },
  );
  it('checks full inspect fields beyond the old identity projection and both observations', () => {
    for (const key of ['inspectBefore', 'inspectAfter', 'both']) {
      const p = exitedProof();
      for (const phase of key === 'both'
        ? ['inspectBefore', 'inspectAfter']
        : [key])
        p.exitedObservation[phase].body.HostConfig.Memory = 1024;
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        'NATIVE_RETIREMENT_EXITED_CONTAINER_INSPECT_CHANGED',
      );
    }
  });
  it.each([
    (b) => (b.State.Pid = 1),
    (b) => (b.State.Running = true),
    (b) => (b.State.Paused = true),
    (b) => (b.State.Restarting = true),
    (b) => (b.HostConfig.RestartPolicy.Name = 'always'),
    (b) => (b.HostConfig.AutoRemove = true),
    (b) =>
      (b.Config.Labels['xyz.bplabs.allrice.cloud.slot-owner'] = 'new-owner'),
    (b) => (b.Mounts[0].Source = '/changed'),
    (b) => (b.Name = '/renamed'),
    (b) => (b.Created = '2026-10-24T00:00:00Z'),
    (b) => (b.State.FinishedAt = '2026-10-24T00:00:00Z'),
  ])(
    'rejects changed state/labels/mounts/history even when rootReviewed stays true (%#)',
    (change) => {
      const p = exitedProof();
      change(p.exitedObservation.inspectAfter.body);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        /EXITED_CONTAINER_/,
      );
    },
  );
  it('cannot approve an active process merely by rewriting every submitted projection/digest', () => {
    const p = exitedProof();
    p.exitedObservation.inspectBefore.body.State.Pid = 1;
    p.exitedObservation.inspectAfter.body.State.Pid = 1;
    p.exitedObservation.baseline.inspect.state.Pid = 1;
    p.review.historicalCloudCarry.preservedExitedContainer.inspectDigest =
      exitedContainerEvidenceDigest(p.exitedObservation.inspectBefore.body);
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_EXITED_CONTAINER_NOT_EXACTLY_STOPPED',
    );
  });
  it.each(['running', 'paused', 'created', 'restarting', 'exited'])(
    'still refuses any new %s cloud/reservation, before or after',
    (State) => {
      for (const phase of ['inventory', 'inventoryAfter']) {
        const p = exitedProof(),
          target =
            phase === 'inventory'
              ? p.inventory
              : p.exitedObservation.inventoryAfter;
        target.body.push({
          Id: 'a'.repeat(64),
          Names: ['/renamed-reservation'],
          Labels: { 'xyz.bplabs.allrice.cloud.slot-owner': 'other' },
          State,
          Mounts: [],
        });
        expect(() => classifyRetirementCloudCarry(p)).toThrow(
          /INVENTORY_CHANGED/,
        );
      }
    },
  );
  it('the unchanged owned-cloud guard still catches another cloud even with a matching submitted inventory', () => {
    const p = exitedProof(),
      c = {
        Id: 'a'.repeat(64),
        Names: ['/allrice-cloud-new'],
        Labels: {},
        Mounts: [],
        State: 'exited',
      };
    for (const v of [
      p.inventory,
      p.exitedObservation.inventoryAfter,
      p.exitedObservation.baseline.inventory,
    ])
      v.body.push(clone(c));
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_CLOUD_CONTAINER_OR_RESERVATION_PRESENT',
    );
  });
  it('rejects any new/unseen ordinary container too, without adding an ignore list', () => {
    const p = exitedProof();
    p.exitedObservation.inventoryAfter.body.push({
      Id: 'a'.repeat(64),
      Names: ['/new-user-container'],
      Labels: {},
      Mounts: [],
      State: 'running',
    });
    expect(() => classifyRetirementCloudCarry(p)).toThrow(/INVENTORY_CHANGED/);
  });
  it('refuses removal/rename/duplicate IDs and a changed original unknown evidence', () => {
    for (const change of [
      (p) => p.exitedObservation.inventoryAfter.body.shift(),
      (p) => (p.inventory.body[0].Names = ['/renamed']),
      (p) =>
        p.exitedObservation.inventoryAfter.body.push(
          clone(p.inventory.body[0]),
        ),
      (p) =>
        (p.exitedObservation.baseline.historical.notTouchingUnknownOtherContainer =
          'other'),
    ]) {
      const p = exitedProof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow(
        /INVENTORY_|ORIGINAL_UNKNOWN/,
      );
    }
  });
  it('does not weaken raw busy, current owner/lifecycle, SQL unknown or daemon guards', () => {
    for (const change of [
      (p) => (p.rawAfter.jobs = 1),
      (p) => (p.after.operation.status = 'running'),
      (p) => (p.healthAfter[1].identity.bootId = 'other'),
      (p) => (p.healthAfter[1].producerLifecycle.activeRoots = 1),
      (p) => (p.physicalAfter.dockerId = 'other'),
    ]) {
      const p = exitedProof();
      change(p);
      expect(() => classifyRetirementCloudCarry(p)).toThrow();
    }
    const p = exitedProof();
    p.review.historicalCloudCarry.preservedExitedContainer.physicalIdentityDigest =
      'sha256:' + 'f'.repeat(64);
    expect(() => classifyRetirementCloudCarry(p)).toThrow(
      'NATIVE_RETIREMENT_EXITED_CONTAINER_DAEMON_CHANGED',
    );
  });
  it('accepts Docker display age/array order changes while preserving every measured identity byte', () => {
    const p = exitedProof();
    p.exitedObservation.inventoryAfter.body[0].Status =
      'Exited (124) 3 weeks ago';
    p.exitedObservation.inventoryAfter.body.reverse();
    expect(
      classifyRetirementCloudCarry(p).historicalExitedContainerPreservation
        .preservedExitedContainers,
    ).toBe(1);
  });
});

describe('fixed read-only Docker inspect transport (mock HTTP, no socket/server/VM)', () => {
  it('uses only GET for the full fixed ID and reads independent responses', async () => {
    const calls = [];
    let n = 0;
    const spy = vi
      .spyOn(http, 'request')
      .mockImplementation((options, respond) => {
        calls.push(options);
        const q = new EventEmitter();
        q.setTimeout = () => q;
        q.destroy = (e) => q.emit('error', e);
        q.end = () =>
          globalThis.queueMicrotask(() => {
            const r = new EventEmitter();
            r.statusCode = 200;
            respond(r);
            r.emit(
              'data',
              Buffer.from(JSON.stringify({ Id: E.id, sequence: ++n })),
            );
            r.emit('end');
          });
        return q;
      });
    try {
      const before = await readHistoricalExitedContainer(
          '/synthetic/never-open.sock',
        ),
        after = await readHistoricalExitedContainer(
          '/synthetic/never-open.sock',
        );
      expect(calls).toHaveLength(2);
      for (const c of calls)
        expect(c).toMatchObject({
          method: 'GET',
          socketPath: '/synthetic/never-open.sock',
          path: '/v1.45/containers/' + E.id + '/json',
        });
      expect(before.body.sequence).toBe(1);
      expect(after.body.sequence).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

// Full synthetic observation records; this never opens SQL, HTTP, VM or Native.
function quiescenceProof(withExitedContainer = false) {
  const p = withExitedContainer ? exitedProof() : proof();
  for (const h of [...p.healthBefore, ...p.healthAfter]) h.status = 'ready';
  return p;
}
function fakeObservationClock() {
  let time = 0;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
    sleep: vi.fn(async (ms) => {
      time += ms;
    }),
  };
}
function observeSynthetic(
  p,
  readObservation,
  clock = fakeObservationClock(),
  extra = {},
) {
  return observeRetirementQuiescence({
    review: p.review,
    plan: p.plan,
    readObservation,
    now: clock.now,
    sleep: clock.sleep,
    timeoutMs: 20,
    intervalMs: 5,
    ...extra,
  });
}

describe('bounded retirement observation does not retry mutations or stitch snapshots', () => {
  it.each(['activeRoots', 'pendingRoots', 'retainedChildren'])(
    'repeats the entire observation for transient %s, accepting only a new fully idle bracket',
    async (key) => {
      const p = quiescenceProof(true),
        clock = fakeObservationClock();
      const original = clone(p),
        rounds = [];
      const readObservation = vi.fn(async (step) => {
        const current = clone(p),
          n = rounds.length;
        const order = [];
        // All eight classes are freshly observed for each round; they are not
        // independently cached until their individual readiness happens to pass.
        for (const name of [
          'rawBefore',
          'healthBefore',
          'before',
          'inventory',
          'exitedObservation',
          'physicalAfter',
          'after',
          'rawAfter',
          'healthAfter',
        ])
          await step(async () => {
            order.push(name);
            return current[name];
          });
        rounds.push(order);
        if (n === 0) current.healthBefore[0].producerLifecycle[key] = 1;
        return current;
      });
      const result = await observeSynthetic(p, readObservation, clock);
      expect(result.quiescenceObservation).toMatchObject({
        attempts: 2,
        mutationRetried: false,
      });
      expect(result).toMatchObject({
        databaseWritten: false,
        historicalOutcomeKnown: false,
        rawUncleanedCloudAttempts: 1,
        historicalExitedContainerPreservation: { containerRemoved: false },
      });
      expect(rounds).toHaveLength(2);
      expect(rounds[0]).toEqual(rounds[1]);
      expect(p).toEqual(original);
      expect(clock.sleep).toHaveBeenCalledTimes(1);
      expect(() =>
        classifyRetirementCloudCarry({
          ...p,
          healthBefore: p.healthBefore.map((h, i) =>
            i === 0
              ? {
                  ...h,
                  producerLifecycle: { ...h.producerLifecycle, [key]: 1 },
                }
              : h,
          ),
        }),
      ).toThrow('NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY');
    },
  );

  it('does not stitch an idle before from one round with an idle after from another', async () => {
    const p = quiescenceProof(),
      clock = fakeObservationClock();
    let n = 0;
    const readObservation = vi.fn(async () => {
      const current = clone(p);
      current[
        n++ % 2 === 0 ? 'healthBefore' : 'healthAfter'
      ][1].producerLifecycle.activeRoots = 1;
      return current;
    });
    await expect(observeSynthetic(p, readObservation, clock)).rejects.toThrow(
      'NATIVE_RETIREMENT_QUIESCENCE_TIMEOUT',
    );
    expect(readObservation).toHaveBeenCalledTimes(4);
    expect(clock.now()).toBe(20);
  });

  it('continuous busy ends at the single deadline and preserves counter evidence', async () => {
    const p = quiescenceProof(),
      clock = fakeObservationClock();
    p.healthAfter[1].producerLifecycle.pendingRoots = 1;
    const readObservation = vi.fn(async () => clone(p));
    const error = await observeSynthetic(p, readObservation, clock).catch(
      (error) => error,
    );
    expect(error.message).toBe('NATIVE_RETIREMENT_QUIESCENCE_TIMEOUT');
    expect(error.quiescenceObservation).toMatchObject({
      attempts: 4,
      mutationRetried: false,
    });
    expect(error.quiescenceObservation.activity).toHaveLength(4);
    expect(readObservation).toHaveBeenCalledTimes(4);
  });

  it('awaits an in-flight bounded read but refuses its late idle result and starts no next step', async () => {
    const p = quiescenceProof(),
      clock = fakeObservationClock();
    const later = vi.fn();
    let completed = false;
    const readObservation = vi.fn(async (step) => {
      await step(async (signal) => {
        expect(signal).toBeInstanceOf(globalThis.AbortSignal);
        clock.advance(21);
        completed = true;
      });
      later();
      return p;
    });
    await expect(observeSynthetic(p, readObservation, clock)).rejects.toThrow(
      'NATIVE_RETIREMENT_QUIESCENCE_TIMEOUT',
    );
    expect(completed).toBe(true);
    expect(later).not.toHaveBeenCalled();
    expect(readObservation).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it.each([
    [
      'identity',
      (p) => {
        p.healthAfter[1].identity.bootId = 'different-boot';
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_IDENTITY_CHANGED',
    ],
    [
      'unknown',
      (p) => {
        p.healthAfter[1].producerLifecycle.unknownOutcomes = [
          'business_lifetime_unknown',
        ];
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'unresolved',
      (p) => {
        p.healthAfter[1].producerLifecycle.unresolvedRoots = 1;
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'negative counter',
      (p) => {
        p.healthAfter[1].producerLifecycle.pendingRoots = -1;
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'unsafe counter',
      (p) => {
        p.healthAfter[1].producerLifecycle.activeRoots =
          Number.MAX_SAFE_INTEGER + 1;
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'NaN counter',
      (p) => {
        p.healthAfter[1].producerLifecycle.activeRoots = NaN;
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'string counter',
      (p) => {
        p.healthAfter[1].producerLifecycle.activeRoots = '0';
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'missing counter',
      (p) => {
        delete p.healthAfter[1].producerLifecycle.retainedChildren;
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'not ready',
      (p) => {
        p.healthAfter[1].status = 'not_ready';
      },
      'NATIVE_RETIREMENT_SERVICE_NOT_READY',
    ],
    [
      'role mismatch',
      (p) => {
        p.healthAfter[1].producerLifecycle.role = 'web';
      },
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    ],
    [
      'new Job',
      (p) => {
        p.rawAfter.jobs = 1;
      },
      'NATIVE_RETIREMENT_DEV_BUSY',
    ],
    [
      'new cloud',
      (p) => {
        p.rawAfter.clouds = 2;
      },
      'NATIVE_RETIREMENT_DEV_BUSY',
    ],
    [
      'old SQL changed',
      (p) => {
        p.after.attempt.rowSha256 = 'f'.repeat(64);
      },
      'NATIVE_RETIREMENT_HISTORICAL_CLOUD_SQL_CHANGED',
    ],
    [
      'physical changed',
      (p) => {
        p.physicalAfter.vm.bootId = 'different-vm';
      },
      'NATIVE_RETIREMENT_CLOUD_PHYSICAL_IDENTITY_CHANGED',
    ],
  ])(
    'rejects %s immediately even alongside a transient root',
    async (_name, change, code) => {
      const p = quiescenceProof(),
        clock = fakeObservationClock();
      p.healthBefore[0].producerLifecycle.activeRoots = 1;
      change(p);
      const readObservation = vi.fn(async () => p);
      await expect(observeSynthetic(p, readObservation, clock)).rejects.toThrow(
        code,
      );
      expect(readObservation).toHaveBeenCalledTimes(1);
      expect(clock.sleep).not.toHaveBeenCalled();
    },
  );

  it('a newly visible container is a hard failure, not a reason to try another observation', async () => {
    const p = quiescenceProof(),
      clock = fakeObservationClock();
    p.healthBefore[0].producerLifecycle.activeRoots = 1;
    p.inventory.body.push({
      Id: 'f'.repeat(64),
      Names: ['/allrice-cloud-unreviewed'],
      State: 'running',
      Labels: {},
    });
    const readObservation = vi.fn(async () => p);
    await expect(observeSynthetic(p, readObservation, clock)).rejects.toThrow(
      'NATIVE_RETIREMENT_CLOUD_CONTAINER_OR_RESERVATION_PRESENT',
    );
    expect(readObservation).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('never catches SQL/network/probe failures as transient activity', async () => {
    const p = quiescenceProof(),
      clock = fakeObservationClock();
    const error = Error('SQL_READ_RESULT_UNKNOWN');
    const readObservation = vi.fn(async () => {
      throw error;
    });
    await expect(observeSynthetic(p, readObservation, clock)).rejects.toBe(
      error,
    );
    expect(readObservation).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });
});

function actualOperatorHealthBoundary() {
  const source = readFileSync(
    new URL('./retire-native-test-contexts.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('    const readHealths = async (signal) =>');
  const end = source.indexOf('    const readBusy = () =>', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return {
    source,
    boundary: new AsyncFunction(
      'r',
      'need',
      'fetch',
      'AbortSignal',
      source.slice(start, end) + '\nreturn readHealths;',
    ),
  };
}

describe('actual retirement operator initial boundary and mutation placement', () => {
  it('does not reject the carry initial transient before reaching the full observer', async () => {
    const { source, boundary } = actualOperatorHealthBoundary();
    const p = quiescenceProof();
    p.healthBefore[0].producerLifecycle.activeRoots = 1;
    const fetch = vi.fn(async (url) => ({
      ok: true,
      json: async () => clone(p.healthBefore[url === 'web' ? 0 : 1]),
    }));
    const need = (ok, code) => {
      if (!ok) throw Error(code);
    };
    const readHealths = await boundary(
      { ...p.review, healthUrls: ['web', 'worker'] },
      need,
      fetch,
      globalThis.AbortSignal,
    );
    expect(fetch).not.toHaveBeenCalled(); // carry waits only inside the complete observer
    expect((await readHealths())[0].producerLifecycle.activeRoots).toBe(1);
    expect(source.match(/await verifyRetirementBusy\(/g)).toHaveLength(1);
    expect(
      source.match(/await db\.applyNativeTestChatRetirement\(/g),
    ).toHaveLength(1);
    expect(source.indexOf('await verifyRetirementBusy(')).toBeLessThan(
      source.indexOf("const intentPath = a.output + '.intent.json';"),
    );
    expect(
      source.indexOf('NATIVE_RETIREMENT_CLOUD_AUTHORITY_CHANGED'),
    ).toBeLessThan(
      source.indexOf("const intentPath = a.output + '.intent.json';"),
    );
  });
  it('preserves the non-carry initial refusal', async () => {
    const { boundary } = actualOperatorHealthBoundary();
    const p = quiescenceProof();
    p.healthBefore[0].producerLifecycle.activeRoots = 1;
    const fetch = vi.fn(async (url) => ({
      ok: true,
      json: async () => clone(p.healthBefore[url === 'web' ? 0 : 1]),
    }));
    const need = (ok, code) => {
      if (!ok) throw Error(code);
    };
    const r = {
      releaseSha: p.review.releaseSha,
      sourceTree: p.review.sourceTree,
      healthUrls: ['web', 'worker'],
    };
    await expect(
      boundary(r, need, fetch, globalThis.AbortSignal),
    ).rejects.toThrow('NATIVE_RETIREMENT_SERVICE_BUSY');
  });
  it('awaits both health reads even when one rejects', async () => {
    const { boundary } = actualOperatorHealthBoundary(),
      p = quiescenceProof();
    let finishOther,
      otherFinished = false;
    const fetch = vi.fn((url) =>
      url === 'web'
        ? Promise.reject(Error('READ_FAILED'))
        : new Promise((resolve) => {
            finishOther = () => {
              otherFinished = true;
              resolve({ ok: true, json: async () => p.healthBefore[1] });
            };
          }),
    );
    const readHealths = await boundary(
      { ...p.review, healthUrls: ['web', 'worker'] },
      (ok, code) => {
        if (!ok) throw Error(code);
      },
      fetch,
      globalThis.AbortSignal,
    );
    let settled = false;
    const pending = readHealths().catch((e) => {
      settled = true;
      return e;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishOther();
    expect((await pending).message).toBe('READ_FAILED');
    expect(otherFinished).toBe(true);
  });
});
