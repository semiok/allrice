import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudCommandSchema,
  CloudCommandInputSchema,
  CloudExecutionProfileSchema,
  cloudPlatform,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import {
  CloudRunnerBackend,
  cloudSupervisor,
  repositoryCompiledSupervisor,
  repositoryExpandedSourceSupervisor,
  repositoryExpandedCompiledSupervisor,
} from './backend.js';
import {
  RepositoryExecutionProofSchema,
  matchesRepositoryExecutionIsolation,
} from '@allrice/database/technical-contracts';
import { colimaEnvironmentPath, colimaExecutable } from './colima.js';

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
  it.each([1024, 1025])(
    'counts %i combined UTF-8 output bytes at collection without character-based truncation',
    async (bytes) => {
      const stdout = Buffer.from('中'.repeat(170));
      const stderr = Buffer.concat([
        Buffer.from('文'.repeat(170)),
        Buffer.alloc(bytes - 1020, 120),
      ]);
      class CapturedFrames extends CloudRunnerBackend {
        override async inspect() {
          return {
            Id: '1'.repeat(64),
            Config: { Labels: {} },
            HostConfig: { Runtime: 'runsc' },
            State: {
              Running: false,
              ExitCode: 0,
              OOMKilled: false,
              Status: 'exited',
            },
          };
        }
        override async call() {
          const body = Buffer.from(
            [stdout, stderr]
              .map((chunk) =>
                JSON.stringify({
                  type: 'output',
                  data: chunk.toString('base64'),
                }),
              )
              .join('\n'),
          );
          const header = Buffer.alloc(8);
          header[0] = 1;
          header.writeUInt32BE(body.length, 4);
          return Buffer.concat([header, body]);
        }
      }
      const result = await new CapturedFrames().collect(
        randomUUID(),
        command('0', { limits: { outputBytes: 1024 } }),
        Date.now(),
      );
      expect(result.reason).toBe(bytes === 1024 ? 'completed' : 'output_limit');
      expect(Buffer.byteLength(result.output)).toBe(
        bytes === 1024 ? 1024 : 510,
      );
    },
  );
  it('recovers a stopped v1 repository container with the original frozen supervisor bytes', async () => {
    // Golden from the deployed v1 release, not a hash recalculated by the test.
    expect(createHash('sha256').update(cloudSupervisor).digest('hex')).toBe(
      '924caa50ef05394efbc389abfe5bc2d567be534e424ce146c7b4fdd2c270d3e9',
    );
    const attempt = randomUUID(),
      digest = 'sha256:' + 'a'.repeat(64);
    const container = {
      Id: 'a'.repeat(64),
      Config: {
        Labels: {
          'xyz.bplabs.allrice.cloud.kind': 'repository',
          'xyz.bplabs.allrice.repository.command': digest,
        },
        Image: cloudToolchainImageV1,
        User: '0:0',
        Env: [],
        Entrypoint: ['/usr/local/bin/node'],
        Cmd: ['--input-type=module', '--eval', cloudSupervisor],
      },
      HostConfig: {
        Runtime: 'runsc',
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        CapAdd: ['SETUID', 'SETGID', 'KILL'],
        SecurityOpt: ['no-new-privileges'],
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777' },
      },
      State: {
        Running: false,
        ExitCode: 0,
        OOMKilled: false,
        Status: 'exited',
      },
    };
    class HistoricalContainer extends CloudRunnerBackend {
      override async inspect() {
        return container;
      }
      override async json<T>() {
        return { Config: { Env: [] } } as T;
      }
      override async call() {
        return Buffer.alloc(0);
      }
    }
    const result = await new HistoricalContainer().collect(
      attempt,
      command('historical typed command'),
      Date.now(),
    );
    expect(result.reason).toBe('completed');
    expect(result.repositoryIsolation).toMatchObject({
      parentUid: 0,
      candidateUid: 1001,
      commandDigest: digest,
      inputLimit: 12_000_000,
    });
    expect(result.repositoryIsolation?.compilerUid).toBeUndefined();
    expect(result.repositoryIsolation?.tmpfsMiB).toBe(64);
    container.HostConfig.Tmpfs['/tmp'] =
      'rw,nosuid,nodev,noexec,size=128m,mode=1777';
    await expect(
      new HistoricalContainer().collect(
        attempt,
        command('historical typed command'),
        Date.now(),
      ),
    ).rejects.toThrow('REPOSITORY_ISOLATION_CHANGED');
    Object.assign(container.Config.Labels, {
      'xyz.bplabs.allrice.repository.source-tmpfs-mib': '128',
    });
    const historical128 = (
      await new HistoricalContainer().collect(
        attempt,
        command('historical typed command'),
        Date.now(),
      )
    ).repositoryIsolation!;
    expect(historical128.tmpfsMiB).toBe(128);
    expect(historical128.inputLimit).toBe(12_000_000);
    for (const size of ['64m', '128m0', '128m,size=128m']) {
      container.HostConfig.Tmpfs['/tmp'] =
        `rw,nosuid,nodev,noexec,size=${size},mode=1777`;
      await expect(
        new HistoricalContainer().collect(
          attempt,
          command('historical typed command'),
          Date.now(),
        ),
      ).rejects.toThrow('REPOSITORY_ISOLATION_CHANGED');
    }
    container.HostConfig.Tmpfs['/tmp'] =
      'rw,nosuid,nodev,noexec,size=128m,mode=1777';
    container.Config.Cmd = [
      '--input-type=module',
      '--eval',
      repositoryExpandedSourceSupervisor,
    ];
    Object.assign(container.Config.Labels, {
      'xyz.bplabs.allrice.repository.input-limit': '48000000',
    });
    const expanded128 = (
      await new HistoricalContainer().collect(
        attempt,
        command('current typed command'),
        Date.now(),
      )
    ).repositoryIsolation!;
    expect(expanded128.tmpfsMiB).toBe(128);
    expect(expanded128.inputLimit).toBe(48_000_000);
    for (const inputLimit of [12_000_000, 48_000_000]) {
      const proof = RepositoryExecutionProofSchema.parse({
        version: 1,
        profileId: 'allrice.output-redaction.v1',
        inputLimit,
        commandDigest: digest,
        tmpfsMiB: 128,
        baselineId: randomUUID(),
        candidateChecksum: digest,
      });
      expect(matchesRepositoryExecutionIsolation(proof, historical128)).toBe(
        inputLimit === 12_000_000,
      );
      expect(matchesRepositoryExecutionIsolation(proof, expanded128)).toBe(
        inputLimit === 48_000_000,
      );
    }
    for (const label of ['12000000', '24000000', '48000001', undefined]) {
      const labels = container.Config.Labels as Record<string, string>;
      if (label === undefined)
        delete labels['xyz.bplabs.allrice.repository.input-limit'];
      else labels['xyz.bplabs.allrice.repository.input-limit'] = label;
      await expect(
        new HistoricalContainer().collect(
          attempt,
          command('current typed command'),
          Date.now(),
        ),
      ).rejects.toThrow('REPOSITORY_ISOLATION_CHANGED');
    }
    Object.assign(container.Config.Labels, {
      'xyz.bplabs.allrice.repository.input-limit': '48000000',
    });
    container.Config.Cmd = ['--input-type=module', '--eval', cloudSupervisor];
    await expect(
      new HistoricalContainer().collect(
        attempt,
        command('current typed command'),
        Date.now(),
      ),
    ).rejects.toThrow('REPOSITORY_ISOLATION_CHANGED');
  });
  it.each([
    [23_000_000, repositoryCompiledSupervisor],
    [59_000_000, repositoryExpandedCompiledSupervisor],
  ] as const)(
    'recovers only the exact %i-byte compiled receiver and label pair',
    async (inputLimit, supervisor) => {
      const container = {
        Id: 'a'.repeat(64),
        Config: {
          Labels: {
            'xyz.bplabs.allrice.cloud.kind': 'repository',
            'xyz.bplabs.allrice.repository.profile':
              'allrice.output-redaction.compiled.v1',
            'xyz.bplabs.allrice.repository.command': 'sha256:' + 'a'.repeat(64),
            'xyz.bplabs.allrice.repository.dependency':
              'sha256:' + 'b'.repeat(64),
            'xyz.bplabs.allrice.repository.timeout': '300000',
            'xyz.bplabs.allrice.repository.input-limit': String(inputLimit),
          },
          Image: cloudToolchainImageV1,
          User: '0:0',
          Env: [],
          Entrypoint: ['/usr/local/bin/node'],
          Cmd: ['--expose-gc', '--input-type=module', '--eval', supervisor],
        },
        HostConfig: {
          Runtime: 'runsc',
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          Privileged: false,
          CapDrop: ['ALL'],
          CapAdd: ['SETUID', 'SETGID', 'KILL'],
          SecurityOpt: ['no-new-privileges'],
          Memory: 768 * 1024 ** 2,
          MemorySwap: 768 * 1024 ** 2,
          PidsLimit: 64,
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=1777' },
        },
        State: {
          Running: false,
          ExitCode: 0,
          OOMKilled: false,
          Status: 'exited',
        },
      };
      class CompiledContainer extends CloudRunnerBackend {
        override async inspect() {
          return container;
        }
        override async json<T>() {
          return { Config: { Env: [] } } as T;
        }
        override async call() {
          return Buffer.alloc(0);
        }
      }
      const collect = () =>
        new CompiledContainer().collect(
          randomUUID(),
          command('typed command'),
          Date.now(),
        );
      expect((await collect()).repositoryIsolation?.inputLimit).toBe(
        inputLimit,
      );
      for (const label of [
        String(inputLimit === 23_000_000 ? 59_000_000 : 23_000_000),
        '35000000',
        '59000001',
      ]) {
        container.Config.Labels['xyz.bplabs.allrice.repository.input-limit'] =
          label;
        await expect(collect()).rejects.toThrow('REPOSITORY_ISOLATION_CHANGED');
      }
    },
  );
  it.each([12_000_000, 48_000_000])(
    'enforces the private %i-byte source proof at Worker input before creating a container',
    async (inputLimit) => {
      const created: Record<string, unknown>[] = [];
      class InputBoundary extends CloudRunnerBackend {
        override async preflight() {
          return {
            backend: 'cloud-gvisor-v1',
            runtime: 'runsc',
            architecture: cloudPlatform.architecture,
            imageDigest: cloudToolchainImageV1,
          } as const;
        }
        override async inspect() {
          return null;
        }
        override async json<T>(
          _method: string,
          _path: string,
          body?: unknown,
        ): Promise<T> {
          created.push(body as Record<string, unknown>);
          throw Error('CLOUD_DAEMON_422');
        }
        run(
          payload: ReturnType<typeof command>,
          files: Parameters<CloudRunnerBackend['execute']>[1],
          options: Parameters<CloudRunnerBackend['execute']>[2],
        ) {
          return this.executeAdmittedScript(
            payload.arguments,
            files,
            options,
            false,
          );
        }
      }
      for (const overflow of [0, 1]) {
        created.length = 0;
        const bytes = Buffer.alloc(inputLimit + overflow);
        const checksum =
          'sha256:' + createHash('sha256').update(bytes).digest('hex');
        const payload = command('0', {
          inputs: [
            { path: 'repository.json.gz', objectId: randomUUID(), checksum },
          ],
          limits: {
            memoryMiB: 512,
            timeoutMs: 60000,
            outputBytes: 16384,
            artifactBytes: 16384,
            cpuMillis: 1000,
            pids: 64,
          },
        });
        const proof = RepositoryExecutionProofSchema.parse({
          version: 1,
          profileId: 'allrice.output-redaction.v1',
          inputLimit,
          tmpfsMiB: 128,
          baselineId: randomUUID(),
          candidateChecksum: checksum,
          commandDigest:
            'sha256:' +
            createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        });
        await expect(
          new InputBoundary().run(
            payload,
            [
              {
                path: 'repository.json.gz',
                contentBase64: bytes.toString('base64'),
              },
            ],
            {
              attemptId: randomUUID(),
              signal: new AbortController().signal,
              deadlineAt: new Date(Date.now() + 60000).toISOString(),
              maintainLease: async () => true,
              repositoryExecution: proof,
            },
          ),
        ).rejects.toThrow(overflow ? 'CLOUD_INPUT_LIMIT' : 'CLOUD_DAEMON_422');
        if (overflow) expect(created).toEqual([]);
        else {
          expect(created[0]?.Cmd).toContain(
            inputLimit === 12_000_000
              ? cloudSupervisor
              : repositoryExpandedSourceSupervisor,
          );
          expect(created[0]?.HostConfig).toMatchObject({
            Memory: 512 * 1024 ** 2,
            Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=128m,mode=1777' },
          });
        }
      }
    },
  );
  describe.each([
    [
      48_000_000,
      65_000_000,
      cloudSupervisor,
      repositoryExpandedSourceSupervisor,
    ],
    [
      59_000_000,
      80_000_000,
      repositoryCompiledSupervisor,
      repositoryExpandedCompiledSupervisor,
    ],
  ] as const)(
    '%i-byte private receiver complete payload boundary',
    (inputBytes, characters, historical, current) => {
      // Keep the complete deployed receiver prefixes unchanged. Preload stdin
      // and deliver one complete event so this tests parsing/capacity, without
      // claiming real pipe chunk throughput or physical VM execution.
      const receive = (supervisor: string, input: string) => {
        const end = supervisor.indexOf('fs.mkdirSync');
        if (end < 0) throw Error('REPOSITORY_TEST_RECEIVER_PREFIX');
        return spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `import { readFileSync } from 'node:fs'; import { Readable } from 'node:stream';
const wire=readFileSync(0,'utf8');
Object.defineProperty(process,'stdin',{value:Readable.from([wire])});
` +
              supervisor.slice(0, end) +
              'process.stdout.write(JSON.stringify({files:input.files.map(f=>({path:f.path,bytes:Buffer.byteLength(f.contentBase64,"base64")})),scriptLength:input.script.length}));process.exit(0);',
          ],
          { input, encoding: 'utf8', maxBuffer: 1024 },
        );
      };
      const files =
        inputBytes === 48_000_000
          ? [{ path: 'repository.json.gz', bytes: 48_000_000 }]
          : [
              { path: 'repository.json.gz', bytes: 48_000_000 },
              { path: 'dependencies.json.gz', bytes: 11_000_000 },
            ];
      const envelope = () =>
        JSON.stringify({
          files: files.map((f) => ({
            path: f.path,
            contentBase64:
              'AAAA'.repeat(Math.floor(f.bytes / 3)) +
              Buffer.alloc(f.bytes % 3).toString('base64'),
          })),
          script: '\u0001'.repeat(100_000),
        }) + '\n';
      it('accepts every binary byte and the bounded JSON envelope in one complete stdin event', () => {
        const accepted = receive(current, envelope());
        expect(accepted.status).toBe(0);
        expect(JSON.parse(accepted.stdout)).toEqual({
          files,
          scriptLength: 100_000,
        });
      });
      it('rejects the same complete payload in the historical 32 MB receiver', () => {
        expect(receive(historical, envelope()).status).toBe(126);
      });
      it('rejects one character beyond the current finite envelope cap', () => {
        expect(receive(current, ' '.repeat(characters + 1)).status).toBe(126);
      });
    },
  );
  it('recognizes watchdog deadline stops from Docker time without guessing or overriding cancellation/unknown', async () => {
    const deadline = Date.now() + 5000;
    const container = {
      Id: '1'.repeat(64),
      Config: {
        Labels: {
          'xyz.bplabs.allrice.cloud.deadline': String(deadline),
        },
      },
      HostConfig: { Runtime: 'runsc' },
      State: {
        Running: false,
        ExitCode: 137,
        OOMKilled: false,
        Status: 'exited',
        FinishedAt: new Date(deadline + 100).toISOString(),
      },
    };
    class StoppedBackend extends CloudRunnerBackend {
      override async inspect() {
        return container;
      }
      override async call() {
        return Buffer.alloc(0);
      }
    }
    const backend = new StoppedBackend();
    const collect = (
      reason: 'completed' | 'canceled' | 'unknown' = 'completed',
    ) => backend.collect(randomUUID(), command('0'), Date.now(), reason);
    expect((await collect()).reason).toBe('deadline');
    expect((await collect('canceled')).reason).toBe('canceled');
    expect((await collect('unknown')).reason).toBe('unknown');
    container.State.FinishedAt = new Date(deadline - 1).toISOString();
    expect((await collect()).reason).toBe('failed');
    container.State.FinishedAt = new Date(deadline + 100).toISOString();
    container.Config.Labels['xyz.bplabs.allrice.cloud.deadline'] = 'unknown';
    expect((await collect()).reason).toBe('failed');
    container.Config.Labels['xyz.bplabs.allrice.cloud.deadline'] =
      String(deadline);
    container.State.OOMKilled = true;
    expect((await collect()).reason).toBe('oom');
  });
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
      architecture: cloudPlatform.architecture,
      runtime: 'runsc',
      runtimeVersion: 'release-20260831.0',
      runtimeChecksum: cloudPlatform.runtimeChecksum,
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
  it(
    'computes from authorized bytes; output survives stop/recovery until cleanup',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20_000 },
    async () => {
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
          Buffer.from(
            r.result.artifacts[0]!.contentBase64,
            'base64',
          ).toString(),
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
    },
  );
  it(
    'has no host files/socket/env; refuses root writes and external networking',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20_000 },
    async () => {
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
    },
  );
  it(
    'enforces actual runsc, cgroups, no mounts/network/capabilities on created sandbox',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20_000 },
    async () => {
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
    },
  );
  it(
    'kills detached descendant processes on cancellation',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 30000 },
    async () => {
      const controller = new AbortController();
      const pending = run(
        "import cp from 'node:child_process';cp.spawn(process.execPath,['-e','setInterval(()=>{},100)'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},100);",
        {},
        { signal: controller.signal },
      );
      void pending.catch(() => undefined);
      try {
        await expect
          .poll(
            async () => (await backend.inspect(attempts[0]!))?.State.Running,
            { timeout: 20000 },
          )
          .toBe(true);
        await delay(1000);
      } finally {
        controller.abort();
      }
      const r = await pending;
      expect(r.result.reason).toBe('canceled');
      expect(r.result.stopped).toBe(true);
      expect((await backend.inspect(r.id))?.State.Running).toBe(false);
    },
  );
  it(
    'fails closed when the current lease is revoked during execution',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20_000 },
    async () => {
      let n = 0;
      const r = await run(
        'setInterval(()=>{},100)',
        {},
        { maintainLease: async () => ++n < 5 },
      );
      expect(r.result.reason).toBe('canceled');
      expect(r.result.stopped).toBe(true);
    },
  );
  it(
    'bounds output and wall time independently of model completion',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20_000 },
    async () => {
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
    },
  );
  it(
    'refuses linked outputs and oversized artifacts without exposing paths',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20_000 },
    async () => {
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
    },
  );
  it(
    'redacts logs before model/DB context without granting secrets to the VM',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20_000 },
    async () => {
      const r = await run(
        "console.log('api_key=synthetic_secret_value');console.log('Bearer abc.def.synthetic')",
      );
      expect(r.result.output).not.toContain('synthetic_secret_value');
      expect(r.result.output).toContain('[REDACTED]');
    },
  );
  it(
    'drains artifact output before exit and preserves rejection diagnostics',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 60000 },
    async () => {
      const value = 'x'.repeat(512_000);
      const result = await run(
        "import fs from 'node:fs';fs.writeFileSync('output/result.txt','x'.repeat(512000))",
        {
          outputs: [
            { path: 'result.txt', fileName: 'result.txt', format: 'txt' },
          ],
        },
      );
      expect(result.result.reason, result.result.output).toBe('completed');
      expect(
        Buffer.from(
          result.result.artifacts[0]!.contentBase64,
          'base64',
        ).toString(),
      ).toBe(value);
      const missing = await run('void 0', {
        outputs: [
          { path: 'missing.txt', fileName: 'missing.txt', format: 'txt' },
        ],
      });
      expect(missing.result.reason).toBe('failed');
      expect(missing.result.output).toContain(
        'Sandbox output validation failed:',
      );
      expect(missing.result.output).toContain('ENOENT');
    },
  );

  it(
    'copies a large authorized input through stdin, not Docker env/argv limits',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 20000 },
    async () => {
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
    },
  );
  it(
    'enforces real tmpfs quota and guest process exhaustion without host mounts',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 30000 },
    async () => {
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
    },
  );
  it(
    'contains real memory exhaustion and leaves the next sandbox usable',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 25000 },
    async () => {
      const memory = await run(
        'const a=[];while(true){const b=Buffer.alloc(16*1024*1024,1);a.push(b)}',
        { limits: { timeoutMs: 6000, memoryMiB: 128, cpuMillis: 1000 } },
      );
      expect(memory.result.stopped).toBe(true);
      expect(['oom', 'failed']).toContain(memory.result.reason);
      const next = await run('console.log("survived")');
      expect(next.result.reason).toBe('completed');
      expect(next.result.output).toContain('survived');
    },
  );
  it(
    'VM watchdog terminates even a SIGSTOPed guest supervisor after Worker SIGKILL; Sentry host seccomp stays enabled',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 40000 },
    async () => {
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
          Date.now() - start < 20000 &&
          !(await backend.inspect(id))?.State.Running
        )
          await delay(100);
        expect((await backend.inspect(id))?.State.Running).toBe(true);
        await delay(1000);
        const { stdout } = await promisify(execFile)(
          colimaExecutable(),
          [
            'ssh',
            '--profile',
            process.env.ALLRICE_CLOUD_PROFILE ?? 'allrice-cloud-b4',
            '--',
            'sudo',
            'python3',
            '-c',
            "import glob,json,os;out=[]\nfor p in glob.glob('/proc/[0-9]*/status'):\n try:\n  s=open(p).read();n=s.splitlines()[0];\n  if os.readlink(p.replace('status','exe'))=='/usr/local/bin/gvisor-bin/gvisor_sentry':out.append({'name':n,'seccomp':next((l for l in s.splitlines() if l.startswith('Seccomp:')),'missing')})\n except OSError:pass\nprint(json.dumps(out))",
          ],
          {
            timeout: 5000,
            maxBuffer: 4096,
            env: { ...process.env, PATH: colimaEnvironmentPath() },
          },
        );
        const sentries = JSON.parse(stdout);
        expect(
          sentries.some((p: { seccomp: string }) =>
            /^Seccomp:\s+2$/u.test(p.seccomp),
          ),
        ).toBe(true);
        child.kill('SIGKILL');
        await exited;
        const deadline = Number(
          (await backend.inspect(id))?.Config.Labels[
            'xyz.bplabs.allrice.cloud.deadline'
          ],
        );
        expect(Number.isFinite(deadline)).toBe(true);
        while (
          Date.now() < deadline + 3000 &&
          (await backend.inspect(id))?.State.Running
        )
          await delay(200);
        const c = await backend.inspect(id);
        expect(c?.State.Running).toBe(false);
        expect(Date.now()).toBeLessThan(deadline + 3000);
        expect(c?.State.ExitCode).toBe(137);
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
    },
  );
  it(
    'measures host cgroup CPU throttling during a busy tenant script',
    { tags: ['manual:ALLRICE_RUN_CLOUD_INTEGRATION'], timeout: 15000 },
    async () => {
      const id = randomUUID();
      attempts.push(id);
      const start = Date.now();
      const result = backend.execute(
        command('while(true){}', {
          limits: { timeoutMs: 6000, cpuMillis: 100 },
        }),
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
          throttling_data: {
            throttled_periods: number;
            throttled_time: number;
          };
        };
      }>('GET', `/containers/allrice-cloud-${id}/stats?stream=false`);
      expect(stats.cpu_stats.throttling_data.throttled_periods).toBeGreaterThan(
        0,
      );
      expect(stats.cpu_stats.throttling_data.throttled_time).toBeGreaterThan(0);
      expect((await result).stopped).toBe(true);
    },
  );
});
