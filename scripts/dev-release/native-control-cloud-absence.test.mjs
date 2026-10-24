import { describe, expect, it } from 'vitest';
import {
  HISTORICAL_EXITED_CONTAINER as E,
  exitedContainerEvidenceDigest as d,
} from './retirement-preserved-cloud.mjs';
import actualInventory from './fixtures/native-control-cloud-inventory.actual.fixture.json';
import actualExitedIdentity from './fixtures/native-control-exited-identity.actual.fixture.json';
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

// Raw Docker list/old projected identity are exact root read-only captures.
// All control tuple/process/daemon/inspect responses remain synthetic offline
// fixtures: these tests never claim a fresh Docker/Dev observation.
function recordedSubject({ officeOnly = false } = {}) {
  const s = subject(),
    inv = {
      ...clone(actualInventory),
      socketPath: baseline.physical.configuredSocket,
    };
  if (officeOnly)
    inv.body = inv.body.filter((c) =>
      c.Names.includes('/allrice-office-met157'),
    );
  s.observation.inventory = clone(inv);
  s.actual.inventoryBefore = clone(inv);
  s.actual.inventoryAfter = clone(inv);
  s.observation.inventoryNonce = 'f325557f-7d61-4237-bdab-8876ad8234c6';
  s.observation.sharedVerifierSha256 = 'a'.repeat(64);
  s.actual.sharedVerifierSha256 = 'a'.repeat(64);
  Object.assign(s.review, {
    kind: 'allrice-dev-native-control-upgrade-review-v1',
    releaseSha: '5'.repeat(40),
    sourceTree: '6'.repeat(40),
    inventoryVerifierSha256: 'a'.repeat(64),
    offlineProofPin: { sha256: '7'.repeat(64) },
    exitedEvidencePin: {
      path: '/synthetic/control-raw-evidence.json',
      sha256: 'e'.repeat(64),
    },
  });
  if (officeOnly) return s;
  const target = actualInventory.body.find((c) => c.Id === E.id),
    v = actualExitedIdentity;
  // Only the recorded projection is real. The full Docker response is a
  // synthetic reconstruction for pure classification; no actual GET is claimed.
  const body = {
    Id: v.id,
    Name: v.name,
    Created: v.created,
    State: clone(v.state),
    Image: target.ImageID,
    Config: { Labels: clone(v.labels) },
    HostConfig: {
      RestartPolicy: clone(v.restartPolicy),
      AutoRemove: v.autoRemove,
      NetworkMode: v.networkMode,
    },
    Mounts: clone(target.Mounts),
  };
  const exited = {
    observedAt: new Date(s.observation.observedAtMs).toISOString(),
    baseline: {
      historical: { notTouchingUnknownOtherContainer: E.attemptId },
      inspect: clone(v),
      inventory: clone(inv),
    },
    inspectBefore: {
      socketPath: inv.socketPath,
      status: 200,
      body: clone(body),
    },
    inspectAfter: {
      socketPath: inv.socketPath,
      status: 200,
      body: clone(body),
    },
    inventoryAfter: clone(inv),
  };
  s.actual.recordedExitedObservation = clone(exited);
  s.actual.exitedObservation = clone(exited);
  const summary = {
    containerId: E.id,
    containerName: E.name,
    state: 'exited',
    pid: 0,
    rawOwnedCloudContainers: 1,
    preservedExitedContainers: 1,
    unclassifiedOwnedCloudContainers: 0,
    historicalOutcomeKnown: false,
    cleanupClaimed: false,
    containerRemoved: false,
    inspectDigest: d(body),
    physicalIdentityDigest: d(s.observation.physical),
    observedAt: exited.observedAt,
    identity: {
      ...clone(v),
      mounts: clone(v.mounts).sort((a, b) =>
        a.Destination.localeCompare(b.Destination),
      ),
    },
    historicalPin: clone(E.historicalPin),
    inspectPin: clone(E.inspectPin),
    inventoryPin: clone(E.inventoryPin),
  };
  s.observation.preservedExitedContainer = summary;
  s.observation.exitedEvidenceDigest = d(exited);
  s.review.controlExitedContainerPreservation = {
    kind: 'native-control-exact-exited-container-preservation-v1',
    enabled: true,
    rootReviewed: true,
    reviewedBy: 'root',
    phase: 'prepare',
    planId: s.observation.planId,
    partitionId: s.observation.partitionId,
    planDigest: null,
    credentialDigest: null,
    nonce: s.observation.inventoryNonce,
    containerId: E.id,
    containerName: E.name,
    releaseSha: s.review.releaseSha,
    sourceTree: s.review.sourceTree,
    reviewedAtMs: s.review.reviewedAtMs,
    expiresAtMs: s.observation.expiresAtMs,
    beforeReference: clone(s.observation.beforeReference),
    afterReference: clone(s.observation.afterReference),
    offlineProofDigest: 'sha256:' + s.review.offlineProofPin.sha256,
    locksDigest: d(s.offline.locks),
    processesDigest: d(s.offline.processes),
    inventoryDigest: d(inv),
    inspectDigest: d(body),
    physicalIdentityDigest: d(s.observation.physical),
    exitedEvidenceDigest: s.observation.exitedEvidenceDigest,
    exitedEvidenceFileDigest: 'sha256:' + s.review.exitedEvidencePin.sha256,
    historicalPin: clone(E.historicalPin),
    inspectPin: clone(E.inspectPin),
    inventoryPin: clone(E.inventoryPin),
    inventoryVerifierSha256: s.actual.sharedVerifierSha256,
  };
  return s;
}
describe('root captured inventory: six raw rows remain visible', () => {
  it('accepts the full captured inventory only under separate exact control preservation', () => {
    const s = recordedSubject(),
      before = clone(s);
    expect(s.observation.inventory.body).toHaveLength(6);
    expect(actualExitedIdentity.state.Pid).toBe(0);
    expect(() => assertNativeControlCloudAbsence(s)).not.toThrow();
    expect(s).toEqual(before);
    expect(s.observation.sqlSnapshot.operation.status).toBe('unknown');
    expect(s.observation.sqlSnapshot.attempt.cleanupConfirmedAt).toBeNull();
  });
  it('does not mistake the captured noncloud running Office infrastructure for a cloud producer', () => {
    const s = recordedSubject({ officeOnly: true });
    expect(s.observation.inventory.body[0].State).toBe('running');
    expect(() => assertNativeControlCloudAbsence(s)).not.toThrow();
  });
  it.each([
    (s) => delete s.review.controlExitedContainerPreservation,
    (s) => (s.review.controlExitedContainerPreservation.enabled = false),
    (s) =>
      (s.review.controlExitedContainerPreservation.kind =
        'allrice-dev-test-chat-retirement-exact-exited-container-v1'),
    (s) => (s.review.controlExitedContainerPreservation.phase = 'apply'),
    (s) =>
      (s.review.controlExitedContainerPreservation.planId = 'another-plan'),
    (s) =>
      (s.review.controlExitedContainerPreservation.partitionId =
        'another-partition'),
    (s) =>
      (s.review.controlExitedContainerPreservation.nonce = 'another-nonce'),
    (s) =>
      (s.review.controlExitedContainerPreservation.planDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.credentialDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.containerId = 'f'.repeat(
        64,
      )),
    (s) =>
      (s.review.controlExitedContainerPreservation.releaseSha = 'f'.repeat(40)),
    (s) =>
      (s.review.controlExitedContainerPreservation.sourceTree = 'f'.repeat(40)),
    (s) =>
      (s.review.controlExitedContainerPreservation.offlineProofDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.locksDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.processesDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.inventoryDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.inspectDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.physicalIdentityDigest =
        'sha256:' + 'f'.repeat(64)),
  ])(
    'requires independent exact control/source/nonce/credential authority (%#)',
    (change) => {
      const s = recordedSubject();
      change(s);
      expect(() => assertNativeControlCloudAbsence(s)).toThrow(
        /^NATIVE_CONTROL_CLOUD_/,
      );
    },
  );
  it.each(['stateRoot', 'storageId', 'profileId', 'artifactId'])(
    'binds both complete control tuples including %s',
    (key) => {
      for (const phase of ['beforeReference', 'afterReference']) {
        const s = recordedSubject();
        s.review.controlExitedContainerPreservation[phase][key] = 'another';
        expect(() => assertNativeControlCloudAbsence(s)).toThrow(
          'CONTROL_EXITED_TUPLE_CHANGED',
        );
      }
    },
  );
  it.each(['historicalPin', 'inspectPin', 'inventoryPin'])(
    'cannot substitute a chat approval or change preserved %s bytes',
    (key) => {
      const s = recordedSubject();
      s.review.controlExitedContainerPreservation[key].sha256 = 'f'.repeat(64);
      expect(() => assertNativeControlCloudAbsence(s)).toThrow(
        'CONTROL_EXITED_EVIDENCE_CHANGED',
      );
    },
  );
  it('requires the same tracked shared physical verifier, not an unchecked transitive dependency', () => {
    const s = recordedSubject();
    s.actual.sharedVerifierSha256 = 'b'.repeat(64);
    expect(() => assertNativeControlCloudAbsence(s)).toThrow(
      'INVENTORY_VERIFIER_OR_NONCE_REQUIRED',
    );
  });
  it('requires a fresh observed nonce even when the inventory contains only Office infrastructure', () => {
    const s = recordedSubject({ officeOnly: true });
    delete s.observation.inventoryNonce;
    expect(() => assertNativeControlCloudAbsence(s)).toThrow(
      'INVENTORY_VERIFIER_OR_NONCE_REQUIRED',
    );
  });
  it('keeps the control credential below the original65KiB bound while retaining all six raw rows', () => {
    const s = recordedSubject();
    const stored = {
      observation: s.observation,
      approval: {
        inventoryPreservation: s.review.controlExitedContainerPreservation,
      },
    };
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(65_536);
    expect(stored.observation.inventory.body).toHaveLength(6);
    expect(stored.observation).not.toHaveProperty('exitedObservation');
    expect(stored.observation).toHaveProperty('exitedEvidenceDigest');
  });
  it.each([
    (s) => delete s.actual.recordedExitedObservation,
    (s) =>
      (s.actual.recordedExitedObservation.inspectAfter.body.HostConfig.AutoRemove = true),
    (s) => (s.observation.exitedEvidenceDigest = 'sha256:' + 'f'.repeat(64)),
    (s) =>
      (s.review.controlExitedContainerPreservation.exitedEvidenceFileDigest =
        'sha256:' + 'f'.repeat(64)),
    (s) => (s.review.kind = 'allrice-dev-test-chat-retirement-review'),
  ])(
    'requires the separately pinned raw evidence and control authorizer (%#)',
    (change) => {
      const s = recordedSubject();
      change(s);
      expect(() => assertNativeControlCloudAbsence(s)).toThrow(
        /^NATIVE_CONTROL_CLOUD_/,
      );
    },
  );
  it('apply binds its own durable credential/plan and never reuses prepare approval', () => {
    const s = recordedSubject(),
      p = s.review.controlExitedContainerPreservation;
    s.review.phase = 'apply';
    s.input = {
      plan: {
        planId: s.observation.planId,
        beforeReference: clone(s.observation.beforeReference),
        afterReference: clone(s.observation.afterReference),
        historicalCloudAbsenceDigest: 'sha256:' + '9'.repeat(64),
      },
      planDigest: 'sha256:' + '8'.repeat(64),
    };
    expect(() => assertNativeControlCloudAbsence(s)).toThrow(
      'CONTROL_EXITED_EXACT_APPROVAL_REQUIRED',
    );
    Object.assign(p, {
      phase: 'apply',
      planDigest: s.input.planDigest,
      credentialDigest: s.input.plan.historicalCloudAbsenceDigest,
    });
    expect(() => assertNativeControlCloudAbsence(s)).not.toThrow();
    p.credentialDigest = 'sha256:' + 'f'.repeat(64);
    expect(() => assertNativeControlCloudAbsence(s)).toThrow(
      'CONTROL_EXITED_EXACT_APPROVAL_REQUIRED',
    );
  });
  it.each(['running', 'paused', 'created', 'exited'])(
    'blocks every OTHER %s cloud/reservation in the actual list',
    (State) => {
      const s = recordedSubject(),
        c = clone(s.actual.inventoryBefore.body.find((c) => c.Id === E.id));
      Object.assign(c, {
        Id: 'f'.repeat(64),
        Names: ['/renamed-reservation'],
        State,
      });
      c.Labels = { 'xyz.bplabs.allrice.cloud.slot-owner': 'current' };
      s.actual.inventoryBefore.body.push(c);
      expect(() => assertNativeControlCloudAbsence(s)).toThrow(
        /^NATIVE_CONTROL_CLOUD_/,
      );
    },
  );
  it('does not accept new noncloud infrastructure after the signed inventory capture', () => {
    const s = recordedSubject({ officeOnly: true });
    s.actual.inventoryAfter.body.push({
      ...clone(s.actual.inventoryAfter.body[0]),
      Id: 'f'.repeat(64),
      Names: ['/new-office'],
    });
    expect(() => assertNativeControlCloudAbsence(s)).toThrow(
      'INVENTORY_CHANGED',
    );
  });
  it.each([
    (s) => (s.actual.exitedObservation.inspectAfter.body.State.Pid = 1),
    (s) => (s.actual.exitedObservation.inspectAfter.body.State.Running = true),
    (s) =>
      (s.actual.exitedObservation.inspectAfter.body.HostConfig.RestartPolicy.Name =
        'always'),
    (s) =>
      (s.actual.exitedObservation.inspectAfter.body.HostConfig.AutoRemove = true),
    (s) =>
      (s.actual.exitedObservation.inspectAfter.body.Config.Labels[
        'xyz.bplabs.allrice.cloud.slot-owner'
      ] = 'current'),
    (s) => (s.actual.exitedObservation.inspectAfter.body.Mounts[0].RW = false),
    (s) => delete s.actual.exitedObservation,
    (s) => (s.actual.physicalAfter.dockerId = 'other'),
    (s) => (s.actual.sqlAfter.operation.status = 'running'),
    (s) => (s.actual.controlAfter.idle.jobs = 1),
  ])(
    'keeps all current activity/full inspect/daemon/raw44 guards (%#)',
    (change) => {
      const s = recordedSubject();
      change(s);
      expect(() => assertNativeControlCloudAbsence(s)).toThrow(
        /^NATIVE_CONTROL_CLOUD_/,
      );
    },
  );
});
