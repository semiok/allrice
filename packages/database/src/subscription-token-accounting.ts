import {
  AssistantSubscriptionSnapshotSchema,
  type RuntimeTaskRef,
} from '@allrice/contracts';
import { observeCodexTokens } from './codex-token-policy.ts';
import type { RuntimeLedgerTransaction } from './runtime-ledger/types.ts';

export const isTokenMetric = (metric: string) =>
  ['input_tokens', 'cached_input_tokens', 'output_tokens'].includes(metric);

/** Server-frozen proof only; never infer billing from a model/tool argument.
 * A later API route does not inherit an earlier subscription exemption. */
export async function observesRootTokens(
  tx: RuntimeLedgerTransaction,
  task: RuntimeTaskRef,
  digest: (value: unknown) => string,
) {
  if (!observeCodexTokens(true)) return false;
  // Pre-proof migration fixtures (and old installations) get no exemption.
  // Resolve in the active schema only, never a search_path fallback tenant.
  const [relation] =
    await tx`select to_regclass(format('%I.allrice_route_subscription_snapshots',current_schema())) is not null as available`;
  if (!relation?.available) return false;
  const [route] = await tx`
    select s.snapshot,s.snapshot_digest from allrice_route_decisions d
    left join allrice_route_subscription_snapshots s on s.route_decision_id=d.id
    where d.run_id=${task.rootRunId} and d.organization_id=${task.scope.organizationId}
      and d.workspace_id=${task.scope.workspaceId}
    order by d.generation desc,d.attempt desc,d.created_at desc,d.id desc limit 1`;
  const proof = AssistantSubscriptionSnapshotSchema.safeParse(route?.snapshot);
  return proof.success && digest(proof.data) === route?.snapshot_digest;
}
