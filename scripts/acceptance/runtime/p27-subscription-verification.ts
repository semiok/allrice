/** Independent acceptance checks; no provider calls and no price invention. */
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import type {
  P27CodexWorkerFixture,
  P27PreparedCodexWorkerTask,
} from './p27-codex-worker-fixture.ts';
import { requireCheck as check } from './p27-runtime-preflight.ts';

export type CodexFixtureIdentity = Pick<
  P27CodexWorkerFixture,
  | 'db'
  | 'context'
  | 'organizationId'
  | 'workspaceId'
  | 'ownerId'
  | 'employeeId'
  | 'connectionId'
  | 'catalogId'
>;
export async function readCodexSubscriptionEvidence(
  fixture: CodexFixtureIdentity,
  task: P27PreparedCodexWorkerTask,
) {
  const [
    { SubscriptionSnapshotSchema, resolveSubscriptionSnapshot },
    { runtimePolicyDigest },
  ] = await Promise.all([
    import('../../../packages/contracts/src/subscription-snapshot.ts'),
    import('../../../packages/database/src/runtime-policy.ts'),
  ]);
  const rows = await fixture.db<
    {
      id: string;
      organization_id: string;
      workspace_id: string;
      run_id: string;
      provider: string;
      model: string;
      status: string;
      employee_id: string;
      model_connection_id: string;
      model_catalog_entry_id: string;
      model_policy_revision: number;
      harness: 'dsh';
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      cost: string | null;
      usage_complete: boolean;
      cache_usage_known: boolean;
      ledger_input: number;
      ledger_output: number;
      ledger_cached: number;
      ledger_cost: string | null;
      ledger_complete: boolean;
      ledger_cache_known: boolean;
      ledger_status: string;
      ledger_route_decision_id: string;
      ledger_organization_id: string;
      ledger_workspace_id: string;
      snapshot: unknown;
      snapshot_digest: string;
    }[]
  >`
    select d.id,d.organization_id,d.workspace_id,d.run_id,
      d.provider,d.model,d.harness,d.status,d.employee_id,
      d.model_connection_id,d.model_catalog_entry_id,d.model_policy_revision,
      d.input_tokens,d.output_tokens,d.cached_input_tokens,d.cost_cents::text as cost,
      d.usage_complete,d.cache_usage_known,
      l.input_tokens as ledger_input,l.output_tokens as ledger_output,
      l.cached_input_tokens as ledger_cached,l.cost_cents::text as ledger_cost,
      l.usage_complete as ledger_complete,l.cache_usage_known as ledger_cache_known,
      l.status as ledger_status,l.route_decision_id as ledger_route_decision_id,
      l.organization_id as ledger_organization_id,l.workspace_id as ledger_workspace_id,
      s.snapshot,s.snapshot_digest
    from allrice_route_decisions d
    join allrice_model_usage_ledger l on l.route_decision_id=d.id
      and l.organization_id=d.organization_id
      and l.workspace_id=d.workspace_id
      and l.connection_id=d.model_connection_id
      and l.model_catalog_entry_id=d.model_catalog_entry_id
    join allrice_route_subscription_snapshots s on s.route_decision_id=d.id
    where d.run_id=${task.runId} and d.organization_id=${fixture.organizationId}
      and d.workspace_id=${fixture.workspaceId} and d.actor_id=${fixture.ownerId}`;
  check(rows.length === 1, 'subscription_snapshot');
  const row = rows[0]!;
  const snapshot = SubscriptionSnapshotSchema.parse(row.snapshot);
  const expected = resolveSubscriptionSnapshot({
    sessionId: task.sessionId,
    modelSnapshot: task.binding.executionSnapshot.modelSnapshot,
    decision: {
      employeeId: row.employee_id,
      modelConnectionId: row.model_connection_id,
      modelCatalogEntryId: row.model_catalog_entry_id,
      modelPolicyRevision: row.model_policy_revision,
      harness: row.harness,
      provider: row.provider,
      model: row.model,
    },
    providerSnapshot: task.binding.providerSnapshot,
  });
  check(
    expected &&
      row.snapshot_digest === runtimePolicyDigest(snapshot) &&
      row.snapshot_digest === runtimePolicyDigest(expected) &&
      snapshot.connectionId === fixture.connectionId &&
      snapshot.modelCatalogEntryId === fixture.catalogId &&
      snapshot.employeeId === fixture.employeeId &&
      snapshot.sessionId === task.sessionId &&
      snapshot.provider === 'openai-codex' &&
      snapshot.model === task.binding.executionSnapshot.modelSnapshot?.model,
    'subscription_identity',
  );
  check(
    row.status === 'succeeded' &&
      row.ledger_status === 'succeeded' &&
      row.cost === null &&
      row.ledger_cost === null &&
      row.usage_complete &&
      row.ledger_complete &&
      row.input_tokens === row.ledger_input &&
      row.output_tokens === row.ledger_output &&
      row.cached_input_tokens === row.ledger_cached &&
      row.cache_usage_known === row.ledger_cache_known,
    'subscription_ledger',
  );
  return {
    row,
    snapshot,
    snapshotDigest: row.snapshot_digest,
  };
}

export function verifyCodexSubscriptionResult(
  result: HarnessExecutionResult,
  evidence: Awaited<ReturnType<typeof readCodexSubscriptionEvidence>>,
) {
  const billing = result as unknown as {
    billingMode: unknown;
    costBasis: unknown;
    estimatedCostCents: unknown;
    subscriptionSnapshotDigest: unknown;
  };
  check(
    result.provider === 'openai-codex' &&
      result.model === evidence.snapshot.model &&
      billing.billingMode === 'subscription' &&
      billing.costBasis === 'not_applicable' &&
      billing.estimatedCostCents === null &&
      billing.subscriptionSnapshotDigest === evidence.snapshotDigest &&
      result.costEstimateAvailable === false &&
      result.actualCostKnown === false &&
      result.usageComplete === true &&
      result.cacheUsageKnown === evidence.row.cache_usage_known &&
      Number.isSafeInteger(result.usage.inputTokens) &&
      result.usage.inputTokens > 0 &&
      Number.isSafeInteger(result.usage.outputTokens) &&
      result.usage.outputTokens > 0 &&
      result.usage.inputTokens === evidence.row.input_tokens &&
      result.usage.outputTokens === evidence.row.output_tokens &&
      result.usage.cachedInputTokens === evidence.row.cached_input_tokens,
    'subscription_result',
  );
  return {
    billingMode: 'subscription',
    costBasis: 'not_applicable',
    estimatedCostCents: null,
    subscriptionSnapshotDigest: evidence.snapshotDigest,
    usage: result.usage,
    usageComplete: result.usageComplete,
    cacheUsageKnown: result.cacheUsageKnown,
    actualCostKnown: result.actualCostKnown,
  };
}
