/** Independent acceptance checks; no provider calls and no price invention. */
import { createHash } from 'node:crypto';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import type {
  P27CodexWorkerFixture,
  P27PreparedCodexWorkerTask,
} from './p27-codex-worker-fixture.ts';
import { checkCodexAssistants as check } from './p27-codex-assistants-preflight.ts';
import {
  parseP27CodexJson,
  type P27CodexJsonObservation,
  type P27CodexJsonObserver,
} from './p27-codex-json.ts';

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
  return {
    row,
    snapshot,
    snapshotDigest: row.snapshot_digest,
    priceSnapshotCount: prices.prices,
    costReceiptCount: prices.receipts,
  };
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

type CodexAdmissionTotals = {
  runIds: string[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
};
const uuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );

/** Read actual per-dispatch settlement before fixture cleanup. Admission input
 * and granted output are reservations, not observed usage. No request bodies,
 * prompts, native transcripts, credentials or inferred token counts are read. */
export async function readCodexAssistantAdmissions(
  fixture: {
    db: CodexFixtureIdentity['db'];
    organizationId: string;
    workspaceId: string;
    ownerId: string;
  },
  task: { runId: string },
  expected: CodexAdmissionTotals,
) {
  check(
    expected.runIds.length === 3 &&
      expected.runIds.every(uuid) &&
      new Set(expected.runIds).size === 3 &&
      expected.runIds.includes(task.runId) &&
      Number.isSafeInteger(expected.modelCalls) &&
      expected.modelCalls >= 3 &&
      Number.isSafeInteger(expected.inputTokens) &&
      expected.inputTokens > 0 &&
      Number.isSafeInteger(expected.outputTokens) &&
      expected.outputTokens > 0,
    'model_admissions_unverified',
  );
  const rows = await fixture.db<
    {
      call_id: string;
      run_id: string;
      request_digest: string | null;
      dispatched: boolean;
      finished: boolean;
      identity_matches: boolean;
      model_calls: string | null;
      input_tokens: string | null;
      output_tokens: string | null;
    }[]
  >`select a.call_id,a.run_id,a.request_digest,
      a.dispatched_at is not null as dispatched,a.finished_at is not null as finished,
      exists (select 1 from allrice_assistant_instances i
        join allrice_runs r on r.id=i.root_run_id
        where i.run_id=a.run_id and i.root_run_id=a.root_run_id
          and r.organization_id=${fixture.organizationId}
          and r.workspace_id=${fixture.workspaceId} and r.owner_id=${fixture.ownerId}
      ) as identity_matches,
      calls.settled_amount::text as model_calls,
      input.settled_amount::text as input_tokens,
      output.settled_amount::text as output_tokens
    from allrice_assistant_model_admissions a
    left join allrice_assistant_usage calls on calls.call_id=a.call_id
      and calls.run_id=a.run_id and calls.root_run_id=a.root_run_id and calls.metric='model_calls'
    left join allrice_assistant_usage input on input.call_id=a.call_id
      and input.run_id=a.run_id and input.root_run_id=a.root_run_id and input.metric='input_tokens'
    left join allrice_assistant_usage output on output.call_id=a.call_id
      and output.run_id=a.run_id and output.root_run_id=a.root_run_id and output.metric='output_tokens'
    where a.root_run_id=${task.runId} order by a.call_id`;
  const actualTokens = (value: string | null) =>
    value !== null &&
    /^[1-9][0-9]*$/.test(value) &&
    Number.isSafeInteger(Number(value));
  check(
    rows.length === expected.modelCalls &&
      new Set(rows.map((row) => row.call_id)).size === rows.length &&
      rows.every(
        (row) =>
          uuid(row.call_id) &&
          expected.runIds.includes(row.run_id) &&
          row.identity_matches &&
          row.dispatched &&
          row.finished &&
          typeof row.request_digest === 'string' &&
          /^sha256:[a-f0-9]{64}$/.test(row.request_digest) &&
          row.model_calls === '1' &&
          actualTokens(row.input_tokens) &&
          actualTokens(row.output_tokens),
      ) &&
      expected.runIds.every((runId) =>
        rows.some((row) => row.run_id === runId),
      ),
    'model_admissions_unverified',
  );
  const admissions = rows.map((row) => ({
    call_id: row.call_id,
    run_id: row.run_id,
    dispatched: row.dispatched,
    finished: row.finished,
    request_digest: row.request_digest!,
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
  }));
  const input = admissions.reduce((sum, row) => sum + row.input_tokens, 0);
  const output = admissions.reduce((sum, row) => sum + row.output_tokens, 0);
  check(
    Number.isSafeInteger(input) &&
      Number.isSafeInteger(output) &&
      input === expected.inputTokens &&
      output === expected.outputTokens,
    'whole_tree_usage',
  );
  return admissions;
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
    usage.length > 0 &&
      usage.every(
        (row) =>
          row.settled_amount !== null &&
          Number.isSafeInteger(Number(row.settled_amount)) &&
          Number(row.settled_amount) >= 0 &&
          tree.instances.some((instance) => instance.runId === row.run_id),
      ),
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
          Number.isSafeInteger(totals[budget.metric]) &&
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
  const [unsettled] = await fixture.db<{ count: number }[]>`
    select ((select count(*) from allrice_assistant_usage
      where root_run_id=${task.runId} and settled_amount is null) +
      (select count(*) from allrice_runtime_reservations
      where root_run_id=${task.runId} and settled_amount is null))::int as count`;
  check(unsettled?.count === 0, 'first_usage_unverified');
  const admissions = await readCodexAssistantAdmissions(fixture, task, {
    runIds: tree.instances.map((item) => item.runId),
    modelCalls: totals.model_calls!,
    inputTokens: totals.input_tokens!,
    outputTokens: totals.output_tokens!,
  });
  return { tree, totals, admissions, unsettledUsageCount: unsettled.count };
}

