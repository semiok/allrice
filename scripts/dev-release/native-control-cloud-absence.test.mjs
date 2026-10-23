import { describe, expect, it } from 'vitest';
import {
  assertNativeControlCloudAbsence,
  verifyNativeControlCloudAbsence,
  CONTROL_CLOUD_READER,
  CONTROL_CLOUD_BASELINE,
} from './native-control-cloud-absence.mjs';
// Portable synthetic observations. The issuing API separately pins and reads
// the real historical baseline; CI never reads this machine's state or VM.
const baseline = {
  snapshot: {
    scope: {
      database: 'synthetic-only',
      schema: 'synthetic-only',
      readOnly: 'on',
    },
    uncleanedOperationIds: ['44cff0b1-a2db-4953-a7b0-8e74c9f414ec'],
    attempt: { cleanupConfirmedAt: null, rowSha256: 'a'.repeat(64) },
    operation: { status: 'unknown', rowSha256: 'b'.repeat(64) },
  },
  physical: {
    configuredSocket: '/synthetic/cloud.sock',
    realSocket: '/synthetic/cloud.sock',
    device: 1,
    inode: 2,
    dockerId: 'synthetic-daemon',
    dockerVersion: 'synthetic-version',
    vm: { bootId: 'synthetic-vm' },
    nameProbeStatus: 404,
    labelProbeStatus: 200,
    labelMatchIds: [],
  },
};
const clone = (v) => JSON.parse(JSON.stringify(v));
function subject() {
  const nowMs = 1_000_000,
    planId = '55da416f-2786-411c-90ce-cc64604c2b7b';
  const before = {
    artifactId: 'sha256:' + '1'.repeat(64),
    profileId: 'allrice-once-control-v1',
    storageId: 'synthetic-control',
    stateRoot: '/synthetic/control',
  };
  const after = { ...before, artifactId: 'sha256:' + '2'.repeat(64) };
  const locks = ['qa-validation.lock', 'dev-deployment.lock'].map((path) => ({
    path: '/synthetic/' + path,
    ownerPid: 7001,
    ownerBirth: 'synthetic-lock-birth',
    acquiredAtMs: 900_000,
    tokenDigest: 'sha256:' + 'a'.repeat(64),
    ownershipEvidenceDigest: 'sha256:' + 'b'.repeat(64),
  }));
  const processes = ['web', 'worker'].map((role, i) => ({
    role,
    pid: 7100 + i,
    birth: 'synthetic-' + role,
    stopMode: 'normal',
    stopRequestedAtMs: 950_000,
    exitConfirmedAtMs: 960_000,
    exitEvidenceDigest: 'sha256:' + 'c'.repeat(64),
  }));
  const offline = { locks, processes };
  const lifecycleProof = processes.map((p) => ({
    identity: {
      service: p.role,
      pid: p.pid,
      sourceSha: '3'.repeat(40),
      sourceTree: '4'.repeat(40),
      environment: 'dev',
      bootId: 'synthetic-' + p.role,
    },
    producerLifecycle: {
      role: p.role,
      instance: { bootId: 'synthetic-' + p.role },
      releaseAdmission: 'disabled',
      unknownOutcomes: [],
      activeRoots: 0,
      pendingRoots: 0,
      unresolvedRoots: 0,
      retainedChildren: 0,
    },
  }));
  const facts = {
    reference: before,
    closeFence: { valid: true },
    protected: {
      allrice_automations: { count: 1, pin: 'sha256:' + 'd'.repeat(64) },
    },
  };
  const raw = {
    clouds: 1,
    employeeTests: 0,
    jobs: 0,
    onceOutbox: 0,
    providerFlows: 0,
    recurringOperations: 0,
    recurringOutbox: 0,
    runtimeLeases: 0,
  };
  const inv = {
    socketPath: baseline.physical.configuredSocket,
    status: 200,
    body: [],
  };
  const observation = {
    kind: 'native-control-cloud-absence-observation-v1',
    planId,
    partitionId: 'synthetic-partition',
    operationId: '44cff0b1-a2db-4953-a7b0-8e74c9f414ec',
    beforeReference: before,
    afterReference: after,
    readerPin: CONTROL_CLOUD_READER,
    baselinePin: CONTROL_CLOUD_BASELINE,
    observedAtMs: 970_000,
    expiresAtMs: 1_080_000,
    locks,
    processes,
    lifecycle: lifecycleProof,
    controlFacts: facts,
    sqlSnapshot: baseline.snapshot,
    physical: baseline.physical,
    inventory: inv,
    historicalOutcomeKnown: false,
    cleanupClaimed: false,
    globalResourceIdleProven: false,
  };
  return JSON.parse(
    JSON.stringify({
      nowMs,
      observation,
      baseline,
      review: {
        enabled: true,
        rootReviewed: true,
        reviewedBy: 'root',
        phase: 'prepare',
        partitionId: 'synthetic-partition',
        reviewedAtMs: 980_000,
        activeReleaseIdentity: {
          releaseSha: '3'.repeat(40),
          sourceTree: '4'.repeat(40),
        },
      },
      input: {
        requestId: planId,
        beforeReference: before,
        afterReference: after,
      },
      offline,
      lifecycleProof,
      actual: {
        baseline,
        sqlBefore: baseline.snapshot,
        sqlAfter: baseline.snapshot,
        controlBefore: { idle: raw, facts },
        controlAfter: { idle: raw, facts },
        physicalBefore: baseline.physical,
        physicalAfter: baseline.physical,
        inventoryBefore: inv,
        inventoryAfter: inv,
      },
    }),
  );
}
describe('exact historical cloud absence observations, synthetic evidence only', () => {
  it('accepts an exact original history without asserting cleanup or outcome', () => {
    const s = subject(),
      before = clone(s);
    expect(() => assertNativeControlCloudAbsence(s)).not.toThrow();
    expect(s).toEqual(before);
    expect(s.observation.sqlSnapshot.operation.status).toBe('unknown');
    expect(s.observation.sqlSnapshot.attempt.cleanupConfirmedAt).toBeNull();
  });
  it.each([
    [
      'unreviewed',
      (s) => {
        s.review.enabled = false;
      },
    ],
    [
      'different plan',
      (s) => {
        s.observation.planId = 'another';
      },
    ],
    [
      'different partition',
      (s) => {
        s.observation.partitionId = 'another';
      },
    ],
    [
      'different from tuple',
      (s) => {
        s.observation.beforeReference.storageId = 'another';
      },
    ],
    [
      'different to tuple',
      (s) => {
        s.observation.afterReference.artifactId = 'sha256:' + '9'.repeat(64);
      },
    ],
    [
      'different operation',
      (s) => {
        s.observation.operationId = 'another';
      },
    ],
    [
      'reader changed',
      (s) => {
        s.observation.readerPin.sha256 = 'f'.repeat(64);
      },
    ],
    [
      'baseline changed',
      (s) => {
        s.observation.baselinePin.sha256 = 'f'.repeat(64);
      },
    ],
    [
      'expired',
      (s) => {
        s.observation.expiresAtMs = s.nowMs;
      },
    ],
    [
      'future',
      (s) => {
        s.observation.observedAtMs = s.nowMs + 1;
      },
    ],
    [
      'unbounded ttl',
      (s) => {
        s.observation.expiresAtMs = s.observation.observedAtMs + 120001;
      },
    ],
    [
      'new cloud',
      (s) => {
        s.actual.controlAfter.idle.clouds = 2;
      },
    ],
    [
      'active job',
      (s) => {
        s.actual.controlBefore.idle.jobs = 1;
      },
    ],
    [
      'live lease',
      (s) => {
        s.actual.controlAfter.idle.runtimeLeases = 1;
      },
    ],
    [
      'pending outbox',
      (s) => {
        s.actual.controlBefore.idle.recurringOutbox = 1;
      },
    ],
    [
      'SQL bytes changed',
      (s) => {
        s.actual.sqlAfter.attempt.rowSha256 = 'f'.repeat(64);
      },
    ],
    [
      'extra SQL attempt',
      (s) => {
        s.actual.sqlAfter.uncleanedOperationIds.push('another');
      },
    ],
    [
      'original snapshot replaced',
      (s) => {
        s.observation.sqlSnapshot.operation.status = 'succeeded';
      },
    ],
    [
      'protected control facts changed',
      (s) => {
        s.actual.controlAfter.facts.protected.allrice_automations.count = 2;
      },
    ],
    [
      'VM reboot',
      (s) => {
        s.actual.physicalAfter.vm.bootId = 'another';
      },
    ],
    [
      'daemon restart',
      (s) => {
        s.actual.physicalAfter.dockerId = 'another';
      },
    ],
    [
      'socket replacement',
      (s) => {
        s.actual.physicalBefore.inode++;
      },
    ],
    [
      'inventory HTTP unknown',
      (s) => {
        s.actual.inventoryAfter.status = 500;
      },
    ],
    [
      'active container',
      (s) => {
        s.actual.inventoryBefore.body.push({ State: 'running' });
      },
    ],
    [
      'stopped container reservation',
      (s) => {
        s.actual.inventoryAfter.body.push({ State: 'created' });
      },
    ],
    [
      'missing complete inventory',
      (s) => {
        delete s.actual.inventoryBefore;
      },
    ],
    [
      'lock changed',
      (s) => {
        s.offline.locks[0].tokenDigest = 'sha256:' + 'f'.repeat(64);
      },
    ],
    [
      'force stop',
      (s) => {
        s.offline.processes[0].stopMode = 'forced';
        s.observation.processes = clone(s.offline.processes);
      },
    ],
    [
      'lifecycle busy',
      (s) => {
        s.lifecycleProof[0].producerLifecycle.activeRoots = 1;
        s.observation.lifecycle = clone(s.lifecycleProof);
      },
    ],
    [
      'lifecycle unknown',
      (s) => {
        s.lifecycleProof[1].producerLifecycle.unknownOutcomes = ['old'];
        s.observation.lifecycle = clone(s.lifecycleProof);
      },
    ],
    [
      'claim cleanup',
      (s) => {
        s.observation.cleanupClaimed = true;
      },
    ],
    [
      'claim settled outcome',
      (s) => {
        s.observation.historicalOutcomeKnown = true;
      },
    ],
  ])('rejects %s', (_name, change) => {
    const s = subject();
    change(s);
    expect(() => assertNativeControlCloudAbsence(s)).toThrow(
      /^NATIVE_CONTROL_CLOUD_/,
    );
  });
  it('does not issue a credential merely from rootReviewed JSON', async () => {
    await expect(
      verifyNativeControlCloudAbsence({
        review: { rootReviewed: true },
        mode: 'prepare',
      }),
    ).rejects.toThrow('EXPLICIT_REVIEW_REQUIRED');
  });
  it('accepts only the acknowledged after-reference/sequence while preserving every protected control fact', () => {
    const s = subject(),
      after = clone(s.input.afterReference);
    s.observation.controlFacts.previousSequence = 0;
    for (const v of [s.actual.controlBefore, s.actual.controlAfter]) {
      v.facts.reference = clone(after);
      v.facts.previousSequence = 1;
    }
    expect(() =>
      assertNativeControlCloudAbsence({
        ...s,
        committedReference: after,
        committedSequence: 1,
      }),
    ).not.toThrow();
    s.actual.controlAfter.facts.protected.allrice_automations.count++;
    expect(() =>
      assertNativeControlCloudAbsence({
        ...s,
        committedReference: after,
        committedSequence: 1,
      }),
    ).toThrow(/^NATIVE_CONTROL_CLOUD_/);
  });
});
