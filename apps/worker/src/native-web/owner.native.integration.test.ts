import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import {
  PersonVmError,
  nativeWebAuthArtifact,
  type PersonVmBootstrapScope,
  type PersonVmManagedJob,
} from '@allrice/person-vm';
import {
  NATIVE_WEB_AUTH_READER,
  parseNativeWebAuth,
} from '../../../../packages/person-vm/src/native-web-auth.ts';
import { runCommand } from '../../../../packages/person-vm/src/process.ts';
import { prepareNativeWebLaunch } from './launch.js';
import { openNativeWebOwner } from './owner.js';
import * as NativeTransport from './transport.js';

// Actual published rc.2 entry, not a fixture protocol server. Its complete
// compatible-OS package tree must be provisioned separately and recorded.
const cli = process.env.ALLRICE_NATIVE_WEB_TEST_CLI;
const tag = 'manual:ALLRICE_NATIVE_WEB_TEST_CLI';
const roots: string[] = [],
  cleanup: (() => Promise<void>)[] = [];
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  const joined = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  const failure = joined.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
});
async function setup() {
  expect(
    createHash('sha256')
      .update(await readFile(cli!))
      .digest('hex'),
  ).toBe('80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f');
  const pkg = JSON.parse(
    await readFile(resolve(dirname(cli!), '../package.json'), 'utf8'),
  );
  expect(pkg).toMatchObject({
    name: '@deepseek-ai/dsh',
    version: '0.2.1-rc.2',
  });
  const root = await mkdtemp('/tmp/ar-native-web-');
  roots.push(root);
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  const binding = {
    vmId: randomUUID(),
    instanceId: randomUUID(),
    personId: randomUUID(),
    organizationId: randomUUID(),
    leaseEpoch: 1,
  };
  const launch = await prepareNativeWebLaunch(
    {
      origin: `http://127.0.0.1:${port}/`,
      publicUrl: `http://127.0.0.1:${port}/`,
      guestAddress: '127.0.0.1',
      guestPort: port,
      dshHome: join(root, 'dsh'),
      agentsHome: join(root, 'agents'),
      workdir: root,
      cliPath: cli!,
      startupTimeoutMs: 10000,
    },
    binding,
  );
  for (const file of launch.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, { mode: file.mode });
  }
  const startup = new AbortController(),
    lifetime = new AbortController();
  let kills = 0,
    exited!: Promise<{ exitCode: number; timedOut: boolean }>,
    child!: ReturnType<typeof spawn>;
  const scope: PersonVmBootstrapScope = {
    binding,
    signal: startup.signal,
    assertCurrent: async () => {
      if (startup.signal.aborted) throw new PersonVmError('LEASE_LOST');
    },
    async launch(command) {
      child = spawn(process.execPath, [...command.args], {
        cwd: root,
        env: {
          PATH: dirname(process.execPath),
          HOME: root,
          ...command.env,
          DO_NOT_TRACK: '1',
          NPM_CONFIG_OFFLINE: 'true',
        },
        stdio: 'ignore',
      });
      exited = new Promise<{ exitCode: number; timedOut: boolean }>(
        (done, reject) => {
          child.once('error', reject);
          child.once('close', (code) =>
            done({ exitCode: code ?? 137, timedOut: false }),
          );
        },
      );
      async function wait(signal: AbortSignal) {
        signal.throwIfAborted();
        let abort!: () => void;
        try {
          return await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
            }),
          ]);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      }
      const job: PersonVmManagedJob = {
        binding,
        jobId: randomUUID(),
        wait,
        cancelAndWait: async (signal) => {
          kills++;
          child.kill('SIGKILL');
          return wait(signal);
        },
      };
      cleanup.push(async () => {
        child.kill('SIGKILL');
        await exited;
      });
      return job;
    },
    async readNativeWebAuth(request) {
      const file = nativeWebAuthArtifact(request);
      const text = await runCommand({
        executable: process.execPath,
        args: ['-e', NATIVE_WEB_AUTH_READER, file.path, String(file.maxBytes)],
        env: { PATH: dirname(process.execPath), HOME: root },
        signal: AbortSignal.any([
          startup.signal,
          AbortSignal.timeout(request.timeoutMs),
        ]),
      });
      return parseNativeWebAuth(text, request);
    },
  };
  const current = vi.fn(async () => {});
  const owner = await openNativeWebOwner({
    scope,
    launch,
    context: { actor: { id: binding.personId } } as RequestContext,
    vm: { assertCurrentBinding: current },
    lifetime: lifetime.signal,
    cleanupTimeoutMs: 5000,
  });
  cleanup.push(() => owner.close());
  return {
    owner,
    startup,
    lifetime,
    child,
    current,
    exited,
    kills: () => kills,
  };
}

