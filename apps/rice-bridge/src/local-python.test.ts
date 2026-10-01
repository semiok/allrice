import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeLocalPythonPayloadSchema,
  managedPythonPayloadForPlatform,
} from '@allrice/contracts';
import {
  createLocalPythonArchive,
  readLocalPythonArchive,
} from './local-python-archive.js';
import { LocalPythonRunner } from './local-python-runner.js';
import {
  assertManagedSandboxConfiguration,
  downloadManagedRuntimeAsset,
  managedSandboxStartArguments,
  managedSandboxEnvironment,
  managedSandboxVMHome,
} from './managed-python-sandbox.js';
import { managedSandboxProfile } from './managed-sandbox-release.js';
import { createServer as httpServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const release = managedPythonPayloadForPlatform('macos-x64')!;
const hash = (b: Buffer) =>
  `sha256:${createHash('sha256').update(b).digest('hex')}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function payload() {
  return RuntimeLocalPythonPayloadSchema.parse({
    capability: 'local.python.execute',
    arguments: {
      path: '.',
      purpose: 'office',
      origin: {
        toolName: 'workspace.export.create',
        callId: 'synthetic',
        argumentsDigest: hash(Buffer.from('args')),
      },
      script: "open('output/result.docx','wb').write(b'fixture')",
      inputs: [],
      outputs: [
        {
          path: 'result.docx',
          fileName: '中文 空格.docx',
          format: 'docx',
          mediaType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          objectId: randomUUID(),
        },
      ],
      profileVersion: 1,
      imageId: release.imageId,
      architecture: release.architecture,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 1000,
        inputBytes: 20_000_000,
        artifactBytes: 8_000_000,
        outputBytes: 8192,
        memoryMiB: 512,
        cpuMillis: 1000,
        pids: 64,
      },
    },
  });
}

async function engine(
  options: {
    cancelStart?: AbortController;
    corrupt?: boolean;
    stdout?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-python-socket-')),
    socket = join(root, 'engine.sock');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  type Body = {
    Image: string;
    Labels: Record<string, string>;
    HostConfig: {
      Mounts?: {
        Type: string;
        Source: string;
        Target: string;
        ReadOnly: boolean;
      }[];
    };
    [key: string]: unknown;
  };
  type FakeContainer = {
    Id: string;
    Name: string | null;
    Config: Body;
    Mounts: { Type: string; Name: string; Destination: string }[];
    State: {
      Running: boolean;
      Status: string;
      ExitCode: number;
      OOMKilled: boolean;
    };
  };
  const containers = new Map<string, FakeContainer>();
  const requests: {
    method: string;
    path: string;
    body?: Body;
    data?: Buffer;
  }[] = [];
  const bytes = Buffer.from([0x50, 0x4b, 0, 0xff, 0xfe, 0x13, 0]),
    p = payload();
  const checkpoint = {
    exitCode: 0,
    reason: 'exited',
    stdout: options.stdout ?? 'generated',
    stderr: '',
    truncated: false,
    artifacts: [
      {
        ...p.arguments.outputs[0],
        sizeBytes: bytes.length,
        checksum: hash(bytes),
        validation: 'dsh_office',
      },
    ],
  };
  const server = createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const b of req) body.push(b);
    const requestBytes = Buffer.concat(body);
    const path = req.url!,
      record = {
        method: req.method!,
        path,
        body:
          requestBytes.length && !path.includes('/archive?')
            ? (JSON.parse(requestBytes.toString('utf8')) as Body)
            : undefined,
        data:
          requestBytes.length && path.includes('/archive?')
            ? requestBytes
            : undefined,
      };
    requests.push(record);
    const json = (v: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(v));
    };
    if (path.endsWith('/info'))
      return json({
        OSType: 'linux',
        Architecture: 'x86_64',
        CgroupVersion: '2',
        MemoryLimit: true,
        SwapLimit: true,
        PidsLimit: true,
        CpuCfsQuota: true,
        SecurityOptions: ['name=seccomp,profile=builtin'],
      });
    if (path.includes('/images/'))
      return json({ Id: release.imageId, Os: 'linux', Architecture: 'amd64' });
    if (path.endsWith('/volumes/create')) return json({ ...record.body });
    if (path.includes('/containers/create?')) {
      const Id = createHash('sha256')
        .update(String(containers.size))
        .digest('hex');
      containers.set(Id, {
        Id,
        Name: new URL(path, 'http://fixture').searchParams.get('name'),
        Config: record.body!,
        Mounts:
          record.body!.HostConfig.Mounts?.map((m) => ({
            Type: m.Type,
            Name: m.Source,
            Destination: m.Target,
          })) ?? [],
        State: {
          Running: false,
          Status: 'created',
          ExitCode: 0,
          OOMKilled: false,
        },
      });
      return json({ Id });
    }
    const id = /\/containers\/([^/]+)\//.exec(path)?.[1],
      c =
        containers.get(id ?? '') ??
        [...containers.values()].find((c) => c.Name === id);
    if (path.includes('/logs?')) {
      const proof = Buffer.from(
        JSON.stringify({
          architecture: release.architecture,
          pythonVersion: release.pythonVersion,
          packagesChecksum: release.packagesChecksum,
          officeChecker: release.officeChecker,
          pngChecker: release.pngChecker,
          font: release.font,
        }) + '\n',
      );
      const h = Buffer.alloc(8);
      h[0] = 1;
      h.writeUInt32BE(proof.length, 4);
      res.end(Buffer.concat([h, proof]));
      return;
    }
    if (req.method === 'DELETE') {
      res.end();
      return;
    }
    if (!c) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (path.endsWith('/json')) return json(c);
    if (path.endsWith('/start')) {
      if (
        options.cancelStart &&
        !c.Config.Labels['xyz.bplabs.allrice.python.probe']
      ) {
        options.cancelStart.abort();
        await new Promise((r) => setTimeout(r, 20));
        c.State.Running = true;
        c.State.Status = 'running';
      } else c.State.Status = 'exited';
      res.end();
      return;
    }
    if (path.includes('/kill?')) {
      c.State.Running = false;
      c.State.Status = 'exited';
      c.State.ExitCode = 137;
      res.end();
      return;
    }
    if (path.includes('/archive?')) {
      if (req.method === 'PUT') {
        res.end();
        return;
      }
      const target = new URL(path, 'http://fixture').searchParams.get('path');
      res.end(
        createLocalPythonArchive([
          {
            path: target?.endsWith('result.json')
              ? 'result.json'
              : 'result.docx',
            bytes: target?.endsWith('result.json')
              ? Buffer.from(JSON.stringify(checkpoint))
              : options.corrupt
                ? Buffer.from('corrupt')
                : bytes,
          },
        ]),
      );
      return;
    }
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const runner = new LocalPythonRunner({ socketPath: socket, release });
  return { runner, requests, containers, bytes, p };
}

describe('managed Python Engine byte adapter and physical-stop evidence', () => {
  it('round-trips binary/Chinese/space names and rejects traversal, a second file and checksum corruption', () => {
    const bytes = Buffer.from([0, 0xff, 1, 2]),
      name = '中文 空格'.repeat(15) + '.docx';
    expect(
      readLocalPythonArchive(
        createLocalPythonArchive([{ path: name, bytes }]),
        name,
        100,
      ),
    ).toEqual(bytes);
    expect(() =>
      createLocalPythonArchive([{ path: '../escape', bytes }]),
    ).toThrow();
    expect(() =>
      readLocalPythonArchive(
        createLocalPythonArchive([
          { path: 'a', bytes },
          { path: 'b', bytes },
        ]),
        'a',
        100,
      ),
    ).toThrow();
    const bad = createLocalPythonArchive([{ path: 'a', bytes }]);
    bad[1] = bad[1]! ^ 1;
    expect(() => readLocalPythonArchive(bad, 'a', 100)).toThrow();
  });
  it('uses no host mounts and uploads original bytes only after observing stopped', async () => {
    const e = await engine();
    let uploaded = false;
    const result = await e.runner.execute(e.p, {
      attemptId: randomUUID(),
      maintainLease: async () => true,
      transport: {
        download: async () => Buffer.alloc(0),
        upload: async (o, m, b) => {
          expect(
            [...e.containers.values()].every((c) => !c.State.Running),
          ).toBe(true);
          expect(b).toEqual(e.bytes);
          uploaded = true;
          return { ...o, ...m, collected: true };
        },
      },
    });
    expect(result).toMatchObject({
      stopped: true,
      reason: 'exited',
      exitCode: 0,
    });
    expect(uploaded).toBe(true);
    const create = e.requests.find(
      (r) =>
        r.path.includes('/containers/create?') && r.body?.HostConfig.Mounts,
    )!;
    expect(create.body!.HostConfig).toMatchObject({
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'KILL'],
    });
    expect(create.body!.HostConfig.Mounts).toEqual([
      {
        Type: 'volume',
        Source: expect.any(String),
        Target: '/tmp/work',
        ReadOnly: false,
      },
    ]);
    const input = e.requests.find((r) => r.method === 'PUT')!.data!;
    expect(input.includes(Buffer.from(e.p.arguments.script))).toBe(true);
  });
  it('a cancellation while start is in flight waits, kills that container and proves stopped without upload', async () => {
    const cancel = new AbortController(),
      e = await engine({ cancelStart: cancel });
    let uploads = 0;
    const result = await e.runner.execute(e.p, {
      attemptId: randomUUID(),
      signal: cancel.signal,
      maintainLease: async () => true,
      transport: {
        download: async () => Buffer.alloc(0),
        upload: async () => {
          uploads++;
          throw Error('unexpected');
        },
      },
    });
    expect(result).toMatchObject({ stopped: true, reason: 'canceled' });
    expect(uploads).toBe(0);
    expect(e.requests.filter((r) => r.path.includes('/kill?'))).toHaveLength(1);
    expect([...e.containers.values()].every((c) => !c.State.Running)).toBe(
      true,
    );
  });
  it('server cancellation aborts a stalled input byte read before creating any tenant container', async () => {
    const e = await engine();
    let checks = 0;
    e.p.arguments.inputs = [
      {
        path: '慢 数据.csv',
        objectId: randomUUID(),
        checksum: hash(Buffer.from('input')),
        sizeBytes: 5,
        mediaType: 'text/csv',
      },
    ];
    await expect(
      e.runner.execute(e.p, {
        attemptId: randomUUID(),
        maintainLease: async () => ++checks < 2,
        transport: {
          download: async (_input, signal) =>
            new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              }),
            ),
          upload: async () => {
            throw Error('unexpected');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_REVOKED' });
    expect(e.requests.some((r) => r.path.endsWith('/volumes/create'))).toBe(
      false,
    );
    expect(
      e.requests.some(
        (r) =>
          r.path.includes('/containers/create?') && r.body?.HostConfig.Mounts,
      ),
    ).toBe(false);
  });
  it('collects a successful checkpoint when legal control-character stdout expands beyond 200 KB in JSON', async () => {
    const stdout = '\0'.repeat(65_536),
      e = await engine({ stdout });
    e.p.arguments.limits.outputBytes = 65_536;
    const result = await e.runner.execute(e.p, {
      attemptId: randomUUID(),
      maintainLease: async () => true,
      transport: {
        download: async () => Buffer.alloc(0),
        upload: async (o, m, b) => {
          expect(b).toEqual(e.bytes);
          return { ...o, ...m, collected: true };
        },
      },
    });
    expect(result).toMatchObject({
      stopped: true,
      exitCode: 0,
      reason: 'exited',
      stdout,
    });
    expect(result.artifacts).toHaveLength(1);
  });
  it('a changed artifact or lost upload leaves retained container evidence unknown, never reruns', async () => {
    const e = await engine({ corrupt: true }),
      attempt = randomUUID();
    await expect(
      e.runner.execute(e.p, {
        attemptId: attempt,
        maintainLease: async () => true,
        transport: {
          download: async () => Buffer.alloc(0),
          upload: async () => {
            throw Error('should not upload');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'PYTHON_RESULT_UNKNOWN' });
    const starts = e.requests.filter((r) => r.path.endsWith('/start')).length;
    await expect(e.runner.recover(attempt, e.p)).rejects.toMatchObject({
      code: 'PYTHON_RESULT_UNKNOWN',
    });
    expect(e.requests.filter((r) => r.path.endsWith('/start'))).toHaveLength(
      starts,
    );
    expect(
      [...e.containers.values()].some(
        (c) => c.Name === `allrice-python-${attempt}`,
      ),
    ).toBe(true);
  });
  it('fixed VM flags/config and process environment cannot adopt home mounts or the user Docker context', () => {
    expect(managedSandboxStartArguments('/private/guest', 'x86_64')).toEqual(
      expect.arrayContaining([
        '--mount',
        'none',
        '--activate=false',
        '--cpus',
        '2',
        '--memory',
        '2',
      ]),
    );
    const env = managedSandboxEnvironment('/private/owned', '/private/tools');
    expect(env.COLIMA_HOME).toBe('/private/owned/c');
    expect(env.DOCKER_CONFIG).toBe('/private/owned/docker-config');
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(() =>
      assertManagedSandboxConfiguration(
        'mounts: []\nvmType: vz\ncpus: 2\nmemory: 2GiB\n',
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedSandboxConfiguration(
        'vmType: vz\ncpus: 2\nmemory: 2048MiB\nssh:\n  forwardAgent: false\n',
      ),
    ).not.toThrow();
    expect(() =>
      assertManagedSandboxConfiguration(
        'mounts:\n- location: /Users/fixture\nvmType: vz\ncpus: 2\nmemory: 2GiB\n',
      ),
    ).toThrow();
    expect(() =>
      assertManagedSandboxConfiguration(
        'mounts: [{location: /Users/fixture}]\nvmType: vz\ncpus: 2\nmemory: 2048MiB\n',
      ),
    ).toThrow();
  });
  it('binds a long Application Support configuration to short private sockets and refuses an oversized UID path', () => {
    const config = {
      server: 'https://synthetic.invalid',
      deviceId: randomUUID(),
      deviceName: 'Synthetic',
      grants: [],
    };
    const path =
      '/Users/synthetic/Library/Application Support/'.repeat(5) +
      'Rice Bridge/config.json';
    const home = managedSandboxVMHome(config, path);
    expect(
      Buffer.byteLength(
        join(
          home,
          'c',
          '_lima',
          `colima-${managedSandboxProfile}`,
          'ssh.sock.1234567890123456',
        ),
      ),
    ).toBeLessThan(104);
    expect(managedSandboxVMHome(config, path)).toBe(home);
    expect(
      managedSandboxVMHome({ ...config, deviceId: randomUUID() }, path),
    ).not.toBe(home);
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(4_294_967_295);
    try {
      expect(() => managedSandboxVMHome(config, path)).toThrow(
        'RUNTIME_SOCKET_PATH_TOO_LONG',
      );
    } finally {
      uid.mockRestore();
    }
  });
  it('download hash mismatch and midstream cancel never activate partial bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-python-download-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const server = httpServer((_req, res) => {
      res.write(Buffer.from('wrong'));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    const address = server.address() as { port: number },
      path = join(root, 'payload'),
      cancel = new AbortController();
    const promise = downloadManagedRuntimeAsset(
      path,
      {
        fileName: 'payload',
        url: `http://127.0.0.1:${address.port}/payload`,
        sizeBytes: 100,
        sha256: 'a'.repeat(64),
      },
      cancel.signal,
    );
    setTimeout(() => cancel.abort(), 30);
    await expect(promise).rejects.toThrow();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
