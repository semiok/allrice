/** Acceptance-only diagnostics. Never copy an error, message, stack, response,
 * headers, URL, model content, or arbitrary class/code into the evidence. */
import { types } from 'node:util';

const MAX_CAUSES = 5;
const MAX_SCAN = 4096;
const classes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DOMException',
  'AbortError',
  'TimeoutError',
  'HandlerError',
  'AssistantRuntimeError',
  'AssistantPricingError',
  'AssistantExecutionUnresolvedError',
  'AssistantFixtureInitializationError',
  'AssistantFixtureCleanupError',
  'APIError',
  'APICallError',
  'AI_APICallError',
  'OpenAIError',
  'AuthenticationError',
  'PermissionDeniedError',
  'RateLimitError',
  'BadRequestError',
  'NotFoundError',
  'InternalServerError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
]);
// Fixed source-defined codes, not a permissive character/prefix regex. Native
// runtime error codes can originate in a provider and are otherwise untrusted.
const codes = new Set([
  'DSH_CREDENTIAL_FILE_INSECURE',
  'DSH_CREDENTIAL_FILE_UNAVAILABLE',
  'DSH_CREDENTIAL_DIRECTORY_INVALID',
  'DSH_CREDENTIAL_UNAVAILABLE',
  'DSH_CREDENTIAL_INVALID',
  'DSH_RUNTIME_CONFIG_INVALID',
  'DSH_RUNTIME_UNAVAILABLE',
  'DSH_RUNTIME_CLOSED',
  'DSH_SESSION_NOT_LIVE',
  'DSH_TENANT_CONTEXT_INVALID',
  'CODEX_SUBSCRIPTION_AUTH_REQUIRED',
  'DSH_PROTOCOL_MISMATCH',
  'DSH_VERSION_MISMATCH',
  'DSH_REQUEST_TIMEOUT',
  'DSH_REQUEST_FAILED',
  'DSH_INBOUND_REQUEST_DENIED',
  'DSH_TURN_FAILED',
  'DSH_TOOL_LIMIT_EXCEEDED',
  'DSH_TOOL_ENVELOPE_INVALID',
  'DSH_NATIVE_TOOL_INVALID',
  'TOOL_NOT_ALLOWED',
  'EXECUTION_ABORTED',
  'HARNESS_UNSUPPORTED',
  'PROVIDER_UNAVAILABLE',
  'ASSISTANT_EXECUTION_UNRESOLVED',
  'ASSISTANT_PARTIAL_RESULT',
  'ASSISTANT_PRICE_UNAVAILABLE',
  'ASSISTANT_PRICE_UNSUPPORTED_BILLING',
  'ASSISTANT_PRICE_AMBIGUOUS',
  'ASSISTANT_PRICE_USAGE_OUT_OF_BAND',
  'disabled',
  'forbidden',
  'conflict',
  'canceled',
  'lease_lost',
  'limit_exceeded',
  'budget_exhausted',
  'unknown',
  'not_found',
  'assistant_identity_denied',
  'assistant_parent_missing',
  'assistant_message_recipient_mismatch',
  'assistant_tool_not_available',
  'assistant_tool_unknown_no_replay',
  'assistant_tool_not_allowed',
  'assistant_child_tool_not_supported',
  'assistant_parent_denied',
  'assistant_output_unavailable',
  'assistant_method_not_allowed',
  'p27_actual_ledger_matches_settled_usage',
  'p27_adapter_assistant_status',
  'p27_adapter_authoritative_whole_tree_outcome',
  'p27_adapter_provider_route',
  'p27_adapter_priced_accounting',
  'p27_adapter_unknown_accounting_flags',
  'p27_adapter_usage_incomplete',
  'p27_adapter_whole_tree_usage',
  'p27_all_usage_settled',
  'p27_ambient_database_denied',
  'p27_arguments',
  'p27_artifact_registered_to_its_child',
  'p27_candidate_mismatch',
  'p27_children_completed_with_only_report_authority',
  'p27_computed_child_report_correct',
  'p27_credential_metadata_denied',
  'p27_dirty_worktree',
  'p27_exact_two_finite_children',
  'p27_execute_deadline',
  'p27_existing_fixture_extensions',
  'p27_external_or_runtime_failure',
  'p27_failure_snapshot_timeout',
  'p27_fixture_initialization_failure',
  'p27_frozen_provider_matches_actual_route',
  'p27_host_close_timeout',
  'p27_immutable_report_bytes_and_owner',
  'p27_installed_entry_outside_package',
  'p27_installed_lock_mismatch',
  'p27_installed_resolution',
  'p27_installed_runtime_unchanged',
  'p27_installed_version_mismatch',
  'p27_manifest_schema',
  'p27_native_messages_durably_adopted',
  'p27_parent_durably_adopted_both_results',
  'p27_parent_synthesis_matches_real_reports',
  'p27_platform_home_denied',
  'p27_platform_home_permissions',
  'p27_platform_home_required',
  'p27_production_assistant_controller_enabled',
  'p27_production_root_call_caps',
  'p27_provider_not_authorized',
  'p27_provider_route_not_authorized',
  'p27_gemini_credential_file_required',
  'p27_gemini_credential_metadata_denied',
  'p27_gemini_existing_platform_home_denied',
  'p27_price_manifest_expired_or_not_effective',
  'p27_price_bound_exceeds_limit',
  'p27_priced_call_receipt_count',
  'p27_priced_receipt_identity',
  'p27_priced_cache_remains_unknown',
  'p27_priced_receipt_amount',
  'p27_priced_receipts_match_settled_tokens',
  'p27_priced_summary_matches_receipts',
  'p27_random_isolated_schema',
  'p27_real_model_usage_for_parent_and_each_child',
  'p27_real_native_tool_registry',
  'p27_report_platform_provenance',
  'p27_same_basename_independent_immutable_objects',
  'p27_stopping',
  'p27_worker_lock_importer_missing',
]);
const categories = [
  [
    'authentication',
    /\b(?:unauthorized|authentication[_ -](?:failed|required|error)|invalid[_ -]api[_ -]key|invalid[_ -]token|token[_ -]expired|credential[_ -](?:invalid|unavailable)|CODEX_SUBSCRIPTION_AUTH_REQUIRED|DSH_CREDENTIAL_(?:FILE_INSECURE|FILE_UNAVAILABLE|DIRECTORY_INVALID|UNAVAILABLE|INVALID))\b/i,
  ],
  [
    'rate_limit',
    /\b(?:rate[_ -]limit(?:ed|ing|_exceeded)?|too[_ -]many[_ -]requests|insufficient_quota)\b/i,
  ],
  [
    'model_unavailable',
    /\b(?:model_not_found|unsupported_model|model_unavailable)\b|\bmodel\b[^\r\n]{0,120}\b(?:does not exist|not found|not available|not supported|unavailable)\b/i,
  ],
  [
    'strict_tool_schema',
    /\b(?:invalid|unsupported|strict)[_ -]+(?:json[_ -]+)?schema\b|\b(?:tool|function)[_ -]+schema\b|\badditionalProperties\b[^\r\n]{0,80}\b(?:false|required)\b/i,
  ],
  [
    'previous_response_state',
    /\bprevious_response(?:_id)?\b|\b(?:conversation|session|response)[_ -](?:state|not_found|expired|invalid|not_live)\b/i,
  ],
  [
    'native_authority',
    /\b(?:assistant_(?:identity_denied|parent_denied|parent_missing|message_recipient_mismatch|tool_not_allowed|tool_not_available|child_tool_not_supported|method_not_allowed)|lease_lost|permission_denied|tool_not_allowed|forbidden|DSH_INBOUND_REQUEST_DENIED|DSH_TENANT_CONTEXT_INVALID)\b|\b(?:native|assistant)[_ -]authority\b|\bauthori[sz]ation[_ -](?:denied|revoked|expired)\b/i,
  ],
  [
    'budget',
    /\b(?:budget[_ -](?:exhausted|exceeded|limit)|limit_exceeded|DSH_TOOL_LIMIT_EXCEEDED|context_length_exceeded|MODEL_(?:TOKEN|COST)_USAGE_UNKNOWN)\b/i,
  ],
  [
    'timeout',
    /\b(?:timed out|timeout|DSH_REQUEST_TIMEOUT|p27_execute_deadline|p27_host_close_timeout)\b/i,
  ],
  [
    'runtime_protocol',
    /\bDSH_(?:PROTOCOL_MISMATCH|VERSION_MISMATCH|RUNTIME_CLOSED|RUNTIME_UNAVAILABLE)\b/i,
  ],
  [
    'execution_aborted',
    /\b(?:EXECUTION_ABORTED|canceled|cancelled|AbortError)\b/i,
  ],
] as const;

