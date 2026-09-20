/** Opt-in, exactly ONE ordinary Codex Worker execution; never starts worker/index.
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
import type {
  P27PreparedCodexWorkerTask,
  P27CodexWorkerFixture,
} from './p27-codex-worker-fixture.ts';
import { observeP27Clients } from './p27-owned-clients.ts';
import { collectP27InstalledRuntime } from './p27-installed-runtime.ts';
import { p27ErrorDiagnostics } from './p27-error-diagnostics.ts';
import {
  parseP27CodexJson,
  syntheticCodexFinalAnswer,
  codexJsonDiagnostics,
  type P27CodexJsonObserver,
} from './p27-codex-json.ts';
import {
  prepareP27PlatformEnvironment,
  readCandidate,
  requireCheck,
} from './p27-assistant-preflight.ts';
import {
  boundedP27Wait,
  maintainP27Lease,
  workerFixtureCleanupConfirmed,
} from './p27-worker-preflight.ts';
import {
  authorizeP27CodexWorker,
  authorizedP27CodexPlatformHome,
  onceP27CodexWorker,
  parseP27CodexWorkerArguments,
  P27_CODEX_COST_CAVEAT,
  P27_CODEX_LIMIT_CAVEAT,
  P27_CODEX_ORDINARY_LIMITS,
  P27_CODEX_ORDINARY_PROMPT,
} from './p27-codex-worker-preflight.ts';
import {
  readCodexSubscriptionEvidence,
  verifyCodexSubscriptionResult,
} from './p27-codex-assistants-verification.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const hash = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const check: typeof requireCheck = requireCheck;
export const P27_CODEX_ORDINARY_SOURCE_FILES = [
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'packages/contracts/src/assistant-subscription.ts',
  'packages/contracts/src/models.ts',
  'packages/contracts/src/skills.ts',
  'packages/database/src/runtime-policy.ts',
  'packages/database/src/execution/route-subscription.ts',
  'packages/database/migrations/0097_route_subscription_snapshots.sql',
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
    'codex-worker-smoke',
    'codex-worker-fixture',
    'codex-worker-preflight',
    'codex-worker-preflight.test',
    'codex-assistants-verification',
    'codex-assistants-verification.test',
    'codex-evidence-stages.test',
    'codex-assistants-preflight',
    'codex-json',
    'codex-json.test',
    'codex-assistants-artifact.test',
    'worker-preflight',
    'assistant-preflight',
    'assistant-diagnostics',
    'error-diagnostics',
    'owned-clients',
    'installed-runtime',
  ].map((name) => `scripts/acceptance/runtime/p27-${name}.ts`),
];

export async function mainP27CodexWorker(argsInput = process.argv.slice(2)) {
  const args = parseP27CodexWorkerArguments(argsInput);
  readCandidate(root, args.sha);
  check(
    process.env.TSX_TSCONFIG_PATH === join(root, 'tsconfig.base.json'),
    'worker_source_alias_required',
  );
  const sources = Object.fromEntries(
    await Promise.all(
      P27_CODEX_ORDINARY_SOURCE_FILES.map(async (file) => [
        file,
        hash(await readFile(join(root, file))),
      ]),
    ),
  );
  const installedRuntime = await collectP27InstalledRuntime(root);
  const report: Record<string, unknown> = {
    version: 1,
    candidateSha: args.sha,
    sources,
    installedRuntime,
    status: 'preflight_only',
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    authMode: 'chatgpt_subscription',
    allowAssistants: false,
    scope: 'independent-ordinary-only-not-assistant-followup-or-ui',
    tools: [],
    fallbackPolicy: 'disabled',
    maxAttempts: 1,
    applicationRetries: 0,
    executionLimit: 1,
    applicationLimits: P27_CODEX_ORDINARY_LIMITS,
    limitCaveat: P27_CODEX_LIMIT_CAVEAT,
    costCaveat: P27_CODEX_COST_CAVEAT,
    credentialBytesReadByDriver: false,
    workerExecutionAttempted: false,
    providerInvocation: 'not_attempted',
    databaseNotOpened: true,
    credentialMetadataNotRead: true,
    excluded: [
      'assistant_acceptance',
      'wire_hard_output_cap',
      'assistant_to_ordinary_same_fixture_continuity',
      'provider_invoice',
      'provider_internal_attempt_bound',
      'bridge_and_signed_release',
      'GA',
    ],
  };
  if (args.mode === '--preflight') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  authorizeP27CodexWorker(process.env, args.sha);
  const codexPlatformHome = await authorizedP27CodexPlatformHome(
    process.env.ALLRICE_DSH_PLATFORM_HOME,
  );
  report.credentialMetadataNotRead = false;
  report.platformHome = codexPlatformHome;
  const evidenceDirectory = join(
    root,
    '.local',
    `p27-codex-worker-${randomUUID()}`,
  );
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p27-codex-worker-')),
  );
  let fixture: P27CodexWorkerFixture | undefined;
  let fixtureAttempted = false;
  let fixtureCleanupVerified = false;
  let clients: ReturnType<typeof observeP27Clients> | undefined;
  let closeAdapters: (() => Promise<void>) | undefined;
  let activeTask: P27PreparedCodexWorkerTask | undefined;
  let execution: Promise<unknown> | undefined;
  let executionSettled = true;
  let executeCount = 0;
  let toolEvents = 0;
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
      providerRoute: 'openai-codex',
      codexPlatformHome,
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
      ALLRICE_DSH_REQUEST_TIMEOUT_MS: String(
        P27_CODEX_ORDINARY_LIMITS.timeoutMs,
      ),
      ALLRICE_STORAGE_ROOT: join(temporary, 'storage'),
      ALLRICE_ASSISTANTS_ENABLED: '0',
    });
    report.phase = 'worker_fixture_prepare';
    const { createP27CodexWorkerFixture } =
      await import('./p27-codex-worker-fixture.ts');
    fixtureAttempted = true;
    report.databaseNotOpened = false;
    fixture = await createP27CodexWorkerFixture();
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
    async function run(task: P27PreparedCodexWorkerTask) {
      activeTask = task;
      check(executeCount < 1, 'worker_execution_count');
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
      report.phase = 'ordinary_worker_execute';
      report.activeRunId = task.runId;
      await save();
      executeCount++;
      report.workerExecutionAttempted = true;
      report.providerInvocation = 'unknown';
      executionSettled = false;
      const pending = executeEmployeeRun({
        execution: claimed,
        isolation,
        signal: abort.signal,
        onHarnessEvent: (event) => {
          if (event.type.startsWith('tool.')) toolEvents++;
          return batcher.accept(event);
        },
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
      await batcher.flush();
      check(toolEvents === 0, 'codex_worker_unexpected_tool_events');
      check(!abort.signal.aborted, 'worker_execution_aborted');
      report.phase = 'ordinary_ledger_verify';
      check(
        'provider' in result && 'model' in result,
        'worker_model_not_invoked',
      );
      report.providerInvocation = 'confirmed_by_worker_result';
      report.finalAnswer = syntheticCodexFinalAnswer(result.answer);
      const proof = await verifyCodexOrdinary(
        fixture!,
        task,
        result,
        (entry) => {
          report.phase = `json_${entry.stage}`;
          report.jsonParsing = [entry];
        },
      );
      report.phase = 'ordinary_completion_verify';
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
        quota.usedRuns === 1 &&
          quota.subscriptionRuns === 1 &&
          quota.unknownCostRuns === 0 &&
          quota.usageComplete,
        'worker_one_run_recorded',
      );
      api.assertQuotaAvailable(quota, 'subscription');
      const [ledgerTotal] = await db<
        { cost: string; tokens: string }[]
      >`select sum(cost_cents)::text as cost,sum(input_tokens+output_tokens)::text as tokens from allrice_model_usage_ledger where organization_id=${fixture!.organizationId}`;
      check(
        quota.usedCostCents === Number(ledgerTotal?.cost) &&
          quota.usedTokens === Number(ledgerTotal?.tokens),
        'worker_quota_matches_ledger',
      );
      report.ordinary = {
        runId: task.runId,
        ...proof,
        quota: {
          usedRuns: quota.usedRuns,
          usedTokens: quota.usedTokens,
          usedCostCents: quota.usedCostCents,
          unknownCostRuns: quota.unknownCostRuns,
          subscriptionRuns: quota.subscriptionRuns,
          usedCostCentsMeaning: 'metered_cost_subtotal_not_subscription_cost',
          usageComplete: quota.usageComplete,
          cacheUsageKnown: quota.cacheUsageKnown,
        },
      };
      activeTask = undefined;
      return task.runId;
    }
    await onceP27CodexWorker(async () =>
      run(await fixture!.prepareOrdinaryTask(P27_CODEX_ORDINARY_PROMPT)),
    )();
    check(executeCount === 1, 'worker_exact_one_execution');
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
      const { P27CodexWorkerFixtureError } =
        await import('./p27-codex-worker-fixture.ts');
      if (error instanceof P27CodexWorkerFixtureError && error.cleanup) {
        report.fixtureCleanup = error.cleanup;
        fixtureCleanupVerified = workerFixtureCleanupConfirmed(error.cleanup);
      }
    }
    report.status = 'failed';
    report.error = {
      ...p27ErrorDiagnostics(error),
      ...(codexJsonDiagnostics(error)
        ? { jsonParsing: codexJsonDiagnostics(error) }
        : {}),
    };
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
          report.failureSnapshot = await codexWorkerFailureSnapshot(
            fixture,
            activeTask,
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
            code: 'P27_CODEX_WORKER_SMOKE_FAILED',
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
          const { P27CodexWorkerFixtureError } =
            await import('./p27-codex-worker-fixture.ts');
          if (error instanceof P27CodexWorkerFixtureError && error.cleanup)
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
    report.toolEvents = toolEvents;
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

/** Standalone ordinary execution uses the same frozen N/A identity and usage
 * validator as the two-task smoke, never the obsolete zero-price estimator. */
