import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RuntimeOperationSnapshotSchema,
  type BrowserAction,
} from '@allrice/contracts';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import {
  createBrowserDirectInput,
  createBrowserOperation,
  listBrowserWorkspaces,
  readCurrentBrowserWorkspace,
  requestBrowserControl,
} from './browser-control.ts';
import {
  pendingLocalBrowserRevocations,
  revokeLocalBrowserGrant,
} from './local-browser-grants.ts';
import { handleLocalBrowserRequest } from '../../../apps/web/lib/bridge/local-browser-runtime.ts';
import { LocalBrowserHttpAuthority } from '../../../apps/rice-bridge/src/local-browser-client.ts';
import { LocalBrowserController } from '../../../apps/rice-bridge/src/local-browser-controller.ts';
import { LocalBrowserProfiles } from '../../../apps/rice-bridge/src/local-browser-profiles.ts';
import { LocalBrowserOutbox } from '../../../apps/rice-bridge/src/local-browser-outbox.ts';
import {
  localBrowserOptIn,
  saveLocalBrowserOptIn,
} from '../../../apps/rice-bridge/src/local-browser-settings.ts';
import { runLocalBrowserWorkspace } from '../../../apps/worker/src/tool-broker/handlers/local-browser.ts';
import type * as Client from './core/client.ts';

let db: ReturnType<typeof postgres>,
  admin: ReturnType<typeof postgres>,
  storageRoot: string;
const transactionFailures: Record<string, unknown>[] = [];
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => db,
}));
const schema = `p22_native_http_${randomUUID().replaceAll('-', '')}`;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_BROWSER_FIXTURE_STATE
    ? describe.sequential
    : describe.skip;
const hash = (value: string) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
async function until<T>(
  read: () => Promise<T | null | false | undefined>,
  label: string,
  milliseconds = 15000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== false && result !== null && result !== undefined)
      return result;
    await delay(50);
  }
  throw Error(`NATIVE_HTTP_WAIT:${label}`);
}