/** Normalization of already checked observations, not a signed release receipt
 * or authentication of their provenance. Never use this to backfill old reports. */
export function codexSubscriptionAccountingProof(
  sourceSha: string,
  result: HarnessExecutionResult,
  evidence: Awaited<ReturnType<typeof readCodexSubscriptionEvidence>>,
  observed: Pick<
    Awaited<ReturnType<typeof verifiedTree>>,
    'totals' | 'admissions' | 'unsettledUsageCount'
  > & { tree: { instances: { runId: string; status: string }[] } },
) {
  check(/^[a-f0-9]{40}$/.test(sourceSha), 'subscription_identity');
  const { row, snapshot } = evidence;
  return {
    schema: 'allrice-p27-subscription-accounting/v1',
    sourceSha,
    runId: row.run_id,
    snapshot,
    snapshotDigest: evidence.snapshotDigest,
    route: {
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      sessionId: snapshot.sessionId,
      employeeId: row.employee_id,
      connectionId: row.model_connection_id,
      modelCatalogEntryId: row.model_catalog_entry_id,
      policyRevision: row.model_policy_revision,
      harness: row.harness,
      provider: row.provider,
      model: row.model,
      status: row.status,
      subscriptionSnapshotDigest: row.snapshot_digest,
      costCents: row.cost,
      usageComplete: row.usage_complete,
      cacheUsageKnown: row.cache_usage_known,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    },
    ledger: {
      routeDecisionId: row.ledger_route_decision_id,
      organizationId: row.ledger_organization_id,
      workspaceId: row.ledger_workspace_id,
      // The ledger has no run column; the immutable route FK supplies this ID.
      runId: row.run_id,
      status: row.ledger_status,
      costCents: row.ledger_cost,
      usageComplete: row.ledger_complete,
      cacheUsageKnown: row.ledger_cache_known,
      inputTokens: row.ledger_input,
      outputTokens: row.ledger_output,
    },
    result: {
      provider: result.provider,
      model: result.model,
      assistantStatus: result.assistantStatus,
      billingMode: result.billingMode,
      costBasis: result.costBasis,
      estimatedCostCents: result.estimatedCostCents,
      subscriptionSnapshotDigest: result.subscriptionSnapshotDigest,
      costEstimateAvailable: result.costEstimateAvailable,
      actualCostKnown: result.actualCostKnown,
      usageComplete: result.usageComplete,
      cacheUsageKnown: result.cacheUsageKnown,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    tree: {
      status: observed.tree.instances.every(
        (item) => item.status === 'completed',
      )
        ? 'completed'
        : 'unknown',
      runIds: observed.tree.instances.map((item) => item.runId),
      modelCalls: observed.totals.model_calls,
      inputTokens: observed.totals.input_tokens,
      outputTokens: observed.totals.output_tokens,
      unsettledUsageCount: observed.unsettledUsageCount,
    },
    admissions: observed.admissions.map((row) => ({
      callId: row.call_id,
      runId: row.run_id,
      requestDigest: row.request_digest,
      dispatched: row.dispatched,
      finished: row.finished,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    })),
    priceSnapshotCount: evidence.priceSnapshotCount,
    costReceiptCount: evidence.costReceiptCount,
  };
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
  observe?: P27CodexJsonObserver,
  exportOptions?: { sourceSha: string },
) {
  const evidence = await readCodexSubscriptionEvidence(fixture, task);
  const accounting = verifyCodexSubscriptionResult(result, evidence, true);
  const observed = await verifiedTree(fixture, task);
  const { tree, totals, admissions } = observed;
  check(
    result.usage.inputTokens === totals.input_tokens &&
      result.usage.outputTokens === totals.output_tokens,
    'whole_tree_usage',
  );
  const parseDiagnostics: P27CodexJsonObservation[] = [];
  const record: P27CodexJsonObserver = (entry) => {
    parseDiagnostics.push(entry);
    observe?.(entry);
  };
  const artifacts = [];
  for (const item of tree.results)
    artifacts.push(
      await verifyCodexAssistantArtifact(fixture, task, item, record),
    );
  const { value: answer } = parseP27CodexJson(
    result.answer,
    'parent_answer',
    record,
  );
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
    ...(exportOptions
      ? {
          subscriptionAccountingProof: codexSubscriptionAccountingProof(
            exportOptions.sourceSha,
            result,
            evidence,
            observed,
          ),
        }
      : {}),
    artifacts,
    parseDiagnostics,
    answerDigest: hash(result.answer),
    wholeWorkerProjectionVerified: true,
  };
}

