/** Acceptance-local authorization only. No credential bytes, DB, or model calls. */
import { parseArguments } from './p27-assistant-preflight.ts';
import { p27ErrorDiagnostics } from './p27-error-diagnostics.ts';
import { codexJsonDiagnostics } from './p27-codex-json.ts';
export { authorizedP27CodexPlatformHome } from './p27-codex-worker-preflight.ts';

export const P27_CODEX_ASSISTANT_LIMITS = Object.freeze({
  timeoutMs: 180000,
  maxInputTokens: 40000,
  maxOutputTokens: 4000,
  maxTotalTokens: 44000,
  maxCostCents: null,
});
export const P27_CODEX_ASSISTANT_PROMPT = `Synthetic acceptance only. Use actual assistant_delegate exactly twice. Start independent children A and B before synthesizing, each child's tools limited to ["assistant.report"]. No other delegation, external tools, or research. A calculates totalCents and rows for [{units:3,unitPriceCents:125},{units:2,unitPriceCents:250}]. A must call assistant_report once with status "completed", short accurate summary, evidence [], incomplete [], and output {name:"report",content:<JSON string with case:"A",totalCents,rows>}. B calculates invoiceCents,paidCents,outstandingCents from [{invoiceCents:1000,paidCents:400},{invoiceCents:900,paidCents:900}]. B must call assistant_report once with status "completed", short accurate summary, evidence [], incomplete [], and output {name:"report",content:<JSON string with case:"B",invoiceCents,paidCents,outstandingCents>}. The platform attaches real immutable artifact evidence; never invent IDs. Wait for and consume both actual reports. Parent must not call assistant_report. Parent final answer ONLY JSON {salesTotalCents:<A total>,outstandingCents:<B total>,reports:2}. On child failure report failure, never fabricate success.`;
export const P27_CODEX_ASSISTANTS_SCOPE =
  'Two Worker executions: one parent with exactly two report-only children, then one ordinary task only after durable success and internal quota checks, followed by read-only private Chrome observation of those exact completed tasks. No application retries or fallback. Subscription token/output limits are soft application accounting controls, not provider-enforced output/spend caps. SDK/provider-internal requests or retries are not bounded by the Worker execution count. Provider allowance is not queried; unknown does not mean available.';

const codes = [
  'arguments',
  'authorization',
  'ambient_database',
  'fixture_flags',
  'already_attempted',
  'ordinary_before_verified',
  'first_run_mismatch',
  'first_not_terminal',
  'first_tree_unverified',
  'first_usage_unverified',
  'subscription_identity',
  'subscription_result',
  'subscription_ledger',
  'subscription_snapshot',
  'subscription_price_rows',
  'subscription_quota',
  'model_usage_unverified',
  'whole_tree_usage',
  'model_admissions_unverified',
  'artifacts_unverified',
  'child_arithmetic',
  'parent_arithmetic',
  'ordinary_result',
  'ordinary_tools',
  'tool_out_of_scope',
  'execution_count',
  'application_limits',
  'schema_invalid',
  'ui_unverified',
] as const;
type Code = (typeof codes)[number];
const allowedCodes = new Set<string>(codes);
export class P27CodexAssistantsCheckError extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
export function checkCodexAssistants(ok: unknown, code: Code): asserts ok {
  if (!ok) throw new P27CodexAssistantsCheckError(code);
}
export function codexAssistantsDiagnostics(error: unknown) {
  return {
    ...p27ErrorDiagnostics(error),
    ...(codexJsonDiagnostics(error)
      ? { jsonParsing: codexJsonDiagnostics(error) }
      : {}),
    acceptanceCheck:
      error instanceof P27CodexAssistantsCheckError &&
      allowedCodes.has(error.code)
        ? error.code
        : null,
  };
}
export function parseP27CodexAssistantsArguments(args: string[]) {
  const parsed = parseArguments(args);
  checkCodexAssistants(
    args.includes('--provider=openai-codex') &&
      parsed.providerRoute === 'openai-codex',
    'arguments',
  );
  return parsed;
}
export function authorizeP27CodexAssistants(
  env: NodeJS.ProcessEnv,
  sha: string,
) {
  checkCodexAssistants(
    /^[a-f0-9]{40}$/.test(sha) &&
      env.ALLRICE_B6_P27_CODEX_ASSISTANTS_AUTHORIZED === '1' &&
      env.ALLRICE_B6_P27_CODEX_ASSISTANTS_AUTHORIZED_SHA === sha &&
      env.ALLRICE_B6_P27_CODEX_ASSISTANTS_MAX_EXECUTIONS === '2' &&
      env.ALLRICE_B6_P27_CODEX_ASSISTANTS_SOFT_LIMIT_ACK === '1' &&
      env.ALLRICE_B6_P27_CODEX_ASSISTANTS_SUBSCRIPTION_ONLY === '1',
    'authorization',
  );
  checkCodexAssistants(
    !env.DATABASE_URL && !env.ALLRICE_TEST_DATABASE_URL,
    'ambient_database',
  );
}
