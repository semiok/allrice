/** Opt-in owned-VM acceptance, with real PostgreSQL, Broker, journal, WSS and
 * Chrome. The socket must be an owned VM (or its private SSH Unix forward).
 * Synthetic accounts are isolated and are not deployed tenant acceptance. */
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { URL } from 'node:url';
import { once } from 'node:events';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect, vi } from 'vitest';
import {
  ProjectVersionRefSchema,
  ProjectServiceViewSchema,
  RuntimeBridgeDispatchSchema,
  RuntimeLocalCommandProfileSchema,
  managedPythonPayloadForPlatform,
  localCommandToolchainImageV1,
} from '@allrice/contracts';
import { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { projectServiceFixture } from '../../../packages/database/src/project-service.fixture.ts';
import { createBridgeConnectionAuthority } from '../../../packages/database/src/bridge-connections.ts';
import { bridgeDeviceStatus } from '../../../packages/database/src/bridge.ts';
import { reportLocalCommandProfile } from '../../../packages/database/src/local-command-profile.ts';
import { createGovernedBridgeOperationLedger } from '../../../packages/database/src/runtime-governed-bridge.ts';
import {
  readProjectService,
  projectServiceUserAction,
  createProjectPreviewAccess,
  resolveProjectPreviewAccess,
} from '../../../packages/database/src/project-services.ts';
import { runProjectWorkspace } from '../../worker/src/tool-broker/handlers/project.ts';
import { BridgeJournal } from '../../rice-bridge/src/journal.ts';
import { LocalCommandRunner } from '../../rice-bridge/src/local-command-runner.ts';
import { localProcessManager } from '../../rice-bridge/src/local-process-manager.ts';
import { ProjectPreviewRelay } from '../../rice-bridge/src/project-preview-relay.ts';
import { BridgeDualTransport } from '../../rice-bridge/src/dual-transport.ts';
import { RuntimeBridgeOperationClient } from '../../rice-bridge/src/operation-client.ts';
import { createRuntimeBridgeHttpHandler } from '../lib/bridge/operation-http.ts';
import { AllRiceHttpServer } from '../server.mjs';
import {
  createBridgeLoopbackDispatch,
  createBridgeSocketGateway,
} from './bridge-socket.mjs';
import { createProjectPreviewGateway } from './project-preview.mjs';
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
  process.env.ALLRICE_RUN_PROJECT_SERVICE_NATIVE === '1'
    ? describe.sequential
    : describe.skip;
const until = async (predicate) => {
  const end = Date.now() + 90000;
  while (!(await predicate())) {
    if (Date.now() > end) throw Error('native service condition timed out');
    await delay(100);
  }
};
suite('project service first complete native chain', () => {
  it('Vite HTTP/modules/HMR, exact source receipt, completed Run lease, stop and physical cleanup', async () => {
    let fixture, server, transport, relay, journal, manager, browser, ticker;
    const owned = await mkdtemp(join(tmpdir(), 'allrice-pr5a-native-'));
    const proof = {
      startedAt: new Date().toISOString(),
      passed: false,
      scope: 'Isolated ordinary member fixture; native owned VM; no model task',
      wiring: [],
    };
    try {
      for (const key of [
        'ASSISTANTS',
        'WORKBENCH',
        'RUNTIME_POLICY',
        'BRIDGE_OPERATION_LEDGER',
        'LOCAL_COMMAND',
        'LOCAL_SERVICE',
        'BRIDGE_WSS',
      ])
        vi.stubEnv(`ALLRICE_${key}_ENABLED`, '1');
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
      );
      const lock = yaml(files.find((f) => f.path === 'pnpm-lock.yaml').text),
        packages = Object.entries(lock.packages).map(([key, value]) => {
          const at = key.lastIndexOf('@');
          return {
            name: key.slice(0, at),
            version: key.slice(at + 1),
            integrity: value.resolution.integrity,
          };
        });
      const architecture =
        process.env.ALLRICE_PROJECT_SERVICE_ARCHITECTURE ?? 'arm64';
      const f = await projectServiceFixture(database, true, {
        files,
        packages,
        architecture,
        args: ['node_modules/vite/bin/vite.js'],
        markReady: false,
      });
      proof.serviceId = f.id;
      proof.source = f.project;
      proof.wiring.push(
        'canonical selection and real ordinary-member operation',
      );
      const token = `pr5a-native-${randomUUID()}`;
      await database`update allrice_bridge_devices set token_hash=${createHash('sha256').update(token).digest('hex')} where id=${f.device.id}`;
      server = new AllRiceHttpServer();
      const handler = createRuntimeBridgeHttpHandler({
        enabled: () => true,
        authenticate: bridgeDeviceStatus,
        ledgerForDevice: async (device) =>
          createGovernedBridgeOperationLedger(device, { database }),
      });
      server.on('request', (req, res) => {
        void (async () => {
          const match =
            /^\/api\/v1\/bridge\/device\/operations\/(next|([a-f0-9-]{36})\/(start|heartbeat|output|receipts|service))$/.exec(
              req.url,
            );
          if (!match) {
            res.writeHead(404);
            res.end();
            return;
          }
          const body = [];
          for await (const bytes of req) body.push(bytes);
          const response = await handler(
            new globalThis.Request(`http://${req.headers.host}${req.url}`, {
              method: 'POST',
              headers: req.headers,
              body: Buffer.concat(body),
            }),
            match[1] === 'next' ? 'next' : match[3],
            match[2],
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(await response.text());
        })().catch((error) => {
          if (!res.headersSent) res.writeHead(500);
          res.end(JSON.stringify({ error: String(error) }));
        });
      });
      // Node only emits upgrade requests when an upgrade listener exists. Next
      // installs one in the real Web process; keep that prerequisite in this
      // isolated server too. AllRiceHttpServer routes the private paths first.
      server.on('upgrade', (_req, socket) => socket.destroy());
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port,
        origin = `http://127.0.0.1:${port}`,
        suffix = `preview.localhost:${port}`;
      vi.stubEnv('ALLRICE_PROJECT_PREVIEW_SUFFIX', suffix);
      server.bridgeGateway = await createBridgeSocketGateway({
        authority: createBridgeConnectionAuthority(database),
        enabled: () => true,
        dispatch: createBridgeLoopbackDispatch(port),
      });
      server.previewGateway = createProjectPreviewGateway({
        suffix,
        mainOrigin: origin,
        secure: false,
        transport: server.bridgeGateway,
        resolveAccess: (id, key) =>
          resolveProjectPreviewAccess(id, key, database),
        onError: (error) => {
          proof.previewErrors ??= [];
          proof.previewErrors.push(String(error));
          console.log('Preview denial:', String(error));
        },
      });
      const config = {
        server: origin,
        deviceId: f.device.id,
        deviceName: 'Owned PR5a native fixture',
        grants: [],
      };
      journal = await BridgeJournal.open({
        directory: join(owned, 'journal'),
        server: origin,
        deviceId: f.device.id,
      });
      const runner = new LocalCommandRunner({
        socketPath: process.env.ALLRICE_PROJECT_SERVICE_SOCKET,
        imageDigest: localCommandToolchainImageV1,
        projectPreparation: {
          root:
            process.env.ALLRICE_PROJECT_SERVICE_PREPARATION ??
            join(owned, 'project-preparation'),
          pythonImage: managedPythonPayloadForPlatform(
            architecture === 'arm64' ? 'macos-arm64' : 'macos-x64',
          ).imageId,
          architecture,
        },
      });
      const execute = runner.projects.execute.bind(runner.projects);
      let containerStartedAt;
      runner.projects.execute = async (...args) => {
        if (args[2].service) {
          const onEvent = args[2].service.onEvent;
          args[2].service.onEvent = async (event) => {
            if (event.type === 'starting') {
              proof.containerId = event.containerId;
              containerStartedAt = Date.now();
            }
            await onEvent(event);
          };
        }
        try {
          return await execute(...args);
        } catch (error) {
          proof.executionError = String(error);
          throw error;
        }
      };
      relay = new ProjectPreviewRelay(runner, journal);
      transport = new BridgeDualTransport({
        ...config,
        token,
        enabled: true,
        onPreview: (frame, send) => relay.receive(frame, send),
        onPreviewDisconnect: () => relay.close(),
      });
      // This harness forwards only an owned ARM VM socket to the Intel test host.
      // Probe the actual project images and pinned managers; the shipped Bridge's
      // host-platform probe remains unchanged and is verified on its native host.
      await runner.api.verifySocket();
      const projectPreparation = await runner.projects.preflight();
      const profile = RuntimeLocalCommandProfileSchema.parse({
        contractVersion: 1,
        available: true,
        backend: 'local-vm-container-v1',
        imageDigest: localCommandToolchainImageV1,
        architecture,
        features: [
          'project_preparation',
          'saved_project_source',
          'background_services',
          'project_services',
        ],
        projectPreparation,
      });
      await reportLocalCommandProfile(f.device, profile, database);
      ticker = setInterval(() => {
        void database`update allrice_bridge_devices set last_seen_at=clock_timestamp() where id=${f.device.id}`;
        void reportLocalCommandProfile(f.device, profile, database);
      }, 5000);
      const dispatch = RuntimeBridgeDispatchSchema.parse({
        contractVersion: 1,
        snapshot: f.dispatchSnapshot,
        payload: f.payload,
        leaseToken: f.identity.leaseToken,
        leaseExpiresAt: f.dispatchLeaseExpiresAt,
        grantRootFingerprint:
          f.dispatchSnapshot.binding.execution.scopeDigest.slice(7),
      });
      await journal.receive(dispatch);
      await journal.begin(f.id);
      manager = localProcessManager({
        journal,
        config,
        token,
        runner,
        request: transport.request,
      });
      await manager.start(dispatch, null);
      proof.connectionAtStart =
        await database`select device_id,organization_id,workspace_id,epoch,expires_at from allrice_bridge_connections where device_id=${f.device.id}`;
      proof.transportAtStart = {
        ready: transport.ready,
        socketState: transport.socket?.readyState,
        failures: transport.failures,
      };
      console.log(
        'Actual WSS before container execution:',
        JSON.stringify(proof.transportAtStart),
      );
      expect(proof.transportAtStart.ready).toBe(true);
      await until(async () => {
        const current = await readProjectService(
          f.requestContext,
          f.id,
          database,
        );
        if (
          proof.containerId &&
          !proof.readinessProbe &&
          Date.now() - containerStartedAt > 5000
        ) {
          const exec = await runner.api.json(
            'POST',
            `/containers/${proof.containerId}/exec`,
            {
              AttachStdout: true,
              AttachStderr: true,
              Tty: false,
              User: '1000:1000',
              Cmd: [
                '/usr/local/bin/node',
                '-e',
                "fetch('http://127.0.0.1:4173/',{signal:AbortSignal.timeout(1000)}).then(async r=>console.log(JSON.stringify({status:r.status,body:(await r.text()).slice(0,2000)}))).catch(e=>console.log(String(e)))",
              ],
            },
          );
          proof.readinessProbe = await new Promise((resolve, reject) => {
            const req = httpRequest(
              {
                socketPath: runner.api.socketPath,
                path: `/v1.45/exec/${exec.Id}/start`,
                method: 'POST',
                headers: { 'content-type': 'application/json' },
              },
              (res) => {
                const chunks = [];
                res.on('data', (b) => chunks.push(b));
                res.on('end', () => {
                  const b = Buffer.concat(chunks);
                  let at = 0,
                    text = '';
                  while (at + 8 <= b.length) {
                    const n = b.readUInt32BE(at + 4);
                    text += b.subarray(at + 8, at + 8 + n);
                    at += 8 + n;
                  }
                  resolve(text.trim());
                });
              },
            );
            req.on('error', reject);
            req.end('{"Detach":false,"Tty":false}');
          });
          console.log('Actual service readiness:', proof.readinessProbe);
        }
        const receipts = await journal.pending();
        if (
          !manager.activeCount ||
          ['failed', 'stopped', 'unknown'].includes(current.state) ||
          receipts.some((r) => r.signal.type !== 'operation.started')
        ) {
          proof.failedService = current;
          proof.failedReceipts = await journal.pending();
          proof.failedOutput = await journal.pendingOutput();
          throw Error(
            'native service not running: ' +
              JSON.stringify(proof.failedReceipts),
          );
        }
        return current.state === 'ready';
      });
      proof.wiring.push(
        'real Bridge WSS, manager, immutable supervisor, ready receipt and database',
      );
      proof.connectionAtReady =
        await database`select device_id,organization_id,workspace_id,epoch,expires_at from allrice_bridge_connections where device_id=${f.device.id}`;
      proof.transportAtReady = {
        ready: transport.ready,
        socketState: transport.socket?.readyState,
        failures: transport.failures,
      };
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
      const started = JSON.parse(
        (await broker(f.command, f.callId)).modelContent,
      );
      expect(started.service.id).toBe(f.id);
      ProjectServiceViewSchema.parse(started.service);
      proof.wiring.push(
        'Worker Broker result parses the actual service identity',
      );
      const loginSession = randomUUID();
      await database`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${loginSession},${f.user},${createHash('sha256').update(randomUUID()).digest('hex')},clock_timestamp()+interval '1 hour')`;
      const access = await createProjectPreviewAccess(
          { ...f.requestContext, sessionId: loginSession },
          f.id,
          database,
        ),
        url = `http://rice-preview-${f.id}.${suffix}/`;
      browser = await chromium.launch({
        executablePath:
          process.env.CHROME_PATH ??
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true,
        args: ['--no-proxy-server'],
      });
      const page = await browser.newPage(),
        frames = [];
      page.on('websocket', (ws) =>
        ws.on('framereceived', (frame) => frames.push(String(frame.payload))),
      );
      const response = await page.goto(
        `${url}?_allrice_preview_ticket=${access}`,
        { waitUntil: 'networkidle', timeout: 30000 },
      );
      expect(response.status()).toBe(200);
      await page.locator('#result').filter({ hasText: 'source:42' }).waitFor();
      expect(page.url()).toBe(url);
      const original = files.find((f) => f.path === 'main.js').text,
        changed = original.replace('source:42', 'source:43');
      const updated = JSON.parse(
        (
          await broker({
            action: 'apply',
            expectedHead: f.project,
            proposal: {
              files: [{ path: 'main.js', before: original, after: changed }],
            },
          })
        ).modelContent,
      );
      const project = ProjectVersionRefSchema.parse(updated.project);
      await broker({
        action: 'service_sync',
        serviceId: f.id,
        requestId: randomUUID(),
        expectedProject: f.project,
        project,
      });
      await page.waitForFunction(
        () =>
          globalThis.document.querySelector('#result')?.textContent ===
          'source:43',
        { timeout: 20000 },
      );
      await until(async () => {
        const s = await readProjectService(f.requestContext, f.id, database);
        return (
          !s.updatePending && s.project.snapshot.id === project.snapshot.id
        );
      });
      expect(frames.some((f) => f.includes('connected'))).toBe(true);
      expect(frames.some((f) => f.includes('update'))).toBe(true);
      proof.hmrFrames = frames.filter(
        (f) => f.includes('connected') || f.includes('update'),
      );
      proof.sourceAfterSync = project;
      proof.wiring.push('private HTTP/modules and actual WebSocket hot update');
      const complete = await f.runtime.finalizeRoot({
        scope: f.task.scope,
        rootRunId: f.context.runId,
        worker: f.assistantWorker,
      });
      expect(complete.status).toBe('completed');
      await database`update allrice_runs set state='succeeded' where id=${f.context.runId}`;
      await database`update allrice_jobs set status='succeeded' where id=${f.context.jobId}`;
      await delay(2200);
      await page.reload({ waitUntil: 'networkidle' });
      expect(await page.locator('#result').textContent()).toBe('source:43');
      await expect(
        readProjectService(
          { ...f.requestContext, actor: { type: 'user', id: randomUUID() } },
          f.id,
          database,
        ),
      ).rejects.toThrow();
      const fresh = await browser.newContext(),
        other = await fresh.newPage();
      expect((await other.goto(url)).status()).toBe(403);
      await fresh.close();
      proof.wiring.push(
        'completed Run continuing lease and unauthenticated/cross-account denial',
      );
      const target = await resolveProjectPreviewAccess(f.id, access, database);
      await projectServiceUserAction(
        f.requestContext,
        f.id,
        { action: 'stop' },
        database,
      );
      await until(() => manager.activeCount === 0);
      const client = new RuntimeBridgeOperationClient({
        config,
        token,
        journal,
        runner,
        request: transport.request,
      });
      while (!(await client.flush())) await delay(100);
      expect(
        (await readProjectService(f.requestContext, f.id, database)).stopped,
      ).toBe(true);
      await expect(
        runner.api.json('GET', `/containers/${target.containerId}/json`),
      ).rejects.toThrow('DAEMON_HTTP_404');
      await expect(
        runner.api.json(
          'GET',
          `/volumes/allrice-project-work-${target.attemptId}`,
        ),
      ).rejects.toThrow('DAEMON_HTTP_404');
      expect((await page.reload()).status()).toBe(403);
      proof.physicalCleanup = true;
      proof.wiring.push(
        'user stop, original journal receipts, reclaimed process/work volume',
      );
      proof.passed = true;
    } catch (error) {
      proof.error = String(error);
      if (journal) {
        proof.failedReceipts = await journal.pending().catch(String);
        proof.failedOutput = await journal.pendingOutput().catch(String);
        if (proof.serviceId)
          proof.failedEvents = await journal
            .serviceJournal()
            .pending(proof.serviceId)
            .catch(String);
      }
      throw error;
    } finally {
      clearInterval(ticker);
      await manager?.close().catch(() => undefined);
      transport?.close();
      relay?.close();
      await browser?.close();
      await journal?.close();
      await server?.previewGateway?.close();
      await server?.bridgeGateway?.close();
      server?.closeAllConnections();
      if (server) await new Promise((r) => server.close(r));
      proof.fixtureCleanup = await fixture?.close();
      await rm(owned, { recursive: true, force: true });
      vi.unstubAllEnvs();
      proof.finishedAt = new Date().toISOString();
      if (process.env.ALLRICE_PROJECT_SERVICE_EVIDENCE)
        await writeFile(
          process.env.ALLRICE_PROJECT_SERVICE_EVIDENCE,
          JSON.stringify(proof, null, 2) + '\n',
          { mode: 0o600 },
        );
    }
  }, 240000);
});
