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
  assertNoOwnedCloudContainers(inventory, physicalBefore);
  return {
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

function readInventory(socketPath) {
  return new Promise((resolve, reject) => {
    const q = http.request(
      {
        socketPath,
        method: 'GET',
        path: '/v1.45/containers/json?all=1',
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
  });
}
