#!/usr/bin/env node
// Dev maintenance only. Preview/readback are read-only. Apply archives only the
// exact reviewed development-test scopes; executable package deletion is separate.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { verifyRetirementBusy } from './retirement-preserved-cloud.mjs';
import {
  REVIEWED_TEST_CHAT_REVIEW_KIND,
  reviewedTestChatPhysicalScope,
  verifyReviewedTestChatCloudCarry,
} from './reviewed-test-chat-preserved-cloud.mjs';
import { collectTerminalNativeAbsence } from './terminal-native-physical-absence.mjs';

if (process.argv.length === 2) {
  console.log(
    JSON.stringify({
      disabled: true,
      databaseWritten: false,
      modes: ['preview', 'apply', 'readback'],
    }),
  );
  process.exit(0);
}
process.umask(0o077);
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
const need = (ok, code) => {
  if (!ok) throw Error(code);
};
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function privateInput(path) {
  need(
    typeof path === 'string' &&
      resolve(path) === path &&
      (await realpath(path)) === path,
    'NATIVE_RETIREMENT_EXACT_PRIVATE_PATH_REQUIRED',
  );
  const stat = await lstat(path);
  need(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid() &&
      (stat.mode & 0o077) === 0 &&
      stat.size <= 8_000_000,
    'NATIVE_RETIREMENT_PRIVATE_INPUT_REQUIRED',
  );
  const bytes = await readFile(path);
  return { bytes, value: JSON.parse(bytes) };
}
async function save(path, value) {
  need(
    typeof path === 'string' &&
      resolve(path) === path &&
      (await realpath(dirname(path))) === dirname(path),
    'NATIVE_RETIREMENT_EXACT_OUTPUT_REQUIRED',
  );
  const f = await open(path, 'wx', 0o600);
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + '\n');
    await f.sync();
  } finally {
    await f.close();
  }
}

