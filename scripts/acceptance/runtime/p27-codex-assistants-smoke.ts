/** Opt-in, TWO subscription Worker executions: two-child assistant then ordinary.
 * Run with TSX_TSCONFIG_PATH=<candidate>/tsconfig.base.json so the production
 * package aliases and fixture use the SAME isolated source database singleton.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HarnessExecutionResult } from '../../../apps/worker/src/harness/adapter.ts';
import {
  parseP27CodexJson,
  syntheticCodexFinalAnswer,
  type P27CodexJsonObservation,
  type P27CodexJsonObserver,
} from './p27-codex-json.ts';
import type {
  P27PreparedCodexAssistantsTask,
  P27CodexAssistantsFixture,
} from './p27-codex-assistants-fixture.ts';
import { observeP27Clients } from './p27-owned-clients.ts';
import { collectP27InstalledRuntime } from './p27-installed-runtime.ts';
import type { AssistantFailureDiagnostics } from '../../../apps/worker/src/harness/dsh/assistant-diagnostics.ts';
import {
  retainP27AssistantDiagnostics,
  correlateP27AssistantDiagnostics,
  type P27DiagnosticAdmission,
} from './p27-assistant-diagnostics.ts';
import {
  prepareP27PlatformEnvironment,
  readCandidate,
  requireCheck,
} from './p27-assistant-preflight.ts';
import {
  boundedP27Wait,
  maintainP27Lease,
  workerFixtureCleanupConfirmed,
  runP27WorkerSequence,
} from './p27-worker-preflight.ts';
import {
  authorizeP27CodexAssistants,
  authorizedP27CodexPlatformHome,
  parseP27CodexAssistantsArguments,
  P27_CODEX_ASSISTANT_LIMITS,
  P27_CODEX_ASSISTANTS_SCOPE,
  checkCodexAssistants,
  codexAssistantsDiagnostics as p27ErrorDiagnostics,
} from './p27-codex-assistants-preflight.ts';
import {
  readCodexSubscriptionEvidence,
  verifyCodexSubscriptionResult,
  verifyCodexAssistantExecution,
} from './p27-codex-assistants-verification.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const hash = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const check: typeof requireCheck = requireCheck;
const sourceFiles = [
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
  'packages/database/src/assistant-output.ts',
  'packages/database/src/artifact-review.ts',
  'packages/database/src/execution/queue.ts',
  'packages/database/src/providers/model-governance.ts',
  'scripts/acceptance/ui/p28-codex-session-ui.ts',
  'scripts/acceptance/ui/p28-codex-session-ui.test.ts',
  ...[
    'codex-assistants-smoke',
    'codex-assistants-fixture',
    'codex-assistants-preflight',
    'codex-assistants-verification',
    'codex-assistants-verification.test',
    'codex-evidence-stages.test',
    'codex-json',
    'codex-json.test',
    'codex-assistants-artifact.test',
    'codex-worker-preflight',
    'worker-preflight',
    'assistant-preflight',
    'assistant-diagnostics',
    'error-diagnostics',
    'owned-clients',
    'installed-runtime',
  ].map((name) => `scripts/acceptance/runtime/p27-${name}.ts`),
];

export async function mainP27CodexAssistants(
  argsInput = process.argv.slice(2),
) {
  const args = parseP27CodexAssistantsArguments(argsInput);
  readCandidate(root, args.sha);
  check(
    process.env.TSX_TSCONFIG_PATH === join(root, 'tsconfig.base.json'),
    'worker_source_alias_required',
  );
  const sources = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (file) => [
        file,
        hash(await readFile(join(root, file))),
      ]),
    ),
  );
  const installedRuntime = await collectP27InstalledRuntime(root);
  // Refuse before any model execution when the real-history UI prerequisites
  // are absent. No GUI process or personal Chrome profile is opened here.
  const chromeExecutable =
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chromeStat = await lstat(chromeExecutable);
  checkCodexAssistants(
    chromeStat.isFile() && (chromeStat.mode & 0o111) !== 0,
    'ui_unverified',
  );
  const uiBuildId = (
    await readFile(join(root, 'apps/web/.next/BUILD_ID'), 'utf8')
  ).trim();
  checkCodexAssistants(uiBuildId.length > 0, 'ui_unverified');
  const report: Record<string, unknown> = {
    version: 1,
    candidateSha: args.sha,
    sources,
    installedRuntime,
    uiBuildId,
    status: 'preflight_only',
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    authMode: 'chatgpt_subscription',
    allowAssistants: true,
    tools: ['assistant.delegate', 'assistant.report'],
    children: {
      maxChildren: 2,
      maxConcurrent: 2,
      maxDepth: 1,
      tools: ['assistant.report'],
    },
    fallbackPolicy: 'disabled',
    maxAttempts: 1,
    applicationRetries: 0,
    executionLimit: 2,
    applicationLimits: P27_CODEX_ASSISTANT_LIMITS,
    scope: P27_CODEX_ASSISTANTS_SCOPE,
    monetaryCost: 'not_applicable_subscription_not_free_or_invoice',
    providerAllowance: { status: 'not_queried', meansAvailable: false },
    credentialBytesReadByDriver: false,
    workerExecutionAttempted: false,
    providerInvocation: 'not_attempted',
    databaseNotOpened: true,
    credentialMetadataNotRead: true,
    excluded: [
      'wire_hard_output_cap',
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
  authorizeP27CodexAssistants(process.env, args.sha);
  const codexPlatformHome = await authorizedP27CodexPlatformHome(
    process.env.ALLRICE_DSH_PLATFORM_HOME,
  );
  report.credentialMetadataNotRead = false;
  report.platformHome = codexPlatformHome;
  const evidenceDirectory = join(
    root,
    '.local',
    `p27-codex-assistants-${randomUUID()}`,
  );
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p27-codex-assistants-')),
  );
  let fixture: P27CodexAssistantsFixture | undefined;
  let fixtureAttempted = false;
  let fixtureCleanupVerified = false;
  let clients: ReturnType<typeof observeP27Clients> | undefined;
  let closeAdapters: (() => Promise<void>) | undefined;
  let activeTask: P27PreparedCodexAssistantsTask | undefined;
  let execution: Promise<unknown> | undefined;
  let executionSettled = true;
  let executeCount = 0;
  let toolEvents = 0;
  let nativeDiagnostics: AssistantFailureDiagnostics | undefined;
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
  let uiResourcesClosed = true;
  const completedUiTasks: {
    assistant?: { runId: string; sessionId: string };
    ordinary?: { runId: string; sessionId: string };
  } = {};
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
        P27_CODEX_ASSISTANT_LIMITS.timeoutMs,
      ),
      ALLRICE_STORAGE_ROOT: join(temporary, 'storage'),
      ALLRICE_ASSISTANTS_ENABLED: '1',
    });
    report.phase = 'worker_fixture_prepare';
    const { createP27CodexAssistantsFixture } =
      await import('./p27-codex-assistants-fixture.ts');
    fixtureAttempted = true;
    report.databaseNotOpened = false;
    fixture = await createP27CodexAssistantsFixture();
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
    async function run(task: P27PreparedCodexAssistantsTask) {
      const assistants = task.assistants;
      const previousToolEvents = toolEvents;
      nativeDiagnostics = undefined;
      activeTask = task;
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
      report.workerExecutionAttempted = true;
      report.providerInvocation = 'unknown';
      executionSettled = false;
      const pending = executeEmployeeRun({
        execution: claimed,
        isolation,
        signal: abort.signal,
        onHarnessEvent: (event) => {
          if (
            event.type === 'tool.started' ||
            event.type === 'tool.completed' ||
            event.type === 'tool.failed'
          ) {
            toolEvents++;
            checkCodexAssistants(
              assistants &&
                [
                  'assistant.delegate',
                  'assistant.report',
                  'assistant_delegate',
                  'assistant_report',
                ].includes(event.name),
              'tool_out_of_scope',
            );
          }
          return batcher.accept(event);
        },
        workflowLease: lease,
      });
      execution = pending.finally(() => {
        executionSettled = true;
      });
      execution.catch(() => {});
      const result = await boundedP27Wait(pending, task.taskLimits.timeoutMs);
      nativeDiagnostics = retainP27AssistantDiagnostics(
        nativeDiagnostics,
        result,
      );
      await batcher.flush();
      checkCodexAssistants(
        assistants || toolEvents === previousToolEvents,
        'ordinary_tools',
      );
      check(!abort.signal.aborted, 'worker_execution_aborted');
      report.phase = assistants
        ? 'assistant_ledger_verify'
        : 'ordinary_ledger_verify';
      check(
        'provider' in result && 'model' in result,
        'worker_model_not_invoked',
      );
      report.providerInvocation = 'confirmed_by_worker_result';
      report[assistants ? 'assistantFinalAnswer' : 'ordinaryFinalAnswer'] =
        syntheticCodexFinalAnswer(result.answer);
      const parsing: P27CodexJsonObservation[] = [];
      report.jsonParsing = parsing;
      const observeJson: P27CodexJsonObserver = (entry) => {
        report.phase = `json_${entry.stage}`;
        if (parsing.length < 8) parsing.push(entry);
      };
      const proof = assistants
        ? await verifyCodexAssistantExecution(
            fixture!,
            task,
            result,
            observeJson,
            {
              sourceSha: args.sha,
              onPlatformVerified: async (proof) => {
                report.assistantPlatform = {
                  status: 'passed',
                  scope: 'platform-only-not-parent-answer-ordinary-or-ui',
                  observedAt: new Date().toISOString(),
                  runId: task.runId,
                  ...proof,
                };
                await save();
              },
            },
          )
        : await verifyCodexOrdinarySubscription(
            fixture!,
            task,
            result,
            observeJson,
          );
      report.phase = assistants
        ? 'assistant_completion_verify'
        : 'ordinary_completion_verify';
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
      checkCodexAssistants(
        quota.usedRuns === executeCount &&
          quota.subscriptionRuns === executeCount &&
          quota.unknownCostRuns === 0 &&
          quota.usageComplete &&
          quota.usedCostCents === 0,
        'subscription_quota',
      );
      api.assertQuotaAvailable(quota, 'subscription');
      const [ledgerTotal] = await db<
        { cost: string; tokens: string }[]
      >`select coalesce(sum(cost_cents),0)::text as cost,sum(input_tokens+output_tokens)::text as tokens from allrice_model_usage_ledger where organization_id=${fixture!.organizationId}`;
      check(
        quota.usedCostCents === Number(ledgerTotal?.cost) &&
          quota.usedTokens === Number(ledgerTotal?.tokens),
        'worker_quota_matches_ledger',
      );
      report[assistants ? 'assistant' : 'ordinary'] = {
        runId: task.runId,
        sessionId: task.sessionId,
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
      completedUiTasks[assistants ? 'assistant' : 'ordinary'] = {
        runId: task.runId,
        sessionId: task.sessionId,
      };
      activeTask = undefined;
      return task.runId;
    }
    await runP27WorkerSequence({
      assistant: async () => run(await fixture!.prepareAssistantTask()),
      ordinary: async (afterRunId) => {
        await run(await fixture!.prepareOrdinaryTask({ afterRunId }));
      },
    });
    checkCodexAssistants(executeCount === 2, 'execution_count');
    checkCodexAssistants(
      completedUiTasks.assistant && completedUiTasks.ordinary,
      'ui_unverified',
    );
    report.phase = 'real_history_browser_verify';
    await save();
    const { verifyCodexWorkerSessionsInChrome } =
      await import('../ui/p28-codex-session-ui.ts');
    uiResourcesClosed = false;
    const ui = await verifyCodexWorkerSessionsInChrome({
      fixture,
      assistant: completedUiTasks.assistant,
      ordinary: completedUiTasks.ordinary,
      storageRoot: process.env.ALLRICE_STORAGE_ROOT!,
      evidenceDirectory,
      chromeExecutable,
    });
    report.ui = ui;
    uiResourcesClosed = Object.values(ui.cleanup).every(Boolean);
    await save();
    checkCodexAssistants(
      ui.passed &&
        uiResourcesClosed &&
        ui.buildId === uiBuildId &&
        ui.sourceHead === args.sha,
      'ui_unverified',
    );
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
      const { P27CodexAssistantsFixtureError } =
        await import('./p27-codex-assistants-fixture.ts');
      if (error instanceof P27CodexAssistantsFixtureError && error.cleanup) {
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
    if (
      nativeStopped &&
      executionSettled &&
      leasesStopped &&
      uiResourcesClosed
    ) {
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
          report.failureSnapshot = await codexAssistantsFailureSnapshot(
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
          const { P27CodexAssistantsFixtureError } =
            await import('./p27-codex-assistants-fixture.ts');
          if (error instanceof P27CodexAssistantsFixtureError && error.cleanup)
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
      uiResourcesClosed,
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

async function verifyCodexOrdinarySubscription(
  fixture: P27CodexAssistantsFixture,
  task: P27PreparedCodexAssistantsTask,
  result: HarnessExecutionResult,
  observe?: P27CodexJsonObserver,
) {
  const evidence = await readCodexSubscriptionEvidence(fixture, task);
  const accounting = verifyCodexSubscriptionResult(result, evidence, false);
  const parsed = parseP27CodexJson(result.answer, 'ordinary_answer', observe);
  checkCodexAssistants(parsed.value.sum === 579, 'ordinary_result');
  const [roots] = await fixture.db<{ count: number }[]>`
    select count(*)::int as count from allrice_assistant_roots where root_run_id=${task.runId}`;
  checkCodexAssistants(roots?.count === 0, 'ordinary_result');
  return {
    accounting,
    ledger: evidence.row,
    answerDigest: hash(result.answer),
    parseDiagnostics: [parsed.observation],
    noAssistantRoot: true,
  };
}

export async function codexAssistantsFailureSnapshot(
  fixture: P27CodexAssistantsFixture,
  task: P27PreparedCodexAssistantsTask,
  diagnostics?: AssistantFailureDiagnostics,
) {
  const { db } = fixture;
  const routes = await db`
    select d.id,d.status,d.input_tokens,d.output_tokens,d.cached_input_tokens,
      d.cost_cents::text,d.usage_complete,d.cache_usage_known,s.snapshot_digest
    from allrice_route_decisions d left join allrice_route_subscription_snapshots s on s.route_decision_id=d.id
    where d.run_id=${task.runId} and d.organization_id=${fixture.organizationId}
      and d.workspace_id=${fixture.workspaceId}`;
  const ledgers = await db`
    select l.status,l.input_tokens,l.output_tokens,l.cached_input_tokens,
      l.cost_cents::text,l.usage_complete,l.cache_usage_known
    from allrice_model_usage_ledger l join allrice_route_decisions d on d.id=l.route_decision_id
    where d.run_id=${task.runId} and d.organization_id=${fixture.organizationId}
      and d.workspace_id=${fixture.workspaceId} and l.organization_id=d.organization_id`;
  const admissions = await db<P27DiagnosticAdmission[]>`
    select a.call_id,a.run_id,i.native_session_id,a.request_digest,
      a.dispatched_at is not null as dispatched,a.finished_at is not null as finished
    from allrice_assistant_model_admissions a join allrice_assistant_instances i
      on i.run_id=a.run_id and i.root_run_id=a.root_run_id where a.root_run_id=${task.runId}`;
  const instances = await db`
    select run_id,parent_run_id,status,depth from allrice_assistant_instances where root_run_id=${task.runId}`;
  const usage = await db`
    select run_id,metric,count(*)::int as reservations,
      count(*) filter(where settled_amount is null)::int as unsettled,
      coalesce(sum(settled_amount),0)::text as settled from allrice_assistant_usage
    where root_run_id=${task.runId} group by run_id,metric`;
  return {
    runId: task.runId,
    routes: [...routes],
    ledgers: [...ledgers],
    instances: [...instances],
    admissions: [...admissions],
    usage: [...usage],
    receiptContract: 'not_applicable_subscription',
    nativeDiagnostics: correlateP27AssistantDiagnostics({
      diagnostics,
      admissions,
      receipts: [],
    }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void mainP27CodexAssistants().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        status: 'codex_assistants_preflight_failed',
        error: p27ErrorDiagnostics(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
