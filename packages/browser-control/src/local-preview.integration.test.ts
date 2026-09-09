import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserProfileSchema,
  RuntimeLocalCommandSchema,
  LocalPreviewTargetSchema,
  localPreviewOrigin,
  localPreviewUrlAllowed,
  type LocalPreviewTarget,
  type RuntimeLocalCommandResult,
} from '@allrice/contracts';
import { LocalPreviewRelay } from '../../../apps/rice-bridge/src/local-preview-relay.js';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import { LocalServiceRunner } from '../../../apps/rice-bridge/src/local-service-runner.js';
import {
  testImage,
  testSocket,
} from '../../../apps/rice-bridge/test/toolchain.js';
import {
  createControlledBrowserRenderer,
  type BrowserRequestEffect,
} from './index.js';

const suite =
  process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET &&
  process.env.ALLRICE_TEST_LOCAL_BROWSER_NATIVE === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'P23 real native Chrome + real private project service (no network fallback)',
  () => {
    let root: string,
      runner: LocalCommandRunner,
      relay: LocalPreviewRelay,
      target: LocalPreviewTarget;
    let lifecycle: Promise<RuntimeLocalCommandResult>,
      stop = false;
    const current = async () => ({
      expiresAt: new Date(Date.now() + 5000).toISOString(),
    });
    const get = (path: string) =>
      relay.fetch(
        target,
        {
          url: localPreviewOrigin(target.endpointId) + path,
          method: 'GET',
          headers: {},
        },
        { assertCurrent: current },
      );
    beforeAll(async () => {
      if (
        process.platform !== 'darwin' ||
        process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET !== testSocket
      )
        throw Error('dedicated native VM required');
      runner = new LocalCommandRunner({
        socketPath: testSocket,
        imageDigest: testImage,
      });
      await runner.preflight();
      relay = new LocalPreviewRelay(runner);
      root = await mkdtemp(join(tmpdir(), 'allrice-p23-browser-project-'));
      const source = `import http from 'node:http';let writes=0;http.createServer((q,s)=>{
   if(q.method==='POST')writes++;
   if(q.url==='/'){s.setHeader('content-type','text/html');s.end('<!doctype html><h1>Actual container project</h1><script src="/app.js"></script><form action="/save" method="post"><button>Save</button></form>');return;}
   if(q.url==='/app.js'){s.setHeader('content-type','application/javascript');s.end('document.addEventListener("DOMContentLoaded",()=>{const p=document.createElement("p");p.textContent="Actual project JavaScript loaded";document.body.append(p)})');return;}
   s.setHeader('content-type','application/json');s.end(JSON.stringify({writes}));
  }).listen(3100,'127.0.0.1');`;
      await writeFile(join(root, 'service.mjs'), source);
      const hash = (s: string) =>
        'sha256:' + createHash('sha256').update(s).digest('hex');
      const command = RuntimeLocalCommandSchema.parse({
        capability: 'local.process.execute',
        arguments: {
          executable: '/usr/local/bin/node',
          args: ['service.mjs'],
          path: '.',
          files: [{ path: 'service.mjs', sha256: hash(source) }],
          imageDigest: testImage,
          isolation: 'local-vm-container-v1',
          network: 'none',
          limits: {
            timeoutMs: 10000,
            outputBytes: 8192,
            memoryMiB: 128,
            cpuMillis: 500,
            pids: 32,
          },
          background: {
            durationMs: 180000,
            readiness: {
              kind: 'http',
              port: 3100,
              path: '/',
              timeoutMs: 10000,
            },
            stdin: {
              mode: 'none',
              maxRequests: 1,
              maxBytes: 100,
              requestTimeoutMs: 1000,
            },
          },
        },
      });
      const attemptId = randomUUID(),
        processId = randomUUID(),
        runId = randomUUID(),
        hardDeadlineAt = new Date(Date.now() + 180000).toISOString();
      let ready!: () => void;
      const signal = new Promise<void>((resolve) => {
        ready = resolve;
      });
      lifecycle = new LocalServiceRunner(runner).execute(root, command, {
        processId,
        attemptId,
        hardDeadlineAt,
        maintainLease: async () => ({
          leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
          stopRequested: stop,
          inputs: [],
        }),
        prepareInput: async () => {
          throw Error('no input');
        },
        onEvent: async (event) => {
          if (event.type === 'starting')
            target = LocalPreviewTargetSchema.parse({
              version: 1,
              endpointId: randomUUID(),
              scope: {
                organizationId: randomUUID(),
                workspaceId: randomUUID(),
                projectId: null,
              },
              ownerId: randomUUID(),
              deviceId: randomUUID(),
              runId,
              rootRunId: runId,
              browserWorkspaceId: randomUUID(),
              browserProfileId: randomUUID(),
              browserGrantId: randomUUID(),
              processId,
              attemptId,
              generation: 1,
              fence: 1,
              processInputDigest: hash(JSON.stringify(command)),
              folderGrantId: randomUUID(),
              folderGrantVersion: 1,
              containerId: event.containerId,
              imageDigest: testImage,
              port: 3100,
              hardDeadlineAt,
            });
          if (event.type === 'ready') ready();
        },
      });
      await Promise.race([
        signal,
        lifecycle.then(() => {
          throw Error('early service exit');
        }),
      ]);
    }, 30000);
    afterAll(async () => {
      stop = true;
      if (lifecycle) {
        const result = await lifecycle;
        await runner.cleanup(target.attemptId, result.containerId);
      }
      if (root) await rm(root, { recursive: true, force: true });
    }, 20000);
    async function launch(options: { relay: boolean; allowWrite: boolean }) {
      let authority = true,
        relays = 0;
      const effects: BrowserRequestEffect[] = [],
        receipts: boolean[] = [],
        relayErrors: string[] = [];
      const browser = await chromium.launch({
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        chromiumSandbox: true,
        headless: true,
        proxy: { server: 'http://127.0.0.1:9' },
        args: [
          '--disable-background-networking',
          '--disable-quic',
          '--host-resolver-rules=MAP * ~NOTFOUND',
          '--proxy-bypass-list=<-loopback>',
        ],
      });
      try {
        const context = await browser.newContext({
          serviceWorkers: 'block',
          permissions: [],
          acceptDownloads: false,
        });
        const assertCurrent = async () => {
          if (!authority) throw Error('synthetic lease revoked');
        };
        const driver = await createControlledBrowserRenderer(
          context,
          browser,
          {
            profileId: target.browserProfileId,
            profile: BrowserProfileSchema.parse({
              version: 1,
              origins: [localPreviewOrigin(target.endpointId)],
            }),
            authorizeUrl: (url) => localPreviewUrlAllowed(target, url),
            assertCurrent,
            requestApproval: async (effect) => {
              effects.push(effect);
              if (!options.allowWrite) throw Error('denied');
              return {
                complete: async (confirmed) => {
                  receipts.push(confirmed);
                },
              };
            },
            requestSent: () => {},
            requestStarted: () => () => {},
            ...(options.relay
              ? {
                  localPreviewRelay: async (
                    input: Parameters<LocalPreviewRelay['fetch']>[1],
                  ) => {
                    relays++;
                    try {
                      return await relay.fetch(target, input, {
                        assertCurrent: async () => {
                          await assertCurrent();
                          return current();
                        },
                      });
                    } catch (error) {
                      relayErrors.push(
                        error instanceof Error ? error.message : 'unknown',
                      );
                      throw error;
                    }
                  },
                }
              : {}),
          },
          async () => {},
        );
        return {
          driver,
          effects,
          receipts,
          relayErrors,
          relays: () => relays,
          revoke: () => {
            authority = false;
          },
        };
      } catch (error) {
        await browser.close();
        throw error;
      }
    }
    it('renders real HTML/JavaScript and requires exact body approval before the project receives POST', async () => {
      const value = await launch({ relay: true, allowWrite: true });
      try {
        await value.driver.perform(
          {
            type: 'navigate',
            url: localPreviewOrigin(target.endpointId) + '/',
          },
          null,
        );
        const view = await value.driver.observe(1);
        expect(view.observation.text).toContain('Actual container project');
        expect(view.observation.text).toContain(
          'Actual project JavaScript loaded',
        );
        expect(view.screenshot.length).toBeGreaterThan(100);
        expect(value.relays()).toBeGreaterThanOrEqual(2);
        const button = view.observation.elements.find(
          (e) => e.label === 'Save',
        );
        expect(button).toBeDefined();
        await value.driver.perform(
          { type: 'click', elementId: button!.id },
          view.observation,
        );
        await expect
          .poll(async () => ({
            writes: JSON.parse((await get('/status')).body.toString()).writes,
            errors: value.relayErrors,
          }))
          .toEqual({ writes: 1, errors: [] });
        expect(value.effects).toHaveLength(1);
        expect(value.effects[0]).toMatchObject({
          method: 'POST',
          url: localPreviewOrigin(target.endpointId) + '/save',
        });
        await expect.poll(() => value.receipts).toEqual([true]);
      } finally {
        await value.driver.close();
      }
    }, 35000);
    it('refused write approval sends no request to the actual service', async () => {
      const value = await launch({ relay: true, allowWrite: false });
      try {
        await value.driver.perform(
          {
            type: 'navigate',
            url: localPreviewOrigin(target.endpointId) + '/',
          },
          null,
        );
        const { observation } = await value.driver.observe(1),
          button = observation.elements.find((e) => e.label === 'Save')!;
        await value.driver.perform(
          { type: 'click', elementId: button.id },
          observation,
        );
        await expect.poll(() => value.effects.length).toBe(1);
        expect(JSON.parse((await get('/status')).body.toString()).writes).toBe(
          1,
        );
        expect(value.receipts).toEqual([]);
      } finally {
        await value.driver.close();
      }
    }, 30000);
    it('reserved origins never fall back to network if the trusted relay is absent', async () => {
      const value = await launch({ relay: false, allowWrite: false });
      try {
        await expect(
          value.driver.perform(
            {
              type: 'navigate',
              url: localPreviewOrigin(target.endpointId) + '/',
            },
            null,
          ),
        ).rejects.toThrow();
        expect(value.relays()).toBe(0);
      } finally {
        await value.driver.close();
      }
    }, 20000);
    it('revocation rejects navigation before relay execution', async () => {
      const value = await launch({ relay: true, allowWrite: true });
      try {
        value.revoke();
        await expect(
          value.driver.perform(
            {
              type: 'navigate',
              url: localPreviewOrigin(target.endpointId) + '/',
            },
            null,
          ),
        ).rejects.toThrow();
        expect(value.relays()).toBe(0);
      } finally {
        await value.driver.close();
      }
    }, 20000);
  },
);
