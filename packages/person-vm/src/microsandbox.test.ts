import type { PersonVmBootstrapScope } from './guest-bootstrap.ts';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  open,
  type FileHandle,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrosandboxPersonVm } from './microsandbox.ts';
import { runCommand } from './process.ts';
import { context, currentReceipt, harness, signal } from './test-support.ts';
import { PersonVmService } from './person-vm.ts';
import type { PersonVmMemoryGuestPlan } from './guest-bootstrap.ts';
import type { PersonVmWebRoster, PersonVmWebStartup } from './web-endpoints.ts';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
else if(a[0]==='create'){
 v.name=a[a.indexOf('--name')+1];v.status='Running';
 v.ports=a.flatMap((arg,i)=>arg==='-p'?[a[i+1].split(':')]:[]).map(([host_bind,h,g])=>({host_bind,host_port:Number(h),guest_port:Number(g),protocol:'tcp'}));
}
else if(a[0]==='inspect'){
 const ports=v.ports??[],active=mode.startsWith('web-inspect')?[]:ports;
 console.log(JSON.stringify({name:v.name,status:v.status,config:{network:{ports}},active_config:{network:{ports:active}},pending_changes:[]}));
}
else if(a[0]==='start')v.status='Running';
else if(a[0]==='stop'){if(!['lost-id-unknown-stop','auth-unknown-stop','web-inspect-unknown-stop'].includes(mode))v.status='Stopped';}
else if(a[0]==='ping'){if(v.status!=='Running')process.exit(41);}
else if(a[0]==='cp'){
 const meta=fs.statSync(a[1]);(v.copies??=[]).push({target:a[2],mode:meta.mode&511,contents:fs.readFileSync(a[1],'utf8')});
}
else if(a[0]==='exec'){
 if(!a.includes('--detach')){
  // v0.7.16 exec uses parse_duration_secs, not the separate ms parser.
  if(!/^[0-9]+[smh]?$/.test(a[a.indexOf('--timeout')+1]??''))process.exit(44);
  if(mode==='auth-budget'){
   fs.writeFileSync(p.join(home,'auth-reading'),String(process.pid));setInterval(()=>{},1000);return;
  }
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
  h.runtime.retireAfterNativeStop = async () => {};
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
    native,
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
  function roster(
    f: Awaited<ReturnType<typeof bootstrapFixture>>,
    count = 2,
  ): PersonVmWebRoster {
    const facts = {
      personId: f.rc.actor.id,
      organizationId: f.rc.organizationId,
      entries: Array.from({ length: count }, () => ({
        workspaceId: randomUUID(),
        employeeInstanceId: randomUUID(),
        employeeRevision: 1,
        employeeVersionId: randomUUID(),
      })).sort((a, b) =>
        a.employeeInstanceId.localeCompare(b.employeeInstanceId),
      ),
    };
    return {
      ...facts,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
    };
  }
  it('首次真实CLI create仅发布实际员工清单并核active inspect；0600 host manifest与scope receipt对应', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f);
    let startup: PersonVmWebStartup | undefined;
    f.h.runtime.start = async (_binding, _signal, _scope, web) => {
      startup = web;
    };
    const service = new PersonVmService({
      ...f.h.options,
      native: f.native,
      nativeWeb: { prepare: async () => assigned },
    });
    const view = await service.prewarm(f.rc, { trigger: 'page' }, signal());
    expect(view.ready).toBe(true); // Fixture runtime readiness, not native editor evidence.
    expect(startup?.context).toBe(f.rc);
    expect(startup?.receipt.rosterDigest).toBe(assigned.digest);
    expect(startup?.receipt.binding).toEqual(
      await service.resolve(f.rc, signal()),
    );
    const calls = await f.calls(),
      creation = calls.find((args) => args[0] === 'create')!;
    const mappings = creation.flatMap((arg, index) =>
      arg === '-p' ? [creation[index + 1]] : [],
    );
    expect(mappings).toEqual(
      startup!.receipt.endpoints.map(
        (entry) => `127.0.0.1:${entry.hostPort}:${entry.guestPort}`,
      ),
    );
    expect(mappings).toHaveLength(assigned.entries.length);
    expect(
      creation.flatMap((arg, index) =>
        arg === '--net-rule' ? [creation[index + 1]] : [],
      ),
    ).toEqual([
      'allow:egress@host:tcp:38990',
      ...startup!.receipt.endpoints.map(
        (entry) => `allow:ingress@127.0.0.1/32:tcp:${entry.guestPort}`,
      ),
    ]);
    expect(creation[creation.indexOf('--net-default') + 1]).toBe('deny');
    expect(
      new Set(startup!.receipt.endpoints.map((entry) => entry.hostPort)).size,
    ).toBe(assigned.entries.length);
    expect(calls.some((args) => args[0] === 'inspect')).toBe(true);
    const path = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    expect(manifest).toMatchObject({
      vmId: view.vmId,
      personId: f.rc.actor.id,
      digest: assigned.digest,
      endpoints: startup!.receipt.endpoints,
    });
    expect(Object.keys(manifest).sort()).toEqual([
      'digest',
      'endpoints',
      'organizationId',
      'personId',
      'version',
      'vmId',
    ]);
    expect(JSON.stringify(startup)).not.toMatch(
      /ownerToken|mount|authenticatedUrl|\?token=/,
    );
    const original = await readFile(path);
    expect(
      (await service.prewarm(f.rc, { trigger: 'page' }, signal())).ready,
    ).toBe(true);
    expect(await readFile(path)).toEqual(original);
    expect(
      (await f.calls()).filter((args) => args[0] === 'create'),
    ).toHaveLength(1);
  });
  it('原生create规则只按已保存的guest G而非host H；保留/32精确TCP与原出口（非policy运行验收）', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f, 1);
    const binding = {
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
      personId: f.rc.actor.id,
      organizationId: f.rc.organizationId,
    };
    await f.native.prepare(binding, f.mount, signal());
    const prior = await f.native.prepareWebEndpoints(
      binding,
      assigned,
      signal(),
    );
    const path = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const h = prior.endpoints[0]!.hostPort,
      g = h === 18101 ? 18102 : 18101;
    manifest.endpoints[0].guestPort = g;
    await writeFile(path, JSON.stringify(manifest));
    const web = await f.native.prepareWebEndpoints(binding, assigned, signal());
    await f.native.create(binding, currentReceipt(binding), signal(), web);
    const create = (await f.calls()).find((args) => args[0] === 'create')!;
    expect(
      create.flatMap((arg, i) => (arg === '--net-rule' ? [create[i + 1]] : [])),
    ).toEqual([
      'allow:egress@host:tcp:38990',
      `allow:ingress@127.0.0.1/32:tcp:${g}`,
    ]);
    expect(create).toContain(`127.0.0.1:${h}:${g}`);
    expect(create).not.toContain(`allow:ingress@127.0.0.1/32:tcp:${h}`);
    expect(create[create.indexOf('--net-default') + 1]).toBe('deny');
  });
  it.each(['success', 'cancel', 'write-failure'] as const)(
    'reservation真实接入立即关闭，manifest %s后service/lease与原H全部真实join',
    async (mode) => {
      const f = await bootstrapFixture(),
        assigned = roster(f, 1),
        cancelled = new AbortController();
      const service = new PersonVmService({
        ...f.h.options,
        native: f.native,
        nativeWeb: { prepare: async () => assigned },
      });
      const created = await service.create(f.rc, signal());
      const binding = {
        vmId: created.vmId,
        instanceId: randomUUID(),
        leaseEpoch: 1,
        personId: f.rc.actor.id,
        organizationId: f.rc.organizationId,
      };
      await f.native.prepare(binding, f.mount, signal());
      const prior = await f.native.prepareWebEndpoints(
        binding,
        assigned,
        signal(),
      );
      const probe = await open(join(f.mount, 'sync-probe'), 'wx');
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const sync = prototype.sync;
      await probe.close();
      let entered!: () => void, release!: () => void;
      const inside = new Promise<void>((done) => {
        entered = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const diskError = new Error('synthetic manifest sync failure'),
        cancelError = new Error('synthetic cancellation');
      vi.spyOn(prototype, 'sync').mockImplementation(async function (
        this: FileHandle,
      ) {
        entered();
        await gate;
        if (mode === 'write-failure') throw diskError;
        await sync.call(this);
      });
      const starting = service.start(f.rc, cancelled.signal).then(
        () => null,
        (error: unknown) => error,
      );
      await inside;
      const peer = createConnection(prior.endpoints[0]!.hostPort, '127.0.0.1');
      peer.on('error', () => {});
      const closed = new Promise<void>((done) => peer.once('close', done));
      try {
        await once(peer, 'connect');
        await closed; // Must happen while fsync is blocked, not just in finally.
        expect(peer.destroyed).toBe(true);
        if (mode === 'cancel') cancelled.abort(cancelError);
      } finally {
        peer.destroy();
        release();
        await closed;
        await starting;
      }
      const outcome = await starting;
      if (mode === 'success') expect(outcome).toBe(null);
      else
        expect(outcome).toMatchObject({
          code: 'PROVIDER_FAILED',
          cause: mode === 'cancel' ? cancelError : diskError,
        });
      expect((await f.h.store.read(f.rc.actor.id))!.leaseOwner).toBe(null);
      expect(f.h.mounts.size).toBe(mode === 'success' ? 1 : 0);
      const rebound = createServer();
      try {
        rebound.listen(prior.endpoints[0]!.hostPort, '127.0.0.1');
        await once(rebound, 'listening');
      } finally {
        await new Promise<void>((done, reject) =>
          rebound.close((error) => (error ? reject(error) : done())),
        );
      }
      expect((await f.calls()).some((args) => args[0] === 'create')).toBe(
        mode === 'success',
      );
    },
  );
  it('运行中新增员工立即preparing；不hold等待、不改manifest、不modify/stop/restart已有任务', async () => {
    const f = await bootstrapFixture();
    let assigned = roster(f);
    const service = new PersonVmService({
      ...f.h.options,
      native: f.native,
      nativeWeb: { prepare: async () => assigned },
    });
    await service.prewarm(f.rc, { trigger: 'page' }, signal());
    const manifest = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    const original = await readFile(manifest),
      before = (await f.calls()).length;
    const facts = {
      personId: assigned.personId,
      organizationId: assigned.organizationId,
      entries: [...assigned.entries, ...roster(f, 1).entries].sort((a, b) =>
        a.employeeInstanceId.localeCompare(b.employeeInstanceId),
      ),
    };
    assigned = {
      ...facts,
      digest: `sha256:${createHash('sha256').update(JSON.stringify(facts)).digest('hex')}`,
    };
    await expect(
      service.prewarm(f.rc, { trigger: 'input' }, signal()),
    ).rejects.toMatchObject({ code: 'WEB_ENDPOINTS_PREPARING' });
    expect(await readFile(manifest)).toEqual(original);
    expect((await service.read(f.rc, signal()))?.phase).toBe('running');
    expect(
      (await f.calls())
        .slice(before)
        .some((args) =>
          ['create', 'start', 'stop', 'modify', 'pull', 'exec', 'cp'].includes(
            args[0]!,
          ),
        ),
    ).toBe(false);
  });
  it.each(['web-inspect-mismatch', 'web-inspect-unknown-stop'])(
    'active端口缺失即使pending_changes=[]也拒绝，%s清理必须真实off才detach',
    async (mode) => {
      const f = await bootstrapFixture(mode),
        assigned = roster(f, 1);
      const service = new PersonVmService({
        ...f.h.options,
        native: f.native,
        nativeWeb: { prepare: async () => assigned },
      });
      await expect(
        service.prewarm(f.rc, { trigger: 'page' }, signal()),
      ).rejects.toMatchObject({
        code: mode.endsWith('unknown-stop')
          ? 'CLEANUP_INCOMPLETE'
          : 'PROVIDER_FAILED',
      });
      expect((await f.calls()).some((args) => args[0] === 'stop')).toBe(true);
      expect(f.h.log.includes('disk:detach')).toBe(
        !mode.endsWith('unknown-stop'),
      );
    },
  );
  it('现有native实例的manifest缺失/非0600/含额外字段一律保留拒绝，不创建替代映射', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f, 1);
    const service = new PersonVmService({
      ...f.h.options,
      native: f.native,
      nativeWeb: { prepare: async () => assigned },
    });
    await service.prewarm(f.rc, { trigger: 'page' }, signal());
    const path = join(
      f.mount,
      'microsandbox/allrice-native-web-endpoints.json',
    );
    const original = await readFile(path, 'utf8'),
      before = (await f.calls()).length;
    const value = JSON.parse(original);
    value.endpoints[0].unexpected = 'not-an-authority-field';
    await writeFile(path, JSON.stringify(value));
    await expect(service.start(f.rc, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(value));
    await writeFile(path, original);
    await chmod(path, 0o644);
    await expect(service.start(f.rc, signal())).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    await rm(path);
    await expect(service.start(f.rc, signal())).rejects.toMatchObject({
      code: 'WEB_ENDPOINTS_PREPARING',
    });
    expect(
      (await f.calls())
        .slice(before)
        .some((args) =>
          ['pull', 'create', 'start', 'stop', 'modify'].includes(args[0]!),
        ),
    ).toBe(false);
  });
  it('首次create前失败重试仅认原manifest端口；真实OS占用则失败保留，不随机换号', async () => {
    const f = await bootstrapFixture(),
      assigned = roster(f, 1);
    const binding = {
      vmId: randomUUID(),
      instanceId: randomUUID(),
      leaseEpoch: 1,
      personId: f.rc.actor.id,
      organizationId: f.rc.organizationId,
    };
    await f.native.prepare(binding, f.mount, signal());
    const receipt = await f.native.prepareWebEndpoints(
      binding,
      assigned,
      signal(),
    );
    const path = join(
        f.mount,
        'microsandbox/allrice-native-web-endpoints.json',
      ),
      original = await readFile(path);
    const occupied = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(receipt.endpoints[0]!.hostPort, '127.0.0.1', resolve);
      });
      await expect(
        f.native.prepareWebEndpoints(binding, assigned, signal()),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(await readFile(path)).toEqual(original);
      expect(
        (await f.calls()).some((args) =>
          ['create', 'modify', 'start'].includes(args[0]!),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it.each([3000, 3001])(
    '真实service scope把固定nonce reader送入原生exec（%sms）；argv无资格，过期scope拒绝读取',
    async (timeoutMs) => {
      const f = await bootstrapFixture(),
        dshHome = await directory(),
        nonce = randomUUID();
      await mkdir(join(dshHome, 'native-web'));
      const localAuthSample = 'QWxsUmljZU5hdGl2ZVdlYkF1dGhGaXh0dXJlT25seTA';
      const authenticatedUrl = `http://127.0.0.1:32179/?token=${localAuthSample}`;
      await writeFile(
        join(dshHome, 'native-web', `auth-${nonce}.json`),
        JSON.stringify({ v: 1, nonce, authenticatedUrl }),
      );
      const request = {
        dshHome,
        nonce,
        origin: 'http://127.0.0.1:32179/',
        timeoutMs,
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
      const reader = calls.find(
        (args) => args[0] === 'exec' && !args.includes('--detach'),
      )!;
      expect(reader[reader.indexOf('--timeout') + 1]).toBe(
        `${Math.ceil(timeoutMs / 1000)}s`,
      );
      expect(JSON.stringify(calls)).not.toContain(localAuthSample);
      await expect(read(request)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(await f.calls()).toEqual(calls);
    },
  );
  it.each([false, true])(
    '真实reader失败仍stop/status；未知stop=%s不得detach或ready',
    async (unknownStop) => {
      const f = await bootstrapFixture(
          unknownStop ? 'auth-unknown-stop' : 'ok',
        ),
        dshHome = await directory(),
        nonce = randomUUID();
      // A directory is an invalid artifact: the real fixed reader must fail.
      await mkdir(join(dshHome, 'native-web', `auth-${nonce}.json`), {
        recursive: true,
      });
      f.h.runtime.start = async (_binding, _signal, scope) => {
        await scope.readNativeWebAuth!({
          dshHome,
          nonce,
          origin: 'http://127.0.0.1:32179/',
          timeoutMs: 3001,
        });
      };
      await expect(
        f.service.prewarm(f.rc, { trigger: 'page' }, signal()),
      ).rejects.toMatchObject({
        code: unknownStop ? 'CLEANUP_INCOMPLETE' : 'PROVIDER_FAILED',
      });
      const calls = await f.calls(),
        stopped = calls.findIndex((args) => args[0] === 'stop');
      expect(stopped).toBeGreaterThan(0);
      expect(calls.slice(stopped + 1).some((args) => args[0] === 'list')).toBe(
        true,
      );
      expect(f.h.mounts.size).toBe(unknownStop ? 1 : 0);
    },
  );
  it('原生秒预算向上取整不延长host毫秒预算，取消后join实际CLI再stop/status', async () => {
    const f = await bootstrapFixture('auth-budget'),
      dshHome = await directory(),
      budget = new AbortController(),
      timeout = AbortSignal.timeout.bind(AbortSignal);
    // Control the actual host deadline at admission, rather than rely on wall-clock sleeps.
    const deadline = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => (ms === 1001 ? budget.signal : timeout(ms)));
    f.h.runtime.start = async (_binding, _signal, scope) => {
      await scope.readNativeWebAuth!({
        dshHome,
        nonce: randomUUID(),
        origin: 'http://127.0.0.1:32179/',
        timeoutMs: 1001,
      });
    };
    const start = f.service.prewarm(f.rc, { trigger: 'page' }, signal());
    const failure = expect(start).rejects.toMatchObject({
      code: 'PROVIDER_FAILED',
    });
    let pid = 0;
    try {
      await vi.waitFor(
        async () => {
          pid = Number(
            await readFile(join(f.mount, 'host-home/auth-reading'), 'utf8'),
          );
          expect(pid).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
      expect(deadline).toHaveBeenCalledWith(1001);
      budget.abort();
      await failure;
      expect(() => process.kill(pid, 0)).toThrow();
      const calls = await f.calls();
      const reader = calls.find(
        (args) => args[0] === 'exec' && !args.includes('--detach'),
      )!;
      expect(reader[reader.indexOf('--timeout') + 1]).toBe('2s');
      const stopped = calls.findIndex((args) => args[0] === 'stop');
      expect(stopped).toBeGreaterThan(0);
      expect(calls.slice(stopped + 1).some((args) => args[0] === 'list')).toBe(
        true,
      );
      expect(f.h.mounts.size).toBe(0);
    } finally {
      budget.abort();
      await start.catch(() => {});
    }
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
