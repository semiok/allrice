import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type { TerminalTarget } from '@allrice/contracts';
import type { BridgeConfig } from './config.js';
import { HumanTerminalHost } from './human-terminal-host.js';

type Authority = 'current' | 'revoked' | 'unknown';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-terminal-authority-')),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const target: TerminalTarget = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    loginSessionId: randomUUID(),
    sessionId: randomUUID(),
    deviceId: randomUUID(),
    grantId: randomUUID(),
    grantVersion: 1,
    rootFingerprint: createHash('sha256').update(root).digest('hex'),
    label: 'Test folder',
  };
  const config: BridgeConfig = {
    server: 'https://example.invalid',
    deviceId: target.deviceId,
    deviceName: 'Test Mac',
    grants: [
      {
        id: target.grantId,
        label: target.label,
        rootPath: root,
        rootFingerprint: target.rootFingerprint,
      },
    ],
  };
  const authority = vi.fn(async (): Promise<Authority> => 'current');
  const host = new HumanTerminalHost({
    server: config.server,
    deviceId: config.deviceId,
    currentConfig: async () => config,
    authorizeTarget: authority,
  });
  cleanup.push(() => host.dispose());
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  return { host, authority, clock, target, config, root };
}
async function finishWithoutAuthority(
  promise: Promise<unknown>,
  gate: ReturnType<typeof deferred<Authority>>,
) {
  const state = await Promise.race([
    promise.then(() => 'finished'),
    delay(150).then(() => 'waiting'),
  ]);
  gate.resolve('current');
  await promise;
  expect(state).toBe('finished');
}

it('awaits first authority and coalesces simultaneous first admissions', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  f.authority.mockImplementationOnce(() => gate.promise);
  let completed = 0;
  const first = f.host.validate(f.target).then(() => completed++);
  const second = f.host.validate(f.target).then(() => completed++);
  await vi.waitFor(() => expect(f.authority).toHaveBeenCalledTimes(1));
  expect(completed).toBe(0);
  gate.resolve('current');
  await Promise.all([first, second]);
  expect(completed).toBe(2);
});

it('keeps input and output within the valid lease off the 500 ms refresh round trip', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  await f.host.validate(f.target);
  f.clock.mockReturnValue(1_000_500);
  f.authority.mockImplementationOnce(() => gate.promise);
  await finishWithoutAuthority(
    Promise.all(Array.from({ length: 20 }, () => f.host.validate(f.target))),
    gate,
  );
  expect(f.authority).toHaveBeenCalledTimes(2);
});

it('does not make fresh-lease input wait for a forced maintenance check', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  await f.host.validate(f.target);
  f.authority.mockImplementationOnce(() => gate.promise);
  const maintenance = f.host.validate(f.target, true);
  await vi.waitFor(() => expect(f.authority).toHaveBeenCalledTimes(2));
  await finishWithoutAuthority(f.host.validate(f.target), gate);
  await maintenance;
});

it('awaits in-flight authority at the exact five-second boundary and rejects unknown', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  await f.host.validate(f.target);
  f.clock.mockReturnValue(1_000_500);
  f.authority.mockImplementationOnce(() => gate.promise);
  const refresh = f.host.validate(f.target);
  await refresh;
  f.clock.mockReturnValue(1_005_000);
  let completed = false;
  const expired = f.host.validate(f.target).finally(() => {
    completed = true;
  });
  const rejected = expect(expired).rejects.toThrow(
    'HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE',
  );
  await delay(10);
  expect(completed).toBe(false);
  expect(f.authority).toHaveBeenCalledTimes(2);
  gate.resolve('unknown');
  await rejected;
});

it('unknown refreshes never renew the five-second lease', async () => {
  const f = await fixture();
  await f.host.validate(f.target);
  f.authority.mockResolvedValue('unknown');
  f.clock.mockReturnValue(1_004_999);
  await expect(f.host.validate(f.target, true)).resolves.toBe(f.root);
  f.clock.mockReturnValue(1_005_000);
  await expect(f.host.validate(f.target)).rejects.toThrow(
    'HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE',
  );
});

it('a background revoked response closes an idle native owner without further validation', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  const owner = await f.host.acquire(f.target);
  const close = vi.spyOn(owner, 'dispose');
  f.clock.mockReturnValue(1_000_500);
  f.authority.mockImplementationOnce(() => gate.promise);
  await f.host.validate(f.target);
  expect(close).not.toHaveBeenCalled();
  gate.resolve('revoked');
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  await expect(
    owner.call('environment', {}, new AbortController().signal),
  ).rejects.toThrow('HUMAN_TERMINAL_OWNER_UNAVAILABLE');
});

