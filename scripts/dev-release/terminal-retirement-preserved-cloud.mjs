// Independent, exact-plan nonchat historical carry. The chat helper is unchanged.
// Import is inert. No cleanup, cancellation, closure or outcome writes exist.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  HISTORICAL_EXITED_CONTAINER as EXITED,
  assertNoOwnedCloudContainers,
  assertHistoricalExitedContainerObservation,
  collectHistoricalExitedContainerObservation,
  readCompleteCloudInventory as readInventory,
  nativeCloudInventoryIdentity,
  exitedContainerEvidenceDigest as digest,
} from './retirement-preserved-cloud.mjs';
export {
  assertNoOwnedCloudContainers,
  privateObservation as readReviewedCloudObservation,
  moduleDigest as readReviewedCloudModuleDigest,
};

async function moduleDigest(url) {
  const path = fileURLToPath(url),
    stat = await lstat(path);
  need(
    stat.isFile() && stat.size <= 1_048_576 && (await realpath(path)) === path,
    'NATIVE_TERMINAL_CLOUD_VERIFIER_CHANGED',
  );
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
async function privateObservation(pin) {
  need(
    pin && typeof pin.path === 'string' && /^[a-f0-9]{64}$/.test(pin.sha256),
    'NATIVE_TERMINAL_CLOUD_OBSERVATION_PIN_REQUIRED',
  );
  const stat = await lstat(pin.path);
  need(
    stat.isFile() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0 &&
      stat.size <= 1_048_576 &&
      (await realpath(pin.path)) === pin.path,
    'NATIVE_TERMINAL_CLOUD_PRIVATE_OBSERVATION_REQUIRED',
  );
  const bytes = await readFile(pin.path);
  need(
    createHash('sha256').update(bytes).digest('hex') === pin.sha256,
    'NATIVE_TERMINAL_CLOUD_OBSERVATION_CHANGED',
  );
  return JSON.parse(bytes);
}
export function assertReviewedExitedContainerPhysical({
  review,
  plan,
  physicalProof: proof,
  physical,
  inventory,
  recorded,
  actual,
  verifierSha256,
  sharedVerifierSha256,
  observationKind = 'terminal-exact-exited-cloud-observation-v1',
}) {
  const p = review.historicalCloudCarry.preservedExitedContainer,
    now = Date.now();
  need(
    p &&
      p.enabled === true &&
      p.rootReviewed === true &&
      p.reviewedBy === 'root' &&
      p.requestId === plan.requestId &&
      p.planDigest === plan.digest &&
      p.authorizationEvidenceDigest === plan.authorizationEvidenceDigest &&
      p.containerId === EXITED.id &&
      p.containerName === EXITED.name &&
      p.releaseSha === review.releaseSha &&
      p.sourceTree === review.sourceTree &&
      /^[a-f0-9]{40}$/.test(p.releaseSha) &&
      /^[a-f0-9]{40}$/.test(p.sourceTree) &&
      p.serviceIdentityDigest === digest(review.serviceIdentities) &&
      p.verifierSha256 === verifierSha256 &&
      /^[a-f0-9]{64}$/.test(verifierSha256) &&
      p.sharedVerifierSha256 === sharedVerifierSha256 &&
      /^[a-f0-9]{64}$/.test(sharedVerifierSha256) &&
      typeof p.observationPin?.path === 'string' &&
      p.observationPin.path.startsWith('/') &&
      /^[a-f0-9]{64}$/.test(p.observationPin.sha256) &&
      recorded?.kind === observationKind &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        p.nonce,
      ) &&
      p.nonce === recorded.nonce &&
      recorded.requestId === plan.requestId &&
      recorded.planDigest === plan.digest &&
      recorded.verifierSha256 === verifierSha256 &&
      recorded.sharedVerifierSha256 === sharedVerifierSha256 &&
      Date.parse(recorded.observedAt) <= Date.parse(p.reviewedAt) &&
      Date.parse(p.reviewedAt) <= now &&
      Date.parse(p.expiresAt) > now &&
      Date.parse(p.expiresAt) <= Date.parse(recorded.expiresAt) &&
      Date.parse(recorded.expiresAt) <=
        Date.parse(recorded.observedAt) + 120_000 &&
      proof?.kind === 'terminal-native-physical-absence-v1' &&
      proof.requestId === plan.requestId &&
      proof.planDigest === plan.digest &&
      proof.scopeDigest === p.physicalScopeDigest &&
      proof.scopeDigest === recorded.physicalScopeDigest &&
      proof.sourceSha === review.releaseSha &&
      proof.sourceTree === review.sourceTree &&
      proof.workerBootId === review.serviceIdentities[1].bootId &&
      proof.workerBootStartedAt === review.serviceIdentities[1].startedAt &&
      Date.parse(proof.workerBootStartedAt) <= Date.parse(proof.observedAt) &&
      Date.parse(proof.observedAt) <= now &&
      Date.parse(proof.expiresAt) > now &&
      Date.parse(proof.expiresAt) <= Date.parse(proof.observedAt) + 120_000,
    'NATIVE_TERMINAL_EXITED_CONTAINER_EXACT_REVIEW_REQUIRED',
  );
  same(
    proof.nativeProcesses,
    [],
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  same(proof.writers, [], 'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED');
  same(
    p.storageNamespaces,
    proof.storageNamespaces,
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  same(
    recorded.storageNamespaces,
    proof.storageNamespaces,
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  same(
    p.artifactRootsDigest,
    digest(proof.artifactRoots),
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  same(
    p.writerScopesDigest,
    digest(proof.writerScopes),
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  same(
    recorded.physical,
    physical,
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  same(
    nativeCloudInventoryIdentity(recorded.inventory),
    nativeCloudInventoryIdentity(inventory),
    'NATIVE_TERMINAL_CLOUD_INVENTORY_CHANGED',
  );
  same(
    p.inventoryDigest,
    digest(nativeCloudInventoryIdentity(recorded.inventory)),
    'NATIVE_TERMINAL_CLOUD_INVENTORY_CHANGED',
  );
  const original = assertHistoricalExitedContainerObservation({
    preservation: p,
    physical,
    inventory: recorded.inventory,
    observation: recorded.observation,
  });
  const current = assertHistoricalExitedContainerObservation({
    preservation: p,
    physical,
    inventory,
    observation: actual,
  });
  same(
    original.identity,
    current.identity,
    'NATIVE_TERMINAL_CLOUD_INSPECT_CHANGED',
  );
  return current;
}

function assertTerminalExitedContainer(input) {
  const p = input.review.historicalCloudCarry.preservedExitedContainer;
  need(
    p?.kind === 'allrice-dev-terminal-nonchat-exact-exited-container-v1',
    'NATIVE_TERMINAL_EXITED_CONTAINER_EXACT_REVIEW_REQUIRED',
  );
  same(
    p.terminalScopes,
    input.plan.snapshots.map((s) => s.scope),
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  return assertReviewedExitedContainerPhysical(input);
}

/** Read-only collection only. Root must save private bytes and separately bind
 * exact terminal scope, current identities and source pins before any apply. */
export async function captureDisabledTerminalExitedCloudObservation({
  plan,
  physicalScope,
}) {
  need(
    plan?.kind === 'development-terminal-test-retirement',
    'NATIVE_TERMINAL_CLOUD_PLAN_REQUIRED',
  );
  return captureDisabledExactExitedCloudObservation({
    requestId: plan.requestId,
    planDigest: plan.digest,
    physicalScope,
    observationKind: 'terminal-exact-exited-cloud-observation-v1',
  });
}
export async function captureDisabledExactExitedCloudObservation({
  requestId,
  planDigest,
  physicalScope,
  observationKind,
}) {
  need(
    requestId &&
      planDigest &&
      physicalScope?.digest &&
      Array.isArray(physicalScope.storageNamespaces),
    'NATIVE_TERMINAL_CLOUD_PLAN_REQUIRED',
  );
  const pin = HISTORICAL_CLOUD.readerPin;
  need(
    (await realpath(pin.path)) === pin.path &&
      (await lstat(pin.path)).isFile() &&
      createHash('sha256')
        .update(await readFile(pin.path))
        .digest('hex') === pin.sha256,
    'NATIVE_RETIREMENT_CLOUD_READER_BYTES_CHANGED',
  );
  const reader = await import(pathToFileURL(pin.path));
  const observedAt = new Date().toISOString(),
    physical = await reader.physicalAbsence();
  const inventory = await readInventory(physical.configuredSocket);
  const observation =
    await collectHistoricalExitedContainerObservation(physical);
  same(
    physical,
    await reader.physicalAbsence(),
    'NATIVE_TERMINAL_CLOUD_PHYSICAL_SCOPE_CHANGED',
  );
  return {
    kind: observationKind,
    enabled: false,
    requiresIndependentRootReview: true,
    requestId,
    planDigest,
    physicalScopeDigest: physicalScope.digest,
    storageNamespaces: physicalScope.storageNamespaces,
    nonce: randomUUID(),
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 120_000).toISOString(),
    physical,
    inventory,
    observation,
    verifierSha256: await moduleDigest(import.meta.url),
    sharedVerifierSha256: await moduleDigest(
      new URL('./retirement-preserved-cloud.mjs', import.meta.url),
    ),
  };
}

const PREFIX =
  '/Users/a123/.local/state/allrice-delivery/scheduled-admission-deadlock-20261023/publication-preparation/';
export const HISTORICAL_CLOUD = Object.freeze({
  operationId: '44cff0b1-a2db-4953-a7b0-8e74c9f414ec',
  runId: '0c350e53-4ad8-4e57-bdc0-f4472e74d0d3',
  jobId: '6a42bf8b-9a3b-432a-9fb1-e4123bbccc8a',
  attemptId: '6275fd00-d4d6-4440-a340-95662caaa7b8',
  readerPin: Object.freeze({
    path: PREFIX + 'preserved-cloud.mjs',
    sha256: '96957a756e54118896bd3b75586c62d57b6f725ef263821e5a493ebed59163e9',
  }),
  baselinePin: Object.freeze({
    path: PREFIX + 'preserved-cloud-baseline.reviewed.json',
    sha256: '22e6ba2d85ce9ec1a917b1c032478ccc97fa300070cbbd9a4a97121cea9bd5ce',
  }),
});
const IDENTITY_KEYS = [
  'service',
  'sourceSha',
  'sourceTree',
  'manifestDigest',
  'environment',
  'bootId',
  'pid',
  'startedAt',
];
const need = (ok, code) => {
  if (!ok) throw Error(code);
};
const same = (a, b, code) => need(isDeepStrictEqual(a, b), code);

function assertCarryReview(review, plan) {
  const c = review.historicalCloudCarry;
  need(
    review.kind === 'allrice-dev-terminal-nonchat-retirement-review' &&
      review.enabled === true &&
      c?.kind === 'allrice-dev-terminal-nonchat-exact-cloud-v1' &&
      c.enabled === true &&
      c.rootReviewed === true &&
      review.rootReviewed === true &&
      review.reviewedBy === 'root' &&
      c.requestId === plan.requestId &&
      c.planDigest === plan.digest,
    'NATIVE_RETIREMENT_CLOUD_CARRY_REVIEW_REQUIRED',
  );
  same(
    c.readerPin,
    HISTORICAL_CLOUD.readerPin,
    'NATIVE_RETIREMENT_CLOUD_READER_PIN_CHANGED',
  );
  same(
    c.baselinePin,
    HISTORICAL_CLOUD.baselinePin,
    'NATIVE_RETIREMENT_CLOUD_BASELINE_PIN_CHANGED',
  );
  // Independent nonchat authority; never borrow PR530's two-chat review.
  need(
    plan.kind === 'development-terminal-test-retirement' &&
      plan.schemaVersion === 1 &&
      Array.isArray(plan.snapshots) &&
      plan.snapshots.length >= 1 &&
      plan.snapshots.length <= 10,
    'NATIVE_TERMINAL_CLOUD_PLAN_REQUIRED',
  );
  const scopes = plan.snapshots.map((s) => s.scope);
  need(
    scopes.every(
      (s) =>
        [
          'platform_employee_test',
          'experience_consolidation',
          'platform_technical',
        ].includes(s.contextKind) &&
        s.contextId !== '68e76b6b-2e75-45b7-b628-951945b12044',
    ),
    'NATIVE_TERMINAL_CLOUD_SCOPE_INVALID',
  );
  same(
    scopes,
    review.terminalScopes,
    'NATIVE_TERMINAL_CLOUD_EXACT_SCOPES_REQUIRED',
  );
  same(
    c.serviceIdentities,
    review.serviceIdentities,
    'NATIVE_TERMINAL_CLOUD_IDENTITIES_CHANGED',
  );
  need(
    c.authorizationEvidenceDigest === plan.authorizationEvidenceDigest &&
      review.authorizationEvidenceDigest === plan.authorizationEvidenceDigest &&
      Date.parse(c.reviewedAt) <= Date.now() &&
      Date.parse(c.expiresAt) > Date.now() &&
      Date.parse(c.expiresAt) - Date.parse(c.reviewedAt) <= 30 * 60_000,
    'NATIVE_TERMINAL_CLOUD_REVIEW_EXPIRED',
  );
}

function assertBusy(raw, expectedClouds) {
  need(
    raw &&
      ['jobs', 'clouds', 'tests', 'leases', 'auth'].every((k) =>
        Object.hasOwn(raw, k),
      ) &&
      raw.clouds === expectedClouds &&
      Object.entries(raw).every(
        ([k, n]) =>
          Number.isSafeInteger(n) && n >= 0 && (k === 'clouds' || n === 0),
      ),
    'NATIVE_RETIREMENT_DEV_BUSY',
  );
}

function assertHealths(healths, review) {
  const expected = review.historicalCloudCarry.serviceIdentities;
  need(
    Array.isArray(healths) &&
      healths.length === 2 &&
      Array.isArray(expected) &&
      expected.length === 2,
    'NATIVE_RETIREMENT_CLOUD_CURRENT_IDENTITIES_REQUIRED',
  );
  for (const [index, role] of ['web', 'worker'].entries()) {
    const h = healths[index],
      pin = expected[index],
      s = h.producerLifecycle;
    need(
      pin?.service === role &&
        pin.sourceSha === review.releaseSha &&
        pin.sourceTree === review.sourceTree &&
        /^[a-f0-9]{40}$/.test(pin.sourceSha) &&
        /^[a-f0-9]{40}$/.test(pin.sourceTree) &&
        /^sha256:[a-f0-9]{64}$/.test(pin.manifestDigest) &&
        pin.environment === 'dev' &&
        typeof pin.bootId === 'string' &&
        pin.bootId.length > 0 &&
        Number.isSafeInteger(pin.pid) &&
        pin.pid > 1 &&
        typeof pin.startedAt === 'string' &&
        pin.startedAt.length > 0,
      'NATIVE_RETIREMENT_CLOUD_CURRENT_IDENTITIES_REQUIRED',
    );
    for (const k of IDENTITY_KEYS)
      same(
        h.identity?.[k],
        pin[k],
        'NATIVE_RETIREMENT_CLOUD_CURRENT_IDENTITY_CHANGED',
      );
    need(
      s?.role === role &&
        s.instance?.bootId === pin.bootId &&
        s.releaseAdmission === 'disabled' &&
        isDeepStrictEqual(s.unknownOutcomes, []) &&
        [
          'activeRoots',
          'pendingRoots',
          'unresolvedRoots',
          'retainedChildren',
        ].every((k) => s[k] === 0),
      'NATIVE_RETIREMENT_CLOUD_CURRENT_LIFECYCLE_BUSY',
    );
  }
}

// Physical/SQL observations only. Role-specific callers must validate their
// own exact approval; these read-only checks never grant retirement authority.
export function assertReviewedHistoricalCloudFacts({
  baseline,
  before,
  after,
  physicalBefore,
  physicalAfter,
}) {
  need(
    baseline?.enabled === true &&
      baseline.rootReviewed === true &&
      baseline.historicalOutcomeKnown === false &&
      baseline.cleanupClaimed === false &&
      baseline.globalResourceIdleProven === false &&
      baseline.scope?.operationId === HISTORICAL_CLOUD.operationId &&
      baseline.scope.runId === HISTORICAL_CLOUD.runId &&
      baseline.scope.jobId === HISTORICAL_CLOUD.jobId &&
      baseline.scope.attemptId === HISTORICAL_CLOUD.attemptId,
    'NATIVE_RETIREMENT_CLOUD_BASELINE_REQUIRED',
  );
  same(
    before,
    baseline.snapshot,
    'NATIVE_RETIREMENT_HISTORICAL_CLOUD_SQL_CHANGED',
  );
  same(after, before, 'NATIVE_RETIREMENT_HISTORICAL_CLOUD_SQL_CHANGED');
  same(
    before.uncleanedOperationIds,
    [HISTORICAL_CLOUD.operationId],
    'NATIVE_RETIREMENT_HISTORICAL_CLOUD_SET_CHANGED',
  );
  same(
    physicalBefore,
    baseline.physical,
    'NATIVE_RETIREMENT_CLOUD_PHYSICAL_IDENTITY_CHANGED',
  );
  same(
    physicalAfter,
    physicalBefore,
    'NATIVE_RETIREMENT_CLOUD_PHYSICAL_IDENTITY_CHANGED',
  );
}
export {
  assertBusy as assertReviewedCloudBusy,
  assertHealths as assertReviewedCloudHealths,
};

// Pure classification of observations already collected by the pinned reader.
// A caller-supplied JSON claim never substitutes for verifyRetirementBusy().
export function classifyRetirementCloudCarry({
  review,
  plan,
  baseline,
  rawBefore,
  rawAfter,
  healthBefore,
  healthAfter,
  before,
  after,
  physicalBefore,
  physicalAfter,
  inventory,
  physicalProof,
  recordedExitedObservation,
  exitedObservation,
  verifierSha256,
  sharedVerifierSha256,
}) {
  assertCarryReview(review, plan);
  assertBusy(rawBefore, 1);
  assertBusy(rawAfter, 1);
  assertHealths(healthBefore, review);
  assertHealths(healthAfter, review);
  assertReviewedHistoricalCloudFacts({
    baseline,
    before,
    after,
    physicalBefore,
    physicalAfter,
  });
  const preservedExitedContainer =
    review.historicalCloudCarry.preservedExitedContainer === undefined
      ? undefined
      : assertTerminalExitedContainer({
          review,
          plan,
          physicalProof,
          physical: physicalBefore,
          inventory,
          recorded: recordedExitedObservation,
          actual: exitedObservation,
          verifierSha256,
          sharedVerifierSha256,
        });
  if (preservedExitedContainer === undefined)
    assertNoOwnedCloudContainers(inventory, physicalBefore);
  return {
    ...(preservedExitedContainer === undefined
      ? {}
      : { preservedExitedContainer }),
    rawBusy: { ...rawBefore },
    finalRawBusy: { ...rawAfter },
    rawUncleanedCloudAttempts: 1,
    preservedUnresolvedCloudAttempts: 1,
    unpreservedCloudAttempts: 0,
    unclassifiedOwnedCloudContainers: 0,
    historicalOutcomeKnown: false,
    cleanupClaimed: false,
    globalResourceIdleProven: false,
    physicalAbsenceObserved: true,
    databaseWritten: false,
    modelCalls: 0,
    readerPin: { ...HISTORICAL_CLOUD.readerPin },
    baselinePin: { ...HISTORICAL_CLOUD.baselinePin },
  };
}

export async function verifyRetirementBusy({
  review,
  plan,
  sql,
  readBusy,
  readHealths,
  healths,
  physicalProof,
  evidencePath,
  saveEvidence,
}) {
  const rawBefore = await readBusy();
  if (review.historicalCloudCarry === undefined) {
    assertBusy(rawBefore, 0);
    return {
      rawBusy: { ...rawBefore },
      rawUncleanedCloudAttempts: 0,
      preservedUnresolvedCloudAttempts: 0,
      unpreservedCloudAttempts: 0,
      historicalCarryEnabled: false,
      databaseWritten: false,
      modelCalls: 0,
    };
  }
  assertCarryReview(review, plan);
  assertBusy(rawBefore, 1);
  assertHealths(healths, review);
  const pin = HISTORICAL_CLOUD.readerPin;
  need(
    (await realpath(pin.path)) === pin.path &&
      (await lstat(pin.path)).isFile() &&
      createHash('sha256')
        .update(await readFile(pin.path))
        .digest('hex') === pin.sha256,
    'NATIVE_RETIREMENT_CLOUD_READER_BYTES_CHANGED',
  );
  const verifierSha256 = await moduleDigest(import.meta.url),
    sharedVerifierSha256 = await moduleDigest(
      new URL('./retirement-preserved-cloud.mjs', import.meta.url),
    );
  const approval = review.historicalCloudCarry.preservedExitedContainer;
  const recordedExitedObservation =
    approval === undefined
      ? undefined
      : await privateObservation(approval.observationPin);
  const reader = await import(pathToFileURL(pin.path));
  const baseline = reader.readReviewedBaseline(HISTORICAL_CLOUD.baselinePin);
  const before = await reader.readSnapshot(sql);
  const physicalBefore = await reader.physicalAbsence();
  const inventory = await readInventory(physicalBefore.configuredSocket);
  const exitedObservation =
    approval === undefined
      ? undefined
      : await collectHistoricalExitedContainerObservation(physicalBefore);
  // Same original probe brackets the extra inventory, fencing VM/daemon/socket
  // changes without introducing any recovery or container lifecycle API.
  const physicalAfter = await reader.physicalAbsence();
  const after = await reader.readSnapshot(sql);
  const rawAfter = await readBusy();
  const healthAfter = await readHealths();
  const classification = classifyRetirementCloudCarry({
    review,
    plan,
    baseline,
    rawBefore,
    rawAfter,
    healthBefore: healths,
    healthAfter,
    before,
    after,
    physicalBefore,
    physicalAfter,
    inventory,
    physicalProof,
    recordedExitedObservation,
    exitedObservation,
    verifierSha256,
    sharedVerifierSha256,
  });
  same(
    verifierSha256,
    await moduleDigest(import.meta.url),
    'NATIVE_TERMINAL_CLOUD_VERIFIER_CHANGED',
  );
  same(
    sharedVerifierSha256,
    await moduleDigest(
      new URL('./retirement-preserved-cloud.mjs', import.meta.url),
    ),
    'NATIVE_TERMINAL_CLOUD_VERIFIER_CHANGED',
  );
  if (approval !== undefined) {
    need(
      typeof saveEvidence === 'function' && typeof evidencePath === 'string',
      'NATIVE_TERMINAL_CLOUD_PRIVATE_EVIDENCE_REQUIRED',
    );
    const evidence = {
      kind: 'terminal-exact-exited-cloud-verification-v1',
      requestId: plan.requestId,
      planDigest: plan.digest,
      nonce: recordedExitedObservation.nonce,
      physical: physicalBefore,
      inventory,
      exitedObservation,
      recordedObservationPin: approval.observationPin,
      verifierSha256,
      sharedVerifierSha256,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
    };
    await saveEvidence(evidencePath, evidence);
    classification.privateCloudEvidence = {
      path: evidencePath,
      sha256: createHash('sha256')
        .update(JSON.stringify(evidence, null, 2) + '\n')
        .digest('hex'),
    };
  }
  return classification;
}
