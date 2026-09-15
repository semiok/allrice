/** One opt-in subscription endpoint cap probe, never a Worker/Agent run.
 * Driver inspects only credential metadata. Native DSH owns credential reads;
 * Node's permission model denies all native-host filesystem writes.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { dshEgressEnvironment } from '../../../apps/worker/src/harness/dsh-egress-environment.ts';
import {
  authorizedPlatformHome,
  parseArguments,
  readCandidate,
  requireCheck,
} from './p27-assistant-preflight.ts';
import { collectP27InstalledRuntime } from './p27-installed-runtime.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const platformHome = '/Users/a123/allrice-dev/.local/dsh-platform';
const sourceFiles = [
  'pnpm-lock.yaml',
  'apps/worker/package.json',
  'apps/worker/dsh/allrice-codex-subscription-cap-probe.mjs',
  'apps/worker/dsh/allrice-codex-subscription-cap-probe-host.mjs',
  'apps/worker/dsh/allrice-codex-cap-probe.cordis.yml',
  'apps/worker/src/harness/dsh-egress-environment.ts',
  'scripts/acceptance/runtime/p27-codex-cap-probe.ts',
  'scripts/acceptance/runtime/p27-assistant-preflight.ts',
  'scripts/acceptance/runtime/p27-installed-runtime.ts',
];

/** Discard native diagnostics not explicitly permitted for persisted reports. */
export function parseP27CodexCapProbeResult(stdout: string) {
  const lines = stdout
    .split('\n')
    .filter((line) => line.startsWith('CODEX_CAP_PROBE_RESULT='));
  requireCheck(lines.length === 1, 'codex_cap_probe_result_missing');
  const value = JSON.parse(lines[0]!.slice('CODEX_CAP_PROBE_RESULT='.length));
  const outcomes = new Set([
    'opt_in_required',
    'invalid_loopback_endpoint',
    'aborted',
    'subscription_grant_required',
    'unexpired_subscription_grant_required',
    'pinned_model_missing',
    'cap_field_rejected',
    'failed',
    'response_received_single_sample',
    'no_terminal_event',
    'probe_failed',
    'host_failed',
    'host_cleanup_failed',
  ]);
  const errors = new Set([
    'aborted',
    'unsupported_output_cap',
    'authentication',
    'rate_limit_or_quota',
    'invalid_request',
    'server',
    'provider_or_transport',
    'credential_or_internal',
    'host_or_credential',
    'host_cleanup',
  ]);
  const finishes = new Set([
    'stop',
    'length',
    'toolUse',
    'error',
    'aborted',
    'unknown',
  ]);
  const numeric = (input: unknown) =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0
      ? input
      : null;
  const usage = value?.usage;
  return {
    outcome: outcomes.has(value?.outcome)
      ? (value.outcome as string)
      : 'invalid_result',
    errorType: errors.has(value?.errorType)
      ? (value.errorType as string)
      : null,
    httpStatus:
      numeric(value?.httpStatus) !== null &&
      value.httpStatus >= 100 &&
      value.httpStatus <= 599
        ? (value.httpStatus as number)
        : null,
    payloadCount: numeric(value?.payloadCount),
    fieldRejected: value?.fieldRejected === true,
    finishReason: finishes.has(value?.finishReason)
      ? (value.finishReason as string)
      : null,
    credentialShapeValidated: value?.credentialShapeValidated === true,
    singleSampleCapConsistent: value?.singleSampleCapConsistent === true,
    serverEnforcementProven: false,
    productionGateEvidence: false,
    usage:
      usage &&
      numeric(usage.inputTokens) !== null &&
      numeric(usage.outputTokens) !== null
        ? {
            inputTokens: numeric(usage.inputTokens),
            cachedInputTokens: numeric(usage.cachedInputTokens),
            outputTokens: numeric(usage.outputTokens),
            reasoningTokens: numeric(usage.reasoningTokens),
          }
        : null,
  };
}

export function authorizeP27CodexCapProbe(env: NodeJS.ProcessEnv, sha: string) {
  requireCheck(
    /^[a-f0-9]{40}$/.test(sha) &&
      env.ALLRICE_B6_P27_CODEX_CAP_PROBE_AUTHORIZED === '1' &&
      env.ALLRICE_B6_P27_CODEX_CAP_PROBE_AUTHORIZED_SHA === sha &&
      env.ALLRICE_B6_P27_CODEX_CAP_PROBE_MAX_REQUESTS === '1' &&
      env.ALLRICE_B6_P27_CODEX_CAP_PROBE_SOFT_LIMIT_ACK === '1',
    'codex_cap_probe_one_request_authorization_required',
  );
  requireCheck(
    !env.DATABASE_URL && !env.ALLRICE_TEST_DATABASE_URL,
    'codex_cap_probe_ambient_database_denied',
  );
}

