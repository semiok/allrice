// Exact later development-test chat plans only. This never changes the sealed
// slot5 authority and never infers that a chat is a test from its title/content.
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  assertNoOwnedCloudContainers,
  collectHistoricalExitedContainerObservation,
  readCompleteCloudInventory,
  exitedContainerEvidenceDigest as digest,
} from './retirement-preserved-cloud.mjs';
import {
  HISTORICAL_CLOUD,
  assertReviewedCloudBusy,
  assertReviewedCloudHealths,
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
export function classifyReviewedTestChatCloudCarry(input) {
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
  assertReviewedCloudHealths(healthBefore, review);
  assertReviewedCloudHealths(healthAfter, review);
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
  healths,
  readHealths,
  physicalProof,
  evidencePath,
  saveEvidence,
}) {
  reviewedTestChatPhysicalScope(review, plan);
  const rawBefore = await readBusy();
  assertReviewedCloudBusy(rawBefore, 1);
  assertReviewedCloudHealths(healths, review);
  const verifierSha256 = await readReviewedCloudModuleDigest(import.meta.url),
    sharedVerifierSha256 = await readReviewedCloudModuleDigest(
      new URL('./retirement-preserved-cloud.mjs', import.meta.url),
    ),
    physicalVerifierSha256 = await readReviewedCloudModuleDigest(
      new URL('./terminal-retirement-preserved-cloud.mjs', import.meta.url),
    );
  const p = review.historicalCloudCarry.preservedExitedContainer,
    recordedExitedObservation =
      p === undefined
        ? undefined
        : await readReviewedCloudObservation(p.observationPin);
  const r = await source(),
    baseline = r.readReviewedBaseline(HISTORICAL_CLOUD.baselinePin),
    before = await r.readSnapshot(sql),
    physicalBefore = await r.physicalAbsence(),
    inventory = await readCompleteCloudInventory(
      physicalBefore.configuredSocket,
    ),
    exitedObservation =
      p === undefined
        ? undefined
        : await collectHistoricalExitedContainerObservation(physicalBefore),
    physicalAfter = await r.physicalAbsence(),
    after = await r.readSnapshot(sql),
    rawAfter = await readBusy(),
    healthAfter = await readHealths();
  const result = classifyReviewedTestChatCloudCarry({
    review,
    plan,
    physicalProof,
    baseline,
    before,
    after,
    physicalBefore,
    physicalAfter,
    inventory,
    recordedExitedObservation,
    exitedObservation,
    verifierSha256,
    sharedVerifierSha256,
    physicalVerifierSha256,
    rawBefore,
    rawAfter,
    healthBefore: healths,
    healthAfter,
  });
  same(
    verifierSha256,
    await readReviewedCloudModuleDigest(import.meta.url),
    'VERIFIER_CHANGED',
  );
  same(
    sharedVerifierSha256,
    await readReviewedCloudModuleDigest(
      new URL('./retirement-preserved-cloud.mjs', import.meta.url),
    ),
    'VERIFIER_CHANGED',
  );
  same(
    physicalVerifierSha256,
    await readReviewedCloudModuleDigest(
      new URL('./terminal-retirement-preserved-cloud.mjs', import.meta.url),
    ),
    'VERIFIER_CHANGED',
  );
  need(
    typeof saveEvidence === 'function' && typeof evidencePath === 'string',
    'PRIVATE_EVIDENCE_REQUIRED',
  );
  const evidence = JSON.parse(
    JSON.stringify({
      kind: 'reviewed-test-chat-cloud-verification-v1',
      requestId: plan.requestId,
      planDigest: plan.digest,
      physicalProof,
      physicalBefore,
      physicalAfter,
      inventory,
      exitedObservation,
      recordedObservationPin: p?.observationPin,
      verifierSha256,
      sharedVerifierSha256,
      physicalVerifierSha256,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
    }),
  );
  await saveEvidence(evidencePath, evidence);
  return {
    ...result,
    privateCloudEvidence: { path: evidencePath, digest: digest(evidence) },
  };
}