let db;
try {
  need(
    ['preview', 'apply', 'readback'].includes(a.mode),
    'NATIVE_RETIREMENT_MODE_REQUIRED',
  );
  need(
    typeof a.root === 'string' &&
      resolve(a.root) === a.root &&
      (await realpath(a.root)) === a.root,
    'NATIVE_RETIREMENT_ROOT_REQUIRED',
  );
  const url = new URL(process.env.DATABASE_URL ?? 'invalid:');
  need(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
      url.pathname === '/allrice_dev' &&
      !['host', 'hostaddr', 'port', 'service', 'options'].some((k) =>
        url.searchParams.has(k),
      ),
    'NATIVE_RETIREMENT_LOCAL_DEV_ONLY',
  );
  const input = await privateInput(a.input);
  db = await import(pathToFileURL(a.root + '/packages/database/dist/index.js'));
  if (a.mode === 'preview') {
    const plan = await db.previewNativeTestChatRetirement(input.value);
    await save(a.output, plan);
    console.log(
      JSON.stringify({
        mode: a.mode,
        databaseWritten: false,
        output: a.output,
        planDigest: plan.digest,
        contexts: plan.snapshots.length,
      }),
    );
  } else if (a.mode === 'readback') {
    const result = await db.readNativeTestChatRetirement(input.value);
    await save(a.output, result);
    console.log(
      JSON.stringify({
        mode: a.mode,
        databaseWritten: false,
        output: a.output,
        ...result,
      }),
    );
  } else {
    const review = await privateInput(a.review);
    need(
      hash(review.bytes) === a['review-sha'],
      'NATIVE_RETIREMENT_REVIEW_CHANGED',
    );
    const r = review.value;
    const state = resolve(homedir(), 'allrice-dev', '.local');
    need(
      (r.kind === 'allrice-dev-test-chat-retirement-review' ||
        r.kind === REVIEWED_TEST_CHAT_REVIEW_KIND) &&
        r.rootReviewed === true &&
        r.reviewedBy === 'root' &&
        r.developmentTestScopesApproved === true &&
        r.releaseDirectory === a.root &&
        r.planPath === a.input &&
        r.planSha256 === hash(input.bytes) &&
        r.authorizationEvidenceDigest ===
          input.value.authorizationEvidenceDigest &&
        r.activeReleasePath === state + '/active-release.json' &&
        r.qaLockPath === state + '/qa-validation.lock' &&
        r.deploymentLockPath === state + '/dev-deployment.lock' &&
        JSON.stringify(r.healthUrls) ===
          JSON.stringify([
            'http://127.0.0.1:3001/api/health/ready',
            'http://127.0.0.1:3102/health/ready',
          ]),
      'NATIVE_RETIREMENT_EXACT_ROOT_REVIEW_REQUIRED',
    );
    const git = (...args) =>
      execFileSync('git', args, { cwd: a.root, encoding: 'utf8' }).trim();
    need(
      git('rev-parse', 'HEAD') === r.releaseSha &&
        git('rev-parse', 'HEAD^{tree}') === r.sourceTree &&
        !git('status', '--porcelain'),
      'NATIVE_RETIREMENT_SOURCE_CHANGED',
    );
    const script = fileURLToPath(import.meta.url);
    need(
      (await realpath(script)) ===
        a.root + '/scripts/dev-release/retire-native-test-contexts.mjs' &&
        hash(await readFile(script)) === r.operatorSha256,
      'NATIVE_RETIREMENT_OPERATOR_CHANGED',
    );
    const active = await privateInput(r.activeReleasePath);
    need(
      ['releaseSha', 'webReleaseSha', 'workerReleaseSha'].every(
        (k) => active.value[k] === r.releaseSha,
      ) && active.value.releaseDirectory === a.root,
      'NATIVE_RETIREMENT_ACTIVE_RELEASE_CHANGED',
    );
    const lock = await privateInput(r.qaLockPath);
    const stable = (value) =>
      JSON.stringify(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
      );
    need(
      stable(lock.value) === stable(r.qaOwner) &&
        lock.value.releaseSha === r.releaseSha &&
        Number.isSafeInteger(lock.value.pid) &&
        lock.value.pid > 1 &&
        typeof lock.value.nonce === 'string' &&
        lock.value.nonce.length >= 32 &&
        execFileSync(
          '/bin/ps',
          ['-p', String(lock.value.pid), '-o', 'lstart='],
          { encoding: 'utf8' },
        ).trim() === lock.value.processStart,
      'NATIVE_RETIREMENT_OWNER_CHANGED',
    );
    need(
      r.deploymentLockPath ===
        resolve(dirname(r.qaLockPath), 'dev-deployment.lock'),
      'NATIVE_RETIREMENT_WINDOW_PATH_CHANGED',
    );
    try {
      await lstat(r.deploymentLockPath);
      throw Error('NATIVE_RETIREMENT_DEPLOYMENT_BUSY');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const healths = [];
    for (const health of r.healthUrls ?? []) {
      const response = await fetch(health, {
        signal: globalThis.AbortSignal.timeout(10_000),
      });
      need(response.ok, 'NATIVE_RETIREMENT_SERVICE_NOT_READY');
      const value = await response.json();
      healths.push(value);
      need(
        value.identity?.sourceSha === r.releaseSha &&
          value.identity?.sourceTree === r.sourceTree &&
          [
            'pendingRoots',
            'activeRoots',
            'retainedChildren',
            'unresolvedRoots',
          ].every((k) => value.producerLifecycle?.[k] === 0),
        'NATIVE_RETIREMENT_SERVICE_BUSY',
      );
    }
    need(
      Array.isArray(r.healthUrls) && r.healthUrls.length === 2,
      'NATIVE_RETIREMENT_BOTH_SERVICE_HEALTH_REQUIRED',
    );
    const laterReviewedChat = r.kind === REVIEWED_TEST_CHAT_REVIEW_KIND;
    const readHealths = () =>
      Promise.all(
        r.healthUrls.map(async (url) => {
          const response = await fetch(url, {
            signal: globalThis.AbortSignal.timeout(10000),
          });
          need(response.ok, 'NATIVE_RETIREMENT_SERVICE_NOT_READY');
          return response.json();
        }),
      );
    const completePhysical = (suffix) =>
      collectTerminalNativeAbsence({
        scope: reviewedTestChatPhysicalScope(r, input.value),
        review: r,
        planDigest: input.value.digest,
        requestId: input.value.requestId,
        reviewSha256: hash(review.bytes),
        readHealths,
        evidencePath: a.output + suffix,
        saveEvidence: save,
      });
    const physicalProof = laterReviewedChat
      ? await completePhysical('.physical-before.json')
      : undefined;
    const classifyBusy = laterReviewedChat
      ? verifyReviewedTestChatCloudCarry
      : verifyRetirementBusy;
    const readBusy = () =>
      db.getDatabase().begin('read only', async (tx) => {
        await tx`set local statement_timeout='5000'`;
        const [row] = await tx`select
        (select count(*)::int from allrice_jobs where status in ('queued','claimed','running','retry_wait','waiting_approval')) jobs,
        (select count(*)::int from allrice_cloud_execution_attempts where cleanup_confirmed_at is null) clouds,
        (select count(*)::int from allrice_platform_employee_test_runs where status in ('queued','running')) tests,
        (select count(*)::int from allrice_runtime_operations where lease_expires_at>clock_timestamp()) leases,
        (select count(*)::int from allrice_provider_authorization_flows where state in ('pending','running','awaiting_user')) auth`;
        if (laterReviewedChat) {
          const [live] =
            await tx`select count(*)::int runtimes from allrice_dsh_runtime_instances where status='live'`;
          return { ...row, runtimes: live.runtimes };
        }
        return row;
      });
    const busyClassification = await classifyBusy({
      review: r,
      plan: input.value,
      ...(laterReviewedChat
        ? {
            physicalProof,
            evidencePath: a.output + '.cloud-before.json',
            saveEvidence: save,
          }
        : {}),
      sql: db.getDatabase(),
      readBusy,
      healths,
      readHealths: () =>
        Promise.all(
          r.healthUrls.map(async (url) => {
            const response = await fetch(url, {
              signal: globalThis.AbortSignal.timeout(10_000),
            });
            need(response.ok, 'NATIVE_RETIREMENT_SERVICE_NOT_READY');
            return response.json();
          }),
        ),
    });
    if (r.historicalCloudCarry !== undefined) {
      // Physical probes may outlive the first owner/active checks. Keep the
      // same private bytes and owner birth before creating any write intent.
      for (const [path, bytes] of [
        [a.review, review.bytes],
        [a.input, input.bytes],
        [r.activeReleasePath, active.bytes],
        [r.qaLockPath, lock.bytes],
      ]) {
        need(
          (await privateInput(path)).bytes.equals(bytes),
          'NATIVE_RETIREMENT_CLOUD_AUTHORITY_CHANGED',
        );
      }
      need(
        execFileSync(
          '/bin/ps',
          ['-p', String(lock.value.pid), '-o', 'lstart='],
          {
            encoding: 'utf8',
          },
        ).trim() === lock.value.processStart,
        'NATIVE_RETIREMENT_OWNER_CHANGED',
      );
      try {
        await lstat(r.deploymentLockPath);
        throw Error('NATIVE_RETIREMENT_DEPLOYMENT_BUSY');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    // A persisted intent means the result may be unknown. Read the original
    // receipt instead of reissuing a mutation, even when the caller repeats apply.
    const intentPath = a.output + '.intent.json';
    let prior;
    try {
      prior = await privateInput(intentPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (prior) {
      need(
        prior.value.planSha256 === hash(input.bytes) &&
          prior.value.requestId === input.value.requestId,
        'NATIVE_RETIREMENT_INTENT_CONFLICT',
      );
      const result = await db.readNativeTestChatRetirement(input.value);
      need(
        result.status === 'completed',
        'NATIVE_RETIREMENT_OUTCOME_UNKNOWN_READBACK_ONLY',
      );
      console.log(
        JSON.stringify({
          mode: 'readback',
          databaseWritten: false,
          originalIntent: intentPath,
          busyClassification,
          ...result,
        }),
      );
    } else {
      await save(intentPath, {
        requestId: input.value.requestId,
        planSha256: hash(input.bytes),
        reviewSha256: hash(review.bytes),
        releaseSha: r.releaseSha,
        at: new Date().toISOString(),
      });
      const result = await db.applyNativeTestChatRetirement(input.value);
      if (laterReviewedChat) {
        await save(a.output + '.committed.json', result);
        const physicalAfter = await completePhysical('.physical-after.json');
        const busyAfter = await verifyReviewedTestChatCloudCarry({
          review: r,
          plan: input.value,
          sql: db.getDatabase(),
          readBusy,
          healths: await readHealths(),
          readHealths,
          physicalProof: physicalAfter,
          evidencePath: a.output + '.cloud-after.json',
          saveEvidence: save,
        });
        await save(a.output, { ...result, busyClassification, busyAfter });
      } else await save(a.output, { ...result, busyClassification });
      console.log(
        JSON.stringify({
          mode: 'apply',
          databaseWritten: !result.alreadyApplied,
          output: a.output,
          busyClassification,
          ...result,
        }),
      );
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      failed: true,
      mode: a.mode,
      code: /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)
        ? error.message
        : 'NATIVE_RETIREMENT_UNCONFIRMED_READ_ORIGINAL',
      neverRetryUnknownWrite: true,
    }),
  );
  process.exitCode = 1;
} finally {
  if (db) await db.closeDatabase();
}