it.skipIf(!cli)(
  '真实rc.2产物交换API Cookie→认证list/control baseline；scope结束不杀长期job，close实际join',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    expect(f.owner.controlReady()).toBe(true);
    f.startup.abort();
    expect((await f.owner.readSessions(new AbortController().signal)).ok).toBe(
      true,
    );
    expect(f.current).toHaveBeenCalledTimes(2);
    expect(f.child.exitCode).toBe(null);
    await Promise.all([f.owner.close(), f.owner.close()]);
    expect(f.owner.controlReady()).toBe(false);
    expect(f.kills()).toBe(1);
    expect(f.child.exitCode !== null || f.child.signalCode !== null).toBe(true);
  },
);

for (const check of [1, 2])
  it.skipIf(!cli)(
    `真实readSessions第${check}次现权检查阻塞时close等待完整operation，禁止新读`,
    { tags: [tag], timeout: 30000 },
    async () => {
      const ioClosed = latch();
      const createTransport = NativeTransport.nativeWebTransport;
      let fetches = 0;
      // Observe real public transport.close completion; no fake protocol/readiness.
      vi.spyOn(NativeTransport, 'nativeWebTransport').mockImplementation(
        (...args) => {
          const transport = createTransport(...args);
          return {
            ...transport,
            fetch: (...call) => {
              fetches++;
              return transport.fetch(...call);
            },
            close: async () => {
              await transport.close();
              ioClosed.resolve();
            },
          };
        },
      );
      const f = await setup(),
        entered = latch(),
        release = latch();
      cleanup.push(async () => {
        release.resolve();
      });
      if (check === 2) f.current.mockResolvedValueOnce(undefined);
      f.current.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise; // Deliberately join even after its signal is aborted.
      });
      const reading = f.owner.readSessions(new AbortController().signal).then(
        () => {
          throw Error('closed reader must not return data');
        },
        (error: unknown) => error,
      );
      await entered.promise;
      const atGuard = fetches;
      let settled = false;
      const closed = f.owner.close().then(() => {
        settled = true;
      });
      await Promise.all([ioClosed.promise, f.exited]); // Real network and exact child join.
      await new Promise<void>((done) => setImmediate(done)); // Drain their settled continuations.
      expect(settled).toBe(false);
      await expect(
        f.owner.readSessions(new AbortController().signal),
      ).rejects.toBeDefined();
      expect(f.current).toHaveBeenCalledTimes(check);
      expect(fetches).toBe(atGuard);
      release.resolve();
      expect(await reading).toBeDefined();
      await closed;
      expect(f.current).toHaveBeenCalledTimes(check);
      expect(fetches).toBe(atGuard);
      expect(f.kills()).toBe(1);
    },
  );
it.skipIf(!cli)(
  '真实native control失联只撤可达资格，不重放；lifetime取消仍精确结束job并join',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    const revoked = once(f.owner.revoked, 'abort');
    f.child.kill('SIGKILL');
    await revoked;
    expect(f.owner.controlReady()).toBe(false);
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toBeDefined();
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);

it.skipIf(!cli)(
  '已join的单次取消不废owner；真实现权失效撤旧epoch，仍由显式close确认guest终止',
  { tags: [tag], timeout: 30000 },
  async () => {
    const f = await setup();
    await expect(
      f.owner.readSessions(AbortSignal.abort()),
    ).rejects.toBeDefined();
    expect(f.owner.controlReady()).toBe(true);
    f.current.mockRejectedValueOnce(new PersonVmError('LEASE_LOST'));
    await expect(
      f.owner.readSessions(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(f.owner.revoked.aborted).toBe(true);
    expect(f.kills()).toBe(0);
    await f.owner.close();
    expect(f.kills()).toBe(1);
  },
);
