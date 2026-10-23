// Exact later development-test chat plans only. This never changes the sealed
// slot5 authority and never infers that a chat is a test from its title/content.
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { observeCompleteReadOnlyQuiescence } from './retirement-readonly-observer.mjs';
import {
  assertNoOwnedCloudContainers,
  collectHistoricalExitedContainerObservation,
  readCompleteCloudInventory,
  reviewedRetirementServicesIdle,
  lifecycleActivity,
  exitedContainerEvidenceDigest as digest,
} from './retirement-preserved-cloud.mjs';
import {
  HISTORICAL_CLOUD,
  assertReviewedCloudBusy,
  assertReviewedHistoricalCloudFacts,
  assertReviewedExitedContainerPhysical,
  readReviewedCloudObservation,
  readReviewedCloudModuleDigest,
  captureDisabledExactExitedCloudObservation,
} from './terminal-retirement-preserved-cloud.mjs';
const PROTECTED = '68e76b6b-2e75-45b7-b628-951945b12044';
const SHA = /^sha256:[a-f0-9]{64}$/;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const REVIEWED_TEST_CHAT_REVIEW_KIND =
  'allrice-dev-reviewed-archived-test-chat-retirement-v1';
const OBSERVATION = 'reviewed-test-chat-exact-exited-cloud-observation-v1';
const need = (ok, code) => {
  if (!ok) throw Error('NATIVE_REVIEWED_TEST_CHAT_' + code);
};
const same = (a, b, code) => need(isDeepStrictEqual(a, b), code);
const unique = (items) => [...new Set(items)].sort();

/** Consumes an exact root decision. An evidence digest identifies that decision;
 * this helper cannot create test eligibility or choose additional chat IDs. */
