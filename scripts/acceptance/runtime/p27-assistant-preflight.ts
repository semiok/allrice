import { execFileSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import type { AssistantFixtureCleanupProof } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { HandlerError } from '../../../apps/worker/src/errors.ts';
import { assertAssistantProviderOutputBound } from '../../../apps/worker/src/harness/dsh/assistant-provider.ts';

export const AUTHORIZED_DEV_ROOT = '/Users/a123/allrice-dev/.local';
export const FIXTURE_DATABASE_URL = 'postgres://a123@127.0.0.1:5432/allrice_b2';
export const PROVIDER = Object.freeze({
  provider: 'dsh' as const,
  authMode: 'platform_subscription' as const,
  route: 'openai-codex' as const,
  model: 'gpt-5.6-luna',
  reasoningEffort: 'low' as const,
  credentialReference: 'deployment:codex-default',
  baseUrl: null,
});
/** Uses the same server-owned capability gate as production. A valid source
 * manifest is not proof that this pinned acceptance route may execute. */
export function providerExecutionEligibility() {
  try {
    assertAssistantProviderOutputBound(PROVIDER, true);
    return { eligible: true, reason: null } as const;
  } catch (error) {
    if (
      error instanceof HandlerError &&
      error.code === 'ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED'
    )
      return {
        eligible: false,
        reason: 'ASSISTANT_PROVIDER_OUTPUT_BOUND_UNSUPPORTED',
      } as const;
    throw error;
  }
}
export const RUN_LIMITS = Object.freeze({
  timeoutMs: 180000,
  maxInputTokens: 80000,
  maxOutputTokens: 12000,
  maxTotalTokens: 92000,
  maxCostCents: null,
});
export function fixtureCleanupFlags(
  attempted: boolean,
  proof?: AssistantFixtureCleanupProof,
) {
  return {
    schemaRemoved: !attempted || proof?.schemaRemoved === true,
    fixtureStorageRemoved: !attempted || proof?.storageRemoved === true,
    fixtureConnectionsClosed:
      !attempted ||
      (proof?.databaseClosed === true && proof?.adminClosed === true),
  };
}
export function requireCheck(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`p27_${code}`);
}
export function parseArguments(args: string[]) {
  requireCheck(args.length === 2, 'arguments');
  const mode = args.find((value) =>
    ['--preflight', '--execute'].includes(value),
  );
  const sha = args
    .find((value) => value.startsWith('--candidate-sha='))
    ?.slice(16);
  requireCheck(mode && sha && /^[a-f0-9]{40}$/.test(sha), 'arguments');
  return { mode, sha };
}
export function assertCandidate(
  expected: string,
  actual: string,
  status: string,
) {
  requireCheck(
    /^[a-f0-9]{40}$/.test(expected) && expected === actual,
    'candidate_mismatch',
  );
  requireCheck(status === '', 'dirty_worktree');
}
export function readCandidate(root: string, sha: string) {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
      },
    }).trim();
  assertCandidate(
    sha,
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain', '--untracked-files=normal']),
  );
}
export function assertExecutionAuthorization(
  env: NodeJS.ProcessEnv,
  sha: string,
) {
  requireCheck(
    env.ALLRICE_B6_P27_PROVIDER_AUTHORIZED === '1' &&
      env.ALLRICE_B6_P27_AUTHORIZED_SHA === sha,
    'provider_not_authorized',
  );
  requireCheck(
    !env.DATABASE_URL && !env.ALLRICE_TEST_DATABASE_URL,
    'ambient_database_denied',
  );
}
export function strictDescendant(root: string, candidate: string) {
  const path = relative(root, candidate);
  return (
    path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path)
  );
}
export async function authorizedPlatformHome(value: string | undefined) {
  requireCheck(value, 'platform_home_required');
  const root = await realpath(AUTHORIZED_DEV_ROOT);
  const home = await realpath(value);
  requireCheck(strictDescendant(root, home), 'platform_home_denied');
  const directory = await lstat(home);
  requireCheck(
    directory.isDirectory() &&
      directory.uid === process.getuid?.() &&
      (directory.mode & 0o022) === 0,
    'platform_home_permissions',
  );
  // Metadata only. This script never reads or copies credential bytes.
  const credentials = await lstat(join(home, '.credentials.yaml'));
  requireCheck(
    credentials.isFile() &&
      !credentials.isSymbolicLink() &&
      credentials.nlink === 1 &&
      credentials.uid === process.getuid?.() &&
      (credentials.mode & 0o077) === 0,
    'credential_metadata_denied',
  );
  return home;
}
export function isolatedEnvironment(
  env: NodeJS.ProcessEnv,
  platformHome: string,
) {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'TSX_TSCONFIG_PATH',
    'ALLRICE_DSH_HTTP_PROXY',
    'ALLRICE_DSH_HTTPS_PROXY',
    'ALLRICE_DSH_NO_PROXY',
  ];
  return {
    ...Object.fromEntries(
      allowed.flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
    ),
    ALLRICE_DSH_PLATFORM_HOME: platformHome,
    ALLRICE_TEST_DATABASE_URL: FIXTURE_DATABASE_URL,
    ALLRICE_ASSISTANTS_ENABLED: '1',
    ALLRICE_WORKBENCH_ENABLED: '1',
    ALLRICE_RUNTIME_POLICY_ENABLED: '1',
    ALLRICE_BRIDGE_TRANSPORT_ENABLED: '0',
    ALLRICE_MCP_ENABLED: '0',
    ALLRICE_LOCAL_MCP_ENABLED: '0',
    ALLRICE_CLOUD_MCP_ENABLED: '0',
    ALLRICE_GEMINI_API_ENABLED: '0',
    ALLRICE_CLOUD_RUNNER_ENABLED: '0',
    ALLRICE_BROWSER_ENABLED: '0',
  };
}
