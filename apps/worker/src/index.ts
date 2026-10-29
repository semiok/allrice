import { installDshCloseObservationIdentity } from './harness/dsh-close-observer.js';
import { observeDshWorkerCloseIdentity } from './harness/dsh-worker-close-identity.js';
import { processNextReference } from './reference-processing.js';
import { startCloudProjectPreviewTransport } from './cloud-runner/project-preview-transport.js';
import {
  cloudArchitectureTranslationProblem,
  configuredCloudCommandRuntimeLimits,
  runtimeFeatureEnabled,
} from '@allrice/contracts';
import { startExecutionPressureLog } from './execution-pressure.js';
import { detectWorkerCapacity } from './worker-capacity.js';
import {
  claimUnderMemoryGate,
  createMemoryGate,
  memoryGateSettings,
} from './memory-gate.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createNativeRunDiagnosticsHttpHandler } from './native-run-diagnostics-http.js';

import {
  DSH_INSTALLED_DISTRIBUTION,
  NATIVE_JOURNAL_CONTRACT,
  UuidSchema,
  makeHealthResponse,
} from '@allrice/contracts';
import {
  runMaintenanceExecutionTick,
  processFolderTriggerEvents,
  claimNextJob,
  closeDatabase,
  maintainQueue,
  listenForReadyJobs,
  probeReadyJobs,
  collectPendingExperienceEvidence,
  recoverExperienceOccurrences,
  dispatchExperienceOccurrence,
  recoverPlatformQualityOccurrences,
  syncExperienceConsolidationSchedules,
  syncExperienceValidations,
  syncExperienceAdoptions,
  pingDatabase,
  queueSummary,
  recoverCodexAuthorizationFlows,
  recordCodexProviderStatus,
  replaceWorkerDshRuntimeInventory,
  syncAutomationRuns,
  recordWorkerCapabilities,
  removeWorkerCapabilities,
  readServiceBuildIdentity,
  readDevMaintenance,
  installDevProducerLifecycle,
  readDevProducerLifecycle,
  recordNativeJournalContract,
  type DevProducerContext,
} from '@allrice/database';

import {
  CodexAuthorizationBroker,
  probeDshCodexProvider,
} from './codex-auth-broker.js';
import { executeClaimedJob } from './runtime.js';
import { createCoalescedTick, startQueueWakeups } from './queue-wakeup.js';
import {
  installDshNativeArtifact,
  checkedDshNativeLaunch,
  checkRetiredDshNativeSettings,
} from './harness/dsh-native-artifact.js';
import { configuredDshNativeLaunch } from './harness/dsh/runtime-pool.js';
import { fileURLToPath } from 'node:url';
import { closeHarnessAdapters, getHarnessRouter } from './harness/router.js';
import {
  closeWorkerResources,
  startWorkerShutdownTask,
  WorkerShutdownError,
} from './worker-shutdown.js';
import {
  verifyWorkerDshRuntimeClosure,
  DshWorkerCloseError,
} from './harness/dsh-worker-close.js';
import { executeNextPlatformEmployeeTest } from './platform-employee-tests.js';
import { executeNextMcpDiscovery } from './mcp/lifecycle.js';
import { recoverMcpRuntimeOperations } from './mcp/executor.js';
import {
  recoverCloudCommandOperations,
  stopCloudProjectServices,
} from './cloud-runner/executor.js';
import { readWorkerCapabilities } from './harness/runtime-capabilities.js';
import { refreshManagedCloudEnvironments } from './managed-cloud-environments.js';
import { workerProducerRunner } from './dev-producer.js';
import { runMaintenanceReportingProducer } from './maintenance-reporting.js';
import {
  captureMaintenanceDiagnosticRuntime,
  runMaintenanceDiagnosisTick,
} from './maintenance-diagnosis.js';

import { createWorkerStartupObservation } from './startup-observation.js';
import {
  configuredNativeOnceControlSource,
  configuredNativeRecurringControlSource,
  createNativeOnceWorkerService,
} from './native-schedule-once-loader.js';

