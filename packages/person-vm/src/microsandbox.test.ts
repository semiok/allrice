import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import { runCommand } from './process.ts';
import { signal } from './test-support.ts';

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  const path = await realpath(await mkdtemp('/tmp/ar-vm-'));
  temporary.push(path);
  return path;
}
async function socketDirectory() {
  // Keep the explicit /tmp spelling: realpath's /private prefix is too long
  // for the pinned native control endpoint, even when artifacts live deeper.
  const path = await mkdtemp('/tmp/a-');
  temporary.push(path);
  return path;
}

describe('Microsandbox public CLI protocol through real child processes (no actual VM)', () => {
  it('空MSB_HOME公开pull预置、2G硬帽、默认deny、固定host端口、真正stop/start命令', async () => {
    vi.stubEnv('ALLRICE_PERSON_VM_SYNTHETIC_HOST_SECRET', 'must-not-inherit');
    const root = await directory();
    const socketRoot = await socketDirectory();
    const binary = join(root, 'msb-fixture');
    await writeFile(
      binary,
      `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),home=process.env.HOME;
const f=p.join(home,'state.json'),v=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};
fs.appendFileSync(p.join(home,'calls.jsonl'),JSON.stringify({args:a,envKeys:Object.keys(process.env).sort()})+'\\n');
if(a[0]==='--version')console.log('microsandbox 0.7.16');
else if(a[0]==='list')console.log(JSON.stringify(v.name?[{name:v.name,status:v.status}]:[]));
else if(a[0]==='pull')v.image=a[1];
else if(a[0]==='create'){if(v.image!==a[1])process.exit(27);v.name=a[a.indexOf('--name')+1];v.status='Running';}
else if(a[0]==='stop')v.status='Stopped';
else if(a[0]==='start')v.status='Running';
else if(a[0]==='ping'){if(v.status!=='Running')process.exit(29);}
else if(a[0]==='exec')console.log('synthetic-exec-protocol');
else process.exit(30);
fs.writeFileSync(f,JSON.stringify(v));
`,
      { mode: 0o700 },
    );
    const native = new MicrosandboxPersonVm({
      binary,
      libkrunfw: join(root, 'fw'),
      agentd: join(root, 'agentd'),
      image: 'registry.example/node@sha256:' + 'a'.repeat(64),
      rootDiskGiB: 20,
      socketRoot,
    });
    const binding = {
      vmId: randomUUID(),
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    };
    await native.prepare(binding, join(root, 'mount'), signal());
    expect(await native.status(binding, signal())).toBe('absent');
    await native.create(
      binding,
      { binding, bindingId: randomUUID(), gatewayPorts: [38990, 38991] },
      signal(),
    );
    await native.ping(binding, signal());
    expect(
      await native.exec(binding, ['node', '-e', 'diagnostic'], signal()),
    ).toContain('synthetic-exec-protocol');
    await native.stop(binding, signal());
    expect(await native.status(binding, signal())).toBe('stopped');
    await native.start(binding, signal());
    expect(await native.status(binding, signal())).toBe('running');
    const calls = (
      await readFile(join(root, 'mount/host-home/calls.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[]; envKeys: string[] });
    const create = calls.find((call) => call.args[0] === 'create')!;
    expect(calls.findIndex((call) => call.args[0] === 'pull')).toBeLessThan(
      calls.indexOf(create),
    );
    expect(create.args).toEqual(
      expect.arrayContaining([
        '--memory',
        '2048M',
        '--max-memory',
        '--max-cpus',
        '--pull',
        'never',
        '--net-default',
        'deny',
        'allow:egress@host:tcp:38990',
      ]),
    );
    expect(create.args).not.toContain('--idle-timeout');
    expect(create.args).not.toContain('--replace');
    for (const call of calls) {
      // CoreFoundation can inject this key into a macOS child with an explicit
      // env. Permit only that platform key; every other key remains exact.
      expect(
        call.envKeys.filter(
          (key) =>
            process.platform !== 'darwin' || key !== '__CF_USER_TEXT_ENCODING',
        ),
      ).toEqual(['HOME', 'LANG', 'MSB_CONFIG_PATH', 'MSB_HOME', 'PATH']);
      expect(call.envKeys).not.toContain(
        'ALLRICE_PERSON_VM_SYNTHETIC_HOST_SECRET',
      );
    }
    const config = JSON.parse(
      await readFile(join(root, 'mount/msb-config.json'), 'utf8'),
    );
    expect(config.allowed_backends).toEqual(['local']);
    expect(config.paths.sandboxes).toBe(
      join(socketRoot, binding.vmId, 'sandboxes'),
    );
  });
  it('不接可变镜像tag或不固定的运行版本', async () => {
    expect(
      () =>
        new MicrosandboxPersonVm({
          binary: '/b',
          libkrunfw: '/fw',
          agentd: '/a',
          image: 'node:latest',
          rootDiskGiB: 20,
          socketRoot: '/s',
        }),
    ).toThrowError('PROVIDER_FAILED');
    const root = await directory();
    const native = new MicrosandboxPersonVm({
      binary: '/b',
      libkrunfw: '/fw',
      agentd: '/a',
      image: 'registry/node@sha256:' + 'a'.repeat(64),
      rootDiskGiB: 20,
      socketRoot: await socketDirectory(),
      runner: async () => 'microsandbox 0.7.15',
    });
    await expect(
      native.prepare(
        {
          vmId: randomUUID(),
          personId: randomUUID(),
          organizationId: randomUUID(),
          instanceId: randomUUID(),
          leaseEpoch: 1,
        },
        join(root, 'm'),
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
  });
  it('按原生control端点的103/104字节边界和UTF8校验，完整vmId别名不覆盖其他target', async () => {
    const root = await mkdtemp('/tmp/aa-'); // 14 bytes: control endpoint is 103.
    temporary.push(root);
    const runner = vi.fn(async () => 'microsandbox 0.7.16');
    const make = (socketRoot: string) =>
      new MicrosandboxPersonVm({
        binary: '/b',
        libkrunfw: '/fw',
        agentd: '/a',
        image: 'registry/node@sha256:' + 'a'.repeat(64),
        rootDiskGiB: 20,
        socketRoot,
        runner,
      });
    const binding = {
      vmId: randomUUID(),
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    };
    const native = make(root),
      mount = join(root, 'mount'),
      alias = join(root, binding.vmId);
    expect(
      Buffer.byteLength(
        join(alias, 'run/sandboxes', '0'.repeat(24), 'control.sock'),
      ),
    ).toBe(103);
    await native.prepare(binding, mount, signal());
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect(await readlink(alias)).toBe(join(mount, 'microsandbox'));
    const config = JSON.parse(
      await readFile(join(mount, 'msb-config.json'), 'utf8'),
    );
    expect(config.home).toBe(alias);
    for (const [index, rejectedRoot] of [
      root + 'x',
      root.slice(0, -1) + 'é',
    ].entries()) {
      expect(
        Buffer.byteLength(
          join(
            rejectedRoot,
            binding.vmId,
            'run/sandboxes',
            '0'.repeat(24),
            'control.sock',
          ),
        ),
      ).toBe(104);
      const untouched = join(root, 'not-created-' + index);
      await expect(
        make(rejectedRoot).prepare(binding, untouched, signal()),
      ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
      await expect(lstat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(
      native.prepare(binding, join(root, 'different'), signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(await readlink(alias)).toBe(join(mount, 'microsandbox'));
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('取消真实子进程等待退出，不把仍跑的promise丢给回收器', async () => {
    const root = await directory(),
      controller = new AbortController();
    const pidFile = join(root, 'pid');
    const command = runCommand({
      executable: process.execPath,
      args: [
        '-e',
        'require("fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',
        pidFile,
      ],
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      signal: controller.signal,
    });
    let pid: number | undefined;
    for (let attempt = 0; attempt < 200 && !pid; attempt += 1) {
      try {
        pid = Number(await readFile(pidFile, 'utf8'));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    controller.abort();
    expect(pid).toBeGreaterThan(0);
    await expect(command).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(() => process.kill(pid!, 0)).toThrow();
  });
});