function data(value: unknown, key: PropertyKey): unknown {
  if (types.isProxy(value)) return undefined;
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  )
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function errorClass(value: unknown) {
  if (types.isProxy(value)) return 'UnknownError';
  const ownName = data(value, 'name');
  if (allowed(ownName, classes)) return ownName;
  try {
    if (
      (typeof value === 'object' && value !== null) ||
      typeof value === 'function'
    ) {
      const constructor = data(Object.getPrototypeOf(value), 'constructor');
      const name = data(constructor, 'name');
      if (allowed(name, classes)) return name;
    }
  } catch {
    /* Unknown prototypes/proxies never cause diagnostic capture to fail. */
  }
  return 'UnknownError';
}
function allowed(
  value: unknown,
  allowlist: ReadonlySet<string>,
): value is string {
  return (
    typeof value === 'string' && value.length <= 128 && allowlist.has(value)
  );
}
function status(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 400 &&
    value <= 599
    ? value
    : null;
}

/** Regex categories are hints from a bounded error string, not a proven cause.
 * Only `cause` is traversed; arbitrary payload/response trees are never walked. */
export function p27ErrorDiagnostics(error: unknown) {
  const errors = [];
  const seen = new Set<unknown>();
  let current = error;
  let causeCycleDetected = false;
  let causeChainTruncated = false;
  for (let depth = 0; depth < MAX_CAUSES; depth++) {
    if (seen.has(current)) {
      causeCycleDetected = true;
      break;
    }
    seen.add(current);
    const rawCode = data(current, 'code');
    const rawMessage =
      typeof current === 'string' ? current : data(current, 'message');
    const code = allowed(rawCode, codes)
      ? rawCode
      : allowed(rawMessage, codes)
        ? rawMessage
        : null;
    const scan = [rawCode, rawMessage]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.slice(0, MAX_SCAN))
      .join('\n');
    const retryable = data(current, 'retryable');
    const httpStatus =
      status(data(current, 'status')) ??
      status(data(current, 'statusCode')) ??
      status(data(current, 'httpStatus')) ??
      status(data(data(current, 'response'), 'status')) ??
      status(
        Number(
          /\b(?:HTTP(?:\/[12](?:\.\d)?)?[_ :\t-]+|status(?:Code| code)?["']?[ :\t=]+)([45]\d{2})\b/i.exec(
            scan,
          )?.[1],
        ),
      );
    const matched = new Set<string>(
      categories
        .filter(([, pattern]) => pattern.test(scan))
        .map(([category]) => category),
    );
    if (httpStatus === 401 || httpStatus === 403) matched.add('authentication');
    if (httpStatus === 429) matched.add('rate_limit');
    errors.push({
      depth,
      class: errorClass(current),
      code,
      retryable: typeof retryable === 'boolean' ? retryable : null,
      httpStatus,
      categories: matched.size ? [...matched] : ['unknown'],
      scanTruncated: [rawCode, rawMessage].some(
        (value) => typeof value === 'string' && value.length > MAX_SCAN,
      ),
    });
    const cause = data(current, 'cause');
    if (cause === undefined || cause === null) break;
    if (depth === MAX_CAUSES - 1) causeChainTruncated = true;
    current = cause;
  }
  return { schemaVersion: 1, errors, causeCycleDetected, causeChainTruncated };
}
