import type { PersonVmBootstrapScope } from './guest-bootstrap.ts';
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import { runCommand } from './process.ts';
import { context, harness, signal } from './test-support.ts';
import { PersonVmService } from './person-vm.ts';
import type { PersonVmMemoryGuestPlan } from './guest-bootstrap.ts';

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

async function bootstrapFixture(mode = 'ok') {
  const root = await directory(),
    mount = join(root, 'mount');
  const binary = join(root, 'msb-bootstrap-fixture');
  await writeFile(
    binary,
    `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),home=process.env.HOME;
const f=p.join(home,'state.json'),v=fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{};
const mode=${JSON.stringify(mode)};
fs.appendFileSync(p.join(home,'calls.jsonl'),JSON.stringify(a)+'\\n');
function save(){fs.writeFileSync(f,JSON.stringify(v));}
if(a[0]==='--version')console.log('microsandbox 0.7.16');
else if(a[0]==='list')console.log(JSON.stringify(v.name?[{name:v.name,status:v.status}]:[]));
else if(a[0]==='pull'){}
else if(a[0]==='create'){v.name=a[a.indexOf('--name')+1];v.status='Running';}
else if(a[0]==='start')v.status='Running';
else if(a[0]==='stop'){if(mode!=='lost-id-unknown-stop')v.status='Stopped';}
else if(a[0]==='ping'){if(v.status!=='Running')process.exit(41);}
else if(a[0]==='cp'){
 const meta=fs.statSync(a[1]);(v.copies??=[]).push({target:a[2],mode:meta.mode&511,contents:fs.readFileSync(a[1],'utf8')});
}
else if(a[0]==='exec'){
 if(!a.includes('--detach')){
  const cmd=a.slice(a.indexOf('--')+1);
  process.exit(require('node:child_process').spawnSync(process.execPath,cmd.slice(1),{stdio:'inherit'}).status??1);
 }
 if(!a.includes('--detach')||!a.includes('--no-stdin')||!a.includes('--no-tty'))process.exit(42);
 const id=require('node:crypto').randomUUID(),cmd=a.slice(a.indexOf('--')+1),init=cmd.includes('/work/memory/init.cjs');
 (v.jobs??={})[id]={cmd,code:init&&mode==='init-error'?23:0};save();
 if(!(init&&mode.startsWith('lost-id')))console.log(id);
}
else if(a[0]==='kill')v.jobs[a[a.indexOf('--job')+1]].code=137;
else if(a[0]==='wait'){
 const job=v.jobs[a[a.indexOf('--job')+1]];
 if(mode==='unknown-wait'){console.log('{}');save();process.exit(0);}
 if(mode==='cancel-init'&&job.cmd.includes('/work/memory/init.cjs')&&job.code===0){
  save();fs.writeFileSync(p.join(home,'waiting'),String(process.pid));setInterval(()=>{},1000);return;
 }
 console.log(JSON.stringify({code:job.code,success:job.code===0,timed_out:false}));save();process.exit(job.code);
} else process.exit(43);
save();
`,
    { mode: 0o700 },
  );
  const native = new MicrosandboxPersonVm({
    binary,
    libkrunfw: join(root, 'fw'),
    agentd: join(root, 'agentd'),
    image: 'registry/node@sha256:' + 'a'.repeat(64),
    rootDiskGiB: 20,
    socketRoot: await socketDirectory(),
  });
  const h = harness(),
    rc = context(),
    attach = h.disk.attach;
  h.disk.attach = async (...args) => {
    await attach(...args);
    return mount;
  };
  const plan: PersonVmMemoryGuestPlan = {
    files: [
      {
        path: '/work/memory/init.cjs',
        contents: '// synthetic initializer',
        mode: 0o700,
      },
      {
        path: '/work/memory/launcher',
        contents: '#!/bin/sh\nexec "$@"\n',
        mode: 0o700,
      },
      { path: '/work/memory/config.json', contents: '{}', mode: 0o600 },
    ],
    initialize: {
      executable: 'node',
      args: ['/work/memory/init.cjs', '/work/memory/config.json'],
    },
    launcher: '/work/memory/launcher',
    env: { BASH_ENV: '/work/memory/bash-env' },
  };
  h.runtime.memoryGuestPlan = async () => plan;
  h.runtime.start = async (_binding, _signal, scope) => {
    const job = await scope.launch({
      executable: 'node',
      args: ['native-dsh'],
      env: { DSH_HOME: '/work/employee-a' },
    });
    expect(await job.wait(signal())).toEqual({ exitCode: 0, timedOut: false });
  };
  const service = new PersonVmService({ ...h.options, native });
  return {
    h,
    rc,
    service,
    mount,
    calls: async () =>
      (await readFile(join(mount, 'host-home/calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]),
  };
}

describe('Microsandbox public CLI protocol through real child processes (no actual VM)', () => {
  it('真实service scope把固定nonce reader送入原生exec；argv无资格，过期scope拒绝读取', async () => {
    const f = await bootstrapFixture(),
      dshHome = await directory(),
      nonce = randomUUID();
    await mkdir(join(dshHome, 'native-web'));
    const authenticatedUrl = `http://127.0.0.1:32179/?token=${'a'.repeat(43)}`;
    await writeFile(
      join(dshHome, 'native-web', `auth-${nonce}.json`),
      JSON.stringify({ v: 1, nonce, authenticatedUrl }),
    );
    const request = {
      dshHome,
      nonce,
      origin: 'http://127.0.0.1:32179/',
      timeoutMs: 3000,
    };
    let read!: NonNullable<PersonVmBootstrapScope['readNativeWebAuth']>;
    f.h.runtime.start = async (_binding, _signal, scope) => {
      read = scope.readNativeWebAuth!;
      expect(await read(request)).toEqual({ authenticatedUrl });
    };
    await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
    const calls = await f.calls();
    expect(
      calls.some(
        (args) =>
          args[0] === 'exec' &&
          !args.includes('--detach') &&
          args.includes('--timeout'),
      ),
    ).toBe(true);
    expect(JSON.stringify(calls)).not.toContain('a'.repeat(43));
    await expect(read(request)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await f.calls()).toEqual(calls);
  });
  it('service真实启动入口按cp/mode→managed init wait→固定launcher/env，running不重init', async () => {
    const f = await bootstrapFixture();
    await f.service.prewarm(f.rc, { trigger: 'page' }, signal());
    const before = await f.calls(),
      init = before.findIndex(
        (a) => a[0] === 'exec' && a.includes('/work/memory/init.cjs'),
      );
    const launch = before.findIndex(
      (a) => a[0] === 'exec' && a.includes('/work/memory/launcher'),
    );
    expect(before.filter((a) => a[0] === 'cp')).toHaveLength(3);
    expect(before.slice(0, init).filter((a) => a[0] === 'cp')).toHaveLength(3);
    expect(
      before
        .slice(init + 1, launch)
        .some(
          (a) => a[0] === 'wait' && a.includes('--job') && a.includes('json'),
        ),
    ).toBe(true);
    expect(before[launch]).toEqual(
      expect.arrayContaining([
        'BASH_ENV=/work/memory/bash-env',
        'DSH_HOME=/work/employee-a',
        '--',
        '/work/memory/launcher',
        'node',
        'native-dsh',
      ]),
    );
    const state = JSON.parse(
      await readFile(join(f.mount, 'host-home/state.json'), 'utf8'),
    );
    expect(state.copies.map((c: { mode: number }) => c.mode)).toEqual([
      0o700, 0o700, 0o600,
    ]);
    expect(
      (await readdir(join(f.mount, 'host-home'))).some((name) =>
        name.startsWith('bootstrap-'),
      ),
    ).toBe(false);
    await f.service.start(f.rc, signal());
    expect((await f.calls()).filter((a) => a[0] === 'exec')).toHaveLength(3); // mkdir, init, DSH
  });
  it.each(['init-error', 'lost-id', 'lost-id-unknown-stop', 'unknown-wait'])(
    'bootstrap %s不ready；真实stop确认后才detach',
    async (mode) => {
      const f = await bootstrapFixture(mode);
      await expect(
        f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
      ).rejects.toMatchObject({
        code:
          mode === 'lost-id-unknown-stop' || mode === 'unknown-wait'
            ? 'CLEANUP_INCOMPLETE'
            : 'PROVIDER_FAILED',
      });
      const calls = await f.calls();
      expect(calls.some((a) => a[0] === 'stop')).toBe(true);
      expect(
        calls.some(
          (a) => a[0] === 'exec' && a.includes('/work/memory/launcher'),
        ),
      ).toBe(false);
      expect(f.h.mounts.size).toBe(mode === 'lost-id-unknown-stop' ? 1 : 0);
    },
  );
  it('取消正在wait的init：CLI退出后仍exact kill+wait非零JSON；随后native stop/status', async () => {
    const f = await bootstrapFixture('cancel-init'),
      controller = new AbortController();
    const start = f.service.prewarm(
      f.rc,
      { trigger: 'page' },
      controller.signal,
    );
    const failure = expect(start).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    let pid = 0;
    for (let attempt = 0; attempt < 200 && !pid; attempt += 1) {
      try {
        pid = Number(
          await readFile(join(f.mount, 'host-home/waiting'), 'utf8'),
        );
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    controller.abort();
    await failure;
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    const calls = await f.calls(),
      kill = calls.findIndex((a) => a[0] === 'kill');
    expect(kill).toBeGreaterThan(0);
    expect(calls[kill + 1]).toEqual([
      'wait',
      calls[kill]![1],
      '--job',
      calls[kill]![3],
      '--format',
      'json',
    ]);
    expect(calls.findIndex((a) => a[0] === 'stop')).toBeGreaterThan(kill + 1);
    expect(f.h.mounts.size).toBe(0);
  });
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
  it.each(['spawn', 'signal', 'oversize', 'nonzero'] as const)(
    '正常非零JSON opt-in仍保留 %s 失败，不把进程异常当guest completion',
    async (failure) => {
      const root = await directory();
      const script =
        failure === 'signal'
          ? 'console.log(JSON.stringify({code:0,success:true,timed_out:false}));process.kill(process.pid,"SIGKILL")'
          : failure === 'oversize'
            ? 'process.stdout.write(Buffer.alloc(4*1024*1024+1));setInterval(()=>{},1000)'
            : 'console.log(JSON.stringify({code:23,success:false,timed_out:false}));process.exit(23)';
      await expect(
        runCommand({
          executable:
            failure === 'spawn'
              ? join(root, 'absent-executable')
              : process.execPath,
          args: ['-e', script],
          env: { HOME: root, PATH: '/usr/bin:/bin' },
          signal: signal(),
          readNonzeroExit: failure !== 'nonzero',
        }),
      ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    },
  );
  it('构造时按完整UUID预算检查103/104字节和UTF8；prepare仍核实际binding及别名target', async () => {
    const root = await mkdtemp('/tmp/aa-'); // 14 bytes: control endpoint is 103.
    temporary.push(root);
    const runner = vi.fn(async () => 'microsandbox 0.7.16');
    const options = {
      binary: '/b',
      libkrunfw: '/fw',
      agentd: '/a',
      image: 'registry/node@sha256:' + 'a'.repeat(64),
      rootDiskGiB: 20,
      socketRoot: root,
      runner,
    };
    const make = (socketRoot: string) =>
      new MicrosandboxPersonVm({ ...options, socketRoot });
    const binding = {
      vmId: randomUUID(),
      personId: randomUUID(),
      organizationId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
    };
    const native = new MicrosandboxPersonVm(options),
      mount = join(root, 'mount'),
      alias = join(root, binding.vmId);
    options.socketRoot = root + 'x'; // Cannot invalidate the qualified snapshot.
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
    for (const rejectedRoot of [root + 'x', root.slice(0, -1) + 'é']) {
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
      expect(() => make(rejectedRoot)).toThrowError('PROVIDER_FAILED');
    }
    const untouched = join(root, 'not-created-invalid-binding');
    await expect(
      native.prepare(
        { ...binding, vmId: binding.vmId + 'x' },
        untouched,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    await expect(lstat(untouched)).rejects.toMatchObject({ code: 'ENOENT' });
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
