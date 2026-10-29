import {
  clearConversationTurn,
  recordConversationNativeContext,
} from '@allrice/database';

import type {
  HarnessAdapter,
  HarnessExecutionResult,
} from '../harness/adapter.js';
import type { ConversationOwnership } from './turn-lifecycle.js';

/**
 * Finishes the SaaS turn lease and projects the native context measurement.
 * DSH owns context recovery and compaction in its persisted session. Run usage
 * belongs to the billing ledger; it must not drive another summary lifecycle.
 * Independent native delivery retains the turn for completeJob's atomic proof
 * check and ownership release.
 */
export async function finalizeEmployeeConversationContext(input: {
  ownership: ConversationOwnership;
  result: HarnessExecutionResult;
  adapter: HarnessAdapter;
  retainTurnUntilCommit?: Awaited<ReturnType<typeof clearConversationTurn>>;
}) {
  const retained = input.retainTurnUntilCommit;
  if (
    retained &&
    (input.adapter.kind !== 'dsh' ||
      input.adapter.contextStrategy !== 'harness-native' ||
      !retained.activeTurnId)
  )
    throw new Error('context_checkpoint_unsafe_boundary');
  let runtime = retained ?? (await clearConversationTurn(input.ownership));
  if (input.result.nativeContextPressure) {
    runtime = await recordConversationNativeContext({
      ...input.ownership,
      generation: runtime.generation,
      ...input.result.nativeContextPressure,
    });
  }
  return runtime;
}
