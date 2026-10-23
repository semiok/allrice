import { processNextReference } from './reference-processing.js';
import { startCloudProjectPreviewTransport } from './cloud-runner/project-preview-transport.js';
import { runtimeFeatureEnabled } from '@allrice/contracts';
import { startExecutionPressureLog } from './execution-pressure.js';
import { detectWorkerCapacity } from './worker-capacity.js';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';

import { UuidSchema, makeHealthResponse } from '@allrice/contracts';
import {
  runMaintenanceExecutionTick,
  processFolderTriggerEvents,
  claimNextJob,
  closeDatabase,
  maintainQueue,
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
  markWorkerDshRuntimesOffline,
  replaceWorkerDshRuntimeInventory,
  syncAutomationRuns,
  recordWorkerCapabilities,
  removeWorkerCapabilities,
  readServiceBuildIdentity,
  readDevMaintenance,
  installDevProducerLifecycle,
  readDevProducerLifecycle,
  type DevProducerContext,
} from '@allrice/database';

import {
  CodexAuthorizationBroker,
  probeDshCodexProvider,
} from './codex-auth-broker.js';
import { executeClaimedJob } from './runtime.js';
import {
  installDshNativeArtifact,
  checkedDshNativeLaunch,
} from './harness/dsh-native-artifact.js';
import { configuredDshNativeLaunch } from './harness/dsh/runtime-pool.js';
import {
  installConfiguredDshNativeRetention,
  verifyConfiguredDshNativeReferences,
} from './harness/dsh-native-retention.js';
import { fileURLToPath } from 'node:url';
import { closeHarnessAdapters, getHarnessRouter } from './harness/router.js';
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
  if (
    process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID &&
    (nativeArtifact.artifactId !==
      process.env.ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID ||
      nativeArtifact.generation !== 'dsh-0.2.1-rc.2-687f282')
  )
    throw Error('DSH_NATIVE_ARTIFACT_NEW_ROOT_APPROVAL');
});
const retainedSpans = new Map<number, ReturnType<typeof startup.start>>();
const retainedNativeArtifacts = await startup.run('native_retention', () =>
  installConfiguredDshNativeRetention({
    observe(event) {
      if (event.kind === 'started')
        retainedSpans.set(
          event.slot,
          startup.start('native_retained_slot', { slot: event.slot }),
        );
      else if (event.kind === 'metric')
        retainedSpans.get(event.slot)?.observe(event.metric);
      else {
        const span = retainedSpans.get(event.slot);
        if (event.kind === 'failed') span?.fail(event.error);
        else span?.complete();
        retainedSpans.delete(event.slot);
      }
    },
  }),
);
const nativeArtifactReferenceCoverage = await startup.run(
  'native_reference_coverage',
  () => verifyConfiguredDshNativeReferences(nativeArtifact),
);
const nativeOnceControlSource = configuredNativeOnceControlSource();
startup.mark('verification_checks_completed');
const producerLifecycle = await startup.run('producer_lifecycle', () =>
  installDevProducerLifecycle('worker'),
);
const nativeOnceControl = createNativeOnceWorkerService({
  workerId,
  source: nativeOnceControlSource,
  readMaintenance: readDevMaintenance,
});
const nativeRecurringControl = createNativeOnceWorkerService({
  workerId,
  source: configuredNativeRecurringControlSource(),
  readMaintenance: readDevMaintenance,
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
const maintenanceReportingAborter = new AbortController();
let tickRunning = false;
let automationTask: Promise<void> | null = null;
let platformEmployeeTestTickRunning = false;
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
  if (codexAuthorizationTask || stopping || !databaseReady) return;
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

const server = createServer(async (request, response) => {
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
        nativeArtifact,
        retainedNativeArtifacts,
        nativeArtifactReferenceCoverage,
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

async function tick() {
  if (tickRunning || stopping || !databaseReady) return;
  tickRunning = true;
  try {
    await runProducer(
      'ordinary_consumer',
      async (scope: DevProducerContext) => {
        startup.mark('ordinary_consumer_entered');
        await maintainQueue();
        while (!stopping && activeExecutions.size < concurrency) {
          if ((process.availableMemory?.() ?? Infinity) < 256 * 1024 ** 2)
            break;
          const job = await claimNextJob(workerId, leaseMs, {
            allowBackground:
              concurrency > 1 && activeExecutions.size < concurrency - 1,
          });
          const leaseToken = job?.lease?.token;
          if (!job || !leaseToken) break;
          const execution = scope
            .child(async () => runClaimed(job.id, leaseToken))
            .catch((error: unknown) => {
              console.error('[M5] Worker execution failed', {
                jobId: job.id,
                message:
                  error instanceof Error ? error.message : 'unknown error',
              });
            })
            .finally(() => activeExecutions.delete(execution));
          activeExecutions.add(execution);
        }
      },
    );
  } catch (error) {
    databaseReady = false;
    lastDatabaseError =
      error instanceof Error ? error.message : 'Unknown queue error';
  } finally {
    tickRunning = false;
  }
}

function automationTick() {
  if (automationTask || stopping || !databaseReady) return automationTask;
  automationTask = runAutomationTick().finally(() => {
    automationTask = null;
  });
  return automationTask;
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
        await control.tick().catch((error: unknown) => {
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

async function platformEmployeeTestTick() {
  if (platformEmployeeTestTickRunning || stopping || !databaseReady) return;
  platformEmployeeTestTickRunning = true;
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
    platformEmployeeTestTickRunning = false;
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
const readinessTimer = setInterval(
  () => void refreshReadiness(),
  readinessIntervalMs,
);
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
  const previewClosing = cloudPreviewTransport?.close();
  void previewClosing?.catch(() => undefined);
  // stop() fences further once ticks/consumer admission synchronously, then
  // drains the current tick, public Schedule/SDK/root, both backends and writes.
  const nativeOnceClosing = Promise.all(
    nativeScheduleControls.map((control) => control.stop()),
  );
  void nativeOnceClosing.catch(() => undefined);
  shutdownTask = (async () => {
    console.info(`[M5] received ${signal}; stopping worker`);
    stopping = true;
    stopPressureLog();
    clearInterval(readinessTimer);
    clearInterval(codexProviderStatusTimer);
    clearInterval(dshRuntimeInventoryTimer);
    clearInterval(queueTimer);
    clearInterval(mcpDiscoveryTimer);
    clearInterval(cloudRecoveryTimer);
    clearInterval(managedCloudTimer);
    clearInterval(mcpRecoveryTimer);
    mcpDiscoveryAborter.abort();
    maintenanceReportingAborter.abort();
    clearInterval(automationTimer);
    clearInterval(platformEmployeeTestTimer);
    clearInterval(codexAuthorizationTimer);
    for (const abort of activeAborters) abort();
    platformEmployeeTestAborter?.abort();
    server.close();
    await Promise.allSettled(activeExecutions);
    await stopCloudProjectServices();
    await previewClosing;
    if (mcpDiscoveryTask) await mcpDiscoveryTask;
    if (cloudRecoveryTask) await cloudRecoveryTask;
    if (managedCloudTask) await managedCloudTask;
    if (mcpRecoveryTask) await mcpRecoveryTask;
    await codexAuthorizationBroker.close();
    await codexAuthorizationTask;
    await codexProbeTask;
    await maintenanceReportingTask;
    await nativeOnceClosing;
    await automationTask;
    await producerLifecycle.waitForCurrentRoots();
    await closeHarnessAdapters();
    await dshInventoryTask;
    await markWorkerDshRuntimesOffline(workerId).catch(() => undefined);
    await removeWorkerCapabilities(workerId).catch(() => undefined);
    await closeDatabase();
    process.exit(0);
  })();
  return shutdownTask;
}

const stopWorker = (signal: string) => {
  void shutdown(signal).catch(() => {
    console.error('[M5] shutdown incomplete; resource closure unconfirmed');
    process.exitCode = 1;
  });
};
process.on('SIGINT', () => stopWorker('SIGINT'));
process.on('SIGTERM', () => stopWorker('SIGTERM'));
