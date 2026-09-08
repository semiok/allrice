import { randomUUID, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudCommandSchema,
  CloudCommandInputSchema,
  CloudExecutionProfileSchema,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import { CloudRunnerBackend } from './backend.js';

const command = (script: string, extra: Record<string, unknown> = {}) =>
  CloudCommandSchema.parse({
    capability: 'cloud.process.execute',
    arguments: { script, ...extra },
    backend: 'cloud-gvisor-v1',
    imageDigest: cloudToolchainImageV1,
    runtime: 'runsc',
    network: 'none',
  });
describe('P15 cloud contract fail-closed', () => {
  it('rejects unsafe or overlapping input/output paths', () => {
    for (const path of ['../secret', '/etc/passwd', 'a/../b', 'a\\b'])
      expect(() =>
        CloudCommandInputSchema.parse({
          script: '0',
          outputs: [{ path, fileName: 'x', format: 'json' }],
        }),
      ).toThrow();
    expect(() =>
      command('0', {
        outputs: [
          { path: 'x', fileName: 'x', format: 'json' },
          { path: 'x/y', fileName: 'y', format: 'json' },
        ],
      }),
    ).toThrow();
    for (const fileName of ['bad\u0000name', 'bad\nname', '../name', 'a\\b'])
      expect(() =>
        command('0', {
          outputs: [{ path: 'result.json', fileName, format: 'json' }],
        }),
      ).toThrow();
  });
  it('does not accept model-selected image/runtime/network or host paths', () => {
    for (const value of [
      { runtime: 'runc' },
      { network: 'host' },
      { imageDigest: `sha256:${'a'.repeat(64)}` },
    ])
      expect(() =>
        CloudCommandSchema.parse({ ...command('0'), ...value }),
      ).toThrow();
    expect(() => new CloudRunnerBackend('/var/run/docker.sock')).toThrow(
      'CLOUD_DEDICATED_BACKEND_REQUIRED',
    );
    const profile = {
      backend: 'cloud-gvisor-v1',
      imageDigest: cloudToolchainImageV1,
      architecture: 'amd64',
      runtime: 'runsc',
      runtimeVersion: 'release-20260831.0',
      runtimeChecksum:
        'sha256:1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a',
      network: 'none',
      maximumConcurrency: 2,
    };
    expect(CloudExecutionProfileSchema.safeParse(profile).success).toBe(true);
    expect(
      CloudExecutionProfileSchema.safeParse({
        ...profile,
        runtimeVersion: 'another-runtime',
      }).success,
    ).toBe(false);
    expect(
      CloudExecutionProfileSchema.safeParse({
        ...profile,
        runtimeChecksum: `sha256:${'a'.repeat(64)}`,
      }).success,
    ).toBe(false);
  });
});
const suite =
  process.env.ALLRICE_RUN_CLOUD_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('P15 actual SaaS-host dedicated VM + gVisor', () => {
  const backend = new CloudRunnerBackend();
  const attempts: string[] = [];
  afterEach(async () => {
    for (const id of attempts.splice(0)) {
      await backend.stop(id);
      await backend.cleanup(id);
    }
  });
  async function run(
    script: string,
    extra: Record<string, unknown> = {},
    options: {
      signal?: AbortSignal;
      maintainLease?: () => Promise<boolean>;
    } = {},
  ) {
    const id = randomUUID();
    attempts.push(id);
    const c = command(script, extra);
    const files = c.arguments.inputs.map((i) => ({
      path: i.path,
      contentBase64: Buffer.from('[1,2,3]').toString('base64'),
    }));
    return {
      id,
      c,
      result: await backend.execute(c, files, {
        attemptId: id,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        maintainLease: options.maintainLease ?? (async () => true),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    };
  }
  it('computes from authorized bytes; output survives stop/recovery until cleanup', async () => {
    const checksum = `sha256:${createHash('sha256').update('[1,2,3]').digest('hex')}`;
    const r = await run(
      "import fs from 'node:fs'; const values=JSON.parse(fs.readFileSync('input/numbers.json','utf8')); fs.writeFileSync('output/result.json',JSON.stringify({sum:values.reduce((a,b)=>a+b,0)})); console.log('done')",
      {
        inputs: [{ path: 'numbers.json', objectId: randomUUID(), checksum }],
        outputs: [
          { path: 'result.json', fileName: 'result.json', format: 'json' },
        ],
      },
    );
    expect(r.result.reason).toBe('completed');
    expect(r.result.exitCode).toBe(0);
    expect(
      JSON.parse(
        Buffer.from(r.result.artifacts[0]!.contentBase64, 'base64').toString(),
      ),
    ).toEqual({ sum: 6 });
    expect((await backend.collect(r.id, r.c, Date.now())).artifacts).toEqual(
      r.result.artifacts,
    );
    await expect(
      backend.execute(r.c, [], {
        attemptId: r.id,
        deadlineAt: new Date(Date.now() + 10000).toISOString(),
        maintainLease: async () => true,
      }),
    ).rejects.toThrow('CLOUD_RECOVERY_REQUIRED');
    await backend.cleanup(r.id);
    expect(await backend.inspect(r.id)).toBeNull();
  }, 20_000);
  it('has no host files/socket/env; refuses root writes and external networking', async () => {
    process.env.ALLRICE_CLOUD_TEST_SECRET = 'synthetic-host-canary';
    try {
      const r = await run(
        "import fs from 'node:fs'; import net from 'node:net'; const denied=[];for(const path of ['/Users/a123','/var/run/docker.sock','/etc/cloud-canary']){try{fs.readFileSync(path)}catch{denied.push(path)}}; let readOnly=false;try{fs.writeFileSync('/etc/cloud-canary','x')}catch{readOnly=true}; const s=net.connect({host:'1.1.1.1',port:443}); const network=await new Promise(resolve=>{s.on('error',()=>resolve(false));s.on('connect',()=>resolve(true));s.setTimeout(500,()=>{s.destroy();resolve(false)})});console.log(JSON.stringify({uid:process.getuid(),hostCanary:process.env.ALLRICE_CLOUD_TEST_SECRET??null,denied,readOnly,network}));",
      );
      expect(r.result.reason).toBe('completed');
      const facts = JSON.parse(r.result.output);
      expect(facts).toEqual({
        uid: 65532,
        hostCanary: null,
        denied: ['/Users/a123', '/var/run/docker.sock', '/etc/cloud-canary'],
        readOnly: true,
        network: false,
      });
    } finally {
      delete process.env.ALLRICE_CLOUD_TEST_SECRET;
    }
  }, 20_000);
  it('enforces actual runsc, cgroups, no mounts/network/capabilities on created sandbox', async () => {
    const r = await run('console.log("sandbox")');
    const c = await backend.json<{
      HostConfig: {
        Runtime: string;
        NetworkMode: string;
        Privileged: boolean;
        ReadonlyRootfs: boolean;
        Memory: number;
        MemorySwap: number;
        CpuQuota: number;
        PidsLimit: number;
        CapDrop: string[];
        SecurityOpt: string[];
        Binds: unknown;
      };
      Config: { User: string };
      Mounts: unknown[];
    }>('GET', `/containers/allrice-cloud-${r.id}/json`);
    expect(c.HostConfig).toMatchObject({
      Runtime: 'runsc',
      NetworkMode: 'none',
      Privileged: false,
      ReadonlyRootfs: true,
      Memory: 256 * 1024 * 1024,
      MemorySwap: 256 * 1024 * 1024,
      CpuQuota: 50000,
      PidsLimit: 64,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
    });
    expect(c.HostConfig.Binds).toBeNull();
    expect(c.Config.User).toBe('65532:65532');
    expect(c.Mounts).toEqual([]);
  }, 20_000);
  it('kills detached descendant processes on cancellation', async () => {
    const signal = AbortSignal.timeout(3000);
    const r = await run(
      "import cp from 'node:child_process';cp.spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},100);",
      {},
      { signal },
    );
    expect(r.result.reason).toBe('canceled');
    expect(r.result.stopped).toBe(true);
    expect((await backend.inspect(r.id))?.State.Running).toBe(false);
  }, 20_000);
  it('fails closed when the current lease is revoked during execution', async () => {
    let n = 0;
    const r = await run(
      'setInterval(()=>{},100)',
      {},
      { maintainLease: async () => ++n < 5 },
    );
    expect(r.result.reason).toBe('canceled');
    expect(r.result.stopped).toBe(true);
  }, 20_000);
  it('bounds output and wall time independently of model completion', async () => {
    const output = await run(
      "process.stdout.write('x'.repeat(10000));setInterval(()=>{},100)",
      { limits: { outputBytes: 1024, timeoutMs: 5000 } },
    );
    expect(output.result.reason).toBe('output_limit');
    expect(output.result.output.length).toBeLessThanOrEqual(1024);
    const deadline = await run('while(true){}', {
      limits: { timeoutMs: 3000 },
    });
    expect(deadline.result.reason).toBe('deadline');
    expect(deadline.result.elapsedMs).toBeLessThan(7000);
    expect(deadline.result.stopped).toBe(true);
  }, 20_000);
  it('refuses linked outputs and oversized artifacts without exposing paths', async () => {
    const r = await run(
      "import fs from 'node:fs';fs.symlinkSync('/etc/passwd','output/result.json')",
      {
        outputs: [
          { path: 'result.json', fileName: 'result.json', format: 'json' },
        ],
      },
    );
    expect(r.result.reason).toBe('failed');
    expect(r.result.artifacts).toEqual([]);
    const large = await run(
      "import fs from 'node:fs';fs.writeFileSync('output/result.json','x'.repeat(1025))",
      {
        outputs: [
          { path: 'result.json', fileName: 'result.json', format: 'json' },
        ],
        limits: { artifactBytes: 1024 },
      },
    );
    expect(large.result.reason).toBe('failed');
    expect(large.result.artifacts).toEqual([]);
  }, 20_000);
  it('redacts logs before model/DB context without granting secrets to the VM', async () => {
    const r = await run(
      "console.log('api_key=synthetic_secret_value');console.log('Bearer abc.def.synthetic')",
    );
    expect(r.result.output).not.toContain('synthetic_secret_value');
    expect(r.result.output).toContain('[REDACTED]');
  }, 20_000);
  it('copies a large authorized input through stdin, not Docker env/argv limits', async () => {
    const id = randomUUID();
    attempts.push(id);
    const bytes = Buffer.alloc(500_000, 65);
    const c = command(
      "import fs from 'node:fs';console.log(fs.readFileSync('input/large.txt').length)",
      {
        inputs: [
          {
            path: 'large.txt',
            objectId: randomUUID(),
            checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          },
        ],
      },
    );
    const result = await backend.execute(
      c,
      [{ path: 'large.txt', contentBase64: bytes.toString('base64') }],
      {
        attemptId: id,
        deadlineAt: new Date(Date.now() + 15000).toISOString(),
        maintainLease: async () => true,
      },
    );
    expect(result.reason).toBe('completed');
    expect(result.output.trim()).toBe('500000');
    const container = await backend.json<{ Config: { Env: string[] } }>(
      'GET',
      `/containers/allrice-cloud-${id}/json`,
    );
    expect(container.Config.Env.join()).not.toContain('ALLRICE_CLOUD_INPUT');
  }, 20000);
  it('enforces real tmpfs quota and guest process exhaustion without host mounts', async () => {
    const disk = await run(
      "import fs from 'node:fs';let code='';try{fs.writeFileSync('/tmp/full',Buffer.alloc(40*1024*1024))}catch(e){code=e.code};console.log(code)",
      { limits: { timeoutMs: 6000, memoryMiB: 512 } },
    );
    expect(disk.result.reason).toBe('completed');
    expect(disk.result.output).toContain('ENOSPC');
    const pids = await run(
      "import cp from 'node:child_process';let ok=0,failed=0;const ps=[];for(let i=0;i<80;i++){const p=cp.spawn('/bin/sleep',['8'],{stdio:'ignore'});ps.push(p);p.on('spawn',()=>ok++);p.on('error',()=>failed++)};await new Promise(r=>setTimeout(r,1000));for(const p of ps)p.kill('SIGKILL');console.log(JSON.stringify({ok,failed}));",
      { limits: { timeoutMs: 8000, memoryMiB: 512, cpuMillis: 1000 } },
    );
    expect(pids.result.stopped).toBe(true);
    // Exhausting host-side runsc threads can terminate the sandbox itself;
    // it must never remove the hard limit to make the script succeed.
    expect(['completed', 'failed', 'oom']).toContain(pids.result.reason);
    if (pids.result.reason === 'completed') {
      const count = JSON.parse(pids.result.output);
      expect(count.ok).toBeLessThan(64);
      expect(count.failed).toBeGreaterThan(0);
    } else expect(pids.result.exitCode).not.toBe(0);
    expect(
      (await run('console.log("after-process-limit")')).result.reason,
    ).toBe('completed');
  }, 30000);
  it('contains real memory exhaustion and leaves the next sandbox usable', async () => {
    const memory = await run(
      'const a=[];while(true){const b=Buffer.alloc(16*1024*1024,1);a.push(b)}',
      { limits: { timeoutMs: 6000, memoryMiB: 128, cpuMillis: 1000 } },
    );
    expect(memory.result.stopped).toBe(true);
    expect(['oom', 'failed']).toContain(memory.result.reason);
    const next = await run('console.log("survived")');
    expect(next.result.reason).toBe('completed');
    expect(next.result.output).toContain('survived');
  }, 25000);
  it('VM watchdog terminates even a SIGSTOPed guest supervisor after Worker SIGKILL; Sentry host seccomp stays enabled', async () => {
    const id = randomUUID();
    attempts.push(id);
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./crash-fixture.ts', import.meta.url)),
        id,
      ],
      {
        stdio: 'ignore',
        env: { ...process.env, ALLRICE_RUN_CLOUD_INTEGRATION: '1' },
      },
    );
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    const start = Date.now();
    try {
      while (
        Date.now() - start < 6000 &&
        !(await backend.inspect(id))?.State.Running
      )
        await delay(100);
      expect((await backend.inspect(id))?.State.Running).toBe(true);
      await delay(1000);
      const { stdout } = await promisify(execFile)(
        '/usr/local/bin/colima',
        [
          'ssh',
          '--profile',
          'allrice-cloud-b4',
          '--',
          'sudo',
          'python3',
          '-c',
          "import glob,json,os;out=[]\nfor p in glob.glob('/proc/[0-9]*/status'):\n try:\n  s=open(p).read();n=s.splitlines()[0];\n  if os.readlink(p.replace('status','exe'))=='/usr/local/bin/gvisor-bin/gvisor_sentry':out.append({'name':n,'seccomp':next((l for l in s.splitlines() if l.startswith('Seccomp:')),'missing')})\n except OSError:pass\nprint(json.dumps(out))",
        ],
        { timeout: 5000, maxBuffer: 4096 },
      );
      const sentries = JSON.parse(stdout);
      expect(
        sentries.some((p: { seccomp: string }) =>
          /^Seccomp:\s+2$/u.test(p.seccomp),
        ),
      ).toBe(true);
      child.kill('SIGKILL');
      await exited;
      while (
        Date.now() - start < 12000 &&
        (await backend.inspect(id))?.State.Running
      )
        await delay(200);
      const c = await backend.inspect(id);
      expect(c?.State.Running).toBe(false);
      expect(Date.now() - start).toBeLessThan(12000);
      expect(c?.State.ExitCode).toBe(137);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  }, 20000);
  it('measures host cgroup CPU throttling during a busy tenant script', async () => {
    const id = randomUUID();
    attempts.push(id);
    const start = Date.now();
    const result = backend.execute(
      command('while(true){}', { limits: { timeoutMs: 6000, cpuMillis: 100 } }),
      [],
      {
        attemptId: id,
        deadlineAt: new Date(Date.now() + 10000).toISOString(),
        maintainLease: async () => true,
      },
    );
    while (
      Date.now() - start < 5000 &&
      !(await backend.inspect(id))?.State.Running
    )
      await delay(100);
    await delay(1000);
    const stats = await backend.json<{
      cpu_stats: {
        throttling_data: { throttled_periods: number; throttled_time: number };
      };
    }>('GET', `/containers/allrice-cloud-${id}/stats?stream=false`);
    expect(stats.cpu_stats.throttling_data.throttled_periods).toBeGreaterThan(
      0,
    );
    expect(stats.cpu_stats.throttling_data.throttled_time).toBeGreaterThan(0);
    expect((await result).stopped).toBe(true);
  }, 15000);
});
