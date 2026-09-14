/** Opt-in, at most TWO real Worker executions; never starts worker/index.
 * Run with TSX_TSCONFIG_PATH=<candidate>/tsconfig.base.json so the production
 * package aliases and fixture use the SAME isolated source database singleton.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import type { AssistantFailureDiagnostics } from '../../../apps/worker/src/harness/dsh/assistant-diagnostics.ts';
import type {
  P27PreparedWorkerTask,
  P27WorkerFixture,
} from './p27-worker-fixture.ts';
import { observeP27Clients } from './p27-owned-clients.ts';
import { collectP27InstalledRuntime } from './p27-installed-runtime.ts';
import { p27ErrorDiagnostics } from './p27-error-diagnostics.ts';
import {
  correlateP27AssistantDiagnostics,
  retainP27AssistantDiagnostics,
  type P27DiagnosticAdmission,
  type P27DiagnosticReceipt,
} from './p27-assistant-diagnostics.ts';
import {
  assertP27PriceDate,
  P27_GEMINI_RUN_LIMITS,
  P27_GEMINI_PRICE_FACTS_DIGEST,
  verifyP27PricingReceipts,
  type P27CostReceipt,
  type P27PricedAdmission,
} from './p27-assistant-pricing.ts';
import {
  authorizedGeminiCredentialFile,
  prepareP27PlatformEnvironment,
  providerExecutionEligibility,
  selectedProvider,
  readCandidate,
  requireCheck,
} from './p27-assistant-preflight.ts';
import {
  authorizeP27Worker,
  boundedP27Wait,
  maintainP27Lease,
  parseP27WorkerArguments,
  P27_ORDINARY_PRICING,
  runP27WorkerSequence,
  workerFixtureCleanupConfirmed,
} from './p27-worker-preflight.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const hash = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const check: typeof requireCheck = requireCheck;
const sourceFiles = [
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'apps/worker/src/jobs/employee-run.ts',
  'apps/worker/src/model-cost.ts',
  'apps/worker/src/assistant-pricing-preflight.ts',
  'apps/worker/src/harness/dsh-adapter.ts',
  'apps/worker/src/harness/dsh/assistant-controller.ts',
  'apps/worker/src/harness/dsh/assistant-diagnostics.ts',
  'apps/worker/dsh/allrice-assistant-runtime.mjs',
  'apps/worker/dsh/allrice-restricted.cordis.yml',
  'packages/database/src/assistant-pricing.ts',
  'packages/database/src/execution/queue.ts',
  'packages/database/src/providers/model-governance.ts',
  ...[
    'worker-smoke',
    'worker-fixture',
    'worker-preflight',
    'assistant-preflight',
    'assistant-pricing',
    'assistant-diagnostics',
    'error-diagnostics',
    'owned-clients',
    'installed-runtime',
  ].map((name) => `scripts/acceptance/runtime/p27-${name}.ts`),
];
const assistantPrompt = `Synthetic acceptance only. Use actual assistant_delegate exactly twice, with each child's tools limited to ["assistant.report"]. Delegate A and B before synthesizing; no other delegation or external tools. A computes totalCents for [{units:3,unitPriceCents:125},{units:2,unitPriceCents:250}] and row count. A must call assistant_report once with status "completed", accurate summary, evidence [], incomplete [], output {name:"report",content:<JSON string with case:"A",totalCents,rows>}. B computes invoice/payment totals from [{invoiceCents:1000,paidCents:400},{invoiceCents:900,paidCents:900}]. B must call assistant_report once with status "completed", accurate summary, evidence [], incomplete [], output {name:"report",content:<JSON string with case:"B",invoiceCents,paidCents,outstandingCents>}. The platform attaches real immutable evidence. Wait for both actual reports and consume them. Parent must not call assistant_report, invent IDs or fabricate success. Parent final response ONLY JSON {salesTotalCents:<A total>,outstandingCents:<B total>,reports:2}. If a child fails, report failure instead.`;
const ordinaryPrompt =
  'Synthetic arithmetic only. Do not use tools or delegates. Return ONLY JSON with key sum equal to 123 + 456. No markdown.';

export async function mainP27Worker(argsInput = process.argv.slice(2)) {
  const args = parseP27WorkerArguments(argsInput);
  readCandidate(root, args.sha);
  check(
    process.env.TSX_TSCONFIG_PATH === join(root, 'tsconfig.base.json'),
    'worker_source_alias_required',
  );
  assertP27PriceDate(new Date().toISOString());
  const sources = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        hash(await readFile(join(root, file))),
      ]),
    ),
  );
  const installedRuntime = await collectP27InstalledRuntime(root);
  check(
    providerExecutionEligibility(selectedProvider('gemini')).eligible,
    'worker_provider_bound_unavailable',
  );
  const report: Record<string, unknown> = {
    version: 1,
    candidateSha: args.sha,
    sources,
    installedRuntime,
    status: 'preflight_only',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    assistantBounds: P27_GEMINI_RUN_LIMITS,
    sourceFactsDigest: P27_GEMINI_PRICE_FACTS_DIGEST,
    ordinaryBounds: {
      ...P27_GEMINI_RUN_LIMITS,
      pricing: P27_ORDINARY_PRICING,
      scope:
        'legacy_post_result_estimator_not_assistant_receipts_not_invoice_or_hard_total_spend_cap',
    },
    executionLimit: 2,
    credentialBytesReadByDriver: false,
    excluded: [
      'provider_invoice',
      'unreported_provider_internal_retries',
      'bridge_and_signed_release',
      'P27_four_task_lines',
      'GA',
    ],
  };
  if (args.mode === '--preflight') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  authorizeP27Worker(process.env, args.sha);
  const credentialFile = await authorizedGeminiCredentialFile(
    process.env.ALLRICE_B6_P27_WORKER_GEMINI_CREDENTIAL_FILE,
  );
  const evidenceDirectory = join(root, '.local', `p27-worker-${randomUUID()}`);
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p27-worker-')),
  );
  let fixture: P27WorkerFixture | undefined;
  let fixtureAttempted = false;
  let fixtureCleanupVerified = false;
  let clients: ReturnType<typeof observeP27Clients> | undefined;
  let closeAdapters: (() => Promise<void>) | undefined;
  let activeTask: P27PreparedWorkerTask | undefined;
  let nativeDiagnostics: AssistantFailureDiagnostics | undefined;
  let execution: Promise<unknown> | undefined;
  let executionSettled = true;
  let executeCount = 0;
  let abort: AbortController | undefined;
  const releases: (() => Promise<unknown>)[] = [];
  const leaseStops: (() => Promise<unknown>)[] = [];
  const isolationCleanup: (() => Promise<void>)[] = [];
  const originalConsole = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  let suppressedLogs = 0;
  // Worker failure logs can contain upstream text. Retain counts, never bytes.
  console.error =
    console.warn =
    console.log =
      () => {
        suppressedLogs++;
      };
  const save = () =>
    writeFile(
      join(evidenceDirectory, 'result.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  report.status = 'running';
  report.startedAt = new Date().toISOString();
  try {
    report.phase = 'private_environment';
    const environment = await prepareP27PlatformEnvironment({
      environment: process.env,
      temporary,
      providerRoute: 'gemini',
      credentialFile,
    });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment, {
      TSX_TSCONFIG_PATH: join(root, 'tsconfig.base.json'),
      ALLRICE_DSH_RUNTIME_COMMAND: process.execPath,
      ALLRICE_DSH_RUNTIME_ARGS: JSON.stringify([
        join(root, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs'),
      ]),
      ALLRICE_DSH_CORDIS_CONFIG: join(
        root,
        'apps/worker/dsh/allrice-restricted.cordis.yml',
      ),
      ALLRICE_DSH_RUNTIME_ROOT: join(temporary, 'runtime'),
      ALLRICE_DSH_REQUEST_TIMEOUT_MS: String(P27_GEMINI_RUN_LIMITS.timeoutMs),
      ALLRICE_STORAGE_ROOT: join(temporary, 'storage'),
      ALLRICE_MODEL_PRICING_JSON: JSON.stringify(P27_ORDINARY_PRICING),
      ALLRICE_ASSISTANT_PRICING_CURRENCY: 'USD',
    });
    report.phase = 'worker_fixture_prepare';
    const { createP27WorkerFixture } = await import('./p27-worker-fixture.ts');
    fixtureAttempted = true;
    fixture = await createP27WorkerFixture();
    process.env.ALLRICE_ASSISTANT_PRICING_JSON = JSON.stringify(
      fixture.pricingCatalog,
    );
    report.schema = fixture.schema;
    report.organizationId = fixture.organizationId;
    const [
      { executeEmployeeRun },
      router,
      { DshProtocolClient },
      api,
      { prepareExecutionIsolation },
      { HarnessEventBatcher },
      { normalizeHarnessRunEvent },
    ] = await Promise.all([
      import('../../../apps/worker/src/jobs/employee-run.ts'),
      import('../../../apps/worker/src/harness/router.ts'),
      import('../../../apps/worker/src/harness/dsh-protocol-client.ts'),
      import('../../../packages/database/src/index.ts'),
      import('../../../apps/worker/src/isolation.ts'),
      import('../../../apps/worker/src/harness/delta-batcher.ts'),
      import('../../../apps/worker/src/harness/runtime-contract.ts'),
    ]);
    clients = observeP27Clients(DshProtocolClient);
    closeAdapters = router.closeHarnessAdapters;
    const { db } = fixture;
    async function run(task: P27PreparedWorkerTask, assistants: boolean) {
      activeTask = task;
      nativeDiagnostics = undefined;
      check(executeCount < 2, 'worker_execution_count');
      abort = new AbortController();
      const { workflowLease: lease, execution: claimed } = task;
      const heartbeat = maintainP27Lease({
        heartbeat: () =>
          api.heartbeatJob(
            lease.workerId,
            lease.jobId,
            lease.leaseToken,
            lease.leaseMs,
          ),
        abort,
      });
      leaseStops.push(() => heartbeat.stop());
      const isolation = await prepareExecutionIsolation({
        root: join(temporary, 'work'),
        organizationId: fixture!.organizationId,
        workspaceId: fixture!.workspaceId,
        ownerId: fixture!.ownerId,
        runId: task.runId,
        jobId: lease.jobId,
        attempt: claimed.job.attempt,
      });
      isolationCleanup.push(isolation.cleanup);
      const batcher = new HarnessEventBatcher((event) => {
        const normalized = normalizeHarnessRunEvent(event);
        return api.appendJobEvent({ ...lease, ...normalized }).then(() => {});
      });
      releases.push(() => batcher.close());
      report.phase = assistants
        ? 'assistant_worker_execute'
        : 'ordinary_worker_execute';
      report.activeRunId = task.runId;
      await save();
      executeCount++;
      executionSettled = false;
      const pending = executeEmployeeRun({
        execution: claimed,
        isolation,
        signal: abort.signal,
        onHarnessEvent: (event) => batcher.accept(event),
        workflowLease: lease,
      });
      execution = pending.finally(() => {
        executionSettled = true;
      });
      execution.catch(() => {});
      const result = await boundedP27Wait(
        pending,
        fixture!.runLimits.timeoutMs,
      );
      nativeDiagnostics = retainP27AssistantDiagnostics(
        nativeDiagnostics,
        result,
      );
      await batcher.flush();
      check(!abort.signal.aborted, 'worker_execution_aborted');
      report.phase = assistants
        ? 'assistant_ledger_verify'
        : 'ordinary_ledger_verify';
      check(
        'provider' in result && 'model' in result,
        'worker_model_not_invoked',
      );
      const proof = assistants
        ? await verifyAssistant(fixture!, task, result)
        : await verifyOrdinary(fixture!, task, result);
      check((await heartbeat.stop()).healthy, 'worker_lease_lost');
      await api.completeJob({ ...lease, result });
      const [terminal] = await db<
        { state: string; status: string }[]
      >`select r.state,j.status from allrice_runs r join allrice_jobs j on j.run_id=r.id where r.id=${task.runId}`;
      check(
        terminal?.state === 'succeeded' && terminal.status === 'succeeded',
        'worker_terminal_success',
      );
      const quota = await api.getOrganizationModelQuota(
        fixture!.organizationId,
      );
      check(
        quota.usedRuns === executeCount &&
          quota.unknownCostRuns === 0 &&
          quota.usageComplete &&
          quota.usedCostCents !== null &&
          quota.usedCostCents > 0,
        'worker_followup_quota_known',
      );
      api.assertQuotaAvailable(quota);
      const [ledgerTotal] = await db<
        { cost: string; tokens: string }[]
      >`select sum(cost_cents)::text as cost,sum(input_tokens+output_tokens)::text as tokens from allrice_model_usage_ledger where organization_id=${fixture!.organizationId}`;
      check(
        quota.usedCostCents === Number(ledgerTotal?.cost) &&
          quota.usedTokens === Number(ledgerTotal?.tokens),
        'worker_quota_matches_ledger',
      );
      report[assistants ? 'assistant' : 'ordinary'] = {
        runId: task.runId,
        ...proof,
        quota: {
          usedRuns: quota.usedRuns,
          usedTokens: quota.usedTokens,
          usedCostCents: quota.usedCostCents,
          unknownCostRuns: quota.unknownCostRuns,
          usageComplete: quota.usageComplete,
          cacheUsageKnown: quota.cacheUsageKnown,
        },
      };
      activeTask = undefined;
      return task.runId;
    }
    await runP27WorkerSequence({
      assistant: async () =>
        run(await fixture!.prepareAssistantTask(assistantPrompt), true),
      ordinary: async (afterRunId) => {
        await run(
          await fixture!.prepareOrdinaryTask({
            afterRunId,
            prompt: ordinaryPrompt,
          }),
          false,
        );
      },
    });
    check(executeCount === 2, 'worker_exact_two_executions');
    readCandidate(root, args.sha);
    check(
      JSON.stringify(await collectP27InstalledRuntime(root)) ===
        JSON.stringify(installedRuntime),
      'worker_installed_runtime_unchanged',
    );
    report.status = 'passed_pending_cleanup';
  } catch (error) {
    abort?.abort();
    if (fixtureAttempted && !fixture) {
      const { P27WorkerFixtureError } = await import('./p27-worker-fixture.ts');
      if (error instanceof P27WorkerFixtureError && error.cleanup) {
        report.fixtureCleanup = error.cleanup;
        fixtureCleanupVerified = workerFixtureCleanupConfirmed(error.cleanup);
      }
    }
    nativeDiagnostics = retainP27AssistantDiagnostics(nativeDiagnostics, error);
    report.status = 'failed';
    report.error = p27ErrorDiagnostics(error);
  } finally {
    abort?.abort();
    // Never renew a lease forever when native close or execution stalls.
    // stop() clears its timer synchronously, then waits for the one owned query.
    let leasesStopped = true;
    for (const stop of leaseStops) {
      try {
        await boundedP27Wait(stop(), 5000);
      } catch {
        leasesStopped = false;
      }
    }
    // Stop/close actual native hosts before touching schema, storage or temp.
    let nativeStopped = !clients;
    try {
      await boundedP27Wait(
        Promise.all([closeAdapters?.(), clients?.closeAll()]),
        10000,
      );
      if (execution)
        await boundedP27Wait(
          execution.catch(() => {}),
          10000,
        );
      await boundedP27Wait(clients?.closeAll() ?? Promise.resolve(), 10000);
      nativeStopped = !clients || clients.snapshot().allStopped;
    } catch {
      nativeStopped = false;
    }
    let resourcesClosed =
      !fixtureAttempted || !!fixture || fixtureCleanupVerified;
    if (nativeStopped && executionSettled && leasesStopped) {
      for (const release of releases) {
        try {
          await boundedP27Wait(release(), 5000);
        } catch {
          resourcesClosed = false;
        }
      }
      if (fixture && activeTask) {
        const finalization = {
          snapshotCaptured: false,
          jobTerminalConfirmed: false,
        };
        report.failureFinalization = finalization;
        try {
          report.failureSnapshot = await workerFailureSnapshot(
            fixture,
            activeTask,
            nativeDiagnostics,
          );
          finalization.snapshotCaptured = true;
        } catch {
          report.failureSnapshotIncomplete = true;
        }
        try {
          const { failJob } =
            await import('../../../packages/database/src/execution/queue.ts');
          await failJob({
            ...activeTask.workflowLease,
            code: 'P27_WORKER_SMOKE_FAILED',
            message: 'Bounded Worker acceptance did not complete',
            retryable: false,
          });
          const [terminal] = await fixture.db<
            { state: string; status: string }[]
          >`select r.state,j.status from allrice_runs r join allrice_jobs j on j.run_id=r.id where r.id=${activeTask.runId}`;
          finalization.jobTerminalConfirmed =
            !!terminal &&
            ['failed', 'canceled', 'timed_out'].includes(terminal.state) &&
            ['failed', 'canceled', 'timed_out'].includes(terminal.status);
        } catch {
          report.failureJobFinalizationUnconfirmed = true;
        }
      }
      for (const cleanup of isolationCleanup) {
        try {
          await cleanup();
        } catch {
          resourcesClosed = false;
        }
      }
      if (fixture) {
        try {
          const proof = await boundedP27Wait(fixture.close(), 10000);
          report.fixtureCleanup = proof;
          fixtureCleanupVerified = workerFixtureCleanupConfirmed(proof);
          resourcesClosed &&= fixtureCleanupVerified;
        } catch (error) {
          const { P27WorkerFixtureError } =
            await import('./p27-worker-fixture.ts');
          if (error instanceof P27WorkerFixtureError && error.cleanup)
            report.fixtureCleanup = error.cleanup;
          resourcesClosed = false;
        }
      }
      clients?.restore();
    } else resourcesClosed = false;
    if (resourcesClosed)
      await rm(temporary, { recursive: true, force: true }).catch(() => {
        resourcesClosed = false;
      });
    report.cleanup = {
      nativeStopped,
      executionSettled,
      leasesStopped,
      resourcesClosed,
      clients: clients?.snapshot() ?? null,
    };
    if (!resourcesClosed) {
      report.status = 'cleanup_blocked';
      report.retainedTemporary = temporary;
    } else if (report.status === 'passed_pending_cleanup')
      report.status = 'passed';
    report.executeCount = executeCount;
    report.finishedAt = new Date().toISOString();
    report.suppressedConsoleRecords = suppressedLogs;
    Object.assign(console, originalConsole);
    await save();
    process.stdout.write(
      `${JSON.stringify({ status: report.status, evidenceDirectory, executeCount, cleanup: report.cleanup })}\n`,
    );
    if (report.status !== 'passed') process.exitCode = 1;
  }
}

async function routeLedger(
  fixture: P27WorkerFixture,
  task: P27PreparedWorkerTask,
  result: HarnessExecutionResult,
) {
  const rows = await fixture.db<
    {
      id: string;
      provider: string;
      model: string;
      status: string;
      cost: string | null;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      usage_complete: boolean;
      cache_usage_known: boolean;
      ledger_cost: string | null;
      ledger_complete: boolean;
      ledger_status: string;
      ledger_input_tokens: number;
      ledger_output_tokens: number;
      ledger_cached_input_tokens: number;
      ledger_cache_usage_known: boolean;
      connection_id: string;
      model_catalog_entry_id: string;
    }[]
  >`
    select d.id,d.provider,d.model,d.status,d.cost_cents::text as cost,d.input_tokens,d.output_tokens,d.cached_input_tokens,d.usage_complete,d.cache_usage_known,
      l.cost_cents::text as ledger_cost,l.usage_complete as ledger_complete,l.connection_id,l.model_catalog_entry_id,
      l.status as ledger_status,l.input_tokens as ledger_input_tokens,l.output_tokens as ledger_output_tokens,
      l.cached_input_tokens as ledger_cached_input_tokens,l.cache_usage_known as ledger_cache_usage_known
    from allrice_route_decisions d join allrice_model_usage_ledger l on l.route_decision_id=d.id
    where d.run_id=${task.runId} and d.organization_id=${fixture.organizationId} and l.organization_id=d.organization_id`;
  const row = rows[0];
  check(
    rows.length === 1 &&
      row &&
      row.provider === 'gemini' &&
      row.model === 'gemini-3.8-flash' &&
      row.connection_id === fixture.connectionId &&
      row.model_catalog_entry_id === fixture.catalogId &&
      row.status === 'succeeded' &&
      row.ledger_status === 'succeeded' &&
      row.usage_complete &&
      row.ledger_complete &&
      row.cost !== null &&
      row.cost === row.ledger_cost &&
      Number(row.cost) > 0 &&
      row.input_tokens === result.usage.inputTokens &&
      row.output_tokens === result.usage.outputTokens &&
      row.cached_input_tokens === result.usage.cachedInputTokens &&
      row.ledger_input_tokens === row.input_tokens &&
      row.ledger_output_tokens === row.output_tokens &&
      row.ledger_cached_input_tokens === row.cached_input_tokens &&
      row.ledger_cache_usage_known === row.cache_usage_known,
    'worker_actual_route_ledger',
  );
  check(
    result.provider === row.provider && result.model === row.model,
    'worker_result_actual_provider',
  );
  return row;
}

async function readWorkerFrozenPrice(
  fixture: P27WorkerFixture,
  task: P27PreparedWorkerTask,
) {
  const [{ AssistantPriceSnapshotSchema }, { runtimePolicyDigest }] =
    await Promise.all([
      import('../../../packages/contracts/src/index.ts'),
      import('../../../packages/database/src/runtime-policy.ts'),
    ]);
  const [frozen] = await fixture.db<
    { snapshot: unknown; snapshot_digest: string }[]
  >`select p.snapshot,p.snapshot_digest from allrice_assistant_price_snapshots p
    join allrice_runs r on r.id=p.root_run_id
    where p.root_run_id=${task.runId} and r.organization_id=${fixture.organizationId}
      and r.workspace_id=${fixture.workspaceId} and r.owner_id=${fixture.ownerId}`;
  if (!frozen) return undefined;
  const snapshot = AssistantPriceSnapshotSchema.parse(frozen.snapshot);
  check(
    runtimePolicyDigest(snapshot) === frozen.snapshot_digest &&
      snapshot.price.target.connectionId === fixture.connectionId &&
      snapshot.price.target.catalogId === fixture.catalogId &&
      runtimePolicyDigest(snapshot.price) ===
        runtimePolicyDigest(fixture.pricingCatalog.entries[0]),
    'worker_frozen_price_identity',
  );
  return { snapshot, snapshot_digest: frozen.snapshot_digest };
}

/** Shared by the actual success verifier and the no-provider PG regression. */
export async function summarizeWorkerPricing(
  fixture: P27WorkerFixture,
  task: P27PreparedWorkerTask,
) {
  const { createAssistantPricing } =
    await import('../../../packages/database/src/assistant-pricing.ts');
  const [authority] = await fixture.db<
    { generation: number; fence: number }[]
  >`select generation::int,fence::int from allrice_assistant_roots where root_run_id=${task.runId}`;
  check(authority, 'worker_assistant_authority');
  return createAssistantPricing({ database: fixture.db }).summarize({
    scope: {
      organizationId: fixture.organizationId,
      workspaceId: fixture.workspaceId,
      projectId: null,
    },
    rootRunId: task.runId,
    worker: {
      workerId: task.workflowLease.workerId,
      jobId: task.workflowLease.jobId,
      leaseToken: task.workflowLease.leaseToken,
      generation: authority.generation,
      fence: authority.fence,
    },
  });
}