export function reviewedTestChatPhysicalScope(review, plan) {
  const carry = review?.historicalCloudCarry;
  need(
    review?.kind === REVIEWED_TEST_CHAT_REVIEW_KIND &&
      review.enabled === true &&
      review.rootReviewed === true &&
      review.reviewedBy === 'root' &&
      review.developmentTestScopesApproved === true &&
      carry?.kind === 'allrice-dev-reviewed-test-chat-exact-cloud-v1' &&
      carry.enabled === true &&
      carry.rootReviewed === true &&
      carry.reviewedBy === 'root' &&
      plan?.kind === 'development-test-chat-retirement' &&
      plan.schemaVersion === 1 &&
      UUID.test(plan.requestId) &&
      SHA.test(plan.digest) &&
      SHA.test(plan.authorizationEvidenceDigest) &&
      review.requestId === plan.requestId &&
      review.planDigest === plan.digest &&
      carry.requestId === plan.requestId &&
      carry.planDigest === plan.digest &&
      carry.authorizationEvidenceDigest === plan.authorizationEvidenceDigest &&
      review.authorizationEvidenceDigest === plan.authorizationEvidenceDigest &&
      Array.isArray(plan.snapshots) &&
      plan.snapshots.length > 0 &&
      plan.snapshots.length <= 50 &&
      Array.isArray(review.exactDevelopmentTestChats) &&
      review.exactDevelopmentTestChats.length === plan.snapshots.length &&
      UUID.test(carry.observationNonce) &&
      Date.parse(carry.reviewedAt) <= Date.now() &&
      Date.parse(carry.expiresAt) > Date.now() &&
      Date.parse(carry.expiresAt) - Date.parse(carry.reviewedAt) <= 30 * 60_000,
    'EXACT_ROOT_TEST_PLAN_REQUIRED',
  );
  same(carry.readerPin, HISTORICAL_CLOUD.readerPin, 'READER_PIN_CHANGED');
  same(carry.baselinePin, HISTORICAL_CLOUD.baselinePin, 'BASELINE_PIN_CHANGED');
  same(carry.serviceIdentities, review.serviceIdentities, 'IDENTITY_CHANGED');
  const artifacts = [],
    namespaces = [],
    scopes = [];
  for (const [index, snapshot] of plan.snapshots.entries()) {
    const scope = snapshot.scope,
      entry = review.exactDevelopmentTestChats[index];
    need(
      scope?.contextKind === 'chat' &&
        snapshot.archived === true &&
        ['contextId', 'organizationId', 'workspaceId', 'ownerId'].every((key) =>
          UUID.test(scope[key]),
        ) &&
        !JSON.stringify(snapshot).toLowerCase().includes(PROTECTED) &&
        entry?.kind === 'reviewed-development-test-chat-v1' &&
        entry.classification === 'development_test' &&
        entry.authorizationEvidenceDigest ===
          plan.authorizationEvidenceDigest &&
        SHA.test(entry.scopeEvidenceDigest) &&
        entry.snapshotDigest === digest(snapshot) &&
        Array.isArray(snapshot.bindings) &&
        Array.isArray(entry.oldArtifactIds) &&
        entry.oldArtifactIds.length > 0 &&
        entry.oldArtifactIds.every((id) => SHA.test(id)) &&
        Array.isArray(entry.storageNamespaces) &&
        entry.storageNamespaces.length > 0 &&
        entry.storageNamespaces.every(
          (p) =>
            typeof p === 'string' &&
            posix.isAbsolute(p) &&
            posix.resolve(p) === p,
        ),
      'EXACT_ARCHIVED_TEST_EVIDENCE_REQUIRED',
    );
    same(entry.scope, scope, 'SCOPE_CHANGED');
    same(
      entry.oldArtifactIds,
      unique(entry.oldArtifactIds),
      'ARTIFACT_SET_CHANGED',
    );
    same(
      entry.storageNamespaces,
      unique(entry.storageNamespaces),
      'STORAGE_SET_CHANGED',
    );
    if (snapshot.origin !== null)
      need(
        snapshot.origin?.contextKind === 'chat' &&
          snapshot.origin.contextId === scope.contextId &&
          entry.oldArtifactIds.includes(snapshot.origin.artifactId),
        'ORIGIN_CHANGED',
      );
    for (const b of snapshot.bindings)
      need(
        b.context_kind === 'chat' &&
          b.context_id === scope.contextId &&
          b.organization_id === scope.organizationId &&
          b.workspace_id === scope.workspaceId &&
          b.owner_id === scope.ownerId &&
          entry.oldArtifactIds.includes(b.artifact_id) &&
          entry.storageNamespaces.includes(b.storage_namespace),
        'BINDING_SCOPE_CHANGED',
      );
    artifacts.push(...entry.oldArtifactIds);
    namespaces.push(...entry.storageNamespaces);
    scopes.push(scope);
  }
  need(
    unique(scopes.map((s) => s.contextId)).length === scopes.length,
    'DUPLICATE_SCOPE',
  );
  same(review.oldArtifactIds, unique(artifacts), 'ARTIFACT_SET_CHANGED');
  const scope = {
    scopes,
    artifactIds: unique(artifacts),
    storageNamespaces: unique(namespaces),
  };
  return { ...scope, digest: digest(scope) };
}
function physicalScope(review, plan, proof, scope) {
  need(
    proof?.kind === 'terminal-native-physical-absence-v1' &&
      proof.requestId === plan.requestId &&
      proof.planDigest === plan.digest &&
      proof.scopeDigest === scope.digest &&
      proof.workerBootId === review.serviceIdentities?.[1]?.bootId &&
      proof.workerBootStartedAt === review.serviceIdentities[1].startedAt &&
      proof.sourceSha === review.releaseSha &&
      proof.sourceTree === review.sourceTree &&
      Date.parse(proof.workerBootStartedAt) <= Date.parse(proof.observedAt) &&
      Date.parse(proof.observedAt) <= Date.now() &&
      Date.parse(proof.expiresAt) > Date.now() &&
      Date.parse(proof.expiresAt) - Date.parse(proof.observedAt) <= 120_000,
    'PHYSICAL_SCOPE_REQUIRED',
  );
  same(proof.nativeProcesses, [], 'PHYSICAL_SCOPE_REQUIRED');
  same(proof.writers, [], 'PHYSICAL_SCOPE_REQUIRED');
  same(proof.storageNamespaces, scope.storageNamespaces, 'STORAGE_SET_CHANGED');
  same(
    unique(proof.artifactRoots.map((p) => p.artifactId)),
    scope.artifactIds,
    'ARTIFACT_SET_CHANGED',
  );
  same(
    unique(proof.writerScopes.map((p) => p.artifactId)),
    scope.artifactIds,
    'ARTIFACT_SET_CHANGED',
  );
  need(
    scope.storageNamespaces.every((ns) =>
      proof.writerScopes.some(
        (p) => ns === p.root || ns.startsWith(p.root + '/'),
      ),
    ),
    'WRITER_SCOPE_CHANGED',
  );
}

