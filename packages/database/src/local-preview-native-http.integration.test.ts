import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  localPreviewOrigin,
  type RequestContext,
  type BrowserCommand,
  type RuntimeOperationSnapshot,
} from '@allrice/contracts';
import {
  createNativePreviewFixture,
  previewProjectSource,
  readNativePreviewWrites,
} from './local-preview-native.fixture.ts';
import {
  createBrowserOperation,
  readCurrentBrowserWorkspace,
  listBrowserWorkspaces,
} from './browser-control.ts';
import { readLocalService } from './local-service-runtime.ts';
import {
  getRuntimeActionApproval,
  decideRuntimeActionApproval,
} from './runtime-policy.ts';
import { handleLocalBrowserRequest } from '../../../apps/web/lib/bridge/local-browser-runtime.ts';
import { LocalBrowserHttpAuthority } from '../../../apps/rice-bridge/src/local-browser-client.ts';
import { LocalBrowserController } from '../../../apps/rice-bridge/src/local-browser-controller.ts';
import { startLocalBrowserDriver } from '../../../apps/rice-bridge/src/local-browser-driver.ts';
import { LocalBrowserProfiles } from '../../../apps/rice-bridge/src/local-browser-profiles.ts';
import { LocalBrowserOutbox } from '../../../apps/rice-bridge/src/local-browser-outbox.ts';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.ts';
import { LocalPreviewRelay } from '../../../apps/rice-bridge/src/local-preview-relay.ts';
import { RuntimeBridgeOperationClient } from '../../../apps/rice-bridge/src/operation-client.ts';
import { BridgeJournal } from '../../../apps/rice-bridge/src/journal.ts';
import {
  stopLocalProcesses,
  activeLocalProcessCount,
} from '../../../apps/rice-bridge/src/local-process-manager.ts';
import {
  testImage,
  testSocket,
} from '../../../apps/rice-bridge/test/toolchain.ts';
import type * as Client from './core/client.ts';

