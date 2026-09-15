import { execFileSync } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import type { AssistantFixtureCleanupProof } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { HandlerError } from '../../../apps/worker/src/errors.ts';
import { assertAssistantProviderOutputBound } from '../../../apps/worker/src/harness/dsh/assistant-provider.ts';
import type { DshExecutionSnapshot } from '../../../packages/contracts/src/index.ts';
import { P27_GEMINI_RUN_LIMITS } from './p27-assistant-pricing.ts';

export const AUTHORIZED_DEV_ROOT = '/Users/a123/allrice-dev/.local';
// Exact existing Dev Worker binding, resolved from its LaunchAgent; never a
// search for credentials, a Prod path, or permission to copy a secret.
export const AUTHORIZED_GEMINI_CREDENTIAL_FILE =
  '/Users/a123/.config/allrice/dsh-credentials.dev.json';
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
export const GEMINI_PROVIDER = Object.freeze({
  provider: 'dsh' as const,
  authMode: 'allrice_credential' as const,
  route: 'gemini' as const,
  model: '3.8flash',
  reasoningEffort: 'low' as const,
  credentialReference: 'deployment:gemini-default',
  baseUrl: null,
});
export type P27ProviderRoute = 'openai-codex' | 'gemini';
export function selectedProvider(
  route: P27ProviderRoute,
): DshExecutionSnapshot {
  return route === 'gemini' ? GEMINI_PROVIDER : PROVIDER;
}
/** Uses the same server-owned capability gate as production. A valid source
 * manifest is not proof that this pinned acceptance route may execute. */
export function providerExecutionEligibility(
  provider = selectedProvider('openai-codex'),
) {
  try {
    assertAssistantProviderOutputBound(provider, true);
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
export function runLimitsForProvider(route: P27ProviderRoute) {
  return route === 'gemini' ? P27_GEMINI_RUN_LIMITS : RUN_LIMITS;
}
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
export function parseArguments(args: string[]): {
  mode: string;
  sha: string;
  providerRoute: P27ProviderRoute;
} {
  const modes = args.filter((value) =>
    ['--preflight', '--execute'].includes(value),
  );
  const shas = args.filter((value) => value.startsWith('--candidate-sha='));
  const providers = args.filter((value) => value.startsWith('--provider='));
  requireCheck(
    modes.length === 1 &&
      shas.length === 1 &&
      providers.length <= 1 &&
      args.length === modes.length + shas.length + providers.length,
    'arguments',
  );
  const sha = shas[0]!.slice(16);
  const providerRoute = providers[0]?.slice(11) ?? 'openai-codex';
  requireCheck(
    /^[a-f0-9]{40}$/.test(sha) &&
      (providerRoute === 'openai-codex' || providerRoute === 'gemini'),
    'arguments',
  );
  return { mode: modes[0]!, sha, providerRoute };
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
  providerRoute: P27ProviderRoute = 'openai-codex',
) {
  requireCheck(
    env.ALLRICE_B6_P27_PROVIDER_AUTHORIZED === '1' &&
      env.ALLRICE_B6_P27_AUTHORIZED_SHA === sha,
    'provider_not_authorized',
  );
  // A prior Codex authorization is never permission to spend against Gemini.
  requireCheck(
    (providerRoute === 'openai-codex' &&
      !env.ALLRICE_B6_P27_AUTHORIZED_PROVIDER) ||
      env.ALLRICE_B6_P27_AUTHORIZED_PROVIDER === providerRoute,
    'provider_route_not_authorized',
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
/** Metadata-only preflight for an explicitly selected existing Dev credential
 * file. Only the production resolver reads its bytes, after execution approval. */
export async function authorizedGeminiCredentialFile(
  value: string | undefined,
) {
  requireCheck(value, 'gemini_credential_file_required');
  const root = await realpath(AUTHORIZED_DEV_ROOT);
  const original = await lstat(value);
  const file = await realpath(value);
  const metadata = await lstat(file);
  requireCheck(
    !original.isSymbolicLink() &&
      (strictDescendant(root, file) ||
        file === AUTHORIZED_GEMINI_CREDENTIAL_FILE) &&
      metadata.isFile() &&
      metadata.nlink === 1 &&
      metadata.uid === process.getuid?.() &&
      (metadata.mode & 0o077) === 0 &&
      metadata.size > 0 &&
      metadata.size <= 65536,
    'gemini_credential_metadata_denied',
  );
  return file;
}
export function isolatedEnvironment(
  env: NodeJS.ProcessEnv,
  platformHome: string,
  selection: { providerRoute: P27ProviderRoute; credentialFile?: string } = {
    providerRoute: 'openai-codex',
  },
) {
  requireCheck(
    selection.providerRoute !== 'gemini' || !!selection.credentialFile,
    'gemini_credential_file_required',
  );
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
    ...(selection.providerRoute === 'gemini'
      ? { ALLRICE_DSH_CREDENTIALS_FILE: selection.credentialFile! }
      : {}),
    ALLRICE_TEST_DATABASE_URL: FIXTURE_DATABASE_URL,
    ALLRICE_ASSISTANTS_ENABLED: '1',
    ALLRICE_WORKBENCH_ENABLED: '1',
    ALLRICE_RUNTIME_POLICY_ENABLED: '1',
    ALLRICE_BRIDGE_TRANSPORT_ENABLED: '0',
    ALLRICE_MCP_ENABLED: '0',
    ALLRICE_LOCAL_MCP_ENABLED: '0',
    ALLRICE_CLOUD_MCP_ENABLED: '0',
    ALLRICE_GEMINI_API_ENABLED:
      selection.providerRoute === 'gemini' ? '1' : '0',
    ALLRICE_CLOUD_RUNNER_ENABLED: '0',
    ALLRICE_BROWSER_ENABLED: '0',
  };
}

/** Call inside the owner's try/finally. Missing .credentials.yaml is a valid
 * empty DSH store; never seed it by copying an existing provider's credentials. */
export async function prepareP27PlatformEnvironment(input: {
  environment: NodeJS.ProcessEnv;
  temporary: string;
  codexPlatformHome?: string;
  providerRoute: P27ProviderRoute;
  credentialFile?: string;
}) {
  requireCheck(
    input.providerRoute !== 'gemini' || !input.codexPlatformHome,
    'gemini_existing_platform_home_denied',
  );
  const platformHome =
    input.codexPlatformHome ?? join(input.temporary, 'platform');
  if (!input.codexPlatformHome) await mkdir(platformHome, { mode: 0o700 });
  return isolatedEnvironment(input.environment, platformHome, {
    providerRoute: input.providerRoute,
    credentialFile: input.credentialFile,
  });
}