/** The same production publication/read/ownership boundary as the live smoke;
 * independently callable with synthetic PG artifacts, without any model. */
export async function verifyCodexAssistantArtifact(
  fixture: Pick<CodexFixtureIdentity, 'db' | 'context'> & {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
  },
  task: { runId: string; sessionId: string },
  item: {
    runId: string;
    deliveryId: string;
    evidence: { id: string; digest: string }[];
  },
  observe?: P27CodexJsonObserver,
) {
  const [{ LocalStorageAdapter }, { getWorkbenchArtifact, readArtifactBytes }] =
    await Promise.all([
      import('../../../packages/storage/src/index.ts'),
      import('../../../packages/database/src/artifact-review.ts'),
    ]);
  const storage = new LocalStorageAdapter(process.env.ALLRICE_STORAGE_ROOT!);
  check(item.evidence.length === 1, 'artifacts_unverified');
  const ref = item.evidence[0]!;
  const parseDiagnostics: P27CodexJsonObservation[] = [];
  const record: P27CodexJsonObserver = (entry) => {
    const correlated = Object.freeze({
      ...entry,
      artifactId: ref.id,
      childRunId: item.runId,
      deliveryId: item.deliveryId,
    });
    parseDiagnostics.push(correlated);
    observe?.(correlated);
  };
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
      artifact.provenance.runId === item.runId &&
      artifact.provenance.stepId === item.deliveryId,
    'artifacts_unverified',
  );
  const { value: content } = parseP27CodexJson(
    Buffer.from(bytes).toString('utf8'),
    'artifact_envelope',
    record,
  );
  check(
    content.version === 1 &&
      content.kind === 'assistant_generated' &&
      content.independentlyVerified === false &&
      typeof content.name === 'string' &&
      content.name.length > 0 &&
      content.rootRunId === task.runId &&
      content.childRunId === item.runId &&
      content.deliveryId === item.deliveryId,
    'artifacts_unverified',
  );
  const { value } = parseP27CodexJson(content.content, 'child_report', record);
  check(
    value.case === 'A'
      ? value.totalCents === 875 && value.rows === 2
      : value.case === 'B' &&
          value.invoiceCents === 1900 &&
          value.paidCents === 1300 &&
          value.outstandingCents === 600,
    'child_arithmetic',
  );
  return {
    id: ref.id,
    digest: ref.digest,
    case: value.case as 'A' | 'B',
    parseDiagnostics,
  };
}
