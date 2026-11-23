/** Synthetic seal/source double and real private files; no native artifacts run. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { readPlatformPersonVmConfiguration } from '@allrice/contracts';
import type { ServiceBuildIdentity } from '@allrice/database';
import { productionInputsFixture } from './production-inputs.fixture.js';

const source = vi.hoisted<{
  build: ReturnType<typeof vi.fn>;
  opened?: (file: FileHandle) => void;
}>(() => ({ build: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const file = await actual.open(...args);
      source.opened?.(file);
      return file;
    },
  };
});
vi.mock('@allrice/database', async () => ({
  readServiceBuildIdentity: source.build,
  ServiceBuildManifestSchema: (
    await import('../../../../packages/database/src/service-build-identity.ts')
  ).ServiceBuildManifestSchema,
}));
import {
  ProductionHostConfigurationUnavailable,
  readProductionHostConfiguration,
} from './production-config.ts';

const digest = (value: string | Buffer) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
const hash = '1'.repeat(64);
let root: string, originalArgv: string[];
let build: ServiceBuildIdentity;
const signal = () => new AbortController().signal;
function value() {
  return {
    version: 1,
    native: {
      binary: join(root, 'artifacts/msb'),
      libkrunfw: join(root, 'artifacts/libkrunfw'),
      agentd: join(root, 'artifacts/agentd'),
      artifactChecksums: {
        binary: `sha256:${hash}`,
        libkrunfw: `sha256:${hash}`,
        agentd: `sha256:${hash}`,
      },
      image: `example.test/synthetic-linux@sha256:${hash}`,
      readonlyDshDirectory: {
        descriptorPath: join(root, 'artifacts/descriptor.json'),
        hostDirectory: join(root, 'artifacts/dsh'),
        guestDirectory: '/opt/allrice/dsh/synthetic',
        artifactSha256: hash,
        manifestSha256: hash,
        sealedManifestSha256: hash,
        treeSha256: hash,
      },
      rootDiskGiB: 8,
      socketRoot: join(root, 'private/sockets'),
      jobCleanupTimeoutMs: 10000,
    },
    disk: {
      root: join(root, 'private/disks'),
      keyRoot: join(root, 'private/keys'),
      capacityGiB: 8,
    },
    memory: {
      persistentDirectory: '/work',
      policyRef: 'synthetic-explicit-policy-not-platform-approval',
      policy: {
        physicalBytes: 2048 * 1024 ** 2,
        swapBytes: 64,
        dshLowBytes: 1,
        dshSwapMaxBytes: 1,
        commandHighBytes: readPlatformPersonVmConfiguration().commandHighBytes,
        commandMaxBytes: readPlatformPersonVmConfiguration().commandMaxBytes,
        commandSwapMaxBytes:
          readPlatformPersonVmConfiguration().commandSwapMaxBytes,
        commandOomGroup: 0,
        dshOomScoreAdj: -1,
        commandOomScoreAdj: 1,
      },
    },
    web: {
      cliPath: '/opt/allrice/dsh/synthetic/cli.mjs',
      guestAddress: '127.0.0.1',
      startupTimeoutMs: 10000,
      publicOrigin: 'https://example.test',
    },
    lifecycle: {
      leaseTtlMs: 30000,
      activityMaxAgeMs: 10000,
      cleanupTimeoutMs: 10000,
    },
  };
}
async function seal(config: unknown = value(), include = true) {
  const contents = JSON.stringify(config);
  await fs.writeFile(join(root, '.local/person-vm-host.json'), contents, {
    mode: 0o600,
  });
  const files = [
    {
      path: 'apps/worker/dist/index.js',
      scope: 'worker',
      checksum: digest('worker'),
      bytes: 6,
    },
    {
      path: 'apps/web/server.mjs',
      scope: 'web',
      checksum: digest('web'),
      bytes: 3,
    },
    {
      path: 'packages/database/dist/index.js',
      scope: 'graph',
      checksum: digest('db'),
      bytes: 2,
    },
    { path: 'package.json', scope: 'graph', checksum: digest('{}'), bytes: 2 },
    ...(include
      ? [
          {
            path: '.local/person-vm-host.json',
            scope: 'worker',
            checksum: digest(contents),
            bytes: Buffer.byteLength(contents),
          },
        ]
      : []),
  ];
  const body = {
    version: 1,
    environment: 'dev',
    repository: 'semiok/allrice',
    sourceSha: 'a'.repeat(40),
    sourceTree: 'b'.repeat(40),
    webBuildId: 'synthetic-build',
    protocols: {
      identity: 1,
      ordinaryConsumer: 1,
      releaseAdmission: 'disabled',
    },
    files,
    workspaceEdges: [],
    nextExternalAliases: [],
  };
  const manifest = { ...body, manifestDigest: digest(JSON.stringify(body)) };
  await fs.writeFile(
    join(root, '.local/dev-build-identity.json'),
    JSON.stringify(manifest),
    { mode: 0o600 },
  );
  build = {
    version: 1,
    environment: 'dev',
    service: 'worker',
    mode: 'production',
    sourceSha: body.sourceSha,
    sourceTree: body.sourceTree,
    manifestDigest: manifest.manifestDigest,
    artifactDigest: digest('synthetic-artifact'),
    runtimeGraphDigest: digest('synthetic-graph'),
    webBuildId: body.webBuildId,
    bootId: '00000000-0000-4000-8000-000000000001',
    pid: 1,
    startedAt: '2026-11-22T00:00:00Z',
    nodeVersion: 'synthetic-version',
    protocols: {
      identity: 1,
      ordinaryConsumer: 1,
      releaseAdmission: 'disabled',
    },
  };
  source.build.mockResolvedValue(build);
  return manifest;
}
beforeEach(async () => {
  source.opened = undefined;
  vi.resetAllMocks();
  originalArgv = process.argv;
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'person-vm-host-config-')),
  );
  await fs.mkdir(join(root, 'apps/worker/dist'), { recursive: true });
  await fs.mkdir(join(root, '.local'), { mode: 0o700 });
  await fs.writeFile(join(root, 'apps/worker/dist/index.js'), 'worker');
  process.argv = [
    originalArgv[0] ?? 'node',
    join(root, 'apps/worker/dist/index.js'),
  ];
  await seal();
});
afterEach(async () => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('private production Host configuration', () => {
  it.each([
    '0.0.0.0',
    '::',
    '0:0:0:0:0:0:0:0',
    '0000:0000:0000:0000:0000:0000:0000:0000',
    '0::0',
    '::0.0.0.0',
    '0:0:0:0:0:0:0.0.0.0',
    '::%lo0',
  ])(
    'rejects unspecified egress address %s in either field through the real sealed reader',
    async (address) => {
      for (const field of ['listenAddress', 'guestGatewayAddress'] as const) {
        const egress = {
          listenAddress: '127.0.0.1',
          guestGatewayAddress: '127.0.0.1',
        };
        egress[field] = address;
        await seal({ ...value(), egress });
        await expect(
          readProductionHostConfiguration(signal()),
        ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
      }
    },
  );
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '203.0.113.9',
    '::1',
    '0:0:0:0:0:0:0:1',
    '2001:db8::1',
    'fe80::1%en0',
    '::ffff:192.0.2.1',
    '::ffff:0.0.0.0',
  ])(
    'preserves valid egress address %s through the real sealed reader without another network policy',
    async (address) => {
      const egress = {
        listenAddress: address,
        guestGatewayAddress: address,
      };
      await seal({ ...value(), egress });
      expect(
        (await readProductionHostConfiguration(signal())).configuration.egress,
      ).toEqual(egress);
    },
  );
  it('accepts the H2 component fixture through the real private configuration reader', async () => {
    const f = await productionInputsFixture();
    try {
      await seal(f.loaded.configuration);
      const result = await readProductionHostConfiguration(signal());
      expect(result.configuration).toEqual(f.loaded.configuration);
      expect(result.platform).toBe(f.loaded.platform);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });
  it('reads only exact measured bytes after the original build verifier succeeds', async () => {
    const result = await readProductionHostConfiguration(signal());
    expect(result.configuration).toEqual(value());
    expect(result.platform).toBe(readPlatformPersonVmConfiguration());
    expect(result.configuration.memory.policy.physicalBytes).toBe(
      result.platform.memoryMiB * 1024 ** 2,
    );
    expect(result.applicationBuild).toEqual({
      sourceSha: build.sourceSha,
      sourceTree: build.sourceTree,
      manifestDigest: build.manifestDigest,
    });
    expect(source.build).toHaveBeenCalledWith('worker');
    expect(result).not.toHaveProperty('verified');
    expect(result).not.toHaveProperty('ready');
  });
  it('rejects a measured guest physical policy that differs from the platform cap without overwriting it', async () => {
    const input = value();
    input.memory.policy.physicalBytes = 3 * 1024 ** 3;
    await seal(input);
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
    expect(
      JSON.parse(
        await fs.readFile(join(root, '.local/person-vm-host.json'), 'utf8'),
      ).memory.policy.physicalBytes,
    ).toBe(input.memory.policy.physicalBytes);
    expect(readPlatformPersonVmConfiguration().memoryMiB).toBe(2 * 1024);
  });
  it.each([
    'commandHighBytes',
    'commandMaxBytes',
    'commandSwapMaxBytes',
  ] as const)(
    'rejects a correctly sealed command policy %s that differs from platform defaults',
    async (field) => {
      const input = value();
      input.memory.policy[field] += field === 'commandMaxBytes' ? 1 : -1;
      await seal(input);
      await expect(
        readProductionHostConfiguration(signal()),
      ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
      expect(
        JSON.parse(
          await fs.readFile(join(root, '.local/person-vm-host.json'), 'utf8'),
        ).memory.policy[field],
      ).toBe(input.memory.policy[field]);
    },
  );
  it.each([
    'commandHighBytes',
    'commandMaxBytes',
    'commandSwapMaxBytes',
  ] as const)(
    'rejects an absent sealed command policy %s without filling a default',
    async (field) => {
      const input = value();
      expect(Reflect.deleteProperty(input.memory.policy, field)).toBe(true);
      await seal(input);
      await expect(
        readProductionHostConfiguration(signal()),
      ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
      expect(
        JSON.parse(
          await fs.readFile(join(root, '.local/person-vm-host.json'), 'utf8'),
        ).memory.policy,
      ).not.toHaveProperty(field);
    },
  );
  it('does not accept private JSON or claimed env SHA without a verified service build', async () => {
    source.build.mockResolvedValue(null);
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('keeps the missing configuration default closed instead of inventing values', async () => {
    await fs.unlink(join(root, '.local/person-vm-host.json'));
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('requires this exact file in the existing seal rather than trusting its self-description', async () => {
    await seal(value(), false);
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('rejects a changed private configuration even when the new JSON remains valid', async () => {
    const changed = value();
    changed.web.publicOrigin = 'https://other.example.test';
    await fs.writeFile(
      join(root, '.local/person-vm-host.json'),
      JSON.stringify(changed),
    );
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('rejects a rewritten self-signed manifest that is not the verified build identity', async () => {
    const verified = build;
    const changed = value();
    changed.lifecycle.cleanupTimeoutMs += 1;
    await seal(changed);
    source.build.mockResolvedValue(verified);
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it.each(['sourceSha', 'sourceTree'] as const)(
    'rejects a different trusted build %s',
    async (field) => {
      source.build.mockResolvedValue({ ...build, [field]: 'f'.repeat(40) });
      await expect(
        readProductionHostConfiguration(signal()),
      ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
    },
  );
  it('cannot read a source entrypoint as a sealed production Worker', async () => {
    const file = join(root, 'worker-source.ts');
    await fs.writeFile(file, 'source');
    process.argv = [originalArgv[0] ?? 'node', file];
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('rejects a symlink instead of following a private configuration alias', async () => {
    const target = join(root, 'elsewhere.json');
    await fs.rename(join(root, '.local/person-vm-host.json'), target);
    await fs.symlink(target, join(root, '.local/person-vm-host.json'));
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('requires the private file permission, including for checksum-correct bytes', async () => {
    await fs.chmod(join(root, '.local/person-vm-host.json'), 0o644);
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('does not fill absent memory policy, artifact pins or ingress from a fixture/default', async () => {
    for (const changed of [
      { ...value(), memory: null },
      {
        ...value(),
        native: { ...value().native, artifactChecksums: undefined },
      },
      { ...value(), web: { ...value().web, publicOrigin: undefined } },
    ]) {
      await seal(changed);
      await expect(
        readProductionHostConfiguration(signal()),
      ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
    }
  });
  it('does not allow request identity or runtime enables in the deployment schema', async () => {
    await seal({ ...value(), personId: 'browser-claim', enabled: true });
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('keeps keys, disk and sockets in independent private roots', async () => {
    const changed = value();
    changed.disk.keyRoot = join(changed.disk.root, 'keys');
    await seal(changed);
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('rejects an invalid guest policy and credential-bearing ingress', async () => {
    const changed = value();
    changed.memory.policy.commandHighBytes =
      changed.memory.policy.commandMaxBytes + 1;
    changed.web.publicOrigin = 'https://private:credential@example.test';
    await seal(changed);
    await expect(
      readProductionHostConfiguration(signal()),
    ).rejects.toBeInstanceOf(ProductionHostConfigurationUnavailable);
  });
  it('withholds validated configuration when cancellation arrives during the actual file close', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let closed = false,
      settled = false;
    let close: MockInstance<FileHandle['close']> | undefined;
    source.opened = (file) => {
      const closeFile = file.close.bind(file);
      close = vi.spyOn(file, 'close').mockImplementation(async () => {
        enter();
        await gate;
        await closeFile();
        closed = true;
      });
    };
    const abort = new AbortController(),
      reason = Error('cancel actual close');
    const outcome = readProductionHostConfiguration(abort.signal).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await entered;
      abort.abort(reason);
      await turn();
      expect(settled).toBe(false);
      expect(closed).toBe(false);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      release();
      expect(await outcome).toBe(reason);
    }
    expect(closed).toBe(true);
  });
  it('joins the actual open/read/close before returning cancellation', async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let close: MockInstance<FileHandle['close']> | undefined;
    source.opened = (file) => {
      const read = file.readFile.bind(file);
      close = vi.spyOn(file, 'close');
      vi.spyOn(file, 'readFile').mockImplementation(async () => {
        enter();
        await gate;
        return read();
      });
    };
    const abort = new AbortController(),
      reason = Error('cancel private read');
    let settled = false;
    const outcome = readProductionHostConfiguration(abort.signal).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await entered;
      abort.abort(reason);
      await turn();
      expect(settled).toBe(false);
      expect(close).not.toHaveBeenCalled();
    } finally {
      release();
      expect(await outcome).toBe(reason);
    }
    expect(close).toHaveBeenCalledOnce();
  });
});
