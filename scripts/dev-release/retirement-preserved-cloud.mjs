// One reviewed historical carry for the two slot5 development-test chats.
// Import is inert. No cleanup, cancellation, closure or outcome writes exist.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

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
// A single independently reviewed stopped container remains historical unknown.
// These original evidence bytes authorize preservation, never removal or closure.
const EXITED_PREFIX = '/Users/a123/.local/state/allrice-delivery/';
export const HISTORICAL_EXITED_CONTAINER = Object.freeze({
  id: 'c059c14ced1dcd6664c7131382a5ef0975c7c6ce1245932892dd921c45a070be',
  name: '/allrice-cloud-91e4fa1c-14af-499a-a2dd-d1989ce056b9',
  attemptId: '91e4fa1c-14af-499a-a2dd-d1989ce056b9',
  historicalPin: Object.freeze({
    path:
      EXITED_PREFIX +
      'sixth-environment-acceptance-20261007/cloud-owned-cleanup-preflight.json',
    sha256: '96f8c32c29a9cef5324f97845e8a7861f46b778952ee9067778ae2481235a2da',
  }),
  inspectPin: Object.freeze({
    path:
      EXITED_PREFIX +
      'met195-execution-convergence-20261023/c-drafts/retirement-entry-audit/actual-slot5-20261024/historical-exited-container-inspect-readonly.private.json',
    sha256: 'cd2ca6577a2941c4316787987c45087137dc3ee0a6cca0b72a0a42bd87843d2b',
  }),
  inventoryPin: Object.freeze({
    path:
      EXITED_PREFIX +
      'met195-execution-convergence-20261023/c-drafts/retirement-entry-audit/actual-slot5-20261024/cloud-inventory-refusal-readonly.private.json',
    sha256: 'b59255b4d7a25c7ddf1babdf7b574e4ed85cc62b6d0e1d1671290ac203525b6d',
  }),
});
const ARTIFACT =
  'sha256:76c014931795dc22967bcc5e1e44cb722f6575ce22fe6a2408d4eeae90de9998';
const IDS = [
  'd04715cd-9355-4fe4-b0e5-ae7eab360275',
  'd81a23d5-fab3-40fe-aa91-37579f1e1149',
];
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
    c?.kind === 'allrice-dev-test-chat-retirement-exact-cloud-v1' &&
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
  // This opt-in cannot be reused to discard real legacy chats or other kinds.
  need(
    plan.kind === 'development-test-chat-retirement' &&
      plan.schemaVersion === 1 &&
      Array.isArray(plan.snapshots) &&
      plan.snapshots.length === 2,
    'NATIVE_RETIREMENT_CLOUD_EXACT_SLOT5_PLAN_REQUIRED',
  );
  same(
    plan.snapshots.map((s) => s.scope?.contextId).sort(),
    IDS,
    'NATIVE_RETIREMENT_CLOUD_EXACT_SLOT5_PLAN_REQUIRED',
  );
  for (const s of plan.snapshots) {
    need(
      s.scope.contextKind === 'chat' &&
        s.scope.organizationId === '20f7df77-1792-4cb1-bacc-7c90e9091b45' &&
        s.scope.workspaceId === 'd6f88c29-1579-4aab-be4f-ff379a558d83' &&
        s.scope.ownerId === 'b5f3f49b-f188-4db1-bdad-82c94304d787' &&
        s.archived === true &&
        s.origin?.artifactId === ARTIFACT,
      'NATIVE_RETIREMENT_CLOUD_EXACT_SLOT5_PLAN_REQUIRED',
    );
  }
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

export function assertNoOwnedCloudContainers(inventory, physical) {
  need(
    inventory?.socketPath === physical.configuredSocket &&
      inventory.status === 200 &&
      Array.isArray(inventory.body),
    'NATIVE_RETIREMENT_CLOUD_INVENTORY_UNCONFIRMED',
  );
  for (const c of inventory.body) {
    need(
      c &&
        /^[a-f0-9]{64}$/.test(c.Id) &&
        Array.isArray(c.Names) &&
        c.Names.every((n) => typeof n === 'string') &&
        (c.Labels === null ||
          (typeof c.Labels === 'object' && !Array.isArray(c.Labels))) &&
        [
          'created',
          'restarting',
          'running',
          'removing',
          'paused',
          'exited',
          'dead',
        ].includes(c.State),
      'NATIVE_RETIREMENT_CLOUD_INVENTORY_UNCONFIRMED',
    );
    const labels = c.Labels ?? {};
    need(
      !c.Names.some((n) => /^\/allrice-cloud(?:-|$)/.test(n)) &&
        labels['xyz.bplabs.allrice.backend'] !== 'cloud-gvisor-v1' &&
        !Object.keys(labels).some((k) =>
          k.startsWith('xyz.bplabs.allrice.cloud.'),
        ),
      'NATIVE_RETIREMENT_CLOUD_CONTAINER_OR_RESERVATION_PRESENT',
    );
  }
}

