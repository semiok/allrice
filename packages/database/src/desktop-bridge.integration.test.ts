import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BridgeDeviceSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  type RequestContext,
} from '@allrice/contracts';
import { BridgeJournal } from '../../../apps/rice-bridge/src/journal.js';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import {
  testImage,
  testSocket,
} from '../../../apps/rice-bridge/test/toolchain.js';
import { createRuntimeBridgeHttpHandler } from '../../../apps/web/lib/bridge/operation-http.js';
import {
  createLocalCommandOperation,
  listLocalCommandOperations,
} from './local-command-service.ts';
import { createGovernedBridgeOperationLedger } from './runtime-governed-bridge.ts';
import { reportLocalCommandProfile } from './local-command-profile.ts';
import {
  bridgeDeviceStatus,
  heartbeatBridgeDevice,
  claimNextBridgeCommand,
  claimNextBridgeWorkspaceSelection,
} from './bridge.ts';
import {
  decideRuntimeActionApproval,
  setRuntimePolicyControls,
  runtimePolicyDigest as digest,
} from './runtime-policy.ts';
import type * as Client from './core/client.ts';

let database: ReturnType<typeof postgres>, admin: ReturnType<typeof postgres>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => database,
}));
const schema = `p13_desktop_${randomUUID().replaceAll('-', '')}`;
const enabled =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET === testSocket;
const suite = enabled ? describe.sequential : describe.skip;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
async function wait(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  maximumMs = 20000,
) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw Error(`P13 governed desktop timed out: ${label}`);
}

