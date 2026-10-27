import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RuntimeLocalCommandSchema,
  type RuntimeLocalCommandResult,
} from '@allrice/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalCommandRunner } from './local-command-runner.js';

// Explicit disposable local VM only: never use the user's default Docker context.
const socketPath = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET;
const suite = socketPath ? describe.sequential : describe.skip;
let runner: LocalCommandRunner;
const roots: string[] = [];
const results: { attemptId: string; result: RuntimeLocalCommandResult }[] = [];

suite('P05 real local VM / cgroup v2 isolation', () => {
  beforeAll(async () => {
    if (!socketPath?.endsWith('/.colima/allrice-b2/docker.sock'))
      throw Error('dedicated allrice-b2 VM required');
    runner = new LocalCommandRunner({
      socketPath,
      imageDigest: process.env.ALLRICE_LOCAL_DOCKER_TEST_IMAGE ?? '',
    });
    await runner.preflight();
  });
  afterAll(async () => {
    for (const { attemptId, result } of results)
      await runner.cleanup(attemptId, result.containerId);
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  async function execute(
    source: string,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      maintainLease?: () => Promise<boolean>;
      pids?: number;
      onOutput?: (text: string) => void;
      onSequence?: (sequence: number) => void;
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), 'allrice-p05-vm-'));
    roots.push(root);
    await writeFile(join(root, 'probe.mjs'), source);
    const command = RuntimeLocalCommandSchema.parse({
      capability: 'local.process.execute',
      arguments: {
        executable: '/usr/local/bin/node',
        args: ['probe.mjs'],
        path: '.',
        files: [
          {
            path: 'probe.mjs',
            sha256: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          },
        ],
        imageDigest: runner.config.imageDigest,
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: {
          timeoutMs: options.timeoutMs ?? 10_000,
          outputBytes: 8192,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: options.pids ?? 32,
        },
      },
    });
    const attemptId = randomUUID();
    const result = await runner.execute(root, command, {
      attemptId,
      ...options,
      onOutput: (chunk) => {
        options.onSequence?.(chunk.sequence);
        options.onOutput?.(chunk.text);
      },
    });
    results.push({ attemptId, result });
    expect(await readFile(join(root, 'probe.mjs'), 'utf8')).toBe(source);
    expect(result.stopped).toBe(true);
    expect(result.sourceDirectoryModified).toBe(false);
    return result;
  }

  it('executes real code with separated output and exact exit code', async () => {
    const output: string[] = [];
    const result = await execute(
      'console.log("hello local"); console.error("stderr fixture"); process.exitCode=7;',
      { onOutput: (text) => output.push(text) },
    );
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain('hello local');
    expect(result.stderr).toContain('stderr fixture');
    expect(output.join('')).toContain('hello local');
  }, 30_000);
  it('preserves signal exit codes instead of treating killed commands as success', async () => {
    const result = await execute('process.kill(process.pid,"SIGTERM");');
    expect(result.exitCode).toBe(143);
    expect(result.reason).toBe('exited');
  });
  it('confines files, credentials, UID, capabilities and supervisor control', async () => {
    const result = await execute(`import fs from 'node:fs';
      if(process.getuid()!==1000) throw Error('uid');
      if(!fs.readFileSync('/proc/self/status','utf8').includes('CapEff:\\t0000000000000000')) throw Error('capabilities');
      for(const path of ['/Users/a123/.config/allrice/dsh-credentials.dev.json','/var/run/docker.sock','/root/.ssh/id_rsa','/proc/1/environ']) {
        try { fs.readFileSync(path); throw Error('READ SUCCEEDED:'+path); } catch(e) { if(!['ENOENT','EACCES'].includes(e.code)) throw e; }
      }
      try {process.kill(1,'SIGSTOP'); throw Error('supervisor stopped');} catch(e) {if(e.code!=='EPERM')throw e;}
      try {fs.writeFileSync('/outside','escaped');throw Error('root writable');} catch(e) {if(!['EROFS','EACCES'].includes(e.code))throw e;}
      fs.writeFileSync('/workspace/only-in-copy.txt','allowed');
      if(process.env.ALLRICE_INPUT_PARTS || process.env.SSH_AUTH_SOCK || process.env.GEMINI_API_KEY) throw Error('env');
      console.log('isolation verified');`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('isolation verified');
  }, 30_000);
  it('has no external network route', async () => {
    const result =
      await execute(`import net from 'node:net'; const socket=net.connect({host:'192.168.5.2',port:7897});
      socket.on('connect',()=>{console.error('escape');process.exit(1)});
      socket.on('error',e=>{console.log(e.code);process.exit(['ENETUNREACH','EHOSTUNREACH'].includes(e.code)?0:1)});
      setTimeout(()=>process.exit(2),2000);`);
    expect(result.exitCode).toBe(0);
  }, 30_000);
  it('enforces cgroup CPU quota and process count', async () => {
    const result =
      await execute(`import fs from 'node:fs';import {spawn} from 'node:child_process';
      const max=fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim();
      if(max!=='50000 100000')throw Error(max);
      const pids=fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim();if(pids!=='32')throw Error(pids);
      let denied=0;const children=[];for(let i=0;i<40;i++){const p=spawn('/bin/sleep',['5']);p.on('error',e=>{if(e.code==='EAGAIN')denied++});children.push(p);}
      setTimeout(()=>{console.log('denied='+denied);for(const p of children)p.kill();process.exit(denied>0?0:1)},500);`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/denied=[1-9]/);
  }, 30_000);
  it('enforces memory limit without exhausting the host VM', async () => {
    const result =
      await execute(`import fs from 'node:fs';if(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='134217728')throw Error('limit');
      const parts=[];for(let i=0;i<24;i++)parts.push(Buffer.alloc(10*1024*1024,1));console.log('should not survive');`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('should not survive');
    expect(result.reason).toBe('memory_limit');
  }, 30_000);
  it('actually throttles busy CPU work, not just reporting a configured quota', async () => {
    const result = await execute(`import fs from 'node:fs';
      const n=()=>Number(fs.readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/^nr_throttled (\\d+)$/m)?.[1]||0);
      const before=n(),until=Date.now()+1200;while(Date.now()<until){}const delta=n()-before;
      console.log('throttled='+delta);process.exit(delta>0?0:1);`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/throttled=[1-9]/);
  }, 30000);
  it('cancels detached setsid descendants and confirms actual container exit', async () => {
    const abort = new AbortController();
    const result = await execute(
      `import {spawn} from 'node:child_process';
      const child=spawn('/bin/sleep',['20'],{detached:true,stdio:'ignore'});child.unref();
      console.log('detached ready');setInterval(()=>console.log('still running'),100);`,
      {
        signal: abort.signal,
        onOutput: (text) => {
          if (text.includes('detached ready')) abort.abort();
        },
      },
    );
    expect(result.reason).toBe('canceled');
    expect(result.exitCode).not.toBe(0);
  }, 30_000);
  it('stops when current lease checks fail', async () => {
    let allowed = true;
    const result = await execute(
      'console.log("started");setInterval(()=>{},100);',
      {
        maintainLease: async () => allowed,
        onOutput: () => {
          allowed = false;
        },
      },
    );
    expect(result.reason).toBe('lease_lost');
  }, 30_000);
  it('has a supervisor deadline even without control polling', async () => {
    const result = await execute('while(true){}', { timeoutMs: 1000 });
    expect(result.reason).toBe('timeout');
    expect(result.exitCode).not.toBe(0);
  }, 30_000);
  it('bounds excessive output and reports truncation', async () => {
    const result = await execute(
      'while(true)process.stdout.write("x".repeat(8192));',
    );
    expect(result.reason).toBe('output_limit');
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(8192);
  }, 30_000);
  it('bounds spaced output frames below the byte limit and confirms an actual output_limit stop', async () => {
    const sequences: number[] = [];
    const result = await execute(
      `let count=0;const timer=setInterval(()=>{
        process.stdout.write('frame-'+count+'\\n');
        if(++count===320){clearInterval(timer);process.exit(0);}
      },15);`,
      {
        onSequence: (sequence) => {
          // Mirrors the strict SQLite/PG contract; overflow must never reach it.
          expect(sequence).toBeLessThan(256);
          sequences.push(sequence);
        },
      },
    );
    expect(sequences.length).toBeGreaterThan(200);
    expect(sequences.length).toBeLessThanOrEqual(256);
    expect(sequences).toEqual(sequences.map((_, index) => index));
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThan(8192);
    expect(result.reason).toBe('output_limit');
    expect(result.truncated).toBe(true);
    expect(result.stopped).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('frame-319');
  }, 30_000);
});