export async function verifyCodexOrdinary(
  fixture: P27CodexWorkerFixture,
  task: P27PreparedCodexWorkerTask,
  result: HarnessExecutionResult,
  observe?: P27CodexJsonObserver,
) {
  const parsed = parseP27CodexJson(result.answer, 'ordinary_answer', observe);
  check(
    result.assistantStatus === undefined &&
      result.provider === 'openai-codex' &&
      result.model === 'gpt-5.6-luna' &&
      parsed.value.sum === 579,
    'codex_worker_ordinary_result',
  );
  const [counts] = await fixture.db<
    { roots: number; jobs: number; runs: number }[]
  >`
    select (select count(*)::int from allrice_assistant_roots) as roots,
      (select count(*)::int from allrice_jobs) as jobs,
      (select count(*)::int from allrice_runs) as runs`;
  check(
    counts?.roots === 0 && counts.jobs === 1 && counts.runs === 1,
    'codex_worker_exact_one_ordinary_task',
  );
  const rows = await fixture.db<
    {
      id: string;
      provider: string;
      model: string;
      status: string;
      cost: string | null;
      ledger_cost: string | null;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      usage_complete: boolean;
      cache_usage_known: boolean;
      ledger_input_tokens: number;
      ledger_output_tokens: number;
      ledger_cached_input_tokens: number;
      ledger_complete: boolean;
      ledger_cache_usage_known: boolean;
      ledger_status: string;
      connection_id: string;
      model_catalog_entry_id: string;
      auth_mode: string;
    }[]
  >`
    select d.id,d.provider,d.model,d.status,d.cost_cents::text as cost,
      d.input_tokens,d.output_tokens,d.cached_input_tokens,d.usage_complete,d.cache_usage_known,
      l.cost_cents::text as ledger_cost,l.input_tokens as ledger_input_tokens,
      l.output_tokens as ledger_output_tokens,l.cached_input_tokens as ledger_cached_input_tokens,
      l.usage_complete as ledger_complete,l.cache_usage_known as ledger_cache_usage_known,
      l.status as ledger_status,l.connection_id,l.model_catalog_entry_id,p.auth_mode
    from allrice_route_decisions d join allrice_model_usage_ledger l on l.route_decision_id=d.id
    join allrice_model_connections c on c.id=l.connection_id
    join allrice_model_providers p on p.id=c.provider_id
    where d.run_id=${task.runId} and d.organization_id=${fixture.organizationId}
      and l.organization_id=d.organization_id`;
  const row = rows[0];
  check(
    rows.length === 1 &&
      row &&
      row.provider === result.provider &&
      row.model === result.model &&
      row.auth_mode === 'chatgpt_subscription' &&
      row.connection_id === fixture.connectionId &&
      row.model_catalog_entry_id === fixture.catalogId &&
      row.status === 'succeeded' &&
      row.ledger_status === 'succeeded' &&
      row.usage_complete &&
      row.ledger_complete &&
      row.cost === row.ledger_cost &&
      row.input_tokens === result.usage.inputTokens &&
      row.output_tokens === result.usage.outputTokens &&
      row.cached_input_tokens === result.usage.cachedInputTokens &&
      row.ledger_input_tokens === row.input_tokens &&
      row.ledger_output_tokens === row.output_tokens &&
      row.ledger_cached_input_tokens === row.cached_input_tokens &&
      row.ledger_cache_usage_known === row.cache_usage_known,
    'codex_worker_actual_route_ledger',
  );
  check(
    Number.isSafeInteger(result.usage.inputTokens) &&
      result.usage.inputTokens > 0 &&
      Number.isSafeInteger(result.usage.outputTokens) &&
      result.usage.outputTokens > 0,
    'codex_worker_observed_tokens',
  );
  const evidence = await readCodexSubscriptionEvidence(fixture, task);
  const accounting = verifyCodexSubscriptionResult(result, evidence, false);
  return {
    ledger: evidence.row,
    accounting,
    subscriptionSnapshot: evidence.snapshot,
    observedUsage: result.usage,
    answerDigest: hash(result.answer),
    parseDiagnostics: [parsed.observation],
    subscriptionIdentityAndUsageVerified: true,
    actualSubscriptionCostKnown: false,
    costCaveat: P27_CODEX_COST_CAVEAT,
  };
}

export async function codexWorkerFailureSnapshot(
  fixture: P27CodexWorkerFixture,
  task: P27PreparedCodexWorkerTask,
) {
  const routes = await fixture.db`
    select id,status,input_tokens,output_tokens,cached_input_tokens,
      cost_cents::text,usage_complete,cache_usage_known
    from allrice_route_decisions where run_id=${task.runId}
      and organization_id=${fixture.organizationId}
      and workspace_id=${fixture.workspaceId}`;
  const ledgers = await fixture.db`
    select l.status,l.input_tokens,l.output_tokens,l.cached_input_tokens,
      l.cost_cents::text,l.usage_complete,l.cache_usage_known
    from allrice_model_usage_ledger l
      join allrice_route_decisions d on d.id=l.route_decision_id
    where d.run_id=${task.runId} and d.organization_id=${fixture.organizationId}
      and d.workspace_id=${fixture.workspaceId}
      and l.organization_id=d.organization_id`;
  return { runId: task.runId, routes: [...routes], ledgers: [...ledgers] };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void mainP27CodexWorker().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        status: 'codex_worker_preflight_failed',
        error: p27ErrorDiagnostics(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