suite(
  'P22 one real chain: PG authority + HTTP device auth + production controller/driver + native Chrome + public HTTPS',
  () => {
    beforeAll(async () => {
      expect(process.platform).toBe('darwin');
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
      for (const key of [
        'ALLRICE_BROWSER_CONTROL_ENABLED',
        'ALLRICE_LOCAL_BROWSER_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
      ])
        vi.stubEnv(key, '1');
      vi.stubEnv('ALLRICE_BROWSER_CONTROL_KEY', '17'.repeat(32));
      admin = postgres(source, { max: 2, onnotice: () => {} });
      await admin.unsafe(`create schema ${schema}`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 8, onnotice: () => {} });
      const begin = db.begin;
      // Observe original transaction failures; never replace queries, results,
      // authority or locks. HTTP intentionally sanitizes internal errors.
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
                transactionFailures.push({
                  name: value.constructor.name,
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
      for (const file of (
        await readdir(new URL('../migrations/', import.meta.url))
      )
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await db.unsafe(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            'utf8',
          ),
        );
      storageRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-p22-native-http-')),
      );
      vi.stubEnv('ALLRICE_STORAGE_ROOT', storageRoot);
      vi.stubEnv('TMPDIR', storageRoot);
    }, 60000);
    afterAll(async () => {
      await db?.end();
      if (admin) {
        if (!/^p22_native_http_[a-f0-9]{32}$/.test(schema))
          throw Error('unsafe schema');
        await admin.unsafe(`drop schema ${schema} cascade`);
        await admin.end();
      }
      // Preserve the report/evidence directory. Owned controller cleanup is separately asserted.
      vi.unstubAllEnvs();
    });
    it('holds real POST until exact durable approval, consumes human input, transfers files, revokes and confirms actual process stop', async () => {
      const state = async () =>
        JSON.parse(
          await readFile(process.env.ALLRICE_BROWSER_FIXTURE_STATE!, 'utf8'),
        ) as {
          endpoint: string;
          logins: number;
          uploads: number;
          downloads: number;
          stoppedAt: string | null;
        };
      const initial = await state(),
        url = new URL(initial.endpoint);
      if (
        initial.stoppedAt ||
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.trycloudflare.com') ||
        !/^\/[a-f0-9]{40}\/login$/.test(url.pathname)
      )
        throw Error('owned synthetic fixture required');
      const base = url.origin + url.pathname.replace(/login$/, '');
      const f = await createLocalBrowserFixture(db, storageRoot, {
        claim: false,
        origin: url.origin,
        persistLogin: true,
      });
      const wId = f.browser!.w.id;
      const traffic: { path: string; kind: string; status: number }[] = [];
      const server = createServer(async (incoming, outgoing) => {
        try {
          const chunks = [];
          let length = 0;
          for await (const chunk of incoming) {
            length += chunk.length;
            if (length > 12 * 1024 * 1024) throw Error('request too large');
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          let kind = 'capture';
          if (incoming.headers['content-type']?.includes('application/json'))
            kind = JSON.parse(body.toString()).kind;
          const response = await handleLocalBrowserRequest(
            new Request(`http://127.0.0.1${incoming.url}`, {
              method: incoming.method,
              headers: new Headers(
                Object.entries(incoming.headers).flatMap(([key, value]) =>
                  value === undefined
                    ? []
                    : [
                        [
                          key,
                          Array.isArray(value) ? value.join(',') : value,
                        ] as [string, string],
                      ],
                ),
              ),
              body: Readable.toWeb(
                Readable.from([body]),
              ) as ReadableStream<Uint8Array>,
              duplex: 'half',
            } as RequestInit),
            incoming.url?.endsWith('/capture'),
          );
          traffic.push({
            path: incoming.url ?? '',
            kind,
            status: response.status,
          });
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers),
          );
          outgoing.end(Buffer.from(await response.arrayBuffer()));
          body.fill(0);
        } catch {
          outgoing.writeHead(500).end();
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('missing port');
      const origin = `http://127.0.0.1:${address.port}`;
      const configPath = join(storageRoot, 'synthetic-device.json');
      const config = {
        server: origin,
        deviceId: f.device.id,
        deviceName: 'Synthetic native HTTP',
        grants: [],
      };
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', configPath);
      await saveLocalBrowserOptIn(config, true);
      const profiles = new LocalBrowserProfiles(configPath, origin);
      const outbox = new LocalBrowserOutbox(configPath, origin, f.device.id);
      const errors: string[] = [];
      const controller = new LocalBrowserController({
        deviceId: f.device.id,
        authority: new LocalBrowserHttpAuthority({
          server: origin,
          token: f.token,
        }),
        profiles,
        outbox,
        paired: async () =>
          JSON.parse(await readFile(configPath, 'utf8')).deviceId ===
          f.device.id,
        enabled: () => localBrowserOptIn(config),
        onError: (code) => errors.push(code),
        // Deliberately no startDriver override: real renderer, proxy, DNS and native launcher.
      });
      const abort = new AbortController();
      const workerAbort = new AbortController();
      let workerTask: ReturnType<typeof runLocalBrowserWorkspace> | undefined;
      let controllerFailure: string | null = null;
      const running = controller.run(abort.signal).catch((e) => {
        controllerFailure = e instanceof Error ? e.message : 'unknown';
      });
      const report: Record<string, unknown> = {
        passed: false,
        schema,
        root: storageRoot,
        modelCalls: 0,
        scope:
          'single running default Bridge controller + real device Bearer HTTP handler + real PG approval service + Worker adapter + native Chrome + production public-DNS/TLS proxy; synthetic Run/account, not UI/password-login or full model loop',
        traffic,
        errors,
      };
      const current = () => readCurrentBrowserWorkspace(f.context, wId, db);
      const readSnapshot = async (id: string) => {
        const [row] =
          await db`select snapshot from allrice_runtime_operations where id=${id}`;
        return row ? RuntimeOperationSnapshotSchema.parse(row.snapshot) : null;
      };
      const complete = async (id: string) =>
        until(
          async () => {
            const snapshot = await readSnapshot(id);
            if (
              !snapshot ||
              !['succeeded', 'failed', 'unknown', 'canceled'].includes(
                snapshot.status,
              )
            )
              return null;
            expect(
              snapshot.status,
              JSON.stringify({ snapshot, errors, traffic }),
            ).toBe('succeeded');
            return snapshot;
          },
          `outcome:${id}`,
          20000,
        );
      const approve = async (id: string) => {
        const snapshot = await until(
          () => readSnapshot(id),
          'persisted operation snapshot',
        );
        if (snapshot.status === 'waiting_user') {
          // Worker publishes the operation before finishing approval creation.
          // Wait for the real durable request, never synthesize an approval row.
          await until(async () => {
            const [row] =
              await db`select id from allrice_approval_requests where resource_type='runtime_operation' and resource_id=${id} and organization_id=${f.org} and workspace_id=${f.workspace}`;
            return row;
          }, 'durable approval request');
          await f.approve({ snapshot });
        }
      };
      const human = async (action: BrowserAction) => {
        const w = await current();
        const op = await createBrowserOperation(
          f.context,
          {
            version: 1,
            workspaceId: wId,
            profileId: w.profile_id,
            actor: 'human',
            fence: w.control_fence,
            observationId:
              action.type === 'navigate' || action.type === 'observe'
                ? null
                : w.observation!.id,
            action,
          },
          randomUUID(),
          db,
        );
        await approve(op.snapshot.binding.attempt.operationId);
        return op.snapshot.binding.attempt.operationId;
      };
      const element = async (label: string) => {
        const e = (await current()).observation!.elements.find(
          (e) => e.label === label,
        );
        if (!e) throw Error(`missing fixture element:${label}`);
        return e.id;
      };
      const requestApproval = async (
        parent: string,
        pathname: string,
        expectedBody?: string,
      ) => {
        const op = await until(async () => {
          const [row] =
            await db`select i.payload,o.snapshot from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id where i.browser_workspace_id=${wId} and i.payload->'action'->>'type'='request' and i.payload->'action'->>'parentOperationId'=${parent}`;
          return row;
        }, 'exact network approval');
        const action = op.payload.action;
        expect(action.method).toBe('POST');
        expect(action.url).toBe(base + pathname);
        expect(action.urlDigest).toBe(hash(base + pathname));
        expect(action.bodyBytes).toBeGreaterThan(0);
        if (expectedBody) expect(action.bodyDigest).toBe(hash(expectedBody));
        const snapshot = RuntimeOperationSnapshotSchema.parse(op.snapshot);
        expect(snapshot.status).toBe('waiting_user');
        return snapshot;
      };
      try {
        await until(async () => {
          const w = await current();
          return w.state === 'agent' && w.acknowledged_fence === 1 ? w : null;
        }, 'native claim/control ack');
        const roots = (await readdir(storageRoot)).filter((n) =>
          n.startsWith('allrice-browser-'),
        );
        expect(roots).toHaveLength(1);
        const nativeRoot = join(storageRoot, roots[0]!);
        const processRecord = JSON.parse(
          await readFile(join(nativeRoot, 'process.json'), 'utf8'),
        );
        expect(processRecord.parentPid).toBe(process.pid);
        report.ownedProcesses = {
          parentPid: process.pid,
          childPid: processRecord.childPid,
          helperPid: processRecord.helperPid,
          directory: nativeRoot,
        };
        const [job] =
          await db`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
        const callId = randomUUID();
        const w = await current();
        const args = {
          command: 'act',
          workspaceId: wId,
          profileId: w.profile_id,
          fence: 1,
          observationId: null,
          action: { type: 'navigate', url: initial.endpoint },
        };
        workerTask = runLocalBrowserWorkspace({
          input: {
            signal: workerAbort.signal,
            context: f.execution,
            capabilities: ['network:outbound'],
            storageRoot,
            call: {
              id: callId,
              name: 'local.browser.workspace',
              arguments: args,
            },
            managedBrowserJobAttempt: job!.attempt,
            managedBrowserJobLeaseToken: job!.lease_token,
          },
          arguments: args,
        });
        void workerTask.catch(() => undefined);
        const workerOp = await until(async () => {
          const [row] =
            await db`select i.operation_id from allrice_browser_operation_inputs i where browser_workspace_id=${wId} and payload->'action'->>'type'='navigate'`;
          return row?.operation_id as string | undefined;
        }, 'Worker adapter operation');
        await approve(workerOp);
        expect(JSON.parse((await workerTask).modelContent)).toMatchObject({
          status: 'succeeded',
          target: 'local',
          deviceId: f.device.id,
        });
        await requestBrowserControl(
          f.context,
          wId,
          {
            requestId: randomUUID(),
            expectedFence: 1,
            control: 'human',
            observationId: (await current()).observation!.id,
          },
          db,
        );
        await until(async () => {
          const w = await current();
          return w.state === 'human' && w.acknowledged_fence === 2 ? w : null;
        }, 'physical human takeover');
        await complete(
          await human({
            type: 'fill',
            elementId: await element('Username'),
            value: 'P21-synthetic',
          }),
        );
        const beforeInput = await current(),
          passwordElement = beforeInput.observation!.elements.find(
            (e) => e.sensitive,
          )!;
        const secret = await createBrowserDirectInput(
          f.context,
          wId,
          {
            fence: 2,
            observationId: beforeInput.observation!.id,
            elementId: passwordElement.id,
            value: 'P21-Synthetic-Password',
          },
          db,
        );
        await complete(
          await human({
            type: 'sensitive_fill',
            elementId: passwordElement.id,
            inputId: secret.inputId,
          }),
        );
        const [consumed] =
          await db`select envelope,consumed_at from allrice_browser_direct_inputs where id=${secret.inputId}`;
        expect(consumed?.envelope).toBeNull();
        expect(consumed?.consumed_at).toBeTruthy();
        expect(
          JSON.stringify(await listBrowserWorkspaces(f.context, f.run, db)),
        ).not.toContain('P21-Synthetic-Password');
        const login = await human({
          type: 'click',
          elementId: await element('Sign in'),
        });
        const loginPermission = await requestApproval(
          login,
          'submit',
          'username=P21-synthetic&password=P21-Synthetic-Password',
        );
        expect((await state()).logins).toBe(initial.logins);
        // Deliberately leave real human approval unanswered beyond the old 5s
        // element timeout. Production controller/job heartbeats remain active;
        // no lease clocks, timestamps or permission responses are rewritten.
        await delay(6100);
        expect((await state()).logins).toBe(initial.logins);
        expect((await readSnapshot(login))?.status).toBe('running');
        expect(
          (await readSnapshot(loginPermission.binding.attempt.operationId))
            ?.status,
        ).toBe('waiting_user');
        await approve(loginPermission.binding.attempt.operationId);
        await complete(login);
        expect((await current()).observation!.text).toContain(
          'Signed in: P21 synthetic',
        );
        expect((await state()).logins).toBe(initial.logins + 1);
        const upload = await f.upload(
          Buffer.from('P21-synthetic-upload'),
          'text/plain',
        );
        await complete(
          await human({
            type: 'upload',
            elementId: await element('Upload'),
            objectId: upload.id,
            checksum: upload.checksum,
            fileName: 'p22-native-http.txt',
          }),
        );
        const submitUpload = await human({
          type: 'click',
          elementId: await element('Upload synthetic file'),
        });
        const uploadPermission = await requestApproval(submitUpload, 'upload');
        expect((await state()).uploads).toBe(initial.uploads);
        await approve(uploadPermission.binding.attempt.operationId);
        await complete(submitUpload);
        expect((await state()).uploads).toBe(initial.uploads + 1);
        const download = await human({
          type: 'download',
          elementId: await element('Download synthetic file'),
        });
        await complete(download);
        expect((await state()).downloads).toBe(initial.downloads + 1);
        const [file] =
          await db`select s.* from allrice_local_browser_captures c join allrice_storage_objects s on s.id=c.object_id where c.browser_workspace_id=${wId} and c.operation_id=${download} and c.kind='download'`;
        expect(file).toBeTruthy();
        expect(file?.checksum).toBe(hash('P21-synthetic-download'));
        expect(
          (
            await db`select version_id from allrice_workbench_artifacts where run_id=${f.run} and kind='browser_capture'`
          ).length,
        ).toBeGreaterThan(5);
        // An old pending command remains historical evidence, never executable after revoke.
        const latest = await current();
        const pending = await createBrowserOperation(
          f.context,
          {
            version: 1,
            workspaceId: wId,
            profileId: latest.profile_id,
            actor: 'human',
            fence: 2,
            observationId: latest.observation!.id,
            action: {
              type: 'click',
              elementId: await element('Upload synthetic file'),
            },
          },
          randomUUID(),
          db,
        );
        expect(pending.snapshot.status).toBe('waiting_user');
        expect(errors).toEqual([]);
        expect(traffic.filter((row) => row.status >= 400)).toEqual([]);
        const revokeTrafficIndex = traffic.length;
        await revokeLocalBrowserGrant(f.context, f.localGrant.grantId, db);
        await expect(f.approve(pending)).rejects.toBeTruthy();
        await until(
          async () => {
            const [row] =
              await db`select state,stopped_at from allrice_browser_workspaces where id=${wId}`;
            return row?.state === 'closed' && row.stopped_at ? row : null;
          },
          'physical stop receipt',
          20000,
        );
        await until(
          async () =>
            (await pendingLocalBrowserRevocations(f.device, db)).length === 0,
          'durable revoke cleanup',
        );
        for (const pid of [processRecord.childPid, processRecord.helperPid])
          await until(async () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              return (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          }, 'owned process exit');
        expect((await state()).uploads).toBe(initial.uploads + 1);
        expect(await outbox.pending()).toEqual([]);
        expect(controllerFailure).toBeNull();
        // An already in-flight poll can reach the authority after revocation.
        // Only that exact denied-next response is expected, and it must lead to
        // the physical stop/cleanup assertions above. Never forgive a 503.
        const revokedPolls = traffic
          .slice(revokeTrafficIndex)
          .filter((row) => row.status >= 400);
        expect(
          revokedPolls.every(
            (row) =>
              row.path === '/api/v1/bridge/browser-workspaces' &&
              row.kind === 'next' &&
              row.status === 403,
          ),
        ).toBe(true);
        expect(errors).toEqual(
          revokedPolls.map(() => 'LOCAL_BROWSER_UNAVAILABLE'),
        );
        report.expectedRevokedPolls = revokedPolls;
        report.passed = true;
        report.actualEffects = { logins: 1, uploads: 1, downloads: 1 };
        report.physicalStopConfirmed = true;
        report.exactSeparatePostApprovals = 2;
        report.secretDestroyed = true;
      } finally {
        workerAbort.abort();
        abort.abort();
        await workerTask?.catch(() => undefined);
        await running;
        await controller.stop();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        report.controllerFailure = controllerFailure;
        report.transactionFailures = transactionFailures;
        report.operations =
          await db`select i.operation_id,i.payload->'action'->>'type' as action,o.snapshot->>'status' as status,i.result from allrice_browser_operation_inputs i join allrice_runtime_operations o on o.id=i.operation_id where i.browser_workspace_id=${wId} order by i.created_at`;
        await writeFile(
          join(storageRoot, 'report.json'),
          JSON.stringify(report, null, 2),
          { mode: 0o600 },
        );
        // Only ephemeral generated profile directories may be removed by production
        // close. Report/config/logical state are retained for diagnosis, never user data.
        console.info(
          JSON.stringify({
            nativeHttpReport: join(storageRoot, 'report.json'),
            passed: report.passed,
          }),
        );
      }
    }, 150000);
  },
);
