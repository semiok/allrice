import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import { runCommand } from './process.ts';
import { signal } from './test-support.ts';

const temporary: string[] = [];
afterEach(async () => {
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function directory() {
  // Realpath resolves macOS /tmp aliases while keeping the native socket prefix short.
  const path = await realpath(await mkdtemp('/tmp/ar-vm-'));
  temporary.push(path);
  return path;
}

describe('Microsandbox public CLI protocol through real child processes (no actual VM)', () => {
  it('空MSB_HOME公开pull预置、2G硬帽、默认deny、固定host端口、真正stop/start命令', async () => {
    const root = await directory();
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
      socketRoot: join(root, 's'),
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
    expect(create.envKeys).toEqual([
      'HOME',
      'LANG',
      'MSB_CONFIG_PATH',
      'MSB_HOME',
      'PATH',
    ]);
    const config = JSON.parse(
      await readFile(join(root, 'mount/msb-config.json'), 'utf8'),
    );
    expect(config.allowed_backends).toEqual(['local']);
    expect(config.paths.sandboxes).toBe(
      join(root, 's', binding.vmId, 'sandboxes'),
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
      socketRoot: join(root, 's'),
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