async function verifyAssistant(
  fixture: P27WorkerFixture,
  task: P27PreparedWorkerTask,
  result: HarnessExecutionResult,
) {
  const [{ createAssistantRuntime }, { assertAssistantAuthority }] =
    await Promise.all([
      import('../../../packages/database/src/assistant-runtime.ts'),
      import('../../../packages/database/src/assistant-authority.ts'),
    ]);
  const { db } = fixture;
  const tree = await createAssistantRuntime({
    database: db,
    authorize: assertAssistantAuthority,
  }).getTree(fixture.context, { runId: task.runId });
  const frozen = await readWorkerFrozenPrice(fixture, task);
  check(frozen, 'worker_frozen_price_missing');
  const { snapshot } = frozen;
  const summary = await summarizeWorkerPricing(fixture, task);
  const admissions = await db<
    P27PricedAdmission[]
  >`select call_id,run_id,request_digest,dispatched_at,finished_at from allrice_assistant_model_admissions where root_run_id=${task.runId}`;
  const receipts = await db<
    P27CostReceipt[]
  >`select call_id,run_id,snapshot_digest,request_digest,usage,usage_complete,cache_usage_known,cost_basis,actual_cost_known,cost_picounits from allrice_assistant_cost_receipts where root_run_id=${task.runId}`;
  const spent = (metric: string) =>
    tree.budgets.find((budget) => budget.metric === metric)?.spent ?? 0;
  const priced = verifyP27PricingReceipts({
    snapshot,
    snapshotDigest: frozen.snapshot_digest,
    admissions,
    receipts,
    modelCalls: spent('model_calls'),
    settledUsage: {
      inputTokens: spent('input_tokens'),
      outputTokens: spent('output_tokens'),
    },
    summary,
  });
  check(
    result.assistantStatus === 'completed' &&
      result.costBasis === 'conservative_upper_bound' &&
      result.usageComplete &&
      result.costEstimateAvailable &&
      result.estimatedCostCents === Number(summary.costCentsDecimal) &&
      result.priceSnapshotDigest === frozen.snapshot_digest &&
      result.cacheUsageKnown === false &&
      result.actualCostKnown === false &&
      result.costCurrency === 'USD' &&
      result.usage.inputTokens === spent('input_tokens') &&
      result.usage.outputTokens === spent('output_tokens'),
    'worker_whole_tree_result',
  );
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
    'worker_children_and_adoption',
  );
  const [{ LocalStorageAdapter }, { getWorkbenchArtifact, readArtifactBytes }] =
    await Promise.all([
      import('../../../packages/storage/src/index.ts'),
      import('../../../packages/database/src/artifact-review.ts'),
    ]);
  const storage = new LocalStorageAdapter(process.env.ALLRICE_STORAGE_ROOT!);
  const artifacts: { id: string; digest: string; case: string }[] = [];
  for (const item of tree.results) {
    const evidence = item.evidence[0]!;
    const artifact = await getWorkbenchArtifact(
      fixture.context,
      task.sessionId,
      evidence.id,
      db,
    );
    const bytes = await readArtifactBytes(storage, artifact.object, 140000);
    check(
      artifact.object.immutable &&
        artifact.object.checksum === evidence.digest &&
        hash(bytes) === evidence.digest &&
        artifact.object.organizationId === fixture.organizationId &&
        artifact.object.workspaceId === fixture.workspaceId &&
        artifact.object.ownerId === fixture.ownerId &&
        artifact.version.sessionId === task.sessionId &&
        artifact.provenance.runId === item.runId,
      'worker_child_artifact_identity',
    );
    const content = JSON.parse(Buffer.from(bytes).toString('utf8'));
    check(
      content.kind === 'assistant_generated' &&
        content.rootRunId === task.runId &&
        content.childRunId === item.runId &&
        content.deliveryId === item.deliveryId,
      'worker_artifact_provenance',
    );
    const data = JSON.parse(content.content);
    check(
      data.case === 'A'
        ? data.totalCents === 875 && data.rows === 2
        : data.case === 'B' &&
            data.invoiceCents === 1900 &&
            data.paidCents === 1300 &&
            data.outstandingCents === 600,
      'worker_child_arithmetic',
    );
    artifacts.push({
      id: evidence.id,
      digest: evidence.digest,
      case: data.case,
    });
  }
  const answer = JSON.parse(result.answer);
  check(
    new Set(artifacts.map((item) => item.case)).size === 2 &&
      answer.salesTotalCents === 875 &&
      answer.outstandingCents === 600 &&
      answer.reports === 2,
    'worker_parent_arithmetic',
  );
  const ledger = await routeLedger(fixture, task, result);
  check(
    ledger.cost === summary.costCentsDecimal &&
      ledger.cache_usage_known === false,
    'worker_root_projection_matches_receipts',
  );
  return {
    ledger,
    pricedReceipts: priced,
    artifacts,
    answerDigest: hash(result.answer),
    wholeWorkerProjectionVerified: true,
  };
}