it('failed background cleanup retains and blocks the owner until maintenance retries it', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  const owner = await f.host.acquire(f.target);
  const close = vi
    .spyOn(owner, 'dispose')
    .mockRejectedValueOnce(Error('synthetic cleanup failure'));
  f.clock.mockReturnValue(1_000_500);
  f.authority.mockImplementationOnce(() => gate.promise);
  await f.host.validate(f.target);
  gate.resolve('revoked');
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  await expect(f.host.validate(f.target)).rejects.toThrow(
    'HUMAN_TERMINAL_AUTHORIZATION_REVOKED',
  );
  await f.host.revalidate();
  expect(close).toHaveBeenCalledTimes(2);
});

it('a retired owner response cannot revoke a later owner with the same target', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  const oldOwner = await f.host.acquire(f.target);
  f.clock.mockReturnValue(1_000_500);
  f.authority.mockImplementationOnce(() => gate.promise);
  await f.host.validate(f.target);
  await f.host.release(oldOwner, true);
  const currentOwner = await f.host.acquire(f.target);
  const close = vi.spyOn(currentOwner, 'dispose');
  gate.resolve('revoked');
  await delay(10);
  expect(close).not.toHaveBeenCalled();
  await expect(
    currentOwner.call('environment', {}, new AbortController().signal),
  ).resolves.toBeDefined();
  await expect(f.host.validate(f.target)).resolves.toBe(f.root);
});

it('joins the same pending revocation cleanup during host disposal', async () => {
  const f = await fixture(),
    authority = deferred<Authority>(),
    cleanupGate = deferred<void>();
  const owner = await f.host.acquire(f.target);
  const dispose = owner.dispose.bind(owner);
  const close = vi.spyOn(owner, 'dispose').mockImplementation(async () => {
    await cleanupGate.promise;
    await dispose();
  });
  f.clock.mockReturnValue(1_000_500);
  f.authority.mockImplementationOnce(() => authority.promise);
  await f.host.validate(f.target);
  authority.resolve('revoked');
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  const stopped = f.host.dispose();
  expect(close).toHaveBeenCalledTimes(1);
  cleanupGate.resolve();
  await stopped;
  expect(close).toHaveBeenCalledTimes(1);
});

it('retains immediate local grant revocation even with a valid server lease', async () => {
  const f = await fixture();
  await f.host.validate(f.target);
  f.config.grants[0]!.revokedAt = new Date().toISOString();
  await expect(f.host.validate(f.target)).rejects.toThrow(
    'HUMAN_TERMINAL_GRANT_UNAVAILABLE',
  );
  expect(f.authority).toHaveBeenCalledTimes(1);
});

it('never lends a valid lease to another login or grant generation', async () => {
  const f = await fixture();
  await f.host.validate(f.target);
  f.authority.mockResolvedValue('unknown');
  await expect(
    f.host.validate({ ...f.target, loginSessionId: randomUUID() }),
  ).rejects.toThrow('HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE');
  await expect(
    f.host.validate({ ...f.target, grantVersion: 2 }),
  ).rejects.toThrow('HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE');
  expect(f.authority).toHaveBeenCalledTimes(3);
});

it('disposal joins a pending check and its late success cannot admit a terminal', async () => {
  const f = await fixture(),
    gate = deferred<Authority>();
  f.authority.mockImplementationOnce(() => gate.promise);
  const validation = f.host.validate(f.target);
  const rejected = expect(validation).rejects.toThrow(
    'HUMAN_TERMINAL_HOST_CLOSED',
  );
  await vi.waitFor(() => expect(f.authority).toHaveBeenCalledTimes(1));
  let stopped = false;
  const stop = f.host.dispose().then(() => {
    stopped = true;
  });
  await delay(10);
  expect(stopped).toBe(false);
  gate.resolve('current');
  await Promise.all([rejected, stop]);
  await expect(f.host.acquire(f.target)).rejects.toThrow(
    'HUMAN_TERMINAL_HOST_CLOSED',
  );
});

it('a synchronous authority failure becomes unknown without an unhandled background rejection', async () => {
  const f = await fixture();
  await f.host.validate(f.target);
  f.clock.mockReturnValue(1_000_500);
  f.authority.mockImplementation(() => {
    throw Error('synthetic synchronous failure');
  });
  await expect(f.host.validate(f.target)).resolves.toBe(f.root);
  await expect(f.host.validate(f.target, true)).resolves.toBe(f.root);
  f.clock.mockReturnValue(1_005_000);
  await expect(f.host.validate(f.target)).rejects.toThrow(
    'HUMAN_TERMINAL_AUTHORIZATION_UNAVAILABLE',
  );
});