/** Independent fixture following runtime-governed-bridge patterns, not importing tests. */
async function fixture(root: string) {
  const org = randomUUID(),
    workspace = randomUUID(),
    owner = randomUUID(),
    membership = randomUUID(),
    policy = randomUUID(),
    run = randomUUID(),
    employee = randomUUID(),
    version = randomUUID(),
    assignment = randomUUID(),
    session = randomUUID(),
    job = randomUUID(),
    worker = randomUUID(),
    deviceId = randomUUID(),
    grant = randomUUID(),
    target = randomUUID();
  const now = new Date().toISOString(),
    token = `p13-synthetic-${randomUUID()}`;
  const memberships = [
    {
      id: membership,
      organizationId: org,
      workspaceId: workspace,
      userId: owner,
      role: 'admin' as const,
      active: true,
    },
  ];
  const policyPayload = {
    memberships,
    grants: [
      { resourceType: 'job', action: 'job:execute', workspaceId: workspace },
    ],
  };
  const context: RequestContext = {
    actor: { type: 'user', id: owner },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    memberships,
    authenticatedAt: now,
  };
  const capabilities = ['model:invoke', 'storage:read', 'storage:write'];
  const frozen = EmployeeExecutionSnapshotSchema.parse({
    schemaVersion: 1,
    employee: {
      id: employee,
      versionId: version,
      key: 'p13-desktop',
      revision: 1,
      definitionChecksum: digest('p13'),
      definition: {
        schemaVersion: 1,
        key: 'p13-desktop',
        name: 'P13 synthetic',
        description: 'Synthetic only',
        systemPrompt: 'Synthetic only',
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
      id: assignment,
      userId: owner,
      assignedBy: owner,
      assignedAt: now,
    },
    runtimePolicy: {
      harness: 'dsh',
      provider: 'openai-codex',
      model: 'synthetic',
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
        toolNames: ['local.process.execute'],
        knowledgeScopes: ['workspace'],
        workflowIds: [],
      },
      skillBindings: [],
    },
    tenantContext: {
      organizationId: org,
      workspaceId: workspace,
      actorId: owner,
      policySnapshotId: policy,
    },
    userProfile: {
      schemaVersion: 1,
      displayName: 'P13 synthetic',
      preferences: {},
    },
    createdAt: now,
  });
  const fingerprint = sha(root);
  await database.begin(async (tx) => {
    await tx`insert into allrice_users(id,email,display_name,password_hash) values(${owner},${`${owner}@example.test`},'P13 synthetic','not-login')`;
    await tx`insert into allrice_organizations(id,slug,name) values(${org},${`p13-${org}`},'P13 synthetic')`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','P13 synthetic')`;
    await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membership},${org},${workspace},${owner},'admin')`;
    await tx`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values(${policy},${org},${owner},1,${tx.json(policyPayload)},clock_timestamp()+interval '1 hour')`;
    await tx`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,policy_snapshot_id,execution_spec,input) values(${run},${org},${workspace},${owner},'running',${policy},${tx.json({ employeeVersionId: version })},'{}')`;
    await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employee},${org},${workspace},'p13-desktop','P13 synthetic')`;
    await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest) values(${version},${org},${workspace},${employee},1,'P13','synthetic','synthetic','[]',${digest('p13')},'{}')`;
    await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignment},${org},${workspace},${employee},${version},${owner})`;
    await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${session},${org},${workspace},${owner},'P13 governed pause',${assignment},${version})`;
    const userMessage = randomUUID(),
      answer = randomUUID();
    await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${userMessage},${org},${workspace},${session},${owner},'user','{"text":"synthetic task","citations":[]}'),(${answer},${org},${workspace},${session},${owner},'assistant','{"text":"synthetic task","citations":[]}')`;
    await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,execution_snapshot) values(${run},${org},${workspace},${owner},${assignment},${version},${session},${userMessage},${answer},'{}','{}',${tx.json(JSON.parse(JSON.stringify(frozen)))})`;
    await tx`insert into allrice_conversation_runtimes(organization_id,workspace_id,session_id,owner_id,thread_generation,config_checksum,state,active_run_id,worker_id) values(${org},${workspace},${session},${owner},1,${digest('p13')},'running',${run},${worker})`;
    await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at) values(${job},${org},${workspace},${owner},${run},'running',${randomUUID()},clock_timestamp()+interval '5 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${worker},${randomUUID()},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes')`;
    await tx`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at) values(${deviceId},${org},${workspace},${owner},'P13 synthetic',${process.arch === 'arm64' ? 'macos-arm64' : 'macos-x64'},2,array['local.fs.read'],${sha(token)},clock_timestamp())`;
    await tx`insert into allrice_bridge_folder_grants(id,organization_id,workspace_id,owner_id,device_id,label,root_fingerprint) values(${grant},${org},${workspace},${owner},${deviceId},'P13 synthetic workspace',${fingerprint})`;
    await tx`insert into allrice_execution_targets(id,organization_id,workspace_id,target_key,kind,label,state,capabilities,metadata) values(${target},${org},${workspace},${`bridge.${deviceId}`},'rice_bridge','P13 synthetic','online','["files.read","files.write"]',${tx.json({ bridgeDeviceId: deviceId })})`;
  });
  await setRuntimePolicyControls(
    context,
    {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: [{ action: 'local.process.execute', effect: 'allow' }],
    },
    null,
    database,
  );
  const device = BridgeDeviceSchema.parse(
    (await bridgeDeviceStatus(token)).device,
  );
  const runner = new LocalCommandRunner({
    socketPath: testSocket,
    imageDigest: testImage,
  });
  const profile = await runner.preflight();
  await reportLocalCommandProfile(
    device,
    { contractVersion: 1, ...profile, available: true },
    database,
  );
  const execution = ExecutionContextSchema.parse({
    executionId: randomUUID(),
    runId: run,
    jobId: job,
    worker: { type: 'worker', id: worker },
    delegatedBy: context.actor,
    organizationId: org,
    workspaceId: workspace,
    policySnapshot: {
      id: policy,
      organizationId: org,
      subjectId: owner,
      version: 1,
      issuedAt: now,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      ...policyPayload,
    },
    startedAt: now,
  });
  return { context, device, token, grant, fingerprint, execution, run, runner };
}

