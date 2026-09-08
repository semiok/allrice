import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  localCommandToolchainImageV1,
  canonicalRuntimeBridgeJson,
  type RuntimeLocalCommandResult,
  type RuntimeLocalServiceEvent,
  type RuntimeLocalServiceInput,
} from '@allrice/contracts';
import { LocalCommandRunner } from './local-command-runner.js';
import { LocalServiceRunner } from './local-service-runner.js';
import { BridgeJournal, bridgeDigest } from './journal.js';
import { journalDispatch } from './journal-fixtures.js';

const socketPath = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET;
const suite = socketPath ? describe.sequential : describe.skip;
const roots: string[] = [];
const results: { attemptId: string; result: RuntimeLocalCommandResult }[] = [];
let runner: LocalCommandRunner;
const digest = (s: string) =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;

suite('P09-c actual dedicated VM service lifecycle', () => {
  beforeAll(async () => {
    if (socketPath !== '/Users/a123/.colima/allrice-b2/docker.sock')
      throw Error('dedicated synthetic VM required');
    runner = new LocalCommandRunner({
      socketPath,
      imageDigest: localCommandToolchainImageV1,
    });
    await runner.preflight();
  });
  afterAll(async () => {
    for (const value of results)
      await runner.cleanup(value.attemptId, value.result.containerId);
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  async function execute(
    source: string,
    options: {
      onEvent?: (event: RuntimeLocalServiceEvent) => void;
      control?: () => {
        stopRequested: boolean;
        inputs: RuntimeLocalServiceInput[];
      };
      requestTimeoutMs?: number;
      durationMs?: number;
      readinessMs?: number;
      outputBytes?: number;
      onOutput?: () => Promise<void>;
      maintainLease?: () => Promise<{
        leaseExpiresAt: string;
        stopRequested: boolean;
        inputs: RuntimeLocalServiceInput[];
      }>;
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), 'allrice-p09c-vm-'));
    roots.push(root);
    await writeFile(join(root, 'service.mjs'), source);
    const command = RuntimeLocalCommandSchema.parse({
      capability: 'local.process.execute',
      arguments: {
        executable: '/usr/local/bin/node',
        args: ['service.mjs'],
        path: '.',
        files: [{ path: 'service.mjs', sha256: digest(source) }],
        imageDigest: localCommandToolchainImageV1,
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: {
          timeoutMs: 10000,
          outputBytes: options.outputBytes ?? 8192,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: 32,
        },
        background: {
          durationMs: options.durationMs ?? 15000,
          readiness: {
            kind: 'http',
            port: 3100,
            path: '/',
            timeoutMs: options.readinessMs ?? 6000,
          },
          stdin: {
            mode: 'requests-v1',
            maxRequests: 4,
            maxBytes: 100,
            requestTimeoutMs: options.requestTimeoutMs ?? 6000,
          },
        },
      },
    });
    const attemptId = randomUUID(),
      events: RuntimeLocalServiceEvent[] = [];
    const result = await new LocalServiceRunner(runner).execute(root, command, {
      processId: randomUUID(),
      attemptId,
      hardDeadlineAt: new Date(
        Date.now() + command.arguments.background!.durationMs,
      ).toISOString(),
      maintainLease:
        options.maintainLease ??
        (async () => ({
          leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
          ...(options.control?.() ?? { stopRequested: false, inputs: [] }),
        })),
      onEvent: async (event) => {
        events.push(event);
        options.onEvent?.(event);
      },
      prepareInput: async () => 'new',
      onOutput: options.onOutput,
    });
    results.push({ attemptId, result });
    expect(await readFile(join(root, 'service.mjs'), 'utf8')).toBe(source);
    expect(result.stopped).toBe(true);
    expect(result.sourceDirectoryModified).toBe(false);
    return { result, events };
  }
  it('returns real container-only readiness while still running and stops the service tree', async () => {
    let stop = false;
    const { result, events } = await execute(
      `import http from 'node:http';
      import {spawn} from 'node:child_process';
      spawn('/usr/local/bin/node',['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}).unref();
      http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');`,
      {
        onEvent: (event) => {
          if (event.type === 'ready') stop = true;
        },
        control: () => ({ stopRequested: stop, inputs: [] }),
      },
    );
    expect(events.map((e) => e.type)).toEqual(['starting', 'ready']);
    expect(result.reason).toBe('canceled');
    const state = await runner.api.json<{
      State: { Running: boolean };
      HostConfig: { PortBindings: unknown; NetworkMode: string };
    }>('GET', `/containers/${result.containerId}/json`);
    expect(state.State.Running).toBe(false);
    expect(state.HostConfig.NetworkMode).toBe('none');
    expect(state.HostConfig.PortBindings ?? {}).toEqual({});
  }, 30000);
  it('delivers only requested non-PTY text and then explicit EOF without duplicate input', async () => {
    let inputs: RuntimeLocalServiceInput[] = [];
    const { result, events } = await execute(
      `import http from 'node:http';import fs from 'node:fs';
      const request=prompt=>fs.writeSync(3,JSON.stringify({type:'input.request',prompt})+'\\n');
      http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1',()=>request('输入测试文字'));
      process.stdin.once('data',data=>{console.log('text:'+data.toString());request('关闭输入');});
      process.stdin.once('end',()=>{console.log('EOF');process.exit(0);});`,
      {
        onEvent: (event) => {
          if (event.type === 'input_request') {
            const kind = event.request.sequence === 0 ? 'text' : 'eof',
              text = kind === 'text' ? 'synthetic-answer\n' : '';
            inputs = [
              {
                inputId: randomUUID(),
                requestId: event.request.requestId,
                sequence: event.request.sequence,
                expiresAt: event.request.expiresAt,
                kind,
                text,
                digest: digest(canonicalRuntimeBridgeJson({ kind, text })),
              },
            ];
          } else if (event.type === 'input_delivered') inputs = [];
        },
        control: () => ({ stopRequested: false, inputs }),
      },
    );
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('text:synthetic-answer');
    expect(result.stdout).toContain('EOF');
    expect(events.filter((e) => e.type === 'input_delivered')).toHaveLength(2);
  }, 30000);
  it('stops an unanswered explicit request at its own expiry', async () => {
    const { result } = await execute(
      `import http from 'node:http';import fs from 'node:fs';
      http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');
      fs.writeSync(3,JSON.stringify({type:'input.request',prompt:'有限输入'})+'\\n');`,
      { requestTimeoutMs: 600 },
    );
    expect(result.reason).toBe('input_expired');
  }, 30000);
  it('reports readiness timeout instead of claiming a live PID is ready', async () => {
    const { result, events } = await execute('setInterval(()=>{},1000);', {
      readinessMs: 600,
    });
    expect(result.reason).toBe('readiness_timeout');
    expect(events.some((e) => e.type === 'ready')).toBe(false);
  }, 30000);
  it('retains a fixed deadline even while authorizations renew', async () => {
    const { result } = await execute(
      `import http from 'node:http';http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');`,
      { durationMs: 2000 },
    );
    expect(result.reason).toBe('timeout');
  }, 30000);
  it('stops after transport loss rather than letting a ready service continue without a lease', async () => {
    let disconnected = false;
    const { result } = await execute(
      `import http from 'node:http';http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');`,
      {
        onEvent: (event) => {
          if (event.type === 'ready') disconnected = true;
        },
        maintainLease: async () => {
          if (disconnected) throw Error('synthetic disconnected');
          return {
            leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
            stopRequested: false,
            inputs: [],
          };
        },
      },
    );
    expect(result.reason).toBe('lease_lost');
  }, 30000);
  it('cancels a service waiting for input and preserves the unanswered request', async () => {
    let stop = false;
    const { result, events } = await execute(
      `import http from 'node:http';import fs from 'node:fs';
      http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');
      fs.writeSync(3,JSON.stringify({type:'input.request',prompt:'输入后续步骤'})+'\\n');`,
      {
        onEvent: (event) => {
          if (event.type === 'input_request') stop = true;
        },
        control: () => ({ stopRequested: stop, inputs: [] }),
      },
    );
    expect(result.reason).toBe('canceled');
    expect(events.filter((e) => e.type === 'input_delivered')).toEqual([]);
  }, 30000);
  it('enforces bounded output rather than collecting an unlimited background log', async () => {
    const { result } = await execute(
      `import http from 'node:http';http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');
      setTimeout(()=>console.log('x'.repeat(2000)),600);`,
      { outputBytes: 1024 },
    );
    expect(result.reason).toBe('output_limit');
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(1024);
  }, 30000);
  it('labels a normal in-container port collision instead of silently choosing another port', async () => {
    const { result } = await execute(`import http from 'node:http';
      http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1',()=>http.createServer().listen(3100,'127.0.0.1'));`);
    expect(result.reason).toBe('port_conflict');
    expect(result.exitCode).not.toBe(0);
  }, 30000);
  it('keeps lease control responsive while a bounded stdout upload is slow', async () => {
    const { result, events } = await execute(
      `import http from 'node:http';
      console.log('one bounded startup line');
      http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');
      setTimeout(()=>process.exit(0),4200);`,
      {
        onOutput: async () => {
          await new Promise((resolve) => setTimeout(resolve, 3500));
        },
      },
    );
    expect(result.reason).toBe('exited');
    expect(result.exitCode).toBe(0);
    expect(events.some((event) => event.type === 'ready')).toBe(true);
  }, 30000);
  it('stops after its Bridge owner exits and reconciles the journal without restarting the container', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-p09c-owner-'));
    roots.push(root);
    const source = `import http from 'node:http';http.createServer((q,s)=>s.end('fixture')).listen(3100,'127.0.0.1');`;
    await writeFile(join(root, 'service.mjs'), source);
    const dispatch = journalDispatch(root);
    dispatch.snapshot.binding.attempt.attemptId = randomUUID();
    dispatch.payload = RuntimeLocalCommandSchema.parse({
      capability: 'local.process.execute',
      arguments: {
        executable: '/usr/local/bin/node',
        args: ['service.mjs'],
        path: '.',
        files: [{ path: 'service.mjs', sha256: digest(source) }],
        imageDigest: localCommandToolchainImageV1,
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: {
          timeoutMs: 10000,
          outputBytes: 8192,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: 32,
        },
        background: {
          durationMs: 30000,
          readiness: { kind: 'http', port: 3100, path: '/', timeoutMs: 5000 },
          stdin: {
            mode: 'none',
            maxRequests: 1,
            maxBytes: 100,
            requestTimeoutMs: 5000,
          },
        },
      },
    });
    dispatch.snapshot.binding.action = 'local.process.execute';
    dispatch.snapshot.binding.inputDigest = bridgeDigest(dispatch.payload);
    const config = { root, journal: join(root, 'private-journal'), dispatch };
    const configPath = join(root, 'synthetic.json');
    await writeFile(configPath, JSON.stringify(config));
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL('../test/local-service-owner.ts', import.meta.url),
        ),
        configPath,
      ],
      {
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL('../../../tsconfig.base.json', import.meta.url),
          ),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let errors = '';
    child.stderr!.on('data', (data) => {
      errors += data;
    });
    let containerId = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('readiness timeout ' + errors)),
          10000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          reject(Error('owner exited ' + errors));
        });
        child.on('message', (raw) => {
          const e = raw as RuntimeLocalServiceEvent;
          if (e.type === 'starting') containerId = e.containerId;
          if (e.type === 'ready') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      child.kill('SIGKILL');
      await once(child, 'exit');
      const until = Date.now() + 7000;
      let running = true;
      while (running && Date.now() < until) {
        const inspected = await runner.api.json<{
          State: { Running: boolean };
        }>('GET', `/containers/${containerId}/json`);
        running = inspected.State.Running;
        if (running) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(running).toBe(false);
      const journal = await BridgeJournal.open({
        directory: config.journal,
        server: 'https://tenant.example',
        deviceId: dispatch.snapshot.binding.execution.deviceId!,
      });
      try {
        expect((await journal.pending())[0]?.signal.type).toBe(
          'operation.uncertain',
        );
        const result = await runner.recover(
          dispatch.snapshot.binding.attempt.attemptId,
          dispatch.payload,
        );
        expect(result?.stopped).toBe(true);
        expect(result?.reason).toBe('lease_lost');
        if (!result) throw Error('missing retained result');
        results.push({
          attemptId: dispatch.snapshot.binding.attempt.attemptId,
          result,
        });
        await journal.reconcileLocalCommand(
          dispatch.snapshot.binding.attempt.operationId,
          result,
        );
        expect(await journal.receive(dispatch)).toBe('duplicate');
        expect((await journal.pending()).at(-1)?.signal.type).toBe(
          'operation.stopped',
        );
      } finally {
        await journal.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      // If the assertion failed, leave stopped daemon evidence for scoped inspection.
    }
  }, 30000);
});