/** Pure observations only; the issuing path below always loads private pins and
 * independently runs the fixed actual GETs. No chat/control approval is accepted. */
function classifyReviewedTestChatCloudFacts(input) {
  const {
    review,
    plan,
    physicalProof,
    baseline,
    before,
    after,
    physicalBefore,
    physicalAfter,
    rawBefore,
    rawAfter,
    healthBefore,
    healthAfter,
    inventory,
    recordedExitedObservation,
    exitedObservation,
    verifierSha256,
    sharedVerifierSha256,
    physicalVerifierSha256,
  } = input;
  const scope = reviewedTestChatPhysicalScope(review, plan);
  physicalScope(review, plan, physicalProof, scope);
  assertReviewedCloudBusy(rawBefore, 1);
  assertReviewedCloudBusy(rawAfter, 1);
  const beforeIdle = reviewedRetirementServicesIdle(healthBefore, review);
  const afterIdle = reviewedRetirementServicesIdle(healthAfter, review);
  assertReviewedHistoricalCloudFacts({
    baseline,
    before,
    after,
    physicalBefore,
    physicalAfter,
  });
  const p = review.historicalCloudCarry.preservedExitedContainer;
  let preservedExitedContainer;
  if (p === undefined) assertNoOwnedCloudContainers(inventory, physicalBefore);
  else {
    need(
      p.kind === 'allrice-dev-reviewed-test-chat-exact-exited-container-v1' &&
        p.nonce === review.historicalCloudCarry.observationNonce &&
        p.physicalVerifierSha256 === physicalVerifierSha256 &&
        /^[a-f0-9]{64}$/.test(physicalVerifierSha256) &&
        recordedExitedObservation?.physicalVerifierSha256 ===
          physicalVerifierSha256,
      'INDEPENDENT_EXITED_REVIEW_REQUIRED',
    );
    same(p.testChatScopes, scope.scopes, 'SCOPE_CHANGED');
    same(p.oldArtifactIds, scope.artifactIds, 'ARTIFACT_SET_CHANGED');
    preservedExitedContainer = assertReviewedExitedContainerPhysical({
      review,
      plan,
      physicalProof,
      physical: physicalBefore,
      inventory,
      recorded: recordedExitedObservation,
      actual: exitedObservation,
      verifierSha256,
      sharedVerifierSha256,
      observationKind: OBSERVATION,
    });
  }
  return {
    idle: beforeIdle && afterIdle,
    classification: {
      rawBusy: { ...rawBefore },
      finalRawBusy: { ...rawAfter },
      rawUncleanedCloudAttempts: 1,
      preservedUnresolvedCloudAttempts: 1,
      unpreservedCloudAttempts: 0,
      unclassifiedOwnedCloudContainers: 0,
      ...(preservedExitedContainer ? { preservedExitedContainer } : {}),
      exactTestChatScopes: scope.scopes,
      oldArtifactIds: scope.artifactIds,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
      globalResourceIdleProven: false,
      databaseWritten: false,
      modelCalls: 0,
    },
  };
}
export function classifyReviewedTestChatCloudCarry(observation) {
  const { idle, classification } =
    classifyReviewedTestChatCloudFacts(observation);
  need(idle, 'CURRENT_LIFECYCLE_BUSY');
  return classification;
}

