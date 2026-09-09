import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import {
  BrowserProfileSchema,
  RuntimeLocalCommandSchema,
  LocalPreviewTargetSchema,
  localPreviewOrigin,
  type LocalPreviewLease,
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
import type { BrowserRequestEffect } from './index.js';
import { startLocalBrowserDriver } from '../../../apps/rice-bridge/src/local-browser-driver.js';
import { LocalBrowserProfiles } from '../../../apps/rice-bridge/src/local-browser-profiles.js';

// The preceding raw-Playwright fixture intermittently exceeded its original
// 20s close gate after denied navigation. Those failures are retained in the
// batch evidence. This test exercises production supervision, not that driver
// with a larger timeout or an ignored close error.

/** Forward every real launch argument/result unchanged. A native startup
 * failure stays a failed test; record only allowlisted phase/category, never
 * raw Playwright text (which can contain private proxy authentication). */
async function diagnosedStart(
  input: Parameters<typeof startLocalBrowserDriver>[0],
) {
  const realLaunch = chromium.launchPersistentContext.bind(chromium);
  let phase = 'before-native-launch',
    category = 'unclassified';
  const spy = vi
    .spyOn(chromium, 'launchPersistentContext')
    .mockImplementation(async (...args) => {
      phase = 'native-launch';
      try {
        const context = await realLaunch(...args);
        phase = 'native-launched';
        return context;
      } catch (error) {
        const text = error instanceof Error ? error.message : '';
        category = /LOCAL_BROWSER_LAUNCHER_DENIED/.test(text)
          ? 'launcher-denied'
          : /Timeout.*exceeded/s.test(text)
            ? 'launch-timeout'
            : /Resource temporarily unavailable|pthread_create/s.test(text)
              ? 'resource-unavailable'
              : /Target page, context or browser has been closed/.test(text)
                ? 'browser-closed'
                : 'unclassified';
        throw error;
      }
    });
  try {
    return await startLocalBrowserDriver(input);
  } catch (error) {
    const outcome =
      error instanceof Error &&
      error.message === 'LOCAL_BROWSER_CLEANUP_PENDING'
        ? 'cleanup-pending'
        : 'unavailable';
    throw Error(`P23_NATIVE_START_FAILED:${phase}:${category}:${outcome}`);
  } finally {
    spy.mockRestore();
  }
}

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
    async function launch(options: {
      relay: boolean;
      allowWrite: boolean;
      approvalGate?: Promise<void>;
    }) {
      let authority = true,
        expiresAt = Infinity;
      const effects: BrowserRequestEffect[] = [],
        receipts: boolean[] = [];
      const assertCurrent = async () => {
        if (!authority || Date.now() >= expiresAt)
          throw Error('synthetic lease revoked');
      };
      const endpointLeaseId = randomUUID();
      let currentTarget = structuredClone(target);
      const lease = async (): Promise<LocalPreviewLease> => {
        await assertCurrent();
        return {
          target: currentTarget,
          endpointLeaseId,
          expiresAt: new Date(
            Math.min(Date.now() + 4900, expiresAt),
          ).toISOString(),
        };
      };
      const fixture = await mkdtemp(join(root, 'browser-'));
      const driver = await diagnosedStart({
        binding: {
          version: 1,
          scope: target.scope,
          ownerId: target.ownerId,
          deviceId: target.deviceId,
          grantId: target.browserGrantId,
          grantRevision: 1,
          logicalProfileId: randomUUID(),
          persistLogin: false,
        },
        profiles: new LocalBrowserProfiles(
          join(fixture, 'config.json'),
          'https://saas.example',
        ),
        assertAlive: assertCurrent,
        leaseExpiresAt: () => Math.min(Date.now() + 4900, expiresAt),
        ...(options.relay ? { preview: { runner, current: lease } } : {}),
        options: {
          profileId: target.browserProfileId,
          profile: BrowserProfileSchema.parse({
            version: 1,
            origins: [localPreviewOrigin(target.endpointId)],
          }),
          assertCurrent,
          requestApproval: async (effect) => {
            effects.push(effect);
            if (!options.allowWrite) throw Error('denied');
            await options.approvalGate;
            return {
              complete: async (confirmed) => {
                receipts.push(confirmed);
              },
            };
          },
          requestSent: () => {},
          requestStarted: () => () => {},
        },
      });
      return {
        driver,
        effects,
        receipts,
        mutateTarget: () => {
          currentTarget = {
            ...currentTarget,
            generation: currentTarget.generation + 1,
          };
        },
        expire: () => {
          expiresAt = Date.now() + 1000;
        },
        revoke: () => {
          authority = false;
        },
      };
    }
    it('renders real HTML/JavaScript and requires exact body approval before the project receives POST', async () => {
      let approve!: () => void;
      const approvalGate = new Promise<void>((resolve) => {
        approve = resolve;
      });
      const value = await launch({
        relay: true,
        allowWrite: true,
        approvalGate,
      });
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
        const button = view.observation.elements.find(
          (e) => e.label === 'Save',
        );
        expect(button).toBeDefined();
        await value.driver.perform(
          { type: 'click', elementId: button!.id },
          view.observation,
        );
        await expect.poll(() => value.effects.length).toBe(1);
        expect(JSON.parse((await get('/status')).body.toString()).writes).toBe(
          0,
        );
        expect(value.receipts).toEqual([]);
        approve();
        await expect
          .poll(
            async () =>
              JSON.parse((await get('/status')).body.toString()).writes,
          )
          .toBe(1);
        expect(value.effects).toHaveLength(1);
        expect(value.effects[0]).toMatchObject({
          method: 'POST',
          url: localPreviewOrigin(target.endpointId) + '/save',
          urlDigest:
            'sha256:' +
            createHash('sha256')
              .update(localPreviewOrigin(target.endpointId) + '/save')
              .digest('hex'),
          bodyDigest: 'sha256:' + createHash('sha256').update('').digest('hex'),
          bodyBytes: 0,
        });
        await expect.poll(() => value.receipts).toEqual([true]);
      } finally {
        approve();
        await value.driver.close('lost');
      }
    }, 35000);
    it('refused write approval sends no request to the actual service', async () => {
      const before = JSON.parse((await get('/status')).body.toString()).writes;
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
          before,
        );
        expect(value.receipts).toEqual([]);
      } finally {
        await value.driver.close('lost');
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
        expect(value.effects).toEqual([]);
      } finally {
        await value.driver.close('lost');
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
        expect(value.effects).toEqual([]);
      } finally {
        await value.driver.close('lost');
      }
    }, 20000);
    it('closing while exact approval is pending cannot send the later-approved request', async () => {
      let approve!: () => void;
      const approvalGate = new Promise<void>((resolve) => {
        approve = resolve;
      });
      const value = await launch({
        relay: true,
        allowWrite: true,
        approvalGate,
      });
      try {
        await value.driver.perform(
          {
            type: 'navigate',
            url: localPreviewOrigin(target.endpointId) + '/',
          },
          null,
        );
        const { observation } = await value.driver.observe(1);
        await value.driver.perform(
          {
            type: 'click',
            elementId: observation.elements.find((e) => e.label === 'Save')!.id,
          },
          observation,
        );
        await expect.poll(() => value.effects.length).toBe(1);
        const before = JSON.parse(
          (await get('/status')).body.toString(),
        ).writes;
        const began = Date.now();
        await value.driver.close('lost');
        expect(Date.now() - began).toBeLessThan(8000);
        approve();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(JSON.parse((await get('/status')).body.toString()).writes).toBe(
          before,
        );
        await expect.poll(() => value.receipts).toEqual([false]);
      } finally {
        approve();
        await value.driver.close('lost');
      }
    }, 20000);
    it('a changed preview generation is rejected without writing to the real service', async () => {
      const before = JSON.parse((await get('/status')).body.toString()).writes;
      const value = await launch({ relay: true, allowWrite: true });
      try {
        value.mutateTarget();
        await expect(
          value.driver.perform(
            {
              type: 'navigate',
              url: localPreviewOrigin(target.endpointId) + '/',
            },
            null,
          ),
        ).rejects.toThrow();
        expect(value.effects).toEqual([]);
        expect(JSON.parse((await get('/status')).body.toString()).writes).toBe(
          before,
        );
      } finally {
        await value.driver.close('lost');
      }
    }, 20000);
    it('an expired preview lease kills the real browser and does not leave close waiting on CDP', async () => {
      const value = await launch({ relay: true, allowWrite: true });
      try {
        await value.driver.perform(
          {
            type: 'navigate',
            url: localPreviewOrigin(target.endpointId) + '/',
          },
          null,
        );
        value.expire();
        await new Promise((resolve) => setTimeout(resolve, 1400));
        await expect(value.driver.observe(1)).rejects.toThrow();
        const began = Date.now();
        await value.driver.close('lost');
        expect(Date.now() - began).toBeLessThan(8000);
      } finally {
        await value.driver.close('lost');
      }
    }, 20000);
    it('never forwards unauthorized loopback, cross-preview or external addresses', async () => {
      const value = await launch({ relay: true, allowWrite: true });
      try {
        for (const url of [
          'http://127.0.0.1:3100/',
          localPreviewOrigin(randomUUID()) + '/',
          'https://example.com/',
          localPreviewOrigin(target.endpointId) + ':444/',
        ])
          await expect(
            value.driver.perform({ type: 'navigate', url }, null),
          ).rejects.toThrow();
        expect(value.effects).toEqual([]);
      } finally {
        await value.driver.close('lost');
      }
    }, 20000);
    it('stopping the real owned service invalidates preview I/O and still closes the supervised browser', async () => {
      const value = await launch({ relay: true, allowWrite: true });
      try {
        await value.driver.perform(
          {
            type: 'navigate',
            url: localPreviewOrigin(target.endpointId) + '/',
          },
          null,
        );
        stop = true;
        await lifecycle;
        await expect(
          value.driver.perform(
            {
              type: 'navigate',
              url: localPreviewOrigin(target.endpointId) + '/status',
            },
            null,
          ),
        ).rejects.toThrow();
      } finally {
        await value.driver.close('lost');
      }
    }, 20000);
  },
);