// Canonical full inspect/daemon digests are bound to the final private review.
export function exitedContainerEvidenceDigest(value) {
  const sorted = (v) =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  return (
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(sorted(value)))
      .digest('hex')
  );
}
function exitedReview(review, plan) {
  const p = review.historicalCloudCarry.preservedExitedContainer;
  const h = HISTORICAL_EXITED_CONTAINER;
  need(
    p?.kind === 'allrice-dev-test-chat-retirement-exact-exited-container-v1' &&
      p.enabled === true &&
      p.rootReviewed === true &&
      p.reviewedBy === 'root' &&
      p.requestId === plan.requestId &&
      p.planDigest === plan.digest &&
      /^sha256:[a-f0-9]{64}$/.test(plan.authorizationEvidenceDigest) &&
      p.authorizationEvidenceDigest === plan.authorizationEvidenceDigest &&
      p.containerId === h.id &&
      p.containerName === h.name &&
      p.releaseSha === review.releaseSha &&
      p.sourceTree === review.sourceTree &&
      p.serviceIdentityDigest ===
        exitedContainerEvidenceDigest(
          review.historicalCloudCarry.serviceIdentities,
        ) &&
      /^sha256:[a-f0-9]{64}$/.test(p.inspectDigest) &&
      /^sha256:[a-f0-9]{64}$/.test(p.physicalIdentityDigest) &&
      Date.parse(p.reviewedAt) <= Date.now() &&
      Date.parse(p.expiresAt) > Date.now() &&
      Date.parse(p.expiresAt) - Date.parse(p.reviewedAt) <= 30 * 60_000,
    'NATIVE_RETIREMENT_EXITED_CONTAINER_EXACT_REVIEW_REQUIRED',
  );
  for (const key of ['historicalPin', 'inspectPin', 'inventoryPin'])
    same(
      p[key],
      h[key],
      'NATIVE_RETIREMENT_EXITED_CONTAINER_EVIDENCE_PIN_CHANGED',
    );
  return p;
}
function stableInventory(inventory) {
  need(
    inventory?.status === 200 &&
      Array.isArray(inventory.body) &&
      new Set(inventory.body.map((c) => c?.Id)).size === inventory.body.length,
    'NATIVE_RETIREMENT_CLOUD_INVENTORY_UNCONFIRMED',
  );
  // Only Docker's relative human Status text and array order are presentation.
  return inventory.body
    .map((c) => {
      const row = { ...c };
      delete row.Status;
      return {
        ...row,
        Names: [...c.Names].sort(),
        Mounts: [...c.Mounts].sort((a, b) =>
          a.Destination.localeCompare(b.Destination),
        ),
      };
    })
    .sort((a, b) => a.Id.localeCompare(b.Id));
}
const mountIdentity = (mounts) =>
  mounts
    .map((m) => ({
      Type: m.Type,
      Name: m.Name,
      Source: m.Source,
      Destination: m.Destination,
      RW: m.RW,
    }))
    .sort((a, b) => a.Destination.localeCompare(b.Destination));
