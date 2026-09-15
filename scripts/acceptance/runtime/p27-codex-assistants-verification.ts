/** Independent acceptance checks; no provider calls and no price invention. */
import { createHash } from 'node:crypto';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import type {
  P27CodexWorkerFixture,
  P27PreparedCodexWorkerTask,
} from './p27-codex-worker-fixture.ts';
import { checkCodexAssistants as check } from './p27-codex-assistants-preflight.ts';

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
const hash = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

export async function readCodexSubscriptionEvidence(
  fixture: CodexFixtureIdentity,
  task: P27PreparedCodexWorkerTask,
) {
  const [
    {
      AssistantSubscriptionSnapshotSchema,
      resolveAssistantSubscriptionSnapshot,
    },
    { runtimePolicyDigest },
  ] = await Promise.all([
    import('../../../packages/contracts/src/assistant-subscription.ts'),
    import('../../../packages/database/src/runtime-policy.ts'),
  ]);
  const rows = await fixture.db<
    {
      id: string;
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
      snapshot: unknown;
      snapshot_digest: string;
    }[]
  >`
    select d.id,d.provider,d.model,d.harness,d.status,d.employee_id,
      d.model_connection_id,d.model_catalog_entry_id,d.model_policy_revision,
      d.input_tokens,d.output_tokens,d.cached_input_tokens,d.cost_cents::text as cost,
      d.usage_complete,d.cache_usage_known,
      l.input_tokens as ledger_input,l.output_tokens as ledger_output,
      l.cached_input_tokens as ledger_cached,l.cost_cents::text as ledger_cost,
      l.usage_complete as ledger_complete,l.cache_usage_known as ledger_cache_known,
      l.status as ledger_status,s.snapshot,s.snapshot_digest
    from allrice_route_decisions d
    join allrice_model_usage_ledger l on l.route_decision_id=d.id
      and l.organization_id=d.organization_id
      and l.connection_id=d.model_connection_id
      and l.model_catalog_entry_id=d.model_catalog_entry_id
    join allrice_route_subscription_snapshots s on s.route_decision_id=d.id
    where d.run_id=${task.runId} and d.organization_id=${fixture.organizationId}
      and d.workspace_id=${fixture.workspaceId} and d.actor_id=${fixture.ownerId}`;
  check(rows.length === 1, 'subscription_snapshot');
  const row = rows[0]!;
  const snapshot = AssistantSubscriptionSnapshotSchema.parse(row.snapshot);
  const expected = resolveAssistantSubscriptionSnapshot({
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
      snapshot.model === 'gpt-5.6-luna',
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
  const [prices] = await fixture.db<
    { prices: number; receipts: number; routes: number }[]
  >`
    select (select count(*)::int from allrice_assistant_price_snapshots
      where root_run_id=${task.runId}) as prices,
      (select count(*)::int from allrice_assistant_cost_receipts
      where root_run_id=${task.runId}) as receipts,
      (select count(*)::int from allrice_route_decisions where run_id=${task.runId}
        and organization_id=${fixture.organizationId}) as routes`;
  check(
    prices?.prices === 0 && prices.receipts === 0 && prices.routes === 1,
    'subscription_price_rows',
  );
  return { row, snapshot, snapshotDigest: row.snapshot_digest };
}

export function verifyCodexSubscriptionResult(
  result: HarnessExecutionResult,
  evidence: Awaited<ReturnType<typeof readCodexSubscriptionEvidence>>,
  assistants: boolean,
) {
  const billing = result as unknown as {
    billingMode: unknown;
    costBasis: unknown;
    estimatedCostCents: unknown;
    subscriptionSnapshotDigest: unknown;
  };
  check(
    result.provider === 'openai-codex' &&
      result.model === 'gpt-5.6-luna' &&
      billing.billingMode === 'subscription' &&
      billing.costBasis === 'not_applicable' &&
      billing.estimatedCostCents === null &&
      billing.subscriptionSnapshotDigest === evidence.snapshotDigest &&
      result.costEstimateAvailable === false &&
      result.actualCostKnown === false &&
      result.costCurrency === undefined &&
      result.priceSnapshotDigest === undefined &&
      result.usageComplete === true &&
      result.cacheUsageKnown === evidence.row.cache_usage_known &&
      Number.isSafeInteger(result.usage.inputTokens) &&
      result.usage.inputTokens > 0 &&
      Number.isSafeInteger(result.usage.outputTokens) &&
      result.usage.outputTokens > 0 &&
      result.usage.inputTokens === evidence.row.input_tokens &&
      result.usage.outputTokens === evidence.row.output_tokens &&
      result.usage.cachedInputTokens === evidence.row.cached_input_tokens &&
      (assistants
        ? result.assistantStatus === 'completed'
        : result.assistantStatus === undefined),
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

async function verifiedTree(
  fixture: CodexFixtureIdentity,
  task: P27PreparedCodexWorkerTask,
) {
  const [{ createAssistantRuntime }, { assertAssistantAuthority }] =
    await Promise.all([
      import('../../../packages/database/src/assistant-runtime.ts'),
      import('../../../packages/database/src/assistant-authority.ts'),
    ]);
  const tree = await createAssistantRuntime({
    database: fixture.db,
    authorize: assertAssistantAuthority,
  }).getTree(fixture.context, { runId: task.runId });
  const children = tree.instances.filter(
    (item) => item.parentRunId === task.runId,
  );
  check(
    tree.instances.length === 3 &&
      children.length === 2 &&
      !tree.cancelRequested &&
      tree.instances.every((item) => item.status === 'completed') &&
      children.every(
        (item) =>
          item.depth === 1 &&
          item.allowedTools.length === 1 &&
          item.allowedTools[0] === 'assistant.report',
      ) &&
      tree.results.length === 2 &&
      tree.results.every(
        (item) =>
          item.status === 'completed' &&
          item.evidence.length === 1 &&
          item.incomplete.length === 0 &&
          item.parentAdoptedSeq !== null,
      ) &&
      tree.messages.length === 2 &&
      tree.messages.every(
        (item) =>
          item.status === 'adopted' &&
          item.nativeMessageId !== null &&
          item.adoptedSeq !== null,
      ),
    'first_tree_unverified',
  );
  const usage = await fixture.db<
    {
      run_id: string;
      metric: string;
      amount: string;
      settled_amount: string | null;
    }[]
  >`select run_id,metric,amount,settled_amount from allrice_assistant_usage
    where root_run_id=${task.runId}`;
  check(
    usage.length > 0 && usage.every((row) => row.settled_amount !== null),
    'first_usage_unverified',
  );
  const totals = Object.fromEntries(
    tree.budgets.map((budget) => [
      budget.metric,
      usage
        .filter((row) => row.metric === budget.metric)
        .reduce((sum, row) => sum + Number(row.settled_amount), 0),
    ]),
  );
  check(
    tree.budgets.length === 4 &&
      tree.budgets.every(
        (budget) =>
          budget.currency === null &&
          budget.reserved === 0 &&
          budget.usageComplete &&
          totals[budget.metric] === budget.spent,
      ) &&
      tree.instances.every((instance) =>
        ['model_calls', 'input_tokens', 'output_tokens'].every((metric) =>
          usage.some(
            (row) =>
              row.run_id === instance.runId &&
              row.metric === metric &&
              Number(row.settled_amount) > 0,
          ),
        ),
      ),
    'whole_tree_usage',
  );
  // Soft token caps may be exceeded by a final provider response. Actual observed
  // usage must remain complete; do not rewrite an overrun as zero/unknown.
  const admissions = await fixture.db<
    {
      call_id: string;
      run_id: string;
      dispatched: boolean;
      finished: boolean;
    }[]
  >`select call_id,run_id,dispatched_at is not null as dispatched,
    finished_at is not null as finished from allrice_assistant_model_admissions
    where root_run_id=${task.runId}`;
  check(
    admissions.length === totals.model_calls &&
      admissions.every((row) => row.dispatched && row.finished) &&
      tree.instances.every((instance) =>
        admissions.some((row) => row.run_id === instance.runId),
      ),
    'model_admissions_unverified',
  );
  return { tree, totals, admissions: [...admissions] };
}

/** Used again by fixture before it even prepares a follow-up ordinary job. */
export async function verifyCodexAssistantTerminal(
  fixture: CodexFixtureIdentity,
  task: P27PreparedCodexWorkerTask,
) {
  const [terminal] = await fixture.db<{ run: string; job: string }[]>`
    select r.state as run,j.status as job from allrice_runs r
      join allrice_jobs j on j.run_id=r.id
    where r.id=${task.runId} and r.organization_id=${fixture.organizationId}
      and r.workspace_id=${fixture.workspaceId} and r.owner_id=${fixture.ownerId}`;
  check(
    terminal?.run === 'succeeded' && terminal.job === 'succeeded',
    'first_not_terminal',
  );
  const evidence = await readCodexSubscriptionEvidence(fixture, task);
  const { tree, totals } = await verifiedTree(fixture, task);
  check(
    evidence.row.input_tokens === totals.input_tokens &&
      evidence.row.output_tokens === totals.output_tokens,
    'whole_tree_usage',
  );
  return { evidence, tree, totals };
}

export async function verifyCodexAssistantExecution(
  fixture: CodexFixtureIdentity,
  task: P27PreparedCodexWorkerTask,
  result: HarnessExecutionResult,
) {
  const evidence = await readCodexSubscriptionEvidence(fixture, task);
  const accounting = verifyCodexSubscriptionResult(result, evidence, true);
  const { tree, totals, admissions } = await verifiedTree(fixture, task);
  check(
    result.usage.inputTokens === totals.input_tokens &&
      result.usage.outputTokens === totals.output_tokens,
    'whole_tree_usage',
  );
  const [{ LocalStorageAdapter }, { getWorkbenchArtifact, readArtifactBytes }] =
    await Promise.all([
      import('../../../packages/storage/src/index.ts'),
      import('../../../packages/database/src/artifact-review.ts'),
    ]);
  const storage = new LocalStorageAdapter(process.env.ALLRICE_STORAGE_ROOT!);
  const artifacts: { id: string; digest: string; case: string }[] = [];
  for (const item of tree.results) {
    const ref = item.evidence[0]!;
    const artifact = await getWorkbenchArtifact(
      fixture.context,
      task.sessionId,
      ref.id,
      fixture.db,
    );
    const bytes = await readArtifactBytes(storage, artifact.object, 140000);
    check(
      artifact.object.immutable &&
        artifact.object.checksum === ref.digest &&
        hash(bytes) === ref.digest &&
        artifact.object.organizationId === fixture.organizationId &&
        artifact.object.workspaceId === fixture.workspaceId &&
        artifact.object.ownerId === fixture.ownerId &&
        artifact.version.sessionId === task.sessionId &&
        artifact.provenance.runId === item.runId,
      'artifacts_unverified',
    );
    const content = JSON.parse(Buffer.from(bytes).toString('utf8'));
    check(
      content.kind === 'assistant_generated' &&
        content.rootRunId === task.runId &&
        content.childRunId === item.runId &&
        content.deliveryId === item.deliveryId,
      'artifacts_unverified',
    );
    const value = JSON.parse(content.content);
    check(
      value.case === 'A'
        ? value.totalCents === 875 && value.rows === 2
        : value.case === 'B' &&
            value.invoiceCents === 1900 &&
            value.paidCents === 1300 &&
            value.outstandingCents === 600,
      'child_arithmetic',
    );
    artifacts.push({ id: ref.id, digest: ref.digest, case: value.case });
  }
  const answer = JSON.parse(result.answer);
  check(
    new Set(artifacts.map((item) => item.case)).size === 2 &&
      answer.salesTotalCents === 875 &&
      answer.outstandingCents === 600 &&
      answer.reports === 2,
    'parent_arithmetic',
  );
  return {
    accounting,
    ledger: evidence.row,
    budgets: tree.budgets,
    admissions,
    artifacts,
    answerDigest: hash(result.answer),
    wholeWorkerProjectionVerified: true,
  };
}
