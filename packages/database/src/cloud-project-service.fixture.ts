/** Isolated ordinary-account scaffolding; readiness is always a real backend fact. */
import { createHash, randomUUID } from 'node:crypto';
import {
  ProjectVersionRefSchema,
  ProjectServiceStartInputSchema,
  CloudExecutionProfileSchema,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import { assistantFixtureStorage } from './assistant-runtime.fixture.ts';
import { createAssistantLocalCommandFixture } from './local-command-assistant.fixture.ts';
import { executeProjectWorkspace } from './project-workspace.ts';
import { selectProjectExecution } from './project-execution.ts';
import { createCloudProjectOperation } from './cloud-execution.ts';
import { getWorkAutomation, updateWorkAutomation } from './work-automation.ts';
import type { getDatabase } from './core/client.ts';
export async function cloudProjectServiceCandidate(
  db: ReturnType<typeof getDatabase>,
  options: {
    files?: { path: string; text: string }[];
    packages?: unknown[];
    args?: string[];
    callId?: string;
  } = {},
) {
  const f = await createAssistantLocalCommandFixture(db, 'allow', false, {
    skipChild: true,
    projectWorkspace: true,
    projectCloud: true,
  });
  const automation = await getWorkAutomation(f.requestContext, f.workspace, db);
  await updateWorkAutomation(
    f.requestContext,
    f.workspace,
    {
      expectedRevision: automation.revision,
      capability: 'computer',
      enabled: true,
    },
    db,
  );
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
  // No synthetic Bridge can satisfy this cloud acceptance.
  await db`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.device.id}`;
  await db`update allrice_execution_targets set state='offline' where target_key=${'bridge.' + f.device.id}`;
  const target = randomUUID(),
    grant = randomUUID(),
    profile = CloudExecutionProfileSchema.parse({
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      architecture: 'amd64',
      imageDigest: cloudToolchainImageV1,
      network: 'none',
      maximumConcurrency: 2,
      runtimeVersion: 'release-20260831.0',
      runtimeChecksum:
        'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
    });
  await db`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata) values(${target},${f.org},${f.workspace},${'cloud-project-' + target},'cloud_sandbox','Isolated cloud project fixture','online',${db.json(['process.execute'])},'{}')`;
  await db`insert into allrice_cloud_execution_grants(id,organization_id,workspace_id,owner_id,target_id,version,profile,enabled) values(${grant},${f.org},${f.workspace},${f.user},${target},1,${db.json(profile)},true)`;
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
  const callId = options.callId ?? randomUUID();
  return {
    ...f,
    storage,
    assistantWorker: f.worker,
    worker,
    project,
    command,
    callId,
    grant,
    target,
  };
}
export async function cloudProjectServiceFixture(
  db: ReturnType<typeof getDatabase>,
  options: Parameters<typeof cloudProjectServiceCandidate>[1] = {},
) {
  const f = await cloudProjectServiceCandidate(db, options);
  const { callId, worker, command, storage } = f;
  const selection = await selectProjectExecution(
    {
      context: f.context,
      arguments: command,
      callId,
      worker,
      cloudReady: true,
    },
    db,
  );
  const created = await createCloudProjectOperation(
    {
      context: f.context,
      callId,
      worker,
      storage,
      projectSelection: selection,
    },
    db,
  );
  if (created.snapshot.status === 'waiting_user')
    await f.approve(
      await f.approvalFor(created.snapshot.binding.attempt.operationId),
    );
  return { ...f, created, id: created.snapshot.binding.attempt.operationId };
}