function inspectedIdentity(response, physical) {
  need(
    response?.socketPath === physical.configuredSocket &&
      response.status === 200 &&
      response.body &&
      Array.isArray(response.body.Mounts),
    'NATIVE_RETIREMENT_EXITED_CONTAINER_INSPECT_UNCONFIRMED',
  );
  const c = response.body;
  return {
    status: response.status,
    id: c.Id,
    name: c.Name,
    created: c.Created,
    state: c.State,
    labels: c.Config?.Labels,
    restartPolicy: c.HostConfig?.RestartPolicy,
    autoRemove: c.HostConfig?.AutoRemove,
    mounts: mountIdentity(c.Mounts),
    networkMode: c.HostConfig?.NetworkMode,
  };
}
function assertExitedContainerPreserved({
  review,
  plan,
  physical,
  inventory,
  observation,
}) {
  const p = exitedReview(review, plan),
    h = HISTORICAL_EXITED_CONTAINER;
  need(
    observation &&
      Date.parse(observation.observedAt) <= Date.now() &&
      Date.now() - Date.parse(observation.observedAt) <= 120_000,
    'NATIVE_RETIREMENT_EXITED_CONTAINER_FRESH_INSPECT_REQUIRED',
  );
  same(
    exitedContainerEvidenceDigest(physical),
    p.physicalIdentityDigest,
    'NATIVE_RETIREMENT_EXITED_CONTAINER_DAEMON_CHANGED',
  );
  const { baseline, inspectBefore, inspectAfter, inventoryAfter } = observation;
  need(
    baseline?.historical?.notTouchingUnknownOtherContainer === h.attemptId,
    'NATIVE_RETIREMENT_EXITED_CONTAINER_ORIGINAL_UNKNOWN_REQUIRED',
  );
  same(
    stableInventory(inventory),
    stableInventory(baseline.inventory),
    'NATIVE_RETIREMENT_EXITED_CONTAINER_INVENTORY_CHANGED',
  );
  same(
    stableInventory(inventoryAfter),
    stableInventory(inventory),
    'NATIVE_RETIREMENT_EXITED_CONTAINER_INVENTORY_CHANGED',
  );
  same(
    inventoryAfter.socketPath,
    physical.configuredSocket,
    'NATIVE_RETIREMENT_CLOUD_INVENTORY_UNCONFIRMED',
  );
  const before = inspectedIdentity(inspectBefore, physical),
    after = inspectedIdentity(inspectAfter, physical);
  const expected = {
    ...baseline.inspect,
    mounts: mountIdentity(baseline.inspect.mounts),
  };
  same(before, expected, 'NATIVE_RETIREMENT_EXITED_CONTAINER_IDENTITY_CHANGED');
  same(after, before, 'NATIVE_RETIREMENT_EXITED_CONTAINER_IDENTITY_CHANGED');
  same(
    inspectBefore.body,
    inspectAfter.body,
    'NATIVE_RETIREMENT_EXITED_CONTAINER_INSPECT_CHANGED',
  );
  same(
    exitedContainerEvidenceDigest(inspectBefore.body),
    p.inspectDigest,
    'NATIVE_RETIREMENT_EXITED_CONTAINER_INSPECT_CHANGED',
  );
  need(
    before.id === h.id &&
      before.name === h.name &&
      before.created === '2026-10-04T02:24:40.086837435Z' &&
      before.state?.Status === 'exited' &&
      before.state.Pid === 0 &&
      before.state.Running === false &&
      before.state.Paused === false &&
      before.state.Restarting === false &&
      before.state.Dead === false &&
      before.state.OOMKilled === false &&
      before.state.Error === '' &&
      before.state.FinishedAt === '2026-10-04T02:24:45.291475245Z' &&
      before.restartPolicy?.Name === 'no' &&
      before.restartPolicy.MaximumRetryCount === 0 &&
      before.autoRemove === false &&
      before.networkMode === 'none' &&
      before.labels?.['xyz.bplabs.allrice.backend'] === 'cloud-gvisor-v1' &&
      before.labels?.['xyz.bplabs.allrice.cloud.attempt'] === h.attemptId,
    'NATIVE_RETIREMENT_EXITED_CONTAINER_NOT_EXACTLY_STOPPED',
  );
  for (const full of [inventory, inventoryAfter]) {
    const matches = full.body.filter((c) => c.Id === h.id);
    need(
      matches.length === 1 &&
        matches[0].State === 'exited' &&
        isDeepStrictEqual(matches[0].Names, [h.name]),
      'NATIVE_RETIREMENT_EXITED_CONTAINER_INVENTORY_CHANGED',
    );
    same(
      matches[0].Labels,
      before.labels,
      'NATIVE_RETIREMENT_EXITED_CONTAINER_IDENTITY_CHANGED',
    );
    same(
      matches[0].ImageID,
      inspectBefore.body.Image,
      'NATIVE_RETIREMENT_EXITED_CONTAINER_IDENTITY_CHANGED',
    );
    same(
      mountIdentity(matches[0].Mounts),
      before.mounts,
      'NATIVE_RETIREMENT_EXITED_CONTAINER_IDENTITY_CHANGED',
    );
    // Only the one fully verified constant can be preserved; all other owned
    // clouds/reservations still pass through the unchanged original guard.
    assertNoOwnedCloudContainers(
      { ...full, body: full.body.filter((c) => c.Id !== h.id) },
      physical,
    );
  }
  return {
    containerId: h.id,
    containerName: h.name,
    state: 'exited',
    pid: 0,
    rawOwnedCloudContainers: 1,
    preservedExitedContainers: 1,
    unclassifiedOwnedCloudContainers: 0,
    historicalOutcomeKnown: false,
    cleanupClaimed: false,
    containerRemoved: false,
    inspectDigest: p.inspectDigest,
    physicalIdentityDigest: p.physicalIdentityDigest,
    observedAt: observation.observedAt,
    identity: before,
    historicalPin: { ...h.historicalPin },
    inspectPin: { ...h.inspectPin },
    inventoryPin: { ...h.inventoryPin },
  };
}
async function readExitedBaseline() {
  const result = {};
  for (const [key, pin] of [
    ['historical', HISTORICAL_EXITED_CONTAINER.historicalPin],
    ['inspect', HISTORICAL_EXITED_CONTAINER.inspectPin],
    ['inventory', HISTORICAL_EXITED_CONTAINER.inventoryPin],
  ]) {
    need(
      (await realpath(pin.path)) === pin.path &&
        (await lstat(pin.path)).isFile(),
      'NATIVE_RETIREMENT_EXITED_CONTAINER_EVIDENCE_CHANGED',
    );
    const bytes = await readFile(pin.path);
    same(
      createHash('sha256').update(bytes).digest('hex'),
      pin.sha256,
      'NATIVE_RETIREMENT_EXITED_CONTAINER_EVIDENCE_CHANGED',
    );
    result[key] = JSON.parse(bytes);
  }
  return result;
}

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
  exitedObservation,
}) {
  assertCarryReview(review, plan);
  assertBusy(rawBefore, 1);
  assertBusy(rawAfter, 1);
  assertHealths(healthBefore, review);
  assertHealths(healthAfter, review);
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
  let exitedPreservation;
  if (review.historicalCloudCarry.preservedExitedContainer !== undefined)
    exitedPreservation = assertExitedContainerPreserved({
      review,
      plan,
      physical: physicalBefore,
      inventory,
      observation: exitedObservation,
    });
  else assertNoOwnedCloudContainers(inventory, physicalBefore);
  return {
    rawBusy: { ...rawBefore },
    finalRawBusy: { ...rawAfter },
    rawUncleanedCloudAttempts: 1,
    preservedUnresolvedCloudAttempts: 1,
    unpreservedCloudAttempts: 0,
    unclassifiedOwnedCloudContainers: 0,
    ...(exitedPreservation
      ? { historicalExitedContainerPreservation: exitedPreservation }
      : {}),
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

function readDocker(socketPath, path) {
  return new Promise((resolve, reject) => {
    const q = http.request(
      {
        socketPath,
        method: 'GET',
        path,
        headers: { connection: 'close' },
      },
      (r) => {
        const chunks = [];
        let bytes = 0;
        r.on('data', (b) => {
          bytes += b.length;
          if (bytes > 1_048_576)
            q.destroy(Error('NATIVE_RETIREMENT_CLOUD_INVENTORY_TOO_LARGE'));
          else chunks.push(b);
        });
        r.on('error', reject);
        r.on('end', () => {
          try {
            resolve({
              socketPath,
              status: r.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch {
            reject(Error('NATIVE_RETIREMENT_CLOUD_INVENTORY_UNCONFIRMED'));
          }
        });
      },
    );
    q.setTimeout(5000, () =>
      q.destroy(Error('NATIVE_RETIREMENT_CLOUD_INVENTORY_TIMEOUT')),
    );
    q.on('error', reject);
    q.end();
  });
}

const readInventory = (socketPath) =>
  readDocker(socketPath, '/v1.45/containers/json?all=1');
export const readHistoricalExitedContainer = (socketPath) =>
  readDocker(
    socketPath,
    '/v1.45/containers/' + HISTORICAL_EXITED_CONTAINER.id + '/json',
  );

export async function verifyRetirementBusy({
  review,
  plan,
  sql,
  readBusy,
  readHealths,
  healths,
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
  let exitedBaseline;
  if (review.historicalCloudCarry.preservedExitedContainer !== undefined) {
    exitedReview(review, plan);
    exitedBaseline = await readExitedBaseline();
  }
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
  const baseline = reader.readReviewedBaseline(HISTORICAL_CLOUD.baselinePin);
  const before = await reader.readSnapshot(sql);
  const physicalBefore = await reader.physicalAbsence();
  const inventory = await readInventory(physicalBefore.configuredSocket);
  let exitedObservation;
  if (exitedBaseline) {
    const observedAt = new Date().toISOString();
    const inspectBefore = await readHistoricalExitedContainer(
      physicalBefore.configuredSocket,
    );
    const inventoryAfter = await readInventory(physicalBefore.configuredSocket);
    const inspectAfter = await readHistoricalExitedContainer(
      physicalBefore.configuredSocket,
    );
    exitedObservation = {
      observedAt,
      baseline: exitedBaseline,
      inspectBefore,
      inspectAfter,
      inventoryAfter,
    };
  }
  // Same original probe brackets the extra inventory, fencing VM/daemon/socket
  // changes without introducing any recovery or container lifecycle API.
  const physicalAfter = await reader.physicalAbsence();
  const after = await reader.readSnapshot(sql);
  const rawAfter = await readBusy();
  const healthAfter = await readHealths();
  return classifyRetirementCloudCarry({
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
    exitedObservation,
  });
}