export async function mainP27CodexCapProbe(argsInput = process.argv.slice(2)) {
  const args = parseArguments(argsInput);
  requireCheck(
    argsInput.includes('--provider=openai-codex') &&
      args.providerRoute === 'openai-codex',
    'codex_cap_probe_explicit_provider_required',
  );
  readCandidate(root, args.sha);
  const sources = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        `sha256:${createHash('sha256')
          .update(await readFile(join(root, file)))
          .digest('hex')}`,
      ]),
    ),
  );
  const report: Record<string, unknown> = {
    version: 1,
    candidateSha: args.sha,
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    maxRequests: 1,
    maxOutputTokens: 64,
    timeoutMs: 20_000,
    sdkRetries: 0,
    credentialBytesReadByDriver: false,
    nativeHostFilesystemWritesAllowed: false,
    productionGateChanged: false,
    assistantReady: false,
    sources,
    installedRuntime: await collectP27InstalledRuntime(root),
    scope:
      'single_endpoint_compatibility_sample_not_general_enforcement_or_accounting_proof',
  };
  if (args.mode === '--preflight') {
    process.stdout.write(
      `${JSON.stringify({ ...report, status: 'preflight_only' })}\n`,
    );
    return;
  }
  authorizeP27CodexCapProbe(process.env, args.sha);
  requireCheck(
    process.env.ALLRICE_B6_P27_CODEX_CAP_PROBE_PLATFORM_HOME === platformHome,
    'codex_cap_probe_home_denied',
  );
  const authorizedHome = await authorizedPlatformHome(platformHome);
  const evidenceDirectory = join(
    root,
    '.local',
    `p27-codex-cap-probe-${randomUUID()}`,
  );
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  report.evidenceDirectory = evidenceDirectory;
  const temporary = await mkdtemp(join(tmpdir(), 'allrice-codex-cap-probe-'));
  const cleanup = { nativeHostExited: false, temporaryRemoved: false };
  try {
    readCandidate(root, args.sha);
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--permission',
          `--allow-fs-read=${root}`,
          `--allow-fs-read=${authorizedHome}`,
          `--allow-fs-read=${temporary}`,
          join(
            root,
            'apps/worker/dsh/allrice-codex-subscription-cap-probe-host.mjs',
          ),
        ],
        {
          cwd: temporary,
          timeout: 30_000,
          killSignal: 'SIGKILL',
          maxBuffer: 65_536,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            ...dshEgressEnvironment(),
            DSH_HOME: temporary,
            DSH_RUNTIME_HOME: temporary,
            DSH_CWD: temporary,
            DSH_CREDENTIALS_PATH: join(authorizedHome, '.credentials.yaml'),
            ALLRICE_CODEX_CAP_PROBE_CONFIRMATION:
              'run-one-codex-subscription-cap-probe',
            ALLRICE_CODEX_CAP_PROBE_SHA: args.sha,
          },
        },
      ));
      cleanup.nativeHostExited = true;
    } catch {
      // execFile errors embed argv, stdout and stderr: never print/rethrow them.
      cleanup.nativeHostExited = true;
      report.status = 'native_host_failed_or_timed_out';
      process.exitCode = 1;
      return;
    }
    const probe = parseP27CodexCapProbeResult(stdout);
    report.probe = probe;
    report.status =
      probe.outcome === 'cap_field_rejected'
        ? 'diagnosed_cap_field_rejected'
        : probe.outcome === 'response_received_single_sample'
          ? 'single_sample_received_not_assistant_ready'
          : 'probe_blocked_or_failed';
    if (report.status === 'probe_blocked_or_failed') process.exitCode = 1;
    readCandidate(root, args.sha);
    report.candidateRevalidated = true;
  } catch {
    report.status = 'probe_result_or_candidate_validation_failed';
    process.exitCode = 1;
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
      cleanup.temporaryRemoved = true;
    } catch {
      report.status = 'probe_cleanup_failed';
      process.exitCode = 1;
    }
    report.cleanup = cleanup;
    await writeFile(
      join(evidenceDirectory, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  mainP27CodexCapProbe().catch(() => {
    process.stdout.write(
      '{"status":"codex_cap_probe_preflight_or_cleanup_failed"}\n',
    );
    process.exitCode = 1;
  });
}
