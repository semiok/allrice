import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { PersonVmBootstrapScope } from '@allrice/person-vm';
import { prepareNativeWebLaunch } from './launch.js';
import { openNativeWebOwner } from './owner.js';

const binding = {
  vmId: randomUUID(),
  instanceId: randomUUID(),
  personId: randomUUID(),
  organizationId: randomUUID(),
  leaseEpoch: 1,
};
it('stage实际native Host插件/patch，独立员工HOME并保原生no-open CLI；不写token或端口池', async () => {
  const config = {
    origin: 'http://127.0.0.1:32179/',
    publicUrl: 'https://e1.example.test/',
    guestAddress: '10.0.0.2',
    guestPort: 8080,
    dshHome: '/work/employee-a/dsh',
    agentsHome: '/work/employee-a/agents',
    workdir: '/work/shared',
    cliPath: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    startupTimeoutMs: 5000,
  };
  const a = await prepareNativeWebLaunch(config, binding),
    b = await prepareNativeWebLaunch(
      {
        ...config,
        dshHome: '/work/employee-b/dsh',
      },
      binding,
    );
  expect(a.command.args).toContain('--profile');
  expect(a.command.args).toContain('--no-open');
  expect(a.command.args.indexOf('--patch')).toBeLessThan(
    a.command.args.indexOf('--no-open'),
  );
  expect(a.command.env).toEqual({
    DSH_HOME: config.dshHome,
    DSH_AGENTS_HOME: config.agentsHome,
  });
  expect(a.files[0]!.contents).toContain(
    'ctx.connection.authenticatedUrl(baseUrl)',
  );
  expect(JSON.parse(a.files[1]!.contents)[1].insert[0].name).toContain(
    '/employee-a/dsh/',
  );
  expect(JSON.parse(a.files[1]!.contents)[0]).toEqual({
    id: 'web-runtime',
    config: { printUrl: false },
  });
  expect(b.auth.nonce).not.toBe(a.auth.nonce);
  expect(JSON.stringify(a)).not.toContain('?token=');
  for (const guestAddress of ['0.0.0.0', '::', 'guest.example.test'])
    await expect(
      prepareNativeWebLaunch({ ...config, guestAddress }, binding),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
});

it('真实Web启动缺有界auth capability时先拒绝，不launch或假ready', async () => {
  const launch = {
    binding,
    auth: {
      dshHome: '/work/a',
      origin: 'http://127.0.0.1:32179/',
      nonce: randomUUID(),
      timeoutMs: 3000,
    },
    files: [],
    command: { executable: 'node', args: [] },
  };
  const scope = {
    launch: vi.fn(),
    assertCurrent: vi.fn(),
    signal: new AbortController().signal,
  } as unknown as PersonVmBootstrapScope;
  await expect(
    openNativeWebOwner({
      scope,
      launch,
      context: {} as never,
      vm: { assertCurrentBinding: vi.fn() },
      lifetime: new AbortController().signal,
      cleanupTimeoutMs: 3000,
    }),
  ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  expect(scope.launch).not.toHaveBeenCalled();
});

it('启动plan绑定exact host epoch，旧plan不能在新scope dispatch', async () => {
  const scope = {
    binding,
    launch: vi.fn(),
    assertCurrent: vi.fn(),
    readNativeWebAuth: vi.fn(),
    signal: new AbortController().signal,
  };
  await expect(
    openNativeWebOwner({
      scope,
      launch: {
        binding: { ...binding, leaseEpoch: binding.leaseEpoch + 1 },
        auth: {
          dshHome: '/work/a',
          nonce: randomUUID(),
          origin: 'http://127.0.0.1:32179/',
          timeoutMs: 3000,
        },
        files: [],
        command: { executable: 'node', args: [] },
      },
      context: {} as never,
      vm: { assertCurrentBinding: vi.fn() },
      lifetime: new AbortController().signal,
      cleanupTimeoutMs: 3000,
    }),
  ).rejects.toMatchObject({ code: 'LEASE_LOST' });
  expect(scope.launch).not.toHaveBeenCalled();
});
