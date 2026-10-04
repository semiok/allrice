import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../packages/database/src/assistant-runtime.fixture.ts';
import { createLocalBrowserFixture } from '../../packages/database/src/local-browser.fixture.ts';
import {
  publishWorkbenchArtifact,
  readArtifactBytes,
  getWorkbenchArtifact,
} from '../../packages/database/src/artifact-review.ts';
import * as client from '../../packages/database/src/core/client.ts';
import {
  getWorkAutomation,
  updateWorkAutomation,
} from '../../packages/database/src/work-automation.ts';
import { handleLocalBrowserRequest } from '../../apps/web/lib/bridge/local-browser-runtime.ts';
import { LocalBrowserHttpAuthority } from '../../apps/rice-bridge/src/local-browser-client.ts';
import { LocalBrowserController } from '../../apps/rice-bridge/src/local-browser-controller.ts';
import { LocalBrowserProfiles } from '../../apps/rice-bridge/src/local-browser-profiles.ts';
import { LocalBrowserOutbox } from '../../apps/rice-bridge/src/local-browser-outbox.ts';
import { runBrowserWorkspace } from '../../apps/worker/src/tool-broker/handlers/browser-workspace.ts';
import { nativeBrokerRoundtrip } from '../../apps/worker/src/harness/dsh-native-broker.fixture.ts';
import type {
  BrowserVerificationOutcome,
  WorkbenchArtifact,
} from '@allrice/contracts';
const ports = vi.hoisted(() => ({ storage: vi.fn() }));
vi.mock('../../apps/web/lib/storage/runtime.ts', () => ({
  getStorageAdapter: ports.storage,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_STATIC_BROWSER_LOCAL_PHYSICAL === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'finite saved-page verification through actual local device HTTP and native renderer',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      root: string;
    beforeAll(async () => {
      expect(process.platform).toBe('darwin');
      for (const key of [
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BROWSER_CONTROL_ENABLED',
        'ALLRICE_LOCAL_BROWSER_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
      ])
        vi.stubEnv(key, '1');
      database = await createAssistantFixtureDatabase();
      root = await mkdtemp(join(tmpdir(), 'allrice-static-browser-native-'));
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });
    it('native DSH -> Broker -> authenticated Bridge HTTP -> controller -> saved HTML interaction -> stopped PNG/report', async () => {
      const f = await createLocalBrowserFixture(database.db, root, {
        open: false,
        workbench: true,
        memberRole: 'member',
      });
      ports.storage.mockReturnValue(f.storage);
      await database.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment}',
      '{"version":1,"clientVersion":"candidate-static","staticBrowserVersion":1,"browser":"ready","sandbox":"unavailable","preview":"unavailable","paused":false}'::jsonb)
      where target_key=${'bridge.' + f.device.id}`;
      const html = `<!doctype html><meta charset="utf-8"><title>Known bug verified</title><button onclick="document.querySelector('output').textContent=20+22">Compute</button><output>0</output>`;
      const source = await publishWorkbenchArtifact(
        {
          context: f.execution,
          sessionId: f.session,
          callId: randomUUID(),
          kind: 'document',
          fileName: 'index.html',
          format: 'html',
          mediaType: 'text/html',
          bytes: Buffer.from(html),
        },
        f.storage,
        database.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      const automation = await getWorkAutomation(
        f.context,
        f.workspace,
        database.db,
      );
      await updateWorkAutomation(
        f.context,
        f.workspace,
        {
          expectedRevision: automation.revision,
          capability: 'computer',
          enabled: true,
        },
        database.db,
      );
      const traffic: { kind: string; status: number }[] = [];
      const server = createServer(async (incoming, outgoing) => {
        try {
          let size = 0;
          const parts: Buffer[] = [];
          for await (const part of incoming) {
            size += part.length;
            if (size > 12_000_000) throw Error('limit');
            parts.push(Buffer.from(part));
          }
          const bytes = Buffer.concat(parts),
            capture = incoming.url?.endsWith('/capture') === true;
          const response = await handleLocalBrowserRequest(
            new Request('http://127.0.0.1' + incoming.url, {
              method: 'POST',
              headers: new Headers(
                Object.entries(incoming.headers).flatMap(([k, v]) =>
                  v === undefined
                    ? []
                    : [
                        [k, Array.isArray(v) ? v.join(',') : v] as [
                          string,
                          string,
                        ],
                      ],
                ),
              ),
              body: Uint8Array.from(bytes),
            }),
            capture,
          );
          traffic.push({
            kind: capture ? 'capture' : JSON.parse(bytes.toString()).kind,
            status: response.status,
          });
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers),
          );
          outgoing.end(Buffer.from(await response.arrayBuffer()));
          bytes.fill(0);
        } catch (error) {
          console.error('STATIC_NATIVE_HTTP_FAILURE', error);
          outgoing.writeHead(500).end();
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('port required');
      const origin = 'http://127.0.0.1:' + address.port,
        configPath = join(root, 'device.json');
      await writeFile(
        configPath,
        JSON.stringify({ server: origin, deviceId: f.device.id, grants: [] }),
        { mode: 0o600 },
      );
      const diagnostics: unknown[] = [],
        abort = new AbortController();
      const profiles = new LocalBrowserProfiles(configPath, origin);
      vi.spyOn(profiles, 'load').mockImplementation(async () => {
        throw Error('STATIC_BROWSER_MUST_NOT_IMPORT_LOGIN_STATE');
      });
      const controller = new LocalBrowserController({
        deviceId: f.device.id,
        authority: new LocalBrowserHttpAuthority({
          server: origin,
          token: f.token,
        }),
        profiles,
        outbox: new LocalBrowserOutbox(configPath, origin, f.device.id),
        enabled: async () => true,
        paired: async () => true,
        onError: (code) => diagnostics.push(code),
        onDiagnostic: (stage, code) => diagnostics.push({ stage, code }),
      });
      const running = controller.run(abort.signal);
      const [j] = await database.db<
        { attempt: number; lease_token: string }[]
      >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
      const args = {
        command: 'verify',
        artifact: { versionId: source.id, checksum: source.object.checksum },
        plan: {
          version: 1,
          timeoutMs: 30000,
          steps: [
            { type: 'click', selector: { tag: 'button', label: 'Compute' } },
            { type: 'text_contains', expected: '42' },
          ],
        },
        location: 'auto',
      };
      let result:
        | {
            verification: BrowserVerificationOutcome;
            artifacts: WorkbenchArtifact[];
          }
        | undefined;
      try {
        await nativeBrokerRoundtrip({
          canonicalName: 'browser.workspace',
          wireName: 'browser_workspace',
          args,
          invalidArgs: { ...args, artifact: { ...args.artifact, html } },
          timeoutMs: 120000,
          onToolCall: async (call) => {
            const response = await runBrowserWorkspace({
              input: {
                context: f.execution,
                capabilities: [
                  'storage:read',
                  'storage:write',
                  'network:outbound',
                ],
                storageRoot: root,
                sessionId: f.session,
                call,
                managedBrowserJobAttempt: j!.attempt,
                managedBrowserJobLeaseToken: j!.lease_token,
              },
              arguments: call.arguments,
            }).catch((error) => {
              console.error(
                'STATIC_NATIVE_CHAIN_FAILURE',
                error,
                JSON.stringify({ traffic, diagnostics }),
              );
              throw error;
            });
            result = JSON.parse(response.modelContent);
            return response;
          },
        });
        const evidence = process.env.ALLRICE_STATIC_BROWSER_EVIDENCE;
        const counts = traffic.reduce<Record<string, number>>((a, t) => {
          const k = t.kind + ':' + t.status;
          a[k] = (a[k] ?? 0) + 1;
          return a;
        }, {});
        if (evidence)
          await writeFile(
            join(evidence, 'pr4b-native-local-chain.json'),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                host: process.arch,
                verification: result!.verification,
                trafficCounts: counts,
                diagnostics,
                loginStateImported: false,
                newModelTasks: 0,
              },
              null,
              2,
            ),
          );
        expect(
          result?.verification,
          JSON.stringify({
            report: result?.verification.report,
            diagnostics,
            counts,
          }),
        ).toMatchObject({
          location: 'local',
          deviceId: f.device.id,
          physicalStopConfirmed: true,
          report: { verdict: 'passed' },
        });
        expect(
          traffic.some((t) => t.kind === 'static_document' && t.status === 200),
        ).toBe(true);
        expect(
          traffic.some((t) => t.kind === 'stopped' && t.status === 200),
        ).toBe(true);
        const delivered = [];
        for (const a of result!.artifacts) {
          const artifact = await getWorkbenchArtifact(
              f.context,
              f.session,
              a.id,
              database.db,
            ),
            bytes = await readArtifactBytes(
              f.storage,
              artifact.object,
              5_000_000,
            );
          expect(
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          ).toBe(artifact.object.checksum);
          delivered.push({
            id: a.id,
            checksum: artifact.object.checksum,
            sizeBytes: bytes.length,
          });
        }
        expect(
          (await readdir(root)).filter((name) =>
            name.startsWith('allrice-browser-'),
          ),
        ).toEqual([]);
        expect(profiles.load).not.toHaveBeenCalled();
        if (evidence)
          await writeFile(
            join(evidence, 'pr4b-native-local-chain.json'),
            JSON.stringify(
              {
                at: new Date().toISOString(),
                host: process.arch,
                verification: result!.verification,
                artifacts: delivered,
                traffic,
                diagnostics,
                loginStateImported: false,
                physicalDirectoriesRemoved: true,
                newModelTasks: 0,
              },
              null,
              2,
            ),
          );
      } finally {
        abort.abort();
        await running;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 180000);
  },
);