suite(
  'P13 desktop core / actual PostgreSQL approval and local VM pause',
  () => {
    beforeAll(async () => {
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      if (
        url.pathname !== '/allrice_b2' ||
        !['localhost', '127.0.0.1'].includes(url.hostname)
      )
        throw Error(
          'P13 requires the dedicated local allrice_b2 test database',
        );
      vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
      vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '1');
      vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
      admin = postgres(url.toString(), { max: 2, onnotice: () => {} });
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(20260907,1)`;
        await tx`create extension if not exists vector with schema public`;
        await tx`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      database = postgres(url.toString(), { max: 12, onnotice: () => {} });
      const directory = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await database.unsafe(await readFile(new URL(file, directory), 'utf8'));
    }, 60000);
    afterAll(async () => {
      await database?.end();
      if (admin) {
        if (!/^p13_desktop_[a-f0-9]{32}$/.test(schema))
          throw Error('invalid synthetic schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      vi.unstubAllEnvs();
    });
    it('asks first, runs only the exact approved task, pauses real work and retains/reconciles its outbox without replay', async () => {
      const temporary = await realpath(
          await mkdtemp(join(tmpdir(), 'allrice-p13-governed-')),
        ),
        root = join(temporary, 'workspace');
      await mkdir(root);
      const source =
        'console.log("P13_GOVERNED_TASK_STARTED");setInterval(()=>{},1000);';
      await writeFile(join(root, 'task.mjs'), source);
      const f = await fixture(root);
      const created = await createLocalCommandOperation(
        {
          context: f.execution,
          callId: 'p13-exact-approved-task',
          arguments: {
            executable: '/usr/local/bin/node',
            args: ['task.mjs'],
            path: '.',
            files: [{ path: 'task.mjs', sha256: `sha256:${sha(source)}` }],
            limits: {
              timeoutMs: 60000,
              outputBytes: 8192,
              memoryMiB: 128,
              cpuMillis: 500,
              pids: 32,
            },
          },
        },
        database,
      );
      const { operationId, attemptId } = created.snapshot.binding.attempt;
      let blockReceipts = true,
        receiptAttempts = 0,
        operationPolls = 0;
      const receiptResponses: { status: number; code: string | null }[] = [];
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: bridgeDeviceStatus,
        ledgerForDevice: async (device) =>
          createGovernedBridgeOperationLedger(device, { database }),
      });
      const server = createServer((req, res) => {
        void (async () => {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          const path = new URL(req.url ?? '/', 'http://localhost').pathname,
            body = raw ? JSON.parse(raw) : {};
          const token = String(req.headers.authorization ?? '').replace(
            /^Bearer /,
            '',
          );
          res.setHeader('content-type', 'application/json');
          if (path.startsWith('/api/v1/bridge/device/operations/')) {
            const action = path.split('/').at(-1)! as
              'next' | 'start' | 'receipts' | 'heartbeat' | 'output';
            if (action === 'next') operationPolls++;
            if (action === 'receipts') {
              receiptAttempts++;
              if (blockReceipts) {
                res.statusCode = 503;
                res.end('{"error":{"message":"synthetic receipt outage"}}');
                return;
              }
            }
            const response = await handler(
              new Request(`http://localhost${path}`, {
                method: 'POST',
                headers: {
                  authorization: String(req.headers.authorization ?? ''),
                  'content-type': 'application/json',
                },
                body: raw || '{}',
              }),
              action,
              path.split('/').at(-2),
            );
            res.statusCode = response.status;
            const responseText = await response.text();
            if (action === 'receipts') {
              const parsed = JSON.parse(responseText) as {
                error?: { code?: unknown };
              };
              receiptResponses.push({
                status: response.status,
                code:
                  typeof parsed.error?.code === 'string'
                    ? parsed.error.code
                    : null,
              });
            }
            res.end(responseText);
          } else if (path.endsWith('/heartbeat'))
            res.end(
              JSON.stringify({
                device: await heartbeatBridgeDevice(token, body),
              }),
            );
          else if (path.endsWith('/runtime-profile')) {
            await reportLocalCommandProfile(
              (await bridgeDeviceStatus(token)).device,
              body,
              database,
            );
            res.end('{}');
          } else if (path.endsWith('/workspace-selections/next'))
            res.end(
              JSON.stringify({
                request: await claimNextBridgeWorkspaceSelection(token),
              }),
            );
          else if (path.endsWith('/commands/next'))
            res.end(
              JSON.stringify({ command: await claimNextBridgeCommand(token) }),
            );
          else {
            res.statusCode = 404;
            res.end('{}');
          }
        })().catch(() => {
          res.statusCode = 500;
          res.end('{"error":{"message":"synthetic fixture failed"}}');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('fixture listener');
      const origin = `http://127.0.0.1:${address.port}/`,
        configPath = join(temporary, 'config.json');
      const config = {
        deviceId: f.device.id,
        deviceName: 'P13 governed synthetic',
        server: origin,
        grants: [
          {
            id: f.grant,
            label: 'P13 synthetic workspace',
            rootPath: root,
            rootFingerprint: f.fingerprint,
          },
        ],
      };
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await writeFile(
        `${configPath}.sandbox.json`,
        JSON.stringify({
          version: 1,
          enabled: true,
          deviceId: f.device.id,
          server: origin,
        }),
        { mode: 0o600 },
      );
      const binary = process.env.ALLRICE_P13_TEST_CORE;
      const child: ChildProcessWithoutNullStreams = spawn(
        binary ?? process.execPath,
        binary
          ? ['desktop']
          : [
              '--import',
              'tsx',
              resolve('apps/rice-bridge/src/index.ts'),
              'desktop',
            ],
        {
          cwd: resolve('.'),
          env: {
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            PATH: process.env.PATH,
            ALLRICE_BRIDGE_CONFIG_PATH: configPath,
            ALLRICE_BRIDGE_DEVICE_TOKEN: f.token,
            TSX_TSCONFIG_PATH: resolve('tsconfig.base.json'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const frames: {
        type: string;
        id?: string;
        ok?: boolean;
        state?: { mode: string; activeForeground: number };
        data?: {
          mode: string;
          activeForeground: number;
          pendingReceipts: number;
        };
      }[] = [];
      let buffer = '',
        serial = 0;
      child.stderr.resume();
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n'),
            line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          frames.push(JSON.parse(line));
        }
      });
      const request = async (type: string) => {
        const id = `p13-${++serial}`;
        child.stdin.write(JSON.stringify({ v: 1, id, type }) + '\n');
        await wait(
          () => frames.some((frame) => frame.id === id),
          `desktop ${type}`,
        );
        return frames.find((frame) => frame.id === id)!;
      };
      const containers = () =>
        f.runner.api.json<{ Id: string; State: string }[]>(
          'GET',
          `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`xyz.bplabs.allrice.attempt=${attemptId}`] }))}`,
        );
      let journal: BridgeJournal | undefined;
      try {
        expect(created.snapshot.status).toBe('waiting_user');
        await wait(() => operationPolls > 0, 'preapproval polling');
        await delay(500);
        expect(await containers()).toEqual([]);
        const [pending] = await listLocalCommandOperations(
          f.context,
          f.run,
          database,
        );
        const approval = pending!.approval!.request;
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
          decision: 'approved' as const,
        };
        await expect(
          decideRuntimeActionApproval(
            f.context,
            approval.approvalId,
            { ...response, requestDigest: `sha256:${'0'.repeat(64)}` },
            database,
          ),
        ).rejects.toThrow();
        await expect(
          listLocalCommandOperations(
            { ...f.context, organizationId: randomUUID() },
            f.run,
            database,
          ),
        ).rejects.toThrow();
        await decideRuntimeActionApproval(
          f.context,
          approval.approvalId,
          response,
          database,
        );
        await wait(
          async () =>
            (await containers()).some((row) => row.State === 'running'),
          'real running container',
        );
        await wait(
          async () =>
            (
              await listLocalCommandOperations(f.context, f.run, database)
            )[0]?.output.some((row) =>
              row.content.includes('P13_GOVERNED_TASK_STARTED'),
            ) ?? false,
          'durable running output',
        );
        expect((await request('status')).data?.activeForeground).toBe(1);
        expect((await request('pause')).ok).toBe(true);
        const status = (await request('status')).data!;
        expect(status).toMatchObject({ mode: 'paused', activeForeground: 0 });
        expect(status.pendingReceipts).toBeGreaterThan(0);
        expect(receiptAttempts).toBeGreaterThan(0);
        expect(
          (await containers()).filter((row) => row.State === 'running'),
        ).toEqual([]);
        journal = await BridgeJournal.open({
          directory: `${configPath}.operation-journal`,
          server: origin,
          deviceId: f.device.id,
        });
        const outbox = await journal.pending();
        const stoppedReceipt = outbox.find(
          (receipt) => receipt.signal.type === 'operation.stopped',
        );
        if (
          !stoppedReceipt ||
          stoppedReceipt.signal.type !== 'operation.stopped'
        )
          throw Error('P13 pause did not preserve its actual stopped receipt');
        const stoppedSignal = stoppedReceipt.signal;
        const scope = created.snapshot.binding.task.scope;
        const ledger = createGovernedBridgeOperationLedger(f.device, {
          database,
        });
        // Receipt validation cannot turn invented facts, another image/tenant
        // or an invalid lease into a stopped operation. Each rejected receipt
        // has its own ID; the actual durable outbox receipt is left untouched.
        const receiptInput = {
          ...stoppedReceipt!,
          scope,
          operationId,
        };
        for (const output of [
          { stopped: true },
          {
            ...(stoppedReceipt!.evidence as { output: object }).output,
            stopped: false,
          },
          {
            ...(stoppedReceipt!.evidence as { output: object }).output,
            imageDigest: `sha256:${'0'.repeat(64)}`,
          },
          {
            ...(stoppedReceipt!.evidence as { output: object }).output,
            reason: 'exited',
          },
        ])
          await expect(
            ledger.recordReceipt({
              ...receiptInput,
              receiptId: randomUUID(),
              evidence: { output },
            }),
          ).rejects.toThrow('invalid_state');
        await expect(
          ledger.recordReceipt({
            ...receiptInput,
            receiptId: randomUUID(),
            signal: { ...stoppedSignal, effects: 'partial' },
          }),
        ).rejects.toThrow('invalid_state');
        await expect(
          ledger.recordReceipt({
            ...receiptInput,
            receiptId: randomUUID(),
            leaseToken: randomUUID(),
          }),
        ).rejects.toThrow('lease_lost');
        await expect(
          ledger.recordReceipt({
            ...receiptInput,
            receiptId: randomUUID(),
            scope: { ...scope, organizationId: randomUUID() },
          }),
        ).rejects.toThrow('scope_mismatch');
        expect((await ledger.readOperation(scope, operationId)).status).toBe(
          'running',
        );
        await journal.close();
        journal = undefined;
        blockReceipts = false;
        const pollsBeforeResume = operationPolls;
        expect((await request('resume')).ok).toBe(true);
        await wait(async () => {
          const [view] = await listLocalCommandOperations(
            f.context,
            f.run,
            database,
          );
          const [rejected] = await database<
            { disposition: string }[]
          >`select disposition from allrice_runtime_operation_receipts where operation_id=${operationId} and disposition in ('conflict','stale') limit 1`;
          if (rejected)
            throw Error(
              `Stopped receipt rejected: ${JSON.stringify({ status: view?.snapshot.status, disposition: rejected.disposition, http: receiptResponses })}`,
            );
          return view?.snapshot.status === 'canceled';
        }, 'durable stopped receipt');
        await wait(
          () => operationPolls >= pollsBeforeResume + 2,
          'resumed work polling without replay',
        );
        expect(await containers()).toEqual([]);
        expect((await request('pause')).ok).toBe(true);
        journal = await BridgeJournal.open({
          directory: `${configPath}.operation-journal`,
          server: origin,
          deviceId: f.device.id,
        });
        expect(await journal.pending()).toEqual([]);
        await journal.close();
        journal = undefined;
        expect((await ledger.recordReceipt(receiptInput)).disposition).toBe(
          'duplicate',
        );
        const [counts] = await database<
          { starts: number; stops: number; cancels: number }[]
        >`select count(*) filter(where payload->'signal'->>'type'='operation.started')::int starts,count(*) filter(where payload->'signal'->>'type'='operation.stopped')::int stops,count(*) filter(where payload->'signal'->>'type'='operation.cancel_requested')::int cancels from allrice_runtime_operation_events where operation_id=${operationId}`;
        expect(counts).toEqual({ starts: 1, stops: 1, cancels: 1 });
        const [view] = await listLocalCommandOperations(
          f.context,
          f.run,
          database,
        );
        expect(view!.evidence).toMatchObject({
          output: { stopped: true, reason: 'canceled' },
        });
        expect(view!.snapshot.binding.task.scope).toEqual({
          organizationId: f.context.organizationId,
          workspaceId: f.context.workspaceId,
          projectId: null,
        });
        expect(view!.snapshot.binding.requestedBy).toEqual(f.context.actor);
        expect(view!.approval!.response).toMatchObject({
          decision: 'approved',
          respondedBy: f.context.actor.id,
          requestDigest: approval.requestDigest,
        });
        expect(await readFile(join(root, 'task.mjs'), 'utf8')).toBe(source);
        expect((await request('stop')).ok).toBe(true);
        await wait(() => child.exitCode !== null, 'core clean exit');
        expect(child.exitCode).toBe(0);
      } finally {
        await journal?.close();
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.end();
          await wait(
            () => child.exitCode !== null || child.signalCode !== null,
            'owned core cleanup',
          );
        }
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        // Only containers carrying this exact synthetic attempt label are touched.
        for (const container of await containers()) {
          const owned = await f.runner.inspect(attemptId, container.Id);
          if (owned.State.Running)
            await f.runner.api.json(
              'POST',
              `/containers/${container.Id}/kill?signal=SIGKILL`,
            );
          await f.runner.cleanup(attemptId, container.Id);
        }
        await rm(temporary, { recursive: true });
      }
    }, 120000);
  },
);
