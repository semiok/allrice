// Exact local Dev control-upgrade observation only. Import is inert.
// No recovery, stop, cleanup, model, VM lifecycle or database write API exists here.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const P =
  '/Users/a123/.local/state/allrice-delivery/scheduled-admission-deadlock-20261023/publication-preparation/';
export const CONTROL_CLOUD_READER = Object.freeze({
  path: P + 'preserved-cloud.mjs',
  sha256: '96957a756e54118896bd3b75586c62d57b6f725ef263821e5a493ebed59163e9',
});
export const CONTROL_CLOUD_BASELINE = Object.freeze({
  path: P + 'preserved-cloud-baseline.reviewed.json',
  sha256: '22e6ba2d85ce9ec1a917b1c032478ccc97fa300070cbbd9a4a97121cea9bd5ce',
});
const OPERATION = '44cff0b1-a2db-4953-a7b0-8e74c9f414ec';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const need = (ok, code) => {
  if (!ok) throw Error('NATIVE_CONTROL_CLOUD_' + code);
};
const same = (a, b, code) => need(isDeepStrictEqual(a, b), code);
async function pinned(pin) {
  need(
    pin &&
      typeof pin.path === 'string' &&
      /^[a-f0-9]{64}$/.test(pin.sha256) &&
      (await realpath(pin.path)) === pin.path,
    'PIN_REQUIRED',
  );
  const s = await lstat(pin.path);
  need(
    s.isFile() &&
      s.uid === process.getuid() &&
      (s.mode & 0o077) === 0 &&
      s.size <= 1_048_576,
    'PRIVATE_PROOF_REQUIRED',
  );
  const bytes = await readFile(pin.path);
  need(hash(bytes) === pin.sha256, 'PIN_CHANGED');
  return { bytes, value: JSON.parse(bytes) };
}
async function reader() {
  const s = await lstat(CONTROL_CLOUD_READER.path);
  need(
    s.isFile() &&
      (await realpath(CONTROL_CLOUD_READER.path)) ===
        CONTROL_CLOUD_READER.path &&
      hash(await readFile(CONTROL_CLOUD_READER.path)) ===
        CONTROL_CLOUD_READER.sha256,
    'READER_CHANGED',
  );
  const r = await import(pathToFileURL(CONTROL_CLOUD_READER.path));
  return { r, baseline: r.readReviewedBaseline(CONTROL_CLOUD_BASELINE) };
}
function inventory(socketPath) {
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
        let size = 0;
        r.on('data', (b) => {
          size += b.length;
          if (size > 1_048_576)
            q.destroy(Error('NATIVE_CONTROL_CLOUD_INVENTORY_LIMIT'));
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
            reject(Error('NATIVE_CONTROL_CLOUD_INVENTORY_UNKNOWN'));
          }
        });
      },
    );
    q.setTimeout(5000, () =>
      q.destroy(Error('NATIVE_CONTROL_CLOUD_INVENTORY_TIMEOUT')),
    );
    q.on('error', reject);
    q.end();
  });
}
async function sqlFacts(sql, partitionId) {
  return sql.begin('isolation level repeatable read read only', async (tx) => {
    await tx`set local statement_timeout='5000'`;
    await tx`set local lock_timeout='1000'`;
    await tx`set local TimeZone='UTC'`;
    const [v] = await tx`select allrice_native_control_upgrade_idle() idle,
      allrice_native_control_upgrade_facts(${partitionId}) facts`;
    return JSON.parse(JSON.stringify(v));
  });
}
async function collect(sql, partitionId) {
  const { r, baseline } = await reader();
  const sqlBefore = await r.readSnapshot(sql),
    controlBefore = await sqlFacts(sql, partitionId);
  const physicalBefore = await r.physicalAbsence();
  const inventoryBefore = await inventory(physicalBefore.configuredSocket);
  const inventoryAfter = await inventory(physicalBefore.configuredSocket);
  const physicalAfter = await r.physicalAbsence();
  const controlAfter = await sqlFacts(sql, partitionId),
    sqlAfter = await r.readSnapshot(sql);
  return {
    baseline,
    sqlBefore,
    sqlAfter,
    controlBefore,
    controlAfter,
    physicalBefore,
    physicalAfter,
    inventoryBefore,
    inventoryAfter,
  };
}
function idle(v) {
  const keys = [
    'clouds',
    'employeeTests',
    'jobs',
    'onceOutbox',
    'providerFlows',
    'recurringOperations',
    'recurringOutbox',
    'runtimeLeases',
  ];
  need(
    v &&
      isDeepStrictEqual(Object.keys(v).sort(), keys) &&
      Object.entries(v).every(([k, n]) => n === (k === 'clouds' ? 1 : 0)),
    'RAW_BUSY',
  );
}
function lifecycle(healths, review, offline) {
  need(Array.isArray(healths) && healths.length === 2, 'LIFECYCLE_REQUIRED');
  same(
    healths.map((h) => h.identity?.service).sort(),
    ['web', 'worker'],
    'LIFECYCLE_REQUIRED',
  );
  for (const h of healths) {
    const i = h.identity,
      p = offline.processes.find((p) => p.role === i.service),
      s = h.producerLifecycle;
    need(
      p &&
        i.environment === 'dev' &&
        i.sourceSha === review.activeReleaseIdentity.releaseSha &&
        (!review.activeReleaseIdentity.sourceTree ||
          i.sourceTree === review.activeReleaseIdentity.sourceTree) &&
        i.pid === p.pid &&
        typeof i.bootId === 'string' &&
        i.bootId &&
        s?.role === i.service &&
        s.instance?.bootId === i.bootId &&
        s.releaseAdmission === 'disabled' &&
        isDeepStrictEqual(s.unknownOutcomes, []) &&
        [
          'activeRoots',
          'pendingRoots',
          'unresolvedRoots',
          'retainedChildren',
        ].every((k) => s[k] === 0),
      'LIFECYCLE_BUSY_OR_CHANGED',
    );
  }
}
/** Pure checks of already collected observations; never an issuing API. */
export function assertNativeControlCloudAbsence({
  observation: o,
  actual: a,
  review,
  input,
  offline,
  lifecycleProof,
  nowMs,
  committedReference,
  committedSequence,
}) {
  need(
    review?.enabled === true &&
      review.rootReviewed === true &&
      review.reviewedBy === 'root',
    'EXPLICIT_REVIEW_REQUIRED',
  );
  const planId =
    review.phase === 'prepare' ? input.requestId : input.plan?.planId;
  const before =
    review.phase === 'prepare'
      ? input.beforeReference
      : input.plan?.beforeReference;
  const after =
    review.phase === 'prepare'
      ? input.afterReference
      : input.plan?.afterReference;
  need(
    o?.kind === 'native-control-cloud-absence-observation-v1' &&
      o.planId === planId &&
      o.partitionId === review.partitionId &&
      o.operationId === OPERATION,
    'EXACT_SCOPE_REQUIRED',
  );
  same(o.beforeReference, before, 'TUPLE_CHANGED');
  same(o.afterReference, after, 'TUPLE_CHANGED');
  same(o.readerPin, CONTROL_CLOUD_READER, 'READER_PIN_CHANGED');
  same(o.baselinePin, CONTROL_CLOUD_BASELINE, 'BASELINE_PIN_CHANGED');
  need(
    Number.isSafeInteger(o.observedAtMs) &&
      Number.isSafeInteger(o.expiresAtMs) &&
      o.observedAtMs <= nowMs &&
      o.expiresAtMs > nowMs &&
      o.expiresAtMs <= o.observedAtMs + 120_000 &&
      o.observedAtMs <= review.reviewedAtMs &&
      review.reviewedAtMs <= nowMs,
    'EXPIRED',
  );
  same(o.locks, offline.locks, 'LOCK_SCOPE_CHANGED');
  same(o.processes, offline.processes, 'STOP_SCOPE_CHANGED');
  need(
    offline.processes.every(
      (p) =>
        p.stopMode === 'normal' &&
        p.stopRequestedAtMs <= p.exitConfirmedAtMs &&
        p.exitConfirmedAtMs <= o.observedAtMs,
    ) && offline.locks.every((l) => l.acquiredAtMs <= o.observedAtMs),
    'STOP_SCOPE_CHANGED',
  );
  same(o.lifecycle, lifecycleProof, 'LIFECYCLE_CHANGED');
  lifecycle(lifecycleProof, review, offline);
  idle(a.controlBefore.idle);
  idle(a.controlAfter.idle);
  same(a.controlAfter, a.controlBefore, 'CONTROL_SQL_CHANGED');
  if (committedReference === undefined) {
    same(o.controlFacts, a.controlBefore.facts, 'CONTROL_SQL_CHANGED');
  } else {
    const unchanged = (facts) =>
      Object.fromEntries(
        Object.entries(facts).filter(
          ([key]) =>
            !['reference', 'partitionPin', 'previousSequence'].includes(key),
        ),
      );
    same(
      a.controlBefore.facts.reference,
      committedReference,
      'COMMITTED_REFERENCE_CHANGED',
    );
    same(
      a.controlBefore.facts.previousSequence,
      committedSequence,
      'COMMITTED_SEQUENCE_CHANGED',
    );
    same(
      unchanged(a.controlBefore.facts),
      unchanged(o.controlFacts),
      'CONTROL_SQL_CHANGED',
    );
  }
  need(o.controlFacts?.closeFence?.valid === true, 'CONTROL_NOT_CLOSED');
  same(o.sqlSnapshot, a.baseline.snapshot, 'HISTORICAL_SQL_CHANGED');
  same(a.sqlBefore, a.baseline.snapshot, 'HISTORICAL_SQL_CHANGED');
  same(a.sqlAfter, a.sqlBefore, 'HISTORICAL_SQL_CHANGED');
  same(a.sqlBefore.uncleanedOperationIds, [OPERATION], 'CLOUD_SET_CHANGED');
  same(o.physical, a.baseline.physical, 'PHYSICAL_CHANGED');
  same(a.physicalBefore, o.physical, 'PHYSICAL_CHANGED');
  same(a.physicalAfter, a.physicalBefore, 'PHYSICAL_CHANGED');
  for (const v of [o.inventory, a.inventoryBefore, a.inventoryAfter])
    need(
      v?.socketPath === o.physical.configuredSocket &&
        v.status === 200 &&
        Array.isArray(v.body) &&
        v.body.length === 0,
      'CONTAINER_OR_UNCONFIRMED_INVENTORY',
    );
  same(a.inventoryBefore, a.inventoryAfter, 'INVENTORY_CHANGED');
  same(o.inventory, a.inventoryBefore, 'INVENTORY_CHANGED');
  need(
    o.historicalOutcomeKnown === false &&
      o.cleanupClaimed === false &&
      o.globalResourceIdleProven === false,
    'FALSE_CLEANUP_CLAIM',
  );
}
async function actualOffline(offline) {
  for (const lock of offline.locks) {
    const bytes = await readFile(lock.path);
    need(
      'sha256:' + hash(bytes) === lock.ownershipEvidenceDigest &&
        execFileSync(
          '/bin/ps',
          ['-p', String(lock.ownerPid), '-o', 'lstart='],
          { encoding: 'utf8', timeout: 5000 },
        ).trim() === lock.ownerBirth,
      'LOCK_OWNER_CHANGED',
    );
  }
  for (const p of offline.processes) {
    try {
      process.kill(p.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') continue;
      throw error;
    }
    need(false, 'STOPPED_PID_PRESENT');
  }
}
/** Existing reviewed operator calls this only after all its original gates.
 * JSON flags cannot issue a credential: the pinned reader and actual probes run
 * again here. SQL cannot attest OS truth; the original local operator is trusted. */
export async function verifyNativeControlCloudAbsence({
  sql,
  review,
  reviewSha256,
  input,
  offline,
  digest,
  mode,
}) {
  need(
    mode !== 'readback' &&
      review.historicalCloudObservationPin &&
      /^[a-f0-9]{64}$/.test(reviewSha256),
    'EXPLICIT_REVIEW_REQUIRED',
  );
  const { value: o } = await pinned(review.historicalCloudObservationPin);
  const life = await pinned(o.lifecyclePin);
  need(
    life.value?.kind === 'native-control-prestop-lifecycle-v1',
    'LIFECYCLE_REQUIRED',
  );
  await actualOffline(offline);
  const actual = await collect(sql, review.partitionId);
  await actualOffline(offline);
  assertNativeControlCloudAbsence({
    observation: o,
    actual,
    review,
    input,
    offline,
    lifecycleProof: life.value.healths,
    nowMs: Date.now(),
  });
  const observedDigest = digest(o);
  if (review.phase === 'apply') {
    const [stored] =
      await sql`select credential_digest,credential from allrice_native_control_cloud_absences where plan_id=${o.planId}`;
    need(
      stored &&
        stored.credential_digest === input.plan.historicalCloudAbsenceDigest &&
        digest(stored.credential) === stored.credential_digest &&
        digest(stored.credential.observation) === observedDigest &&
        isDeepStrictEqual(stored.credential.observation, o),
      'DURABLE_CREDENTIAL_CHANGED',
    );
    return {
      digest: stored.credential_digest,
      applyVerified: true,
      observation: o,
    };
  }
  return {
    observation: o,
    credential: {
      kind: 'native-control-cloud-absence-credential-v1',
      observation: o,
      approval: {
        kind: 'native-control-cloud-absence-source-approval-v1',
        reviewedBy: 'root',
        reviewedAtMs: review.reviewedAtMs,
        observationDigest: observedDigest,
        reviewPolicyDigest: 'sha256:' + reviewSha256,
        operatorSha256: review.operatorSha256,
        verifierSha256: review.cloudVerifierSha256,
        releaseSha: review.releaseSha,
        sourceTree: review.sourceTree,
        offlineProofDigest: 'sha256:' + review.offlineProofPin.sha256,
      },
    },
  };
}
/** Root may invoke this read-only collector in its later owned window. It never
 * approves or writes SQL; keep its output disabled until a separate exact review. */
export async function captureDisabledNativeControlCloudAbsence({
  sql,
  request,
  offline,
  lifecyclePin,
  ttlMs = 100_000,
}) {
  need(
    Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 120_000,
    'TTL_INVALID',
  );
  const observedAtMs = Date.now(),
    life = await pinned(lifecyclePin),
    a = await collect(sql, request.partitionId);
  same(a.sqlBefore, a.sqlAfter, 'HISTORICAL_SQL_CHANGED');
  same(a.sqlBefore, a.baseline.snapshot, 'HISTORICAL_SQL_CHANGED');
  same(a.physicalBefore, a.physicalAfter, 'PHYSICAL_CHANGED');
  same(a.physicalBefore, a.baseline.physical, 'PHYSICAL_CHANGED');
  same(a.controlBefore, a.controlAfter, 'CONTROL_SQL_CHANGED');
  idle(a.controlBefore.idle);
  need(
    a.inventoryBefore?.status === 200 &&
      isDeepStrictEqual(a.inventoryBefore.body, []) &&
      isDeepStrictEqual(a.inventoryBefore, a.inventoryAfter),
    'CONTAINER_OR_UNCONFIRMED_INVENTORY',
  );
  return {
    enabled: false,
    requiresSeparateRootReview: true,
    observation: {
      kind: 'native-control-cloud-absence-observation-v1',
      planId: request.requestId,
      partitionId: request.partitionId,
      beforeReference: request.beforeReference,
      afterReference: request.afterReference,
      operationId: OPERATION,
      readerPin: CONTROL_CLOUD_READER,
      baselinePin: CONTROL_CLOUD_BASELINE,
      observedAtMs,
      expiresAtMs: observedAtMs + ttlMs,
      locks: offline.locks,
      processes: offline.processes,
      lifecyclePin,
      lifecycle: life.value.healths,
      controlFacts: a.controlBefore.facts,
      sqlSnapshot: a.sqlBefore,
      physical: a.physicalBefore,
      inventory: a.inventoryBefore,
      historicalOutcomeKnown: false,
      cleanupClaimed: false,
      globalResourceIdleProven: false,
    },
  };
}

/** Probe after the acknowledged SQL mutation too. Failure retains the original
 * operator intent and forces exact readback; it never repeats the transaction. */
export async function verifyNativeControlCloudAbsenceAfter({
  sql,
  review,
  input,
  offline,
  observation,
  result,
}) {
  const life = await pinned(observation.lifecyclePin);
  await actualOffline(offline);
  const actual = await collect(sql, review.partitionId);
  await actualOffline(offline);
  assertNativeControlCloudAbsence({
    observation,
    actual,
    review,
    input,
    offline,
    lifecycleProof: life.value.healths,
    nowMs: Date.now(),
    committedReference:
      review.phase === 'apply'
        ? input.plan.afterReference
        : input.beforeReference,
    committedSequence:
      review.phase === 'apply'
        ? Number(result.sequence)
        : observation.controlFacts.previousSequence,
  });
}
