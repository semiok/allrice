import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import ts from 'typescript';
import { composeEntries } from '@deepseek-ai/dsh-app-boot';
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
it('生产compiler收集全部native Web产品而不emit测试；typecheck仍收集完整测试', () => {
  const worker = fileURLToPath(new URL('../../', import.meta.url));
  function configuration(name: string) {
    const loaded = ts.readConfigFile(join(worker, name), ts.sys.readFile);
    expect(loaded.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, worker);
    expect(parsed.errors).toEqual([]);
    return parsed;
  }
  const build = configuration('tsconfig.build.json'),
    typecheck = configuration('tsconfig.json');
  for (const file of ['launch', 'owner', 'transport', 'composition'])
    expect(build.fileNames).toContain(
      join(worker, `src/native-web/${file}.ts`),
    );
  expect(build.fileNames.filter((file) => file.endsWith('.test.ts'))).toEqual(
    [],
  );
  for (const file of [
    'composition.test.ts',
    'owner.native.integration.test.ts',
  ])
    expect(typecheck.fileNames).toContain(join(worker, 'src/native-web', file));
  expect(build.options.rootDir).toBe(join(worker, 'src'));
  expect(build.options.paths).toEqual({});
});
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
    config: {
      openBrowser: false,
      publicUrl: config.publicUrl,
      surfaceContext: true,
      printUrl: false,
    },
  });
  // Use rc.2's public boot composition, which replaces the whole config.
  const composed = composeEntries([
    [
      {
        insert: [
          {
            id: 'web-runtime',
            name: '@deepseek-ai/dsh-web-app',
            config: {
              openBrowser: true,
              publicUrl: 'http://10.0.0.2:8080/',
              surfaceContext: true,
              printUrl: true,
            },
          },
        ],
      },
    ],
    JSON.parse(a.files[1]!.contents),
  ]);
  expect(composed.find((entry) => entry.id === 'web-runtime')?.config).toEqual({
    openBrowser: false,
    publicUrl: config.publicUrl,
    surfaceContext: true,
    printUrl: false,
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