let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
let browserIdentity: RequestContext | null = null;
const transactionFailures: Record<string, unknown>[] = [];
let deadlockCount = 0;
const lockSamples: { at: number; locks: unknown }[] = [];
let lockMonitor: ReturnType<typeof setInterval> | undefined;
let lockMonitorTask: Promise<void> | undefined;
let handleRuntimeBridgeOperation: (
  request: Request,
  action: 'next' | 'start' | 'receipts' | 'heartbeat' | 'output' | 'service',
  operationId?: string,
) => Promise<Response>;
let servicePost: (request: Request) => Promise<Response>;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
// Only the already-authenticated synthetic user issuer is substituted. Real
// same-origin HTTP parsing, ownership, frozen policy and approval remain intact.
vi.mock('../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browserIdentity,
}));
const schema = `p23_native_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_TEST_LOCAL_BROWSER_NATIVE === '1' &&
  process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET
    ? describe.sequential
    : describe.skip;

async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  label: string,
  timeout = 15000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}

suite(
  'P23 actual HTTP + PG + Intel VM service + supervised native Chrome',
  () => {
    beforeAll(async () => {
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source) throw Error('dedicated DB required');
      const url = new URL(source);
      if (
        url.hostname !== '127.0.0.1' ||
        url.port !== '5432' ||
        url.username !== 'a123' ||
        url.pathname !== '/allrice_b2'
      )
        throw Error('disposable DB only');
      if (
        process.platform !== 'darwin' ||
        process.arch !== 'x64' ||
        process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET !== testSocket
      )
        throw Error('dedicated Intel VM required');
      for (const key of [
        'ALLRICE_BROWSER_CONTROL_ENABLED',
        'ALLRICE_LOCAL_BROWSER_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_LOCAL_SERVICE_ENABLED',
        'ALLRICE_LOCAL_PREVIEW_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ])
        vi.stubEnv(key, '1');
      vi.stubEnv('ALLRICE_BROWSER_CONTROL_KEY', '19'.repeat(32));
      admin = postgres(source, { max: 2, onnotice: () => {} });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set(
        'options',
        `-csearch_path=${schema},public -capplication_name=${schema}`,
      );
      db = postgres(url.toString(), {
        max: 12,
        connection: { application_name: schema },
        onnotice: () => {},
      });
      const begin = db.begin;
      // Diagnostics only: preserve the same arguments, transaction, failure and
      // locks. The HTTP boundary intentionally hides internal SQL from callers.
      Object.defineProperty(db, 'begin', {
        value: (...args: unknown[]) =>
          (Reflect.apply(begin, db, args) as Promise<unknown>).catch(
            (error: unknown) => {
              if (error instanceof Error) {
                const value = error as Error & {
                  code?: string;
                  detail?: string;
                  where?: string;
                  query?: string;
                };
                if (value.code === '40P01') deadlockCount++;
                transactionFailures.push({
                  message: value.message,
                  code: value.code,
                  detail: value.detail,
                  where: value.where,
                  query: value.query,
                });
                if (transactionFailures.length > 40)
                  transactionFailures.shift();
              }
              throw error;
            },
          ),
      });
      const dir = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(dir))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, dir), 'utf8'));
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p23-native-http-'));
      vi.stubEnv('ALLRICE_STORAGE_ROOT', storageRoot);
      // Next's production modules use bundler resolution, unlike this package's
      // NodeNext typecheck. Load those exact modules through the test bundler.
      const bridgeModule = '../../../apps/web/lib/bridge/operation-runtime.ts';
      const serviceModule =
        '../../../apps/web/app/api/v1/runtime/local-services/route.ts';
      ({ handleRuntimeBridgeOperation } = await import(bridgeModule));
      ({ POST: servicePost } = await import(serviceModule));
      lockMonitor = setInterval(() => {
        if (lockMonitorTask) return;
        lockMonitorTask = (async () => {
          const locks =
            await admin`select pid,wait_event,pg_blocking_pids(pid) as blockers,query
          from pg_stat_activity where datname=current_database() and application_name=${schema} and wait_event_type='Lock'`;
          if (locks.length) {
            lockSamples.push({ at: Date.now(), locks });
            if (lockSamples.length > 30) lockSamples.shift();
          }
        })()
          .catch(() => {})
          .finally(() => {
            lockMonitorTask = undefined;
          });
      }, 100);
    }, 60000);
    afterAll(async () => {
      clearInterval(lockMonitor);
      await lockMonitorTask;
      browserIdentity = null;
      await db?.end();
      if (admin) {
        if (!/^p23_native_[a-f0-9]{32}$/.test(schema))
          throw Error('unsafe schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      if (storageRoot?.includes('/allrice-p23-native-http-'))
        await rm(storageRoot, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    for (const termination of ['stop', 'disconnect', 'deny'] as const)
      it(`real approval/JS/POST lifecycle, then ${termination} closes private channel`, async () => {
        const runner = new LocalCommandRunner({
          socketPath: testSocket,
          imageDigest: testImage,
        });
        await runner.preflight();
        const f = await createNativePreviewFixture(db, storageRoot, runner);
        transactionFailures.length = 0;
        deadlockCount = 0;
        lockSamples.length = 0;
        browserIdentity = f.context;
        const traffic: {
          path: string;
          status: number;
          kind: string;
          at: number;
          code?: string;
        }[] = [];
        let disconnectService = false;
        const server = createServer(async (incoming, outgoing) => {
          try {
            const url = new URL(
              incoming.url ?? '/',
              `http://${incoming.headers.host}`,
            );
            const headers = new Headers();
            for (const [key, value] of Object.entries(incoming.headers))
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(',') : value,
                );
            const request = new Request(url, {
              method: incoming.method,
              headers,
              body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              duplex: 'half',
            } as RequestInit);
            const kind = headers
              .get('content-type')
              ?.startsWith('application/json')
              ? (((await request.clone().json()) as { kind?: string }).kind ??
                '')
              : 'capture';
            let response: Response;
            if (url.pathname === '/api/v1/runtime/local-services')
              response = await servicePost(request);
            else if (
              url.pathname.startsWith('/api/v1/bridge/browser-workspaces')
            )
              response = await handleLocalBrowserRequest(
                request,
                url.pathname.endsWith('/capture'),
              );
            else {
              const match = url.pathname.match(
                /^\/api\/v1\/bridge\/device\/operations\/(?:(?<id>[a-f0-9-]{36})\/)?(?<action>next|start|receipts|heartbeat|output|service)$/,
              );
              if (!match?.groups) throw Error('unexpected test route');
              response =
                disconnectService && match.groups.action === 'service'
                  ? new Response(null, { status: 503 })
                  : await handleRuntimeBridgeOperation(
                      request,
                      match.groups.action as
                        | 'next'
                        | 'start'
                        | 'receipts'
                        | 'heartbeat'
                        | 'output'
                        | 'service',
                      match.groups.id,
                    );
            }
            traffic.push({
              path: url.pathname,
              status: response.status,
              kind,
              at: Date.now(),
              ...(response.status >= 400
                ? { code: await response.clone().text() }
                : {}),
            });
            outgoing.writeHead(
              response.status,
              Object.fromEntries(response.headers),
            );
            outgoing.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) {
            outgoing.writeHead(500).end(
              JSON.stringify({
                error:
                  error instanceof Error ? error.message : 'server failure',
              }),
            );
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (!address || typeof address === 'string') throw Error('port');
        const origin = `http://127.0.0.1:${address.port}`;
        const deviceRoot = await mkdtemp(join(storageRoot, 'bridge-'));
        const journal = await BridgeJournal.open({
          directory: join(deviceRoot, 'journal'),
          server: origin,
          deviceId: f.device.id,
        });
        const client = new RuntimeBridgeOperationClient({
          config: {
            server: origin,
            deviceId: f.device.id,
            deviceName: f.device.name,
            grants: [
              {
                id: f.folderId,
                label: 'test project',
                rootPath: f.projectRoot,
                rootFingerprint: f.rootFingerprint,
              },
            ],
          },
          token: f.token,
          journal,
          runner,
        });
        const abort = new AbortController();
        const errors: string[] = [];
        const timeline: { at: number; event: string }[] = [];
        const trace = (event: string) =>
          timeline.push({ at: Date.now(), event });
        const controller = new LocalBrowserController({
          deviceId: f.device.id,
          authority: new LocalBrowserHttpAuthority({
            server: origin,
            token: f.token,
          }),
          profiles: new LocalBrowserProfiles(
            join(deviceRoot, 'browser.json'),
            origin,
          ),
          outbox: new LocalBrowserOutbox(
            join(deviceRoot, 'browser.json'),
            origin,
            f.device.id,
          ),
          enabled: async () => true,
          paired: async () => true,
          preview: { enabled: async () => true, runner },
          onError: (code) => errors.push(code),
          startDriver: async (input) => {
            const driver = await startLocalBrowserDriver({
              ...input,
              options: {
                ...input.options,
                requestStarted: () => {
                  trace('request.started');
                  const release = input.options.requestStarted();
                  return () => {
                    trace('request.released');
                    release();
                  };
                },
                assertCurrent: async () => {
                  try {
                    await input.options.assertCurrent();
                  } catch (error) {
                    trace('authority.rejected');
                    errors.push(
                      `actual current: ${error instanceof Error ? error.message : 'unknown'}`,
                    );
                    throw error;
                  }
                },
                requestApproval: async (effect) => {
                  trace(`request.approval.enter.${effect.method}`);
                  try {
                    return await input.options.requestApproval(effect);
                  } catch (error) {
                    trace('request.approval.rejected');
                    errors.push(
                      `actual request approval: ${error instanceof Error ? error.message : 'unknown'}`,
                    );
                    throw error;
                  }
                },
              },
            });
            return {
              ...driver,
              perform: async (...args) => {
                trace(`perform.enter.${args[0].type}`);
                try {
                  const result = await driver.perform(...args);
                  trace(`perform.return.${args[0].type}`);
                  return result;
                } catch (error) {
                  errors.push(
                    `actual driver: ${error instanceof Error ? error.message : 'unknown'}`,
                  );
                  throw error;
                }
              },
              observe: async (...args) => {
                trace('capture.enter');
                try {
                  const result = await driver.observe(...args);
                  trace('capture.return');
                  return result;
                } catch (error) {
                  errors.push(
                    `actual capture: ${error instanceof Error ? error.message : 'unknown'}`,
                  );
                  throw error;
                }
              },
              checkpoint: async () => {
                trace('checkpoint.enter');
                try {
                  return await driver.checkpoint();
                } catch (error) {
                  errors.push(
                    `actual checkpoint: ${error instanceof Error ? error.message : 'unknown'}`,
                  );
                  throw error;
                }
              },
            };
          },
        });
        let controllerLoop: Promise<void> | undefined,
          workspaceId: string | undefined;
        let pendingPostMilliseconds = 0;
        const userAction = async (action: 'preview' | 'stop') => {
          const url = new URL('/api/v1/runtime/local-services', origin);
          url.searchParams.set('processId', f.processId);
          if (action === 'stop') url.searchParams.set('runId', f.run);
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: JSON.stringify({ action }),
          });
          const value = await response.json();
          expect(response.status, JSON.stringify(value)).toBe(200);
          return value as {
            workspaceId: string;
            endpointId: string;
            previewUrl: string;
            pending: boolean;
            operationId?: string;
          };
        };
        const operation = async (id: string) => {
          const [row] = await db<
            { snapshot: RuntimeOperationSnapshot }[]
          >`select snapshot from allrice_runtime_operations where id=${id}`;
          return row?.snapshot;
        };
        const approve = async (id: string) => {
          const snapshot = await operation(id);
          if (!snapshot) throw Error('missing operation');
          await f.approve({ snapshot });
        };
        const observe = () =>
          readCurrentBrowserWorkspace(f.context, workspaceId!, db);
        const relay = new LocalPreviewRelay(runner);
        const projectStatus = async () => {
          const w = await observe();
          if (!w.preview) throw Error('preview lease');
          const result = await relay.fetch(
            w.preview.target,
            {
              url: localPreviewOrigin(w.preview.target.endpointId) + '/status',
              method: 'GET',
              headers: {},
            },
            {
              assertCurrent: async () => {
                const current = await observe();
                if (!current.preview) throw Error('preview lost');
                return current.preview;
              },
            },
          );
          return JSON.parse(result.body.toString()) as {
            writes: number;
            lastBody: string;
          };
        };
        const count = async () => (await projectStatus()).writes;
        const act = async (action: BrowserCommand['action']) => {
          const w = await observe();
          const op = await createBrowserOperation(
            f.context,
            {
              version: 1,
              workspaceId: w.id,
              profileId: w.profile_id,
              actor: 'agent',
              fence: w.control_fence,
              observationId: w.observation?.id ?? null,
              action,
            },
            randomUUID(),
            db,
          );
          await f.approve(op);
          return op.snapshot.binding.attempt.operationId;
        };
        const terminal = async (id: string) =>
          until(
            async () => {
              const snapshot = await operation(id);
              return snapshot &&
                ['succeeded', 'failed', 'unknown', 'canceled'].includes(
                  snapshot.status,
                )
                ? snapshot
                : false;
            },
            'operation terminal',
            20000,
          );
        try {
          expect(await client.pollOnce()).toBe(true);
          const ready = await until(
            async () => {
              const s = await readLocalService(f.processId, db);
              return s?.ready ? s : false;
            },
            'actual VM ready',
            25000,
          );
          expect(activeLocalProcessCount(journal)).toBe(1);
          const prepared = await userAction('preview');
          workspaceId = prepared.workspaceId;
          expect(prepared.pending).toBe(true);
          expect(prepared.operationId).toBeUndefined();
          controllerLoop = controller.run(abort.signal);
          await until(
            async () =>
              traffic.some((t) => t.kind === 'control_ack' && t.status === 200),
            'native controller ACK',
            20000,
          );
          const acknowledged = await observe();
          expect(acknowledged.state).toBe('agent');
          expect(acknowledged.acknowledged_fence).toBe(
            acknowledged.control_fence,
          );
          const navigation = await userAction('preview');
          expect(navigation.pending).toBe(false);
          expect(navigation.operationId).toBeTruthy();
          expect((await operation(navigation.operationId!))?.status).toBe(
            'waiting_user',
          );
          expect((await observe()).observation?.url).toBe('about:blank');
          await approve(navigation.operationId!);
          expect((await terminal(navigation.operationId!)).status).toBe(
            'succeeded',
          );
          await until(async () => {
            const w = await observe();
            return w.observation?.text.includes(
              'Actual project JavaScript loaded',
            )
              ? w
              : false;
          }, 'actual HTML + JavaScript');
          expect(await count()).toBe(0);
          const target = (await observe()).preview!.target;
          // Cross multiple physical lease windows, using only the production service
          // loop's real HTTP exchanges and real browser heartbeats (no DB time edits).
          const began = Date.now();
          await until(
            async () => {
              expect(activeLocalProcessCount(journal)).toBe(1);
              expect((await readLocalService(f.processId, db))?.ready).toBe(
                true,
              );
              return Date.now() - began >= 8500;
            },
            'sustained physical liveness',
            12000,
          );
          const sustainedLivenessMs = Date.now() - began;
          expect(
            traffic.filter(
              (t) =>
                t.path.endsWith('/service') &&
                t.status === 200 &&
                t.at >= began,
            ).length,
          ).toBeGreaterThanOrEqual(7);
          for (const decision of (termination === 'deny'
            ? ['rejected']
            : ['approved']) as ('approved' | 'rejected')[]) {
            const w = await observe();
            const button = w.observation!.elements.find(
              (e) => e.label === 'Save once',
            );
            expect(button).toBeDefined();
            const parent = await act({ type: 'click', elementId: button!.id });
            const request = await until(async () => {
              const [row] = await db<
                { id: string; payload: BrowserCommand }[]
              >`select operation_id as id,payload from allrice_browser_operation_inputs where browser_workspace_id=${w.id} and payload->'action'->>'type'='request' and payload->'action'->>'parentOperationId'=${parent}`;
              return row;
            }, 'physical POST exact approval');
            expect(request.payload.action).toMatchObject({
              type: 'request',
              method: 'POST',
              url: prepared.previewUrl + '/save',
              bodyBytes: Buffer.byteLength('message=synthetic-p23'),
              bodyDigest: `sha256:${createHash('sha256').update('message=synthetic-p23').digest('hex')}`,
            });
            expect(await count()).toBe(0);
            if (termination === 'stop') {
              const approvalWaitBegan = Date.now();
              await until(
                async () => {
                  expect((await operation(parent))?.status).toBe('running');
                  expect(activeLocalProcessCount(journal)).toBe(1);
                  return Date.now() - approvalWaitBegan >= 6100;
                },
                'real human approval wait beyond default click timeout',
                9000,
              );
              pendingPostMilliseconds = Date.now() - approvalWaitBegan;
              expect(await count()).toBe(0);
            }
            const [row] = await db<
              { id: string }[]
            >`select id from allrice_approval_requests where resource_id=${request.id} and resource_type='runtime_operation'`;
            const { request: approval } = await getRuntimeActionApproval(
              f.context,
              row!.id,
              db,
            );
            await decideRuntimeActionApproval(
              f.context,
              approval.approvalId,
              {
                contractVersion: 1,
                direction: 'response',
                kind: 'action_approval',
                requestId: approval.requestId,
                version: approval.version,
                requestDigest: approval.requestDigest,
                task: approval.task,
                responseId: randomUUID(),
                respondedBy: f.user,
                respondedAt: new Date().toISOString(),
                approvalId: approval.approvalId,
                decision,
              },
              db,
            );
            await terminal(parent);
            expect(
              await readNativePreviewWrites(
                runner,
                target.containerId,
                f.processId,
              ),
            ).toEqual(decision === 'approved' ? [1] : []);
            if (decision === 'approved') {
              expect(await projectStatus()).toEqual({
                writes: 1,
                lastBody: 'message=synthetic-p23',
              });
              await until(async () => {
                const x = await observe();
                return x.observation?.text.includes('Writes: 1') &&
                  x.observation.text.includes('Received: message=synthetic-p23')
                  ? x
                  : false;
              }, 'actual POST rendered response');
            }
          }
          const container = await runner.api.json<{
            State: { Running: boolean };
            HostConfig: { NetworkMode: string; PortBindings: unknown };
          }>('GET', `/containers/${target.containerId}/json`);
          expect(container.State.Running).toBe(true);
          expect(container.HostConfig.NetworkMode).toBe('none');
          expect(container.HostConfig.PortBindings ?? {}).toEqual({});
          const revokedAt = Date.now();
          if (termination !== 'disconnect') await userAction('stop');
          else disconnectService = true;
          await until(
            async () => {
              const [row] = await db<
                { state: string }[]
              >`select state from allrice_browser_workspaces where id=${workspaceId!}`;
              return row?.state === 'closed';
            },
            'physical Chrome closed after authority loss',
            12000,
          );
          expect(Date.now() - revokedAt).toBeLessThan(12000);
          await expect(count()).rejects.toThrow();
          await until(
            async () => activeLocalProcessCount(journal) === 0,
            'actual service stop',
            12000,
          );
          await expect(
            runner.api.json('GET', `/containers/${target.containerId}/json`),
          ).rejects.toMatchObject({ code: 'DAEMON_HTTP_404' });
          expect(
            await readFile(join(f.projectRoot, 'service.mjs'), 'utf8'),
          ).toBe(previewProjectSource);
          expect(
            (await listBrowserWorkspaces(f.context, f.run, db))[0]!.state,
          ).toBe('closed');
          expect(
            traffic.some(
              (t) => t.kind === 'request_approval' && t.status === 200,
            ),
          ).toBe(true);
          expect(
            traffic.some((t) => t.kind === 'stopped' && t.status === 200),
          ).toBe(true);
          expect(errors).not.toContain('LOCAL_BROWSER_CLEANUP_PENDING');
          expect(
            deadlockCount,
            'no hidden SQL deadlock may be counted as successful cleanup',
          ).toBe(0);
          expect(ready).toBeTruthy();
          console.info(
            'P23 real native acceptance',
            JSON.stringify({
              scenario: termination,
              platform: `${process.platform}-${process.arch}`,
              sustainedLivenessMs,
              pendingPostMilliseconds,
              actualPostWrites: termination === 'deny' ? 0 : 1,
              exactPostBodyVerified: termination !== 'deny',
              serviceExchangeCount: traffic.filter(
                (entry) =>
                  entry.path.endsWith('/service') && entry.status === 200,
              ).length,
              closeAndServiceRemovalMs: Date.now() - revokedAt,
              sourceUnchanged: true,
              realVmContainerRemoved: true,
              noSqlDeadlock: true,
              modelCalls: 0,
            }),
          );
        } catch (error) {
          const operations =
            await db`select o.id,o.snapshot->>'status' as status,o.snapshot->'stopReason' as stop_reason,i.payload->'action' as action
            from allrice_runtime_operations o left join allrice_browser_operation_inputs i on i.operation_id=o.id where o.run_id=${f.run}`;
          const workspaces =
            await db`select id,state,control_fence,acknowledged_fence,observation->>'text' as observed_text from allrice_browser_workspaces where run_id=${f.run}`;
          console.error(
            'P23 synthetic fixture diagnostics',
            JSON.stringify({
              operations,
              workspaces,
              errors,
              timeline,
              transactionFailures,
              deadlockCount,
              lockSamples: lockSamples.slice(-12),
              traffic: traffic
                .filter(
                  (t) =>
                    t.status >= 400 ||
                    (!['claim', 'heartbeat'].includes(t.kind) &&
                      !t.path.endsWith('/service')),
                )
                .slice(-40),
              failure:
                error instanceof Error
                  ? {
                      name: error.name,
                      message: error.message,
                      ...('detail' in error ? { detail: error.detail } : {}),
                    }
                  : error,
            }),
          );
          throw error;
        } finally {
          disconnectService = false;
          abort.abort();
          await controllerLoop?.catch(() => undefined);
          await controller.stop();
          await stopLocalProcesses(journal);
          await client.flush().catch(() => undefined);
          journal.close();
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }, 120000);
  },
);
