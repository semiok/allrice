import { createHash, randomUUID } from 'node:crypto';
import {
  ProjectVersionRefSchema,
  managedPythonPayloadForPlatform,
  localCommandToolchainImageV1,
  ProjectServiceStartInputSchema,
  projectServiceLimits,
  RuntimeLocalCommandSchema,
} from '@allrice/contracts';
import { assistantFixtureStorage } from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { executeProjectWorkspace } from './project-workspace.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { getWorkAutomation, updateWorkAutomation } from './work-automation.ts';
import { selectProjectExecution } from './project-execution.ts';
import { createLocalCommandOperation } from './local-command-service.ts';
import type { getDatabase } from './core/client.ts';
/** Account/Job scaffolding only. Physical execution is collected separately. */
export async function projectServiceFixture(
  db: ReturnType<typeof getDatabase>,
  automation = false,
  options: {
    architecture?: 'amd64' | 'arm64';
    files?: { path: string; text: string }[];
    packages?: unknown[];
    args?: string[];
    markReady?: boolean;
  } = {},
) {
  const f = await createAssistantLocalCommandFixture(db, 'allow', false, {
    skipChild: true,
    projectWorkspace: true,
  });
  const architecture = options.architecture ?? 'amd64',
    platform = architecture === 'arm64' ? 'macos-arm64' : 'macos-x64';
  if (architecture === 'arm64') {
    f.device.platform = platform;
    await db`update allrice_bridge_devices set platform=${platform} where id=${f.device.id}`;
  }
  if (automation) {
    const value = await getWorkAutomation(f.requestContext, f.workspace, db);
    await updateWorkAutomation(
      f.requestContext,
      f.workspace,
      {
        expectedRevision: value.revision,
        capability: 'computer',
        enabled: true,
      },
      db,
    );
  }
  const storage = assistantFixtureStorage(db),
    [job] = await db<
      { attempt: number }[]
    >`select attempt from allrice_jobs where id=${f.context.jobId}`;
  const worker = { attempt: job!.attempt, leaseToken: f.worker.leaseToken };
  const files = options.files ?? [
    {
      path: 'main.cjs',
      text: "require('node:http').createServer((q,s)=>s.end('source:42')).listen(4173,'127.0.0.1')\n",
    },
    {
      path: 'package.json',
      text: '{"name":"service-fixture","version":"1.0.0","packageManager":"pnpm@10.33.3"}',
    },
    {
      path: 'pnpm-lock.yaml',
      text: "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n",
    },
  ];
  const opened = (await executeProjectWorkspace(
    {
      context: f.context,
      sessionId: f.task.chatSessionId!,
      worker,
      callId: randomUUID(),
      arguments: { action: 'open', files },
    },
    storage,
    db,
  )) as { project: unknown; sourceDigest: string };
  const project = ProjectVersionRefSchema.parse(opened.project);
  await reportLocalCommandProfile(
    f.device,
    {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      imageDigest: localCommandToolchainImageV1,
      architecture,
      available: true,
      features: [
        'project_preparation',
        'saved_project_source',
        'background_services',
        'project_services',
      ],
      projectPreparation: {
        version: 1,
        available: true,
        nodeImage: localCommandToolchainImageV1,
        pythonImage: managedPythonPayloadForPlatform(platform)!.imageId,
        pnpmVersion: '10.33.3',
        uvVersion: '0.8.22',
      },
    },
    db,
  );
  await db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment}',${db.json({ version: 1, clientVersion: '0.6.0-dev.33', browser: 'unavailable', sandbox: 'ready', preview: 'unavailable', paused: false, readiness: [{ capability: 'local.process', state: 'ready', reason: 'synthetic_fixture', missing: [], versions: {}, observedAt: new Date().toISOString() }] })}) where target_key=${'bridge.' + f.device.id}`;
  const command = ProjectServiceStartInputSchema.parse({
    action: 'service_start',
    project,
    service: { port: 4173, leaseMs: 600000 },
    executable: '/usr/local/bin/node',
    args: options.args ?? ['main.cjs'],
    path: '.',
    limits: {
      timeoutMs: 60000,
      outputBytes: 32768,
      memoryMiB: 512,
      cpuMillis: 1000,
      pids: 64,
    },
    projectPreparation: {
      version: 1,
      projectId: project.projectId,
      sourceDigest: opened.sourceDigest,
      lockChecksum:
        'sha256:' +
        createHash('sha256')
          .update(files.find((f) => f.path === 'pnpm-lock.yaml')!.text)
          .digest('hex'),
      manager: 'pnpm',
      managerVersion: '10.33.3',
      lockPath: 'pnpm-lock.yaml',
      offline: !options.packages?.length,
      scripts: 'disabled',
      packages: options.packages ?? [],
    },
  });
  const callId = randomUUID(),
    selection = await selectProjectExecution(
      {
        context: f.context,
        arguments: command,
        callId,
        worker,
        cloudReady: false,
      },
      db,
    );
  const { action: _action, service: _service, ...localArguments } = command;
  void _action;
  void _service;
  const op = await createLocalCommandOperation(
    {
      context: f.context,
      callId,
      worker,
      storage,
      projectSelection: selection,
      arguments: {
        ...localArguments,
        background: {
          durationMs: projectServiceLimits.maximumLifetimeMs,
          readiness: { kind: 'http', port: 4173, path: '/', timeoutMs: 30000 },
          stdin: {
            mode: 'none',
            maxRequests: 1,
            maxBytes: 1,
            requestTimeoutMs: 1000,
          },
          projectService: command.service,
        },
      },
    },
    db,
  );
  if (op.snapshot.status === 'waiting_user')
    await f.approve(
      await f.approvalFor(op.snapshot.binding.attempt.operationId),
    );
  const ledger = f.freshLedger(),
    id = op.snapshot.binding.attempt.operationId;
  const lease = await ledger.dispatch({
    scope: f.task.scope,
    operationId: id,
    leaseOwner: randomUUID(),
    leaseMs: 30000,
  });
  const identity = {
    scope: f.task.scope,
    operationId: id,
    attempt: lease.snapshot.binding.attempt,
    leaseToken: lease.leaseToken,
  };
  await ledger.startOperation({ ...identity, receiptId: randomUUID() });
  const exchange = (
    events: Parameters<typeof ledger.exchangeLocalService>[0]['events'] = [],
    sourceReceipts?: { updateId: string; sourceDigest: string }[],
  ) =>
    ledger.exchangeLocalService({
      ...identity,
      events,
      ...(sourceReceipts ? { sourceReceipts } : {}),
    });
  const first = await exchange(),
    event = { processId: id, attemptId: identity.attempt.attemptId };
  if (options.markReady !== false)
    await exchange([
      {
        ...event,
        type: 'starting',
        sequence: 0,
        containerId: 'a'.repeat(64),
        hardDeadlineAt: first.hardDeadlineAt,
      },
      {
        ...event,
        type: 'ready',
        sequence: 1,
        port: 4173,
        visibility: 'container_only',
      },
    ]);
  const [stored] = await db<
    { bridge_payload: unknown }[]
  >`select bridge_payload from allrice_runtime_operations where id=${id}`;
  return {
    ...f,
    storage,
    worker,
    assistantWorker: f.worker,
    project,
    command,
    callId,
    op,
    id,
    identity,
    ledger,
    exchange,
    first,
    dispatchSnapshot: lease.snapshot,
    dispatchLeaseExpiresAt: lease.leaseExpiresAt,
    payload: RuntimeLocalCommandSchema.parse(stored!.bridge_payload),
  };
}
