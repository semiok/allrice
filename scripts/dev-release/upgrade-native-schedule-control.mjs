#!/usr/bin/env node
// Local Dev operator only; disabled without explicit arguments and root review.
// Root supplies reviewed artifact/public-history and normal-stop OS evidence.
// This script does not stop/start services, take locks, or activate a supervisor.
import { createHash } from 'node:crypto';
import {
  verifyNativeControlCloudAbsence,
  verifyNativeControlCloudAbsenceAfter,
} from './native-control-cloud-absence.mjs';
import { execFileSync } from 'node:child_process';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PREFIX = 'NATIVE_CONTROL_UPGRADE_';
const GENERATION = 'dsh-0.2.1-rc.2-687f282';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digest = (value) =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const time = (value) => Number.isSafeInteger(value) && value >= 0;
function need(ok, code) {
  if (!ok) throw Error(PREFIX + code);
}
const exact = (a, b) => isDeepStrictEqual(a, b);
const normalized = (value) =>
  typeof value === 'string' && resolve(value) === value;
async function privateInput(path, parseJson = true) {
  need(
    normalized(path) && (await realpath(path)) === path,
    'EXACT_PRIVATE_PATH_REQUIRED',
  );
  const s = await lstat(path);
  need(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.uid === process.getuid() &&
      (s.mode & 0o077) === 0 &&
      s.size <= 1_000_000,
    'PRIVATE_INPUT_REQUIRED',
  );
  const bytes = await readFile(path);
  return { bytes, value: parseJson ? JSON.parse(bytes) : null };
}
async function pinned(pin, parseJson = true) {
  need(pin && normalized(pin.path) && sha(pin.sha256), 'EXACT_PIN_REQUIRED');
  const file = await privateInput(pin.path, parseJson);
  need(hash(file.bytes) === pin.sha256, 'PIN_CHANGED');
  return file;
}
async function outputAbsent(path) {
  need(
    normalized(path) && (await realpath(dirname(path))) === dirname(path),
    'EXACT_OUTPUT_REQUIRED',
  );
  const p = await lstat(dirname(path));
  need(
    p.isDirectory() && p.uid === process.getuid() && (p.mode & 0o022) === 0,
    'PRIVATE_OUTPUT_DIRECTORY_REQUIRED',
  );
  try {
    await lstat(path);
    throw Error(PREFIX + 'OUTPUT_EXISTS');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
async function save(path, value) {
  const f = await open(path, 'wx', 0o600);
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}

/** Pin all regular compiled database files, with relative POSIX paths sorted by
 * JS code-unit order. No symlinks or alternate database module are accepted. */
export async function nativeControlDatabaseDistDigest(directory) {
  need(
    normalized(directory) && (await realpath(directory)) === directory,
    'EXACT_DATABASE_DIST_REQUIRED',
  );
  const files = [];
  let total = 0;
  async function visit(relative) {
    const at = join(directory, relative),
      s = await lstat(at);
    need(!s.isSymbolicLink(), 'DATABASE_DIST_SYMLINK');
    if (s.isDirectory()) {
      for (const name of (await readdir(at)).sort())
        await visit(relative ? relative + '/' + name : name);
    } else {
      need(
        s.isFile() && files.length < 5000 && (total += s.size) <= 100_000_000,
        'DATABASE_DIST_LIMIT',
      );
      files.push({ path: relative, sha256: hash(await readFile(at)) });
    }
  }
  await visit('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  need(
    files.some((f) => f.path === 'index.js') &&
      files.some((f) => f.path === 'native-schedule-control-upgrade.js'),
    'DATABASE_UPGRADE_BUILD_REQUIRED',
  );
  return hash(JSON.stringify(files));
}

export function validateNativeControlUpgradeDatabaseUrl(env) {
  let url;
  try {
    url = new URL(env.DATABASE_URL ?? 'invalid:');
  } catch {
    need(false, 'LOCAL_DEV_ONLY');
  }
  need(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.port === '5432' &&
      url.pathname === '/allrice_dev' &&
      url.username &&
      !url.search &&
      !url.hash &&
      ![
        'PGHOST',
        'PGHOSTADDR',
        'PGPORT',
        'PGDATABASE',
        'PGSERVICE',
        'PGSERVICEFILE',
        'PGOPTIONS',
        'PGTARGETSESSIONATTRS',
      ].some((k) => env[k]),
    'LOCAL_DEV_ONLY',
  );
}
function activeIdentity(review) {
  const identity = review.activeReleaseIdentity;
  need(
    identity &&
      exact(
        Object.keys(identity).sort(),
        [
          'releaseDirectory',
          'releaseSha',
          ...(identity.sourceTree === undefined ? [] : ['sourceTree']),
        ].sort(),
      ) &&
      normalized(identity.releaseDirectory) &&
      /^[a-f0-9]{40}$/.test(identity.releaseSha) &&
      (identity.sourceTree === undefined ||
        /^[a-f0-9]{40}$/.test(identity.sourceTree)),
    'ACTIVE_BASE_IDENTITY_REQUIRED',
  );
  return identity;
}
export function validateNativeControlUpgradeActiveIdentity(review, active) {
  const identity = activeIdentity(review);
  need(
    active?.releaseDirectory === identity.releaseDirectory &&
      ['releaseSha', 'webReleaseSha', 'workerReleaseSha'].every(
        (k) => active[k] === identity.releaseSha,
      ) &&
      (identity.sourceTree === undefined ||
        active.sourceTree === identity.sourceTree),
    'ACTIVE_RELEASE_CHANGED',
  );
}
function reference(value) {
  need(
    value &&
      exact(Object.keys(value).sort(), [
        'artifactId',
        'profileId',
        'stateRoot',
        'storageId',
      ]) &&
      digest(value.artifactId) &&
      ['allrice-once-control-v1', 'allrice-recurring-control-v1'].includes(
        value.profileId,
      ) &&
      typeof value.storageId === 'string' &&
      value.storageId.length > 0 &&
      normalized(value.stateRoot),
    'REFERENCE_INVALID',
  );
}
/** Receipts are root's reviewed facts, not independent OS/package detection by
 * the DB. Full proof bytes are SHA-bound, not accepted merely for passed=true. */
export function validateNativeControlUpgradeProofs({
  review,
  input,
  artifact,
  history,
  offline,
  mode,
  stateRoot,
}) {
  const prepare = review.phase === 'prepare';
  need(
    ['prepare', 'apply'].includes(review.phase) &&
      ['prepare', 'apply', 'readback'].includes(mode) &&
      (mode === 'readback' || mode === review.phase),
    'PHASE_CONFLICT',
  );
  need(
    input?.kind ===
      (prepare
        ? 'native-control-upgrade-prepare-input-v1'
        : 'native-control-upgrade-apply-input-v1'),
    'INPUT_KIND',
  );
  need(
    exact(
      Object.keys(input).sort(),
      prepare
        ? [
            'afterReference',
            'beforeReference',
            'kind',
            'partitionId',
            'requestId',
            ...(input.ttlMs === undefined ? [] : ['ttlMs']),
          ].sort()
        : ['kind', 'offlineStoppedAttestation', 'plan', 'planDigest'].sort(),
    ) &&
      (!prepare ||
        input.ttlMs === undefined ||
        (time(input.ttlMs) && input.ttlMs > 0 && input.ttlMs <= 900_000)),
    'INPUT_SHAPE',
  );
  const before = prepare ? input.beforeReference : input.plan?.beforeReference;
  const after = prepare ? input.afterReference : input.plan?.afterReference;
  reference(before);
  reference(after);
  need(
    before.artifactId !== after.artifactId &&
      exact({ ...before, artifactId: after.artifactId }, after) &&
      exact(before, review.beforeReference) &&
      exact(after, review.afterReference) &&
      (prepare ? input.partitionId : input.plan.partitionId) ===
        review.partitionId,
    'TUPLE_CONFLICT',
  );
  const planId = prepare ? input.requestId : input.plan.planId;
  need(
    typeof planId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        planId,
      ),
    'PLAN_ID_INVALID',
  );
  for (const [proof, kind] of [
    [artifact, 'allrice-native-control-artifact-proof-v1'],
    [history, 'allrice-native-control-public-history-proof-v1'],
  ]) {
    need(
      proof?.kind === kind &&
        proof.rootReviewed === true &&
        proof.reviewedBy === 'root' &&
        proof.passed === true &&
        proof.generation === GENERATION &&
        exact(proof.beforeReference, before) &&
        exact(proof.afterReference, after),
      'REVIEWED_COMPATIBILITY_REQUIRED',
    );
  }
  need(
    offline?.kind === 'allrice-native-control-offline-proof-v1' &&
      offline.rootReviewed === true &&
      offline.reviewedBy === 'root' &&
      offline.passed === true &&
      exact(offline.candidate, {
        releaseDirectory: review.releaseDirectory,
        releaseSha: review.releaseSha,
        sourceTree: review.sourceTree,
      }) &&
      exact(offline.stoppedRelease, activeIdentity(review)) &&
      offline.planId === planId &&
      offline.planDigest === (prepare ? null : input.planDigest) &&
      Array.isArray(offline.locks) &&
      offline.locks.length === 2 &&
      Array.isArray(offline.processes) &&
      offline.processes.length === 2 &&
      time(offline.observedAtMs) &&
      time(offline.expiresAtMs) &&
      offline.expiresAtMs > offline.observedAtMs &&
      offline.expiresAtMs <= offline.observedAtMs + 120_000,
    'REVIEWED_OFFLINE_REQUIRED',
  );
  need(
    exact(offline.locks.map((v) => v.path).sort(), [
      stateRoot + '/dev-deployment.lock',
      stateRoot + '/qa-validation.lock',
    ]) &&
      offline.locks.every(
        (v) =>
          time(v.ownerPid) &&
          v.ownerPid > 1 &&
          typeof v.ownerBirth === 'string' &&
          v.ownerBirth.length > 0 &&
          digest(v.tokenDigest) &&
          time(v.acquiredAtMs) &&
          digest(v.ownershipEvidenceDigest),
      ) &&
      offline.locks[0].ownerPid === offline.locks[1].ownerPid &&
      offline.locks[0].ownerBirth === offline.locks[1].ownerBirth &&
      exact(offline.processes.map((v) => v.role).sort(), ['web', 'worker']) &&
      new Set(offline.processes.map((v) => v.pid)).size === 2 &&
      offline.processes.every(
        (v) =>
          time(v.pid) &&
          v.pid > 1 &&
          typeof v.birth === 'string' &&
          v.birth.length > 0 &&
          v.stopMode === 'normal' &&
          time(v.stopRequestedAtMs) &&
          time(v.exitConfirmedAtMs) &&
          v.stopRequestedAtMs <= v.exitConfirmedAtMs &&
          v.exitConfirmedAtMs <= offline.observedAtMs &&
          digest(v.exitEvidenceDigest),
      ),
    'OFFLINE_IDENTITY_CONFLICT',
  );
  if (!prepare) {
    const a = input.offlineStoppedAttestation;
    need(
      digest(input.planDigest) &&
        a?.kind === 'offlineStopped' &&
        a.environment === 'dev' &&
        a.planId === planId &&
        a.planDigest === input.planDigest &&
        exact(a.locks, offline.locks) &&
        exact(a.processes, offline.processes) &&
        a.observedAtMs === offline.observedAtMs &&
        a.expiresAtMs === offline.expiresAtMs &&
        a.operatorEvidenceDigest === 'sha256:' + review.offlineProofPin.sha256,
      'ATTESTATION_BINDING_CONFLICT',
    );
    need(
      input.plan.artifactEvidenceDigest &&
        exact(input.plan.artifactEvidence, {
          kind: 'reviewed-native-control-compatibility-v1',
          generation: GENERATION,
          beforeReference: before,
          afterReference: after,
          artifactVerificationDigest:
            'sha256:' + review.artifactProofPin.sha256,
          publicHistoryVerificationDigest:
            'sha256:' + review.publicHistoryPin.sha256,
        }),
      'PLAN_ARTIFACT_EVIDENCE_CONFLICT',
    );
  }
  return { planId, before, after };
}
async function currentOfflineEvidence(offline, review, stateRoot) {
  need(
    Date.now() >= offline.observedAtMs && Date.now() < offline.expiresAtMs,
    'OFFLINE_PROOF_EXPIRED',
  );
  const active = await pinned(review.activeReleasePin);
  need(
    review.activeReleasePin.path === stateRoot + '/active-release.json',
    'ACTIVE_RELEASE_PATH_CHANGED',
  );
  validateNativeControlUpgradeActiveIdentity(review, active.value);
  need(
    Array.isArray(offline.exitEvidencePins) &&
      offline.exitEvidencePins.length === 2,
    'EXIT_EVIDENCE_PINS_REQUIRED',
  );
  for (const p of offline.processes) {
    const evidence = offline.exitEvidencePins.find((v) => v.role === p.role);
    need(
      evidence && 'sha256:' + evidence.pin.sha256 === p.exitEvidenceDigest,
      'EXIT_EVIDENCE_BINDING_CONFLICT',
    );
    await pinned(evidence.pin, false);
  }
  for (const lock of offline.locks) {
    const actual = await privateInput(lock.path, false);
    need(
      'sha256:' + hash(actual.bytes) === lock.ownershipEvidenceDigest,
      'LOCK_EVIDENCE_CHANGED',
    );
  }
  // Independent normal-exit and lock-owner OS observations are supplied by the
  // reviewed root proof above, not fabricated from lease TTL or missing health.
}

/** Internal dispatch, separately exercised with fake DB ports. A durable intent
 * always changes subsequent invocations into exact readback, never another write. */
export async function nativeControlUpgradeStep({
  api,
  db,
  mode,
  phase,
  input,
  approval,
  intentPath,
  binding,
  artifactEvidence,
  historicalCloudAbsenceCredential,
}) {
  let prior;
  try {
    prior = await privateInput(intentPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (prior)
    need(
      prior.value.kind === 'native-control-upgrade-intent-v1' &&
        exact(prior.value.binding, binding),
      'INTENT_CONFLICT',
    );
  const read = async () => {
    const result = await api.readNativeScheduleControlUpgrade({
      db,
      planId: binding.planId,
      ...(phase === 'apply'
        ? {
            expected: {
              planDigest: input.planDigest,
              approvalDigest: api.nativeOnceDigest(approval),
              attestationDigest: api.nativeOnceDigest(
                input.offlineStoppedAttestation,
              ),
            },
          }
        : {}),
    });
    if (phase === 'prepare' && result.status === 'plan_only')
      need(
        result.plan?.planId === binding.planId &&
          result.plan.partitionId === input.partitionId &&
          exact(result.plan.beforeReference, input.beforeReference) &&
          exact(result.plan.afterReference, input.afterReference) &&
          exact(result.plan.artifactEvidence, artifactEvidence) &&
          api.nativeOnceDigest(result.plan) === result.planDigest,
        'PREPARE_READBACK_CONFLICT',
      );
    return result;
  };
  if (mode === 'readback' || prior)
    return {
      mode: 'readback',
      databaseWritten: false,
      result: await read(),
      originalIntent: prior ? intentPath : null,
    };
  await save(intentPath, {
    kind: 'native-control-upgrade-intent-v1',
    binding,
    at: new Date().toISOString(),
  });
  const result =
    phase === 'prepare'
      ? await api.prepareNativeScheduleControlUpgrade({
          db,
          requestId: input.requestId,
          partitionId: input.partitionId,
          beforeReference: input.beforeReference,
          afterReference: input.afterReference,
          artifactEvidence,
          ...(historicalCloudAbsenceCredential === undefined
            ? {}
            : { historicalCloudAbsenceCredential }),
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        })
      : await api.applyNativeScheduleControlUpgrade({
          db,
          planId: input.plan.planId,
          planDigest: input.planDigest,
          approval,
          offlineStoppedAttestation: input.offlineStoppedAttestation,
        });
  return { mode: phase, databaseWritten: true, result };
}

async function main() {
  if (process.argv.length === 2) {
    console.log(
      JSON.stringify({
        disabled: true,
        databaseWritten: false,
        modes: ['prepare', 'apply', 'readback'],
      }),
    );
    return;
  }
  process.umask(0o077);
  let api,
    mode,
    mayHaveWritten = false;
  try {
    const { values: a } = parseArgs({
      strict: true,
      options: {
        mode: { type: 'string' },
        root: { type: 'string' },
        input: { type: 'string' },
        output: { type: 'string' },
        review: { type: 'string' },
        'review-sha': { type: 'string' },
      },
    });
    mode = a.mode;
    need(['prepare', 'apply', 'readback'].includes(mode), 'MODE_REQUIRED');
    need(
      normalized(a.root) && (await realpath(a.root)) === a.root,
      'ROOT_REQUIRED',
    );
    validateNativeControlUpgradeDatabaseUrl(process.env);
    const input = await privateInput(a.input),
      review = await privateInput(a.review);
    need(
      sha(a['review-sha']) && hash(review.bytes) === a['review-sha'],
      'REVIEW_CHANGED',
    );
    const r = review.value;
    need(
      r.kind === 'allrice-dev-native-control-upgrade-review-v1' &&
        r.enabled === true &&
        r.rootReviewed === true &&
        r.reviewedBy === 'root' &&
        r.releaseDirectory === a.root &&
        /^[a-f0-9]{40}$/.test(r.releaseSha) &&
        /^[a-f0-9]{40}$/.test(r.sourceTree) &&
        sha(r.operatorSha256) &&
        sha(r.databaseDistDigest) &&
        r.inputPin?.path === a.input &&
        r.inputPin.sha256 === hash(input.bytes) &&
        time(r.reviewedAtMs),
      'EXACT_ROOT_REVIEW_REQUIRED',
    );
    const stateRoot = resolve(homedir(), 'allrice-dev', '.local');
    const artifact = await pinned(r.artifactProofPin),
      history = await pinned(r.publicHistoryPin),
      offline = await pinned(r.offlineProofPin);
    const tuple = validateNativeControlUpgradeProofs({
      review: r,
      input: input.value,
      artifact: artifact.value,
      history: history.value,
      offline: offline.value,
      mode,
      stateRoot,
    });
    const git = (...args) =>
      execFileSync('git', args, {
        cwd: a.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    need(
      git('rev-parse', 'HEAD') === r.releaseSha &&
        git('rev-parse', 'HEAD^{tree}') === r.sourceTree &&
        !git('status', '--porcelain=v1', '--untracked-files=normal'),
      'SOURCE_CHANGED',
    );
    const script = fileURLToPath(import.meta.url);
    need(
      (await realpath(script)) ===
        a.root + '/scripts/dev-release/upgrade-native-schedule-control.mjs' &&
        hash(await readFile(script)) === r.operatorSha256,
      'OPERATOR_CHANGED',
    );
    need(
      (await nativeControlDatabaseDistDigest(
        a.root + '/packages/database/dist',
      )) === r.databaseDistDigest,
      'DATABASE_BUILD_CHANGED',
    );
    await outputAbsent(a.output);
    const intentPath = a.input + '.intent.json';
    const binding = {
      phase: r.phase,
      planId: tuple.planId,
      inputSha256: hash(input.bytes),
      reviewSha256: hash(review.bytes),
      releaseSha: r.releaseSha,
      sourceTree: r.sourceTree,
      ...(r.historicalCloudObservationPin === undefined
        ? {}
        : {
            historicalCloudObservationSha256:
              r.historicalCloudObservationPin.sha256,
          }),
    };
    let prior;
    try {
      prior = await privateInput(intentPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (prior)
      need(
        prior.value.kind === 'native-control-upgrade-intent-v1' &&
          exact(prior.value.binding, binding),
        'INTENT_CONFLICT',
      );
    if (mode !== 'readback' && !prior)
      await currentOfflineEvidence(offline.value, r, stateRoot);
    api = await import(
      pathToFileURL(a.root + '/packages/database/dist/index.js')
    );
    need(
      [
        'prepareNativeScheduleControlUpgrade',
        'applyNativeScheduleControlUpgrade',
        'readNativeScheduleControlUpgrade',
        'nativeOnceDigest',
        'nativeControlCloudEvidenceDigest',
        'getDatabase',
        'closeDatabase',
      ].every((k) => typeof api[k] === 'function'),
      'DATABASE_API_REQUIRED',
    );
    const artifactEvidence = {
      kind: 'reviewed-native-control-compatibility-v1',
      generation: GENERATION,
      beforeReference: tuple.before,
      afterReference: tuple.after,
      artifactVerificationDigest: 'sha256:' + r.artifactProofPin.sha256,
      publicHistoryVerificationDigest: 'sha256:' + r.publicHistoryPin.sha256,
    };
    const approval =
      r.phase === 'apply'
        ? {
            kind: 'native-control-upgrade-approval-v1',
            approved: true,
            reviewedBy: 'root',
            reviewedAtMs: r.reviewedAtMs,
            reviewPolicyDigest: 'sha256:' + hash(review.bytes),
            planId: tuple.planId,
            planDigest: input.value.planDigest,
            artifactEvidenceDigest: api.nativeOnceDigest(artifactEvidence),
            attestationDigest: api.nativeOnceDigest(
              input.value.offlineStoppedAttestation,
            ),
          }
        : null;
    if (r.phase === 'apply')
      need(
        api.nativeOnceDigest(input.value.plan) === input.value.planDigest,
        'PLAN_DIGEST_CONFLICT',
      );
    let historicalCloudAbsenceCredential, historicalCloudObservation;
    if (
      r.phase === 'apply' &&
      input.value.plan.historicalCloudAbsenceDigest !== undefined
    )
      need(
        r.historicalCloudObservationPin !== undefined,
        'CLOUD_OBSERVATION_REQUIRED',
      );
    if (
      r.historicalCloudObservationPin !== undefined &&
      mode !== 'readback' &&
      !prior
    ) {
      const verifier =
        a.root + '/scripts/dev-release/native-control-cloud-absence.mjs';
      need(
        sha(r.cloudVerifierSha256) &&
          (await realpath(verifier)) === verifier &&
          hash(await readFile(verifier)) === r.cloudVerifierSha256,
        'CLOUD_VERIFIER_CHANGED',
      );
      const verified = await verifyNativeControlCloudAbsence({
        sql: api.getDatabase(),
        review: r,
        reviewSha256: hash(review.bytes),
        input: input.value,
        offline: offline.value,
        digest: api.nativeControlCloudEvidenceDigest,
        mode,
      });
      historicalCloudAbsenceCredential = verified.credential;
      historicalCloudObservation = verified.observation;
    }
    mayHaveWritten = mode !== 'readback' && !prior;
    const result = await nativeControlUpgradeStep({
      api,
      db: api.getDatabase(),
      mode,
      phase: r.phase,
      input: input.value,
      approval,
      intentPath,
      binding,
      artifactEvidence,
      historicalCloudAbsenceCredential,
    });
    if (historicalCloudObservation && result.mode !== 'readback') {
      await verifyNativeControlCloudAbsenceAfter({
        sql: api.getDatabase(),
        review: r,
        input: input.value,
        offline: offline.value,
        observation: historicalCloudObservation,
        result: result.result,
      });
    }
    mayHaveWritten = false;
    await save(a.output, {
      kind: 'native-control-upgrade-operator-receipt-v1',
      ...result,
      binding,
    });
    need(
      mode === 'readback' ||
        result.mode !== 'readback' ||
        ['applied', 'plan_only'].includes(result.result.status),
      'OUTCOME_UNKNOWN_READBACK_ONLY',
    );
    console.log(
      JSON.stringify({
        mode: result.mode,
        databaseWritten: result.databaseWritten,
        output: a.output,
        planId: tuple.planId,
        status: result.result.status ?? 'acknowledged',
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        failed: true,
        mode,
        code:
          typeof error.message === 'string' &&
          /^NATIVE_CONTROL_UPGRADE_[A-Z0-9_]{2,100}$/.test(error.message)
            ? error.message
            : PREFIX + 'UNCONFIRMED_READBACK_ONLY',
        outcomeUnknown: mayHaveWritten,
        neverRetryUnknownWrite: true,
      }),
    );
    process.exitCode = 1;
  } finally {
    if (api) {
      try {
        await api.closeDatabase();
      } catch {
        console.error(
          JSON.stringify({
            failed: true,
            code: PREFIX + 'DATABASE_CLOSE_UNCONFIRMED',
            neverRetryUnknownWrite: true,
          }),
        );
        process.exitCode = 1;
      }
    }
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
