import {
  authorizedPlatformHome,
  parseArguments,
  requireCheck,
} from './p27-assistant-preflight.ts';

export const P27_CODEX_PLATFORM_HOME =
  '/Users/a123/allrice-dev/.local/dsh-platform';
export const P27_CODEX_ORDINARY_PROMPT =
  'Synthetic arithmetic only. Do not use tools or delegates. Return ONLY JSON with key sum equal to 123 + 456. No markdown.';
export const P27_CODEX_ORDINARY_LIMITS = Object.freeze({
  timeoutMs: 90000,
  maxInputTokens: 8000,
  maxOutputTokens: 512,
  maxTotalTokens: 8512,
  maxCostCents: null,
});
export const P27_CODEX_LIMIT_CAVEAT =
  'Timeout and token limits are application controls; pinned Codex does not prove a wire-enforced maxTokens cap. There is no application-level retry; SDK/provider-internal retries are not a hard constraint of this smoke. One Worker execution is not a claim of one model request. No hard spend or subscription allowance bound is claimed.';
export const P27_CODEX_COST_CAVEAT =
  'Frozen Codex subscription identity requires N/A monetary accounting and complete observed tokens. A zero metered-cost subtotal is not proof of free subscription usage or zero actual cost.';

export function parseP27CodexWorkerArguments(args: string[]) {
  const parsed = parseArguments(args);
  requireCheck(
    args.includes('--provider=openai-codex') &&
      parsed.providerRoute === 'openai-codex',
    'codex_worker_explicit_provider_required',
  );
  return parsed;
}

/** A separate one-Worker ticket: prior assistant/Gemini opt-ins never apply. */
export function authorizeP27CodexWorker(env: NodeJS.ProcessEnv, sha: string) {
  requireCheck(
    /^[a-f0-9]{40}$/.test(sha) &&
      env.ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED === '1' &&
      env.ALLRICE_B6_P27_CODEX_WORKER_AUTHORIZED_SHA === sha &&
      env.ALLRICE_B6_P27_CODEX_WORKER_MAX_EXECUTIONS === '1' &&
      env.ALLRICE_B6_P27_CODEX_WORKER_SOFT_LIMIT_ACK === '1' &&
      env.ALLRICE_B6_P27_CODEX_WORKER_SUBSCRIPTION_ONLY === '1',
    'codex_worker_one_execution_authorization_required',
  );
  requireCheck(
    !env.DATABASE_URL && !env.ALLRICE_TEST_DATABASE_URL,
    'codex_worker_ambient_database_denied',
  );
}

/** Metadata only, exact existing Dev binding; never discover/copy credentials. */
export async function authorizedP27CodexPlatformHome(value?: string) {
  requireCheck(value === P27_CODEX_PLATFORM_HOME, 'codex_worker_home_denied');
  return authorizedPlatformHome(value);
}

export function onceP27CodexWorker<T>(execute: () => Promise<T>) {
  let attempted = false;
  return async () => {
    requireCheck(!attempted, 'codex_worker_already_attempted');
    attempted = true;
    return execute();
  };
}
