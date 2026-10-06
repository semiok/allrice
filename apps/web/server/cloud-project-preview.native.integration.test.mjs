/** Opt-in real runsc, native DSH/Broker, PostgreSQL, private IPC and Chrome.
 * Ordinary isolated accounts and a fixed project; no paid model or Bridge. */
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL } from 'node:url';
/* global document */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect, vi } from 'vitest';
import { ProjectServiceViewSchema } from '@allrice/contracts';
import { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { cloudProjectServiceCandidate } from '../../../packages/database/src/cloud-project-service.fixture.ts';
import {
  readProjectService,
  projectServiceUserAction,
  createProjectPreviewAccess,
  resolveProjectPreviewAccess,
} from '../../../packages/database/src/project-services.ts';
import { listCloudRuntimeOperations } from '../../../packages/database/src/cloud-operation-view.ts';
import { completeJob } from '../../../packages/database/src/execution/queue.ts';
import { runProjectWorkspace } from '../../worker/src/tool-broker/handlers/project.ts';
import { nativeBrokerRoundtrip } from '../../worker/src/harness/dsh-native-broker.fixture.ts';
import { CloudRunnerBackend } from '../../worker/src/cloud-runner/backend.ts';
import { startCloudProjectPreviewTransport } from '../../worker/src/cloud-runner/project-preview-transport.ts';
import {
  stopCloudProjectServices,
  recoverCloudCommandOperations,
} from '../../worker/src/cloud-runner/executor.ts';
import { AllRiceHttpServer } from '../server.mjs';
import { createProjectPreviewGateway } from './project-preview.mjs';
import { createCloudProjectPreviewTransport } from './cloud-project-preview.mjs';
import { CloudOperationCard } from '../app/chatflow/cloud-operation-panel.tsx';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContainerProjectPreviewRelay } from '@allrice/project-runtime';
let database;
vi.mock('../../../packages/database/src/core/client.ts', async (original) => ({
  ...(await original()),
  getDatabase: () => database,
}));
const require = createRequire(
  new URL('../../rice-bridge/package.json', import.meta.url),
);
const { parse: yaml } = require('yaml'),
  { chromium } = require('playwright-core');
const suite =
  process.env.ALLRICE_RUN_CLOUD_PROJECT_SERVICE_NATIVE === '1'
    ? describe.sequential
    : describe.skip;