// An x64 Node translated by Rosetta would select the amd64 cloud toolchain on an
// Apple-silicon host (MET-216): refuse to start instead of running emulated.
configuredCloudCommandRuntimeLimits();
if (runtimeFeatureEnabled('ALLRICE_CLOUD_RUNNER_ENABLED')) {
  const problem = cloudArchitectureTranslationProblem();
  if (problem) throw new Error(problem);
}
const startup = createWorkerStartupObservation();
const port = Number(process.env.ALLRICE_WORKER_PORT ?? 3101);
function integerSetting(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const readinessIntervalMs = 5000;
const codexProviderStatusIntervalMs = 30_000;
const dshRuntimeInventoryIntervalMs = 5_000;
const pollIntervalMs = integerSetting(
  'ALLRICE_WORKER_POLL_INTERVAL_MS',
  1000,
  100,
  60_000,
);
// MET-223: LISTEN/NOTIFY wakeups only add earlier ticks; '0' falls back to
// the poll alone. The poll keeps its interval because the same tick also runs
// maintainQueue (lease expiry, retry release) and covers lost announcements.
const queueWakeupEnabled =
  integerSetting('ALLRICE_WORKER_QUEUE_WAKEUP', 1, 0, 1) === 1;
const queueWakeupProbeMs = integerSetting(
  'ALLRICE_WORKER_QUEUE_WAKEUP_PROBE_MS',
  30_000,
  1_000,
  600_000,
);
const queueWakeupTimeoutMs = integerSetting(
  'ALLRICE_WORKER_QUEUE_WAKEUP_TIMEOUT_MS',
  10_000,
  1_000,
  120_000,
);
const leaseMs = integerSetting(
  'ALLRICE_WORKER_LEASE_MS',
  30_000,
  1_000,
  300_000,
);
const heartbeatMs = integerSetting(
  'ALLRICE_WORKER_HEARTBEAT_MS',
  Math.max(500, Math.floor(leaseMs / 3)),
  250,
  Math.max(250, leaseMs - 100),
);
process.env.ALLRICE_SERVICE_ROLE = 'worker';
const capacity = detectWorkerCapacity();
const concurrency = capacity.concurrency;
const memoryGate = createMemoryGate({ settings: memoryGateSettings() });
const workerId = UuidSchema.parse(
  process.env.ALLRICE_WORKER_ID ?? randomUUID(),
);
const executionRoot = process.env.ALLRICE_EXECUTION_ROOT ?? '.local/executions';
const codexAuthorizationBroker = new CodexAuthorizationBroker(
  workerId,
  executionRoot,
);
const serviceBuildIdentity = await startup.run('service_identity', (observe) =>
  readServiceBuildIdentity('worker', { bootId: startup.bootId, observe }),
);
// The expected content ID comes from the reviewed deployment/image release,
// not the manifest's own claim. Verify before any producer can consume work.
const nativeArtifact = await startup.run('native_primary', (observe) =>
  installDshNativeArtifact({
    root: fileURLToPath(new URL('../../..', import.meta.url)),
    expectedId: process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID ?? '',
    observe,
    ...(serviceBuildIdentity
      ? {
          sourceSha: serviceBuildIdentity.sourceSha,
          sourceTree: serviceBuildIdentity.sourceTree,
        }
      : {}),
  }),
);
// Provider probes/authentication also use the configured profile before a Run
// reaches the pool. Reject unapproved deployment overrides before producers.
await startup.run('native_launch_policy', () => {
  checkedDshNativeLaunch(configuredDshNativeLaunch());
  if (nativeArtifact.generation !== DSH_INSTALLED_DISTRIBUTION.generation)
    throw Error('DSH_NATIVE_ARTIFACT_GENERATION');
  const ignored = checkRetiredDshNativeSettings();
  if (ignored.length)
    console.info('[MET-221] ignoring retired native settings', ignored);
});
// Before any producer: this build must read every journal already written,
// and the database then records its contract as the high-water (MET-221).
const nativeJournalContract = await startup.run('native_journal_contract', () =>
  recordNativeJournalContract(NATIVE_JOURNAL_CONTRACT),
);
const nativeCloseIdentity = await observeDshWorkerCloseIdentity({
  workerId,
  workerBootId: startup.bootId,
  entrypoint: import.meta.url,
  nativeArtifactId: nativeArtifact.artifactId,
  serviceBuildIdentity,
});
installDshCloseObservationIdentity(nativeCloseIdentity.identity);
console.info('[MET-195] worker native close identity', nativeCloseIdentity);
const nativeOnceControlSource = configuredNativeOnceControlSource();
startup.mark('verification_checks_completed');
const producerLifecycle = await startup.run('producer_lifecycle', () =>
  installDevProducerLifecycle('worker'),
);
// MET-223: a timer delivery dispatches its occurrence now; the automation poll
// stays the fallback.
const nativeOnceControl = createNativeOnceWorkerService({
  workerId,
  source: nativeOnceControlSource,
  readMaintenance: readDevMaintenance,
  onDelivery: () => requestAutomationTick(),
});
const nativeRecurringControl = createNativeOnceWorkerService({
  workerId,
  source: configuredNativeRecurringControlSource(),
  readMaintenance: readDevMaintenance,
  onDelivery: () => requestAutomationTick(),
});
const nativeScheduleControls = [nativeOnceControl, nativeRecurringControl];
const maintenanceDiagnosticRuntime =
  process.env.ALLRICE_MAINTENANCE_CENTRAL_ENABLED === '1'
    ? await startup.run('maintenance_diagnostics', () =>
        captureMaintenanceDiagnosticRuntime(serviceBuildIdentity),
      )
    : null;

const stopPressureLog = startExecutionPressureLog(
  executionRoot,
  workerId,
  capacity,
);
let databaseReady = false;
let lastDatabaseError: string | undefined;
let stopping = false;
const runProducer = workerProducerRunner(producerLifecycle, () => stopping);
// Idle DSH close writes durable close receipts; never start one unready.
getHarnessRouter().setIdleCloseGate(() => databaseReady && !stopping);
const maintenanceReportingAborter = new AbortController();
let platformEmployeeTestTask: Promise<void> | null = null;
const activeExecutions = new Set<Promise<void>>();
const activeAborters = new Set<() => void>();
let platformEmployeeTestAborter: AbortController | null = null;
const mcpDiscoveryAborter = new AbortController();
let mcpDiscoveryTask: Promise<void> | null = null;
let cloudRecoveryTask: Promise<void> | null = null;
let managedCloudTask: Promise<unknown> | null = null;
function managedCloudTick() {
  if (
    managedCloudTask ||
    stopping ||
    !databaseReady ||
    !runtimeFeatureEnabled('ALLRICE_RUNTIME_POLICY_ENABLED')
  )
    return;
  managedCloudTask = runProducer('managed_cloud', () =>
    refreshManagedCloudEnvironments(workerId),
  )
    .catch(() => console.error('[MET-159] managed cloud preparation failed'))
    .finally(() => {
      managedCloudTask = null;
    });
}
let mcpRecoveryTask: Promise<void> | null = null;
function mcpRecoveryTick() {
  if (mcpRecoveryTask || stopping || !databaseReady) return;
  mcpRecoveryTask = runProducer('mcp_recovery', () =>
    recoverMcpRuntimeOperations(),
  )
    .then(() => undefined)
    .catch(() => {
      console.error('[P16] MCP recovery failed');
    })
    .finally(() => {
      mcpRecoveryTask = null;
    });
}
function cloudRecoveryTick() {
  if (cloudRecoveryTask || stopping || !databaseReady) return;
  cloudRecoveryTask = runProducer('cloud_recovery', () =>
    recoverCloudCommandOperations(),
  )
    .then(() => undefined)
    .catch(() => {
      console.error('[P15] cloud recovery failed');
    })
    .finally(() => {
      cloudRecoveryTask = null;
    });
}
function mcpDiscoveryTick() {
  if (
    mcpDiscoveryTask ||
    stopping ||
    !databaseReady ||
    !runtimeFeatureEnabled('ALLRICE_CLOUD_MCP_ENABLED')
  )
    return;
  mcpDiscoveryTask = runProducer('mcp_discovery', () =>
    executeNextMcpDiscovery({
      workerId,
      signal: mcpDiscoveryAborter.signal,
    }),
  )
    .then(() => undefined)
    .catch(() => {
      console.error('[P16] MCP discovery failed');
    })
    .finally(() => {
      mcpDiscoveryTask = null;
    });
}

async function refreshReadiness() {
  try {
    for (const control of nativeScheduleControls)
      if (control.enabled) await control.admissionOpen();
    await pingDatabase();
    await queueSummary();
    databaseReady = true;
    lastDatabaseError = undefined;
  } catch (error) {
    databaseReady = false;
    lastDatabaseError =
      error instanceof Error ? error.message : 'Unknown database error';
  }
}

let codexProbeTask: Promise<void> | null = null;
let firstProviderProbe = true;
function refreshCodexProviderStatus() {
  if (codexProbeTask || stopping) return codexProbeTask;
  const observation = firstProviderProbe
    ? startup.start('provider_probes')
    : undefined;
  firstProviderProbe = false;
  let admitted = false;
  codexProbeTask = runProducer('provider_probe', async () => {
    admitted = true;
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    for (const slot of [1, 2] as const) {
      const codex = await probeDshCodexProvider(executionRoot, slot);
      await recordCodexProviderStatus(codex, slot);
    }
  })
    .then(() => {
      if (admitted) observation?.complete();
      else observation?.skip();
    })
    .catch((error) => {
      observation?.fail(error);
      console.error('[M5] Codex provider probe failed', {
        message: error instanceof Error ? error.message : 'codex_probe_failed',
      });
    })
    .finally(() => {
      codexProbeTask = null;
    });
  return codexProbeTask;
}

let codexAuthorizationTask: Promise<void> | null = null;
function codexAuthorizationTick() {
  if (
    codexAuthorizationTask ||
    stopping ||
    !databaseReady ||
    codexAuthorizationBroker.hasUnconfirmedClose()
  )
    return;
  codexAuthorizationTask = runProducer('provider_authorization', async () => {
    await codexAuthorizationBroker.tick();
  })
    .catch(() => console.error('[MET-167] authorization lifecycle failed'))
    .finally(() => {
      codexAuthorizationTask = null;
    });
}

let dshInventoryTask: Promise<void> | null = null;
function refreshDshRuntimeInventory() {
  if (stopping || dshInventoryTask) return;
  dshInventoryTask = Promise.allSettled([
    Promise.resolve().then(() =>
      recordWorkerCapabilities(readWorkerCapabilities(workerId)),
    ),
    replaceWorkerDshRuntimeInventory({
      workerId,
      // This registry owns chat sessions. Private background adapters are
      // scoped to their leased Job and closed with its isolated directory.
      runtimes: getHarnessRouter()
        .runtimeInventory()
        .flatMap((runtime) =>
          runtime.sessionId === null
            ? []
            : [{ ...runtime, sessionId: runtime.sessionId }],
        ),
    }),
  ])
    .then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        console.error('[MET-90] DSH runtime inventory sync failed');
    })
    .finally(() => {
      dshInventoryTask = null;
    });
}