/** Uses the common bounded mechanism, but only this exact chat authority and
 * classifier. Every attempted round contains fresh target physical evidence. */
export function observeReviewedTestChatQuiescence({
  review,
  plan,
  ...options
}) {
  reviewedTestChatPhysicalScope(review, plan);
  return observeCompleteReadOnlyQuiescence({
    ...options,
    classifyObservation: (observation) => {
      const facts = classifyReviewedTestChatCloudFacts({
        ...observation,
        review,
        plan,
      });
      const scope = reviewedTestChatPhysicalScope(review, plan);
      const healthPairs = [observation.healthBefore, observation.healthAfter];
      for (const target of [
        observation.targetPhysicalBefore,
        observation.targetPhysicalAfter,
      ]) {
        need(
          target && typeof target === 'object',
          'TARGET_PHYSICAL_ROUND_REQUIRED',
        );
        physicalScope(review, plan, target.physicalProof, scope);
        healthPairs.push(target.healthBefore, target.healthAfter);
      }
      // Do not short-circuit: a busy first pair must not mask a later hard error.
      const idlePairs = healthPairs.map((healths) =>
        reviewedRetirementServicesIdle(healths, review, true),
      );
      same(
        observation.physicalProof,
        observation.targetPhysicalAfter.physicalProof,
        'FINAL_PHYSICAL_ROUND_CHANGED',
      );
      return {
        idle: facts.idle && idlePairs.every(Boolean),
        classification: { classification: facts.classification, observation },
        activity: {
          serviceAndTargetBrackets: healthPairs.map(lifecycleActivity),
        },
      };
    },
  });
}

/** Production wiring is injected only with bounded read-only readers. Tests can
 * exercise this exact order without a real database, VM or service. */
export async function collectReviewedTestChatRound(
  {
    review,
    plan,
    attempt,
    readBusy,
    readHealths,
    reader,
    sql,
    baseline,
    collectPhysicalObservation,
    readInventory = readCompleteCloudInventory,
    readExited = collectHistoricalExitedContainerObservation,
    recordedExitedObservation,
    verifierSha256,
    sharedVerifierSha256,
    physicalVerifierSha256,
  },
  step,
) {
  reviewedTestChatPhysicalScope(review, plan);
  need(
    Number.isSafeInteger(attempt) &&
      attempt > 0 &&
      typeof collectPhysicalObservation === 'function',
    'TARGET_PHYSICAL_ROUND_REQUIRED',
  );
  const rawBefore = await step(() => readBusy());
  assertReviewedCloudBusy(rawBefore, 1);
  const healthBefore = await step((signal) => readHealths(signal));
  reviewedRetirementServicesIdle(healthBefore, review, true);
  const before = await step(() => reader.readSnapshot(sql));
  const targetPhysicalBefore = await step(() =>
    collectPhysicalObservation(
      '.attempt-' + attempt + '.target-before.json',
      step,
    ),
  );
  const physicalBefore = await step(() => reader.physicalAbsence());
  const inventory = await step(() =>
    readInventory(physicalBefore.configuredSocket),
  );
  const exitedObservation =
    review.historicalCloudCarry.preservedExitedContainer === undefined
      ? undefined
      : await step(() => readExited(physicalBefore, step));
  const physicalAfter = await step(() => reader.physicalAbsence());
  const targetPhysicalAfter = await step(() =>
    collectPhysicalObservation(
      '.attempt-' + attempt + '.target-after.json',
      step,
    ),
  );
  const after = await step(() => reader.readSnapshot(sql));
  const rawAfter = await step(() => readBusy());
  const healthAfter = await step((signal) => readHealths(signal));
  return {
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
    exitedObservation,
    targetPhysicalBefore,
    targetPhysicalAfter,
    physicalProof: targetPhysicalAfter.physicalProof,
    recordedExitedObservation,
    verifierSha256,
    sharedVerifierSha256,
    physicalVerifierSha256,
  };
}