const until = async (predicate, timeoutMs = 90000) => {
  const end = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > end) throw Error('cloud native condition timed out');
    await delay(150);
  }
};
suite('cloud project first complete native chain', () => {
  it('no Bridge: native parameters, runsc readiness, HTTP/modules/WS/HMR, post-Run lease and physical stop', async () => {
    let fixture, server, ipc, transport, browser, f;
    const owned = await mkdtemp('/tmp/ar5b-'),
      proof = {
        passed: false,
        startedAt: new Date().toISOString(),
        wiring: [],
        ordinaryAccount: true,
        noBridge: true,
        noPaidModel: true,
      };
    try {
      for (const key of [
        'ASSISTANTS',
        'WORKBENCH',
        'RUNTIME_POLICY',
        'CLOUD_RUNNER',
        'LOCAL_COMMAND',
        'LOCAL_SERVICE',
        'BRIDGE_OPERATION_LEDGER',
      ])
        vi.stubEnv('ALLRICE_' + key + '_ENABLED', '1');
      vi.stubEnv('ALLRICE_CLOUD_PREVIEW_SOCKET', join(owned, 'ipc', 'p.sock'));
      fixture = await createAssistantFixtureDatabase();
      database = fixture.db;
      const folder = new URL(
          '../../rice-bridge/test/project-service-vite/',
          import.meta.url,
        ),
        names = [
          'package.json',
          'pnpm-lock.yaml',
          'index.html',
          'main.js',
          'vite.config.js',
        ];
      const files = await Promise.all(
          names.map(async (path) => ({
            path,
            text: await readFile(new URL(path, folder), 'utf8'),
          })),
        ),
        lock = yaml(files.find((x) => x.path === 'pnpm-lock.yaml').text);
      const packages = Object.entries(lock.packages).map(([key, value]) => {
        const at = key.lastIndexOf('@');
        return {
          name: key.slice(0, at),
          version: key.slice(at + 1),
          integrity: value.resolution.integrity,
        };
      });
      f = await cloudProjectServiceCandidate(database, {
        files,
        packages,
        args: ['node_modules/vite/bin/vite.js'],
        callId: 'call_1',
      });
      proof.project = f.project;
      const backend = new CloudRunnerBackend();
      await backend.preflight(undefined, true);
      const originalCall = CloudRunnerBackend.prototype.call;
      vi.spyOn(CloudRunnerBackend.prototype, 'call').mockImplementation(
        async function (method, path, body) {
          const result = await originalCall.call(this, method, path, body);
          if (
            method === 'POST' &&
            /^\/containers\/[a-f0-9]{64}\/start$/.test(path)
          )
            await delay(6500);
          return result;
        },
      );
      const originalArchive = CloudRunnerBackend.prototype.putArchive;
      vi.spyOn(CloudRunnerBackend.prototype, 'putArchive').mockImplementation(
        async function (id, bytes, signal) {
          if (
            Buffer.from(bytes).includes(Buffer.from('.allrice/staging-ready'))
          )
            await delay(6500);
          return originalArchive.call(this, id, bytes, signal);
        },
      );
      ipc = await startCloudProjectPreviewTransport(
        process.env.ALLRICE_CLOUD_PREVIEW_SOCKET,
        {
          database,
          backend,
          onError: (error) => {
            proof.relayErrors ??= [];
            proof.relayErrors.push(String(error));
          },
        },
      );
      transport = createCloudProjectPreviewTransport(
        process.env.ALLRICE_CLOUD_PREVIEW_SOCKET,
        {
          onError: (error) => {
            proof.frameErrors ??= [];
            proof.frameErrors.push(String(error));
          },
        },
      );
      server = new AllRiceHttpServer();
      // Node only emits upgrade when a listener exists. Next installs one in
      // production; model that registration here rather than sending WS as HTTP.
      server.on('upgrade', (_req, socket) => socket.destroy());
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port,
        origin = 'http://127.0.0.1:' + port,
        suffix = 'preview.allrice.test:' + port;
      vi.stubEnv('ALLRICE_PROJECT_PREVIEW_SUFFIX', suffix);
      server.previewGateway = createProjectPreviewGateway({
        suffix,
        mainOrigin: origin,
        secure: false,
        transport,
        resolveAccess: (id, token) =>
          resolveProjectPreviewAccess(id, token, database),
        onError: (error) => {
          proof.previewErrors ??= [];
          proof.previewErrors.push(String(error));
        },
      });
      const broker = async (args, callId = randomUUID()) =>
        runProjectWorkspace({
          arguments: args,
          input: {
            context: f.context,
            capabilities: [],
            storageRoot: f.storage.root,
            sessionId: f.session,
            managedBrowserJobAttempt: f.worker.attempt,
            managedBrowserJobLeaseToken: f.worker.leaseToken,
            call: { id: callId, name: 'workspace.project', arguments: args },
          },
        });
      let ready;
      proof.beforeNativeAt = new Date().toISOString();
      proof.diagnosticOnly =
        process.env.ALLRICE_CLOUD_PREVIEW_DIAGNOSTIC === '1';
      if (process.env.ALLRICE_CLOUD_PREVIEW_DIAGNOSTIC === '1') {
        ready = JSON.parse(
          (await broker(f.command, f.callId)).modelContent,
        ).service;
      } else {
        await nativeBrokerRoundtrip({
          timeoutMs: 120000,
          canonicalName: 'workspace.project',
          wireName: 'workspace_project',
          args: f.command,
          invalidArgs: { ...f.command, deviceId: randomUUID() },
          inspectSchema: (schema) => {
            expect(schema.properties).toHaveProperty('service');
            expect(schema.properties).not.toHaveProperty('projectSource');
          },
          onToolCall: async (call) => {
            proof.nativeCallAt = new Date().toISOString();
            expect(call.arguments).toMatchObject(f.command);
            const result = await broker(call.arguments, f.callId).catch(
              (error) => {
                proof.brokerError = String(error);
                throw error;
              },
            );
            ready = JSON.parse(result.modelContent).service;
            proof.readyAt = new Date().toISOString();
            return result;
          },
        });
      }
      proof.nativeFinishedAt = new Date().toISOString();
      expect(ProjectServiceViewSchema.parse(ready).state).toBe('ready');
      expect(ready.backend).toBe('cloud');
      f.id = ready.id;
      proof.serviceId = f.id;
      proof.delayedStartAndStagingMs = 6500;
      proof.wiring.push(
        proof.diagnosticOnly
          ? 'direct Broker diagnostic -> runsc supervisor -> durable readiness'
          : 'real native DSH schema -> Broker -> runsc supervisor -> durable readiness',
      );
      const details = await listCloudRuntimeOperations(
          f.requestContext,
          f.context.runId,
          database,
        ),
        op = details.find(
          (x) => x.snapshot.binding.attempt.operationId === f.id,
        );
      expect(ProjectServiceViewSchema.parse(op.projectService).id).toBe(f.id);
      const markup = renderToStaticMarkup(
        createElement(CloudOperationCard, {
          op,
          busy: false,
          onAct: () => {},
          projectServiceContext: {
            workspaceId: f.workspace,
            tenantHeaders: {},
            onChanged: () => {},
          },
        }),
      );
      expect(markup).toContain('打开预览');
      expect(markup).toContain('云端');
      proof.wiring.push('details API shape -> same ProjectServiceCard');
      const loginSession = randomUUID();
      await database`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${loginSession},${f.user},${createHash('sha256').update(randomUUID()).digest('hex')},clock_timestamp()+interval '1 hour')`;
      const token = await createProjectPreviewAccess(
          { ...f.requestContext, sessionId: loginSession },
          f.id,
          database,
        ),
        host = 'rice-preview-' + f.id + '.' + suffix;
      browser = await chromium.launch({
        headless: true,
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
          '--no-proxy-server',
          '--host-resolver-rules=MAP *.preview.allrice.test 127.0.0.1',
        ],
      });
      const page = await browser.newPage();
      const originalReceive = ContainerProjectPreviewRelay.prototype.receive;
      proof.socketIngress = [];
      proof.socketRelay = [];
      vi.spyOn(
        ContainerProjectPreviewRelay.prototype,
        'receive',
      ).mockImplementation(function (frame, send) {
        if (frame.type === 'preview.open' && frame.request.websocket)
          proof.socketIngress.push({
            ...frame.request,
            path: frame.request.path.replace(
              /([?&]token=)[^&]+/g,
              '$1[redacted]',
            ),
          });
        return originalReceive.call(this, frame, (response) => {
          if (
            (response.type === 'preview.response' && response.status === 101) ||
            (response.type === 'preview.data' && response.binary !== undefined)
          )
            proof.socketRelay.push({
              type: response.type,
              status: response.status,
              data:
                response.type === 'preview.data'
                  ? Buffer.from(response.data, 'base64')
                      .toString()
                      .slice(0, 150)
                  : undefined,
            });
          return send(response);
        });
      });
      proof.browserMessages = [];
      proof.socketFrames = [];
      proof.socketUrls = [];
      page.on('console', (message) => {
        if (message.text().includes('[vite]'))
          proof.browserMessages.push(message.text().slice(0, 400));
      });
      let connected = false;
      page.on('websocket', (socket) => {
        socket.on('socketerror', (error) => {
          proof.browserSocketErrors ??= [];
          proof.browserSocketErrors.push(String(error));
        });
        proof.socketUrls.push(
          socket.url().replace(/([?&]token=)[^&]+/g, '$1[redacted]'),
        );
        socket.on('framereceived', (frame) => {
          if (proof.socketFrames.length < 5)
            proof.socketFrames.push(String(frame.payload).slice(0, 150));
          if (String(frame.payload).includes('"type":"connected"'))
            connected = true;
        });
      });
      await page.goto('http://' + host + '/?_allrice_preview_ticket=' + token, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForFunction(() =>
        document.body.textContent.includes('42'),
      );
      await until(() => connected, 15000);
      proof.httpAndWebSocket = true;
      const changed = JSON.parse(
        (
          await broker({
            action: 'apply',
            expectedHead: f.project,
            proposal: {
              files: [
                {
                  path: 'main.js',
                  before: files.find((x) => x.path === 'main.js').text,
                  after: files
                    .find((x) => x.path === 'main.js')
                    .text.replace('42', '43'),
                },
              ],
            },
          })
        ).modelContent,
      );
      await broker({
        action: 'service_sync',
        serviceId: f.id,
        requestId: randomUUID(),
        expectedProject: f.project,
        project: changed.project,
      });
      await page.waitForFunction(() =>
        document.body.textContent.includes('43'),
      );
      proof.hmr = true;
      const finalized = await f.runtime.finalizeRoot({
        scope: f.task.scope,
        rootRunId: f.context.runId,
        worker: f.assistantWorker,
      });
      expect(finalized.status).toBe('completed');
      await completeJob({
        workerId: f.context.worker.id,
        jobId: f.context.jobId,
        leaseToken: f.worker.leaseToken,
        result: { answer: 'Preview ready' },
      });
      const [conversation] =
        await database`select state,active_run_id from allrice_conversation_runtimes where session_id=${f.task.chatSessionId}`;
      expect(conversation.state).toBe('idle');
      expect(conversation.active_run_id).toBeNull();
      await delay(70000);
      await recoverCloudCommandOperations({ database, backend });
      expect(
        (await readProjectService(f.requestContext, f.id, database)).state,
      ).toBe('ready');
      await page.reload();
      await page.waitForFunction(() =>
        document.body.textContent.includes('43'),
      );
      proof.continuesAfterRun = true;
      proof.survivesCommandCeilingAndMaintenance = true;
      await expect(
        projectServiceUserAction(
          { ...f.requestContext, actor: { type: 'user', id: randomUUID() } },
          f.id,
          { action: 'status' },
          database,
        ),
      ).rejects.toThrow();
      proof.foreignAccountDenied = true;
      const [attempt] =
        await database`select container_id,snapshot->'binding'->'attempt'->>'attemptId' as attempt_id from allrice_cloud_execution_attempts a join allrice_runtime_operations o on o.id=a.operation_id where a.operation_id=${f.id}`;
      await projectServiceUserAction(
        f.requestContext,
        f.id,
        { action: 'stop' },
        database,
      );
      await until(async () => {
        const [row] =
          await database`select cleanup_confirmed_at from allrice_cloud_execution_attempts where operation_id=${f.id}`;
        return !!row.cleanup_confirmed_at;
      });
      expect(await backend.inspect(attempt.attempt_id)).toBeNull();
      await expect(
        backend.json(
          'GET',
          '/volumes/allrice-project-work-' + attempt.attempt_id,
        ),
      ).rejects.toThrow('CLOUD_DAEMON_404');
      const resources = await backend.json('GET', '/containers/json?all=1');
      expect(
        resources.some(
          (c) =>
            c.Labels?.['xyz.bplabs.allrice.cloud.slot-owner'] ===
              attempt.attempt_id ||
            c.Labels?.['xyz.bplabs.allrice.project.fence-owner'] ===
              attempt.attempt_id,
        ),
      ).toBe(false);
      expect(
        (await readProjectService(f.requestContext, f.id, database)).stopped,
      ).toBe(true);
      proof.physicalCleanup = true;
      proof.passed = true;
    } finally {
      await stopCloudProjectServices();
      if (f && database)
        proof.finalOperations =
          await database`select o.id,o.snapshot->>'status' as status,a.outcome->>'reason' as reason,a.outcome->>'errorCode' as error_code,a.outcome->>'exitCode' as exit_code,left(a.outcome->>'output',500) as output_start,right(a.outcome->>'output',1500) as output_end,a.cleanup_confirmed_at from allrice_runtime_operations o left join allrice_cloud_execution_attempts a on a.operation_id=o.id where o.run_id=${f.context.runId}`;
      await browser?.close();
      await server?.previewGateway?.close();
      await transport?.close();
      await ipc?.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      proof.finishedAt = new Date().toISOString();
      if (process.env.ALLRICE_CLOUD_SERVICE_EVIDENCE)
        await writeFile(
          process.env.ALLRICE_CLOUD_SERVICE_EVIDENCE,
          JSON.stringify(proof, null, 2) + '\n',
          { mode: 0o600 },
        );
      await fixture?.close();
      await rm(owned, { recursive: true, force: true });
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  }, 240000);
});