const httpAborter = new AbortController();
const nativeRunDiagnosticsHttp = createNativeRunDiagnosticsHttpHandler(
  undefined,
  undefined,
  httpAborter.signal,
);
const server = createServer(async (request, response) => {
  if (await nativeRunDiagnosticsHttp(request, response, stopping)) return;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  if (/^[a-f0-9]{40}$/.test(process.env.ALLRICE_RELEASE_SHA ?? ''))
    response.setHeader(
      'x-allrice-release-sha',
      process.env.ALLRICE_RELEASE_SHA!,
    );

  if (request.url === '/health/live') {
    response.statusCode = 200;
    response.end(JSON.stringify(makeHealthResponse('worker', 'live')));
    return;
  }

  if (request.url === '/health/ready') {
    let maintenance;
    try {
      maintenance = await readDevMaintenance();
      for (const control of nativeScheduleControls)
        await control.observeMaintenance(maintenance);
    } catch {
      await Promise.allSettled(
        nativeScheduleControls.map((control) => control.stop()),
      );
      response.writeHead(503);
      response.end(
        JSON.stringify(
          makeHealthResponse(
            'worker',
            'not_ready',
            'dev_maintenance_unavailable',
          ),
        ),
      );
      return;
    }
    const nativeOnceStatus = nativeOnceControl.status();
    const nativeOnceBlocked =
      nativeOnceStatus.state === 'blocked' ||
      (nativeOnceStatus.state === 'cold' &&
        'lastFault' in nativeOnceStatus &&
        nativeOnceStatus.lastFault?.phase === 'initialization');
    const nativeOnceRestartRequired =
      nativeOnceControl.enabled &&
      nativeOnceStatus.state === 'closed' &&
      (!maintenance || maintenance.state === 'open');
    const nativeRecurringStatus = nativeRecurringControl.status();
    const nativeRecurringBlocked =
      nativeRecurringStatus.state === 'blocked' ||
      (nativeRecurringStatus.state === 'cold' &&
        'lastFault' in nativeRecurringStatus &&
        nativeRecurringStatus.lastFault?.phase === 'initialization');
    const nativeRecurringRestartRequired =
      nativeRecurringControl.enabled &&
      nativeRecurringStatus.state === 'closed' &&
      (!maintenance || maintenance.state === 'open');
    const ready =
      databaseReady &&
      !nativeOnceBlocked &&
      !nativeOnceRestartRequired &&
      !nativeRecurringBlocked &&
      !nativeRecurringRestartRequired;
    response.statusCode = ready ? 200 : 503;
    if (ready) response.once('finish', () => startup.mark('health_ready'));
    response.end(
      JSON.stringify({
        ...makeHealthResponse(
          'worker',
          ready ? 'ready' : 'not_ready',
          nativeOnceBlocked
            ? 'native_once_blocked'
            : nativeOnceRestartRequired
              ? 'native_once_restart_required'
              : nativeRecurringBlocked
                ? 'native_recurring_blocked'
                : nativeRecurringRestartRequired
                  ? 'native_recurring_restart_required'
                  : lastDatabaseError,
        ),
        ...(serviceBuildIdentity ? { identity: serviceBuildIdentity } : {}),
        nativeCloseIdentity,
        nativeArtifact,
        nativeJournalContract,
        queueWakeup: queueWakeup?.status() ?? { state: 'disabled' },
        ...(nativeOnceControl.enabled
          ? { nativeOnceControl: nativeOnceStatus }
          : {}),
        ...(nativeRecurringControl.enabled
          ? { nativeRecurringControl: nativeRecurringStatus }
          : {}),
        ...(maintenance ? { maintenance } : {}),
        ...(maintenance
          ? { producerLifecycle: readDevProducerLifecycle('worker') }
          : {}),
      }),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found' }));
});

async function runClaimed(jobId: string, leaseToken: string) {
  let abort: () => void = () => undefined;
  activeAborters.add(abort);
  try {
    await executeClaimedJob({
      workerId,
      jobId,
      leaseToken,
      leaseMs,
      heartbeatMs,
      executionRoot,
      stopping: () => stopping,
      onAbortReady(nextAbort) {
        activeAborters.delete(abort);
        abort = nextAbort;
        activeAborters.add(abort);
      },
    });
  } finally {
    activeAborters.delete(abort);
  }
}

const queueTicks = createCoalescedTick(
  runQueueTick,
  () => !stopping && databaseReady,
);
function tick() {
  return queueTicks.tick();
}
async function runQueueTick() {
  try {
    await runProducer(
      'ordinary_consumer',
      async (scope: DevProducerContext) => {
        startup.mark('ordinary_consumer_entered');
        await maintainQueue();
        await claimUnderMemoryGate({
          gate: memoryGate,
          concurrency,
          active: () => activeExecutions.size,
          stopping: () => stopping,
          claim: (options) => claimNextJob(workerId, leaseMs, options),
          start(job, leaseToken) {
            const execution = scope
              .child(async () => runClaimed(job.id, leaseToken))
              .catch((error: unknown) => {
                console.error('[M5] Worker execution failed', {
                  jobId: job.id,
                  message:
                    error instanceof Error ? error.message : 'unknown error',
                });
              })
              .finally(() => {
                activeExecutions.delete(execution);
                // A freed slot or a released follow-up need not wait a poll.
                queueTicks.request();
              });
            activeExecutions.add(execution);
          },
        });
      },
    );
  } catch (error) {
    databaseReady = false;
    lastDatabaseError =
      error instanceof Error ? error.message : 'Unknown queue error';
  }
}

const automationTicks = createCoalescedTick(
  runAutomationTick,
  () => !stopping && databaseReady,
);
function automationTick() {
  return automationTicks.tick();
}
function requestAutomationTick() {
  automationTicks.request();
}
async function runAutomationTick() {
  let admitted = false;
  try {
    // workerProducerRunner swallows maintenance refusal. Observe it outside that
    // wrapper too, so a native Schedule timer cannot outlive closed admission.
    // Its own admission still guards the independent producers below. A once
    // Host fault must not starve existing automations or reference ingestion.
    for (const control of nativeScheduleControls)
      if (control.enabled) {
        await control.admissionOpen().catch((error: unknown) => {
          console.error('[M6] native schedule admission failed', {
            message: error instanceof Error ? error.message : 'unknown error',
          });
        });
      }
    await runProducer('automation', async () => {
      admitted = true;
      if (stopping) return;
      for (const control of nativeScheduleControls)
        await control
          .tick()
          .then((result) => {
            // MET-223: a capped burst continues at once, not a second later.
            if (result?.limitReached) requestAutomationTick();
          })
          .catch((error: unknown) => {
            console.error('[M6] native schedule scheduler failed', {
              message: error instanceof Error ? error.message : 'unknown error',
            });
          });
      if (stopping) return;
      await processNextReference(
        process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
      );
      await syncAutomationRuns();
      await processFolderTriggerEvents(Math.max(1, concurrency));
      const limit = Math.max(1, concurrency);
      for (const id of await recoverExperienceOccurrences(limit)) {
        try {
          await dispatchExperienceOccurrence(id);
        } catch {
          /* Durable failure retained by dispatcher. */
        }
      }
      const recovered = await recoverPlatformQualityOccurrences(limit);
      if (recovered > 0) {
        console.info('[M6] recovered quality occurrences', {
          count: recovered,
        });
      }
      // Reuse this background producer, keeping collection off the foreground
      // claim/completion path. It persists evidence without any model calls.
      if (!stopping) {
        await collectPendingExperienceEvidence();
        await syncExperienceConsolidationSchedules();
        await syncExperienceValidations();
        await syncExperienceAdoptions();
      }
    });
    if (!admitted)
      await Promise.all(
        nativeScheduleControls.map((control) => control.stop()),
      );
  } catch (error) {
    console.error('[M6] automation scheduler failed', {
      message: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

let maintenanceReportingTask: Promise<void> | null = null;
let maintenanceDiagnosisNextAt = 0;
function maintenanceReportingTick() {
  if (
    maintenanceReportingTask ||
    stopping ||
    !databaseReady ||
    (!process.env.ALLRICE_MAINTENANCE_CONNECTION_FILE &&
      !maintenanceDiagnosticRuntime)
  )
    return;
  maintenanceReportingTask = runProducer('automation', async () => {
    await runMaintenanceReportingProducer({
      signal: maintenanceReportingAborter.signal,
    });
    if (Date.now() >= maintenanceDiagnosisNextAt) {
      maintenanceDiagnosisNextAt = Date.now() + 60000;
      await runMaintenanceDiagnosisTick(
        maintenanceDiagnosticRuntime,
        maintenanceReportingAborter.signal,
      );
      await runMaintenanceExecutionTick(maintenanceReportingAborter.signal);
    }
  })
    .catch(() =>
      console.error('[MET-167] maintenance report database outcome unknown'),
    )
    .finally(() => {
      maintenanceReportingTask = null;
    });
}

function platformEmployeeTestTick() {
  if (platformEmployeeTestTask || stopping || !databaseReady)
    return platformEmployeeTestTask;
  platformEmployeeTestTask = runPlatformEmployeeTestTick().finally(() => {
    platformEmployeeTestTask = null;
  });
  return platformEmployeeTestTask;
}
async function runPlatformEmployeeTestTick() {
  const aborter = new AbortController();
  platformEmployeeTestAborter = aborter;
  try {
    await runProducer('employee_test', () =>
      executeNextPlatformEmployeeTest({
        workerId,
        executionRoot,
        signal: aborter.signal,
      }),
    );
  } catch (error) {
    console.error('[MET-93] platform employee test failed', {
      message: error instanceof Error ? error.message : 'unknown error',
    });
  } finally {
    platformEmployeeTestAborter = null;
  }
}

const databaseReadinessObservation = startup.start('database_readiness');
await refreshReadiness();
if (databaseReady) databaseReadinessObservation.complete();
else databaseReadinessObservation.fail();
const authorizationRecoveryObservation = startup.start(
  'provider_authorization_recovery',
);
let authorizationRecoveryAdmitted = false;
try {
  await runProducer('provider_authorization', async () => {
    authorizationRecoveryAdmitted = true;
    await recoverCodexAuthorizationFlows();
  });
  if (authorizationRecoveryAdmitted)
    authorizationRecoveryObservation.complete();
  else authorizationRecoveryObservation.skip();
} catch (error) {
  authorizationRecoveryObservation.fail(error);
  throw error;
}
await refreshCodexProviderStatus();
const readinessTimer = setInterval(async () => {
  const wasReady = databaseReady;
  await refreshReadiness();
  // MET-223: a resubscription sweep is dropped while the database is unready.
  if (!wasReady && databaseReady) queueTicks.request();
}, readinessIntervalMs);
const codexProviderStatusTimer = setInterval(
  () => void refreshCodexProviderStatus(),
  codexProviderStatusIntervalMs,
);
const dshRuntimeInventoryTimer = setInterval(
  () => void refreshDshRuntimeInventory(),
  dshRuntimeInventoryIntervalMs,
);
const queueTimer = setInterval(() => void tick(), pollIntervalMs);
const mcpDiscoveryTimer = setInterval(mcpDiscoveryTick, pollIntervalMs);
const cloudRecoveryTimer = setInterval(cloudRecoveryTick, 10_000);
const managedCloudTimer = setInterval(managedCloudTick, 60_000);
const mcpRecoveryTimer = setInterval(mcpRecoveryTick, 10_000);
const automationTimer = setInterval(() => {
  void automationTick();
  maintenanceReportingTick();
}, pollIntervalMs);
const platformEmployeeTestTimer = setInterval(
  () => void platformEmployeeTestTick(),
  pollIntervalMs,
);
const codexAuthorizationTimer = setInterval(
  codexAuthorizationTick,
  pollIntervalMs,
);
void tick();
void automationTick();
const queueWakeup = queueWakeupEnabled
  ? startQueueWakeups({
      listen: (onReady, onListen, { signal }) =>
        listenForReadyJobs(onReady, onListen, {
          signal,
          timeoutMs: queueWakeupTimeoutMs,
        }),
      probe: probeReadyJobs,
      wake: () => queueTicks.request(),
      probeIntervalMs: queueWakeupProbeMs,
      probeTimeoutMs: queueWakeupTimeoutMs,
    })
  : null;
maintenanceReportingTick();
void platformEmployeeTestTick();
codexAuthorizationTick();
void refreshDshRuntimeInventory();
managedCloudTick();

const cloudPreviewTransport = process.env.ALLRICE_CLOUD_PREVIEW_SOCKET
  ? await startCloudProjectPreviewTransport(
      process.env.ALLRICE_CLOUD_PREVIEW_SOCKET,
    )
  : null;
const httpListenObservation = startup.start('http_listen');
server.listen(port, '0.0.0.0', () => {
  httpListenObservation.complete();
  startup.mark('http_listening');
  console.info(`[M5] AllRice worker 0.1.0 listening on ${port}`, {
    workerId,
    concurrency,
    capacity,
    leaseMs,
  });
});

let shutdownTask: Promise<void> | undefined;
function shutdown(signal: string) {
  if (shutdownTask) return shutdownTask;
  startup.mark('shutdown_requested');
  stopping = true;
  // Fence preview admission before waiting for commands or service shutdown.
  const previewClosing = startWorkerShutdownTask(() =>
    cloudPreviewTransport?.close(),
  );
  // stop() fences further once ticks/consumer admission synchronously, then
  // drains the current tick, public Schedule/SDK/root, both backends and writes.
  const nativeClosing = nativeScheduleControls.map((control) =>
    startWorkerShutdownTask(() => control.stop()),
  );
  shutdownTask = (async () => {
    console.info(`[M5] received ${signal}; stopping worker`);
    stopping = true;
    const fenceTasks = [
      { name: 'pressure_log', run: stopPressureLog },
      { name: 'queue_wakeup', run: () => queueWakeup?.stop() },
      { name: 'mcp_abort', run: () => mcpDiscoveryAborter.abort() },
      {
        name: 'maintenance_abort',
        run: () => maintenanceReportingAborter.abort(),
      },
      {
        name: 'employee_test_abort',
        run: () => platformEmployeeTestAborter?.abort(),
      },
      {
        name: 'http_server',
        run: () =>
          new Promise<void>((resolve, reject) => {
            httpAborter.abort();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      },
      ...[...activeAborters].map((abort, index) => ({
        name: `execution_abort_${index}`,
        run: abort,
      })),
    ].map(({ name, run }) => ({ name, task: startWorkerShutdownTask(run) }));
    clearInterval(readinessTimer);
    clearInterval(codexProviderStatusTimer);
    clearInterval(dshRuntimeInventoryTimer);
    clearInterval(queueTimer);
    clearInterval(mcpDiscoveryTimer);
    clearInterval(cloudRecoveryTimer);
    clearInterval(managedCloudTimer);
    clearInterval(mcpRecoveryTimer);
    clearInterval(automationTimer);
    clearInterval(platformEmployeeTestTimer);
    clearInterval(codexAuthorizationTimer);
    await closeWorkerResources({
      drainTasks: [
        ...fenceTasks.map(({ name, task }) => ({ name, run: () => task })),
        {
          name: 'executions',
          run: async () => {
            // A claim already awaiting SQL can publish its execution after the
            // first abort snapshot. Drain that tick, then abort/wait the new set.
            const results: PromiseSettledResult<unknown>[] =
              await Promise.allSettled([queueTicks.current()]);
            results.push(
              ...(await Promise.allSettled(
                [...activeAborters].map((abort) =>
                  startWorkerShutdownTask(abort),
                ),
              )),
            );
            results.push(...(await Promise.allSettled([...activeExecutions])));
            const errors = results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : [],
            );
            if (errors.length)
              throw new AggregateError(
                errors,
                'Execution drain remains unconfirmed',
              );
          },
        },
        { name: 'preview', run: () => previewClosing },
        { name: 'mcp_discovery', run: () => mcpDiscoveryTask },
        { name: 'cloud_recovery', run: () => cloudRecoveryTask },
        { name: 'managed_cloud', run: () => managedCloudTask },
        { name: 'mcp_recovery', run: () => mcpRecoveryTask },
        {
          name: 'authorization_close',
          run: () => codexAuthorizationBroker.close(),
        },
        { name: 'authorization_tick', run: () => codexAuthorizationTask },
        { name: 'provider_probe', run: () => codexProbeTask },
        { name: 'maintenance_reporting', run: () => maintenanceReportingTask },
        ...nativeClosing.map((task, index) => ({
          name: `native_control_${index}`,
          run: () => task,
        })),
        { name: 'automation', run: () => automationTicks.current() },
        { name: 'employee_test', run: () => platformEmployeeTestTask },
      ],
      waitForProducerRoots: () => producerLifecycle.waitForCurrentRoots(),
      stopCloudProjects: stopCloudProjectServices,
      closeHarness: closeHarnessAdapters,
      waitForInventory: async () => {
        await dshInventoryTask;
      },
      verifyRuntimeClosure: async () => {
        try {
          const summary = await verifyWorkerDshRuntimeClosure({
            ...nativeCloseIdentity.identity,
            runtimeInventory: () => getHarnessRouter().runtimeInventory(),
            closureInventory: () =>
              getHarnessRouter().runtimeClosureInventory(),
          });
          console.info('[MET-195] native close readback', summary);
        } catch (error) {
          if (error instanceof DshWorkerCloseError)
            console.error('[MET-195] native close unconfirmed', error.summary);
          throw error;
        }
      },
      removeCapabilities: () => removeWorkerCapabilities(workerId),
      closeDatabase,
    });
    process.exit(0);
  })();
  return shutdownTask;
}

const stopWorker = (signal: string) => {
  void shutdown(signal).catch((error) => {
    console.error('[M5] shutdown incomplete; resource closure unconfirmed', {
      failedStages:
        error instanceof WorkerShutdownError
          ? error.failures.map(({ name }) => name)
          : ['shutdown_setup'],
    });
    process.exitCode = 1;
  });
};
process.on('SIGINT', () => stopWorker('SIGINT'));
process.on('SIGTERM', () => stopWorker('SIGTERM'));
