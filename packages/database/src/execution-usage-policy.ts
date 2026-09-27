/** Product policy: execution usage is telemetry, never a spending gate.
 * Applies equally to subscription/API routes and to parent/child calls.
 * Keep missing receipts unknown; task completion is established separately.
 * Tenant task-count/day entitlements belong at new-task admission.
 */
export function observesExecutionUsage() {
  return true;
}

/** Time and byte bounds are resource controls, not commercial usage allowances. */
export const isObservedExecutionMetric = (metric: string) =>
  [
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'model_calls',
    'tool_calls',
    'cost',
  ].includes(metric);

export const isTokenMetric = (metric: string) =>
  ['input_tokens', 'cached_input_tokens', 'output_tokens'].includes(metric);
export const isCallMetric = (metric: string) =>
  metric === 'model_calls' || metric === 'tool_calls';