async function verifyOrdinary(
  fixture: P27WorkerFixture,
  task: P27PreparedWorkerTask,
  result: HarnessExecutionResult,
) {
  check(
    result.assistantStatus === undefined &&
      JSON.parse(result.answer).sum === 579,
    'worker_ordinary_result',
  );
  const [roots] = await fixture.db<
    { count: number }[]
  >`select count(*)::int as count from allrice_assistant_roots where root_run_id=${task.runId}`;
  check(roots?.count === 0, 'worker_ordinary_no_assistant_root');
  const ledger = await routeLedger(fixture, task, result);
  const { estimateModelCostCents } =
    await import('../../../apps/worker/src/model-cost.ts');
  const estimate = estimateModelCostCents({
    provider: result.provider,
    model: result.model,
    ...result.usage,
  });
  check(
    estimate > 0 && Number(ledger.cost) === Number(estimate.toFixed(6)),
    'worker_ordinary_legacy_estimate',
  );
  return {
    ledger,
    answerDigest: hash(result.answer),
    estimator: 'legacy_confirmed_result_not_invoice',
    cacheTariffBoundVerified: false,
  };
}

export async function workerFailureSnapshot(
  fixture: P27WorkerFixture,
  task: P27PreparedWorkerTask,
  diagnostics?: AssistantFailureDiagnostics,
) {
  const { db } = fixture;
  const admissions = await db<
    P27DiagnosticAdmission[]
  >`select a.call_id,a.run_id,i.native_session_id,a.request_digest,a.dispatched_at is not null as dispatched,a.finished_at is not null as finished from allrice_assistant_model_admissions a join allrice_assistant_instances i on i.run_id=a.run_id and i.root_run_id=a.root_run_id where a.root_run_id=${task.runId}`;
  const receipts = await db<
    P27DiagnosticReceipt[]
  >`select call_id,run_id,request_digest,snapshot_digest,usage_complete,usage->>'inputTokens' is not null as input_usage_known,usage->>'outputTokens' is not null as output_usage_known,cache_usage_known,actual_cost_known,cost_picounits is not null as cost_known from allrice_assistant_cost_receipts where root_run_id=${task.runId}`;
  const usage =
    await db`select run_id,metric,count(*)::int as reservations,count(*) filter(where settled_amount is null)::int as unsettled,coalesce(sum(settled_amount),0)::text as settled from allrice_assistant_usage where root_run_id=${task.runId} group by run_id,metric`;
  const routes =
    await db`select id,status,input_tokens,output_tokens,cost_cents::text,usage_complete,cache_usage_known from allrice_route_decisions where run_id=${task.runId}`;
  // Trust the independently frozen root price, never a receipt's own claimed
  // digest. Product Session -> native session remains the actual PG mapping.
  const frozen = await readWorkerFrozenPrice(fixture, task);
  return {
    runId: task.runId,
    admissions: [...admissions],
    receipts: [...receipts],
    usage: [...usage],
    routes: [...routes],
    nativeDiagnostics: correlateP27AssistantDiagnostics({
      diagnostics,
      admissions,
      receipts,
      snapshotDigest: frozen?.snapshot_digest,
    }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void mainP27Worker().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ status: 'worker_preflight_failed', error: p27ErrorDiagnostics(error) })}\n`,
    );
    process.exitCode = 1;
  });