async function source() {
  const pin = HISTORICAL_CLOUD.readerPin;
  same(
    await readReviewedCloudModuleDigest(pathToFileURL(pin.path)),
    pin.sha256,
    'READER_CHANGED',
  );
  return import(pathToFileURL(pin.path));
}
export async function captureDisabledReviewedTestChatCloudObservation({
  review,
  plan,
}) {
  const scope = reviewedTestChatPhysicalScope(review, plan);
  const result = await captureDisabledExactExitedCloudObservation({
    requestId: plan.requestId,
    planDigest: plan.digest,
    physicalScope: scope,
    observationKind: OBSERVATION,
  });
  return {
    ...result,
    nonce: randomUUID(),
    physicalVerifierSha256: result.verifierSha256,
    verifierSha256: await readReviewedCloudModuleDigest(import.meta.url),
  };
}
export async function verifyReviewedTestChatCloudCarry({
  review,
  plan,
  sql,
  readBusy,
  readHealths,
  collectPhysicalObservation,
  evidencePath,
  saveEvidence,
}) {
  reviewedTestChatPhysicalScope(review, plan);
  need(
    typeof saveEvidence === 'function' &&
      typeof evidencePath === 'string' &&
      typeof collectPhysicalObservation === 'function',
    'PRIVATE_EVIDENCE_REQUIRED',
  );
  const verifierSha256 = await readReviewedCloudModuleDigest(import.meta.url),
    sharedVerifierSha256 = await readReviewedCloudModuleDigest(
      new URL('./retirement-preserved-cloud.mjs', import.meta.url),
    ),
    physicalVerifierSha256 = await readReviewedCloudModuleDigest(
      new URL('./terminal-retirement-preserved-cloud.mjs', import.meta.url),
    );
  const p = review.historicalCloudCarry.preservedExitedContainer;
  const recordedExitedObservation =
    p === undefined
      ? undefined
      : await readReviewedCloudObservation(p.observationPin);
  const reader = await source(),
    baseline = reader.readReviewedBaseline(HISTORICAL_CLOUD.baselinePin);
  let attempt = 0;
  const result = await observeReviewedTestChatQuiescence({
    review,
    plan,
    readObservation: async (step) => {
      const observation = await collectReviewedTestChatRound(
        {
          review,
          plan,
          attempt: ++attempt,
          readBusy,
          readHealths,
          reader,
          sql,
          baseline,
          collectPhysicalObservation,
          recordedExitedObservation,
          verifierSha256,
          sharedVerifierSha256,
          physicalVerifierSha256,
        },
        step,
      );
      for (const [url, original] of [
        [import.meta.url, verifierSha256],
        [
          new URL('./retirement-preserved-cloud.mjs', import.meta.url),
          sharedVerifierSha256,
        ],
        [
          new URL('./terminal-retirement-preserved-cloud.mjs', import.meta.url),
          physicalVerifierSha256,
        ],
      ])
        same(
          original,
          await step(() => readReviewedCloudModuleDigest(url)),
          'VERIFIER_CHANGED',
        );
      return observation;
    },
  });
  const evidence = JSON.parse(
    JSON.stringify({
      kind: 'reviewed-test-chat-cloud-verification-v1',
      requestId: plan.requestId,
      planDigest: plan.digest,
      ...result.observation,
      recordedObservationPin: p?.observationPin,
      quiescenceObservation: result.quiescenceObservation,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
    }),
  );
  await saveEvidence(evidencePath, evidence);
  return {
    ...result.classification,
    quiescenceObservation: result.quiescenceObservation,
    privateCloudEvidence: { path: evidencePath, digest: digest(evidence) },
  };
}
