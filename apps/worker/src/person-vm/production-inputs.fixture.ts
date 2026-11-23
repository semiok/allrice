/** Synthetic seal boundary and real private files for H2 component tests only. */
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPlatformPersonVmConfiguration } from '@allrice/contracts';
import type {
  ProductionHostConfiguration,
  readProductionHostConfiguration,
} from './production-config.ts';

export async function productionInputsFixture() {
  // Sibling socket/disk/key roots remain private to this short random root.
  // Keep /tmp spelling: the provider checks this literal socket path.
  const root = await mkdtemp('/tmp/h');
  const hash = '1'.repeat(64);
  const native = {
    binary: join(root, 'msb'),
    libkrunfw: join(root, 'libkrunfw'),
    agentd: join(root, 'agentd'),
  };
  const artifactChecksums = { binary: '', libkrunfw: '', agentd: '' };
  for (const name of ['binary', 'libkrunfw', 'agentd'] as const) {
    const bytes = Buffer.from(name.repeat(70000));
    await writeFile(native[name], bytes);
    artifactChecksums[name] =
      'sha256:' + createHash('sha256').update(bytes).digest('hex');
  }
  const platform = readPlatformPersonVmConfiguration();
  const configuration: ProductionHostConfiguration = {
    version: 1,
    native: {
      ...native,
      artifactChecksums,
      image: `example.test/synthetic-image@sha256:${hash}`,
      readonlyDshDirectory: {
        descriptorPath: join(root, hash, 'descriptor.json'),
        hostDirectory: join(root, hash, 'public'),
        guestDirectory: `/opt/allrice/dsh/${hash}`,
        artifactSha256: hash,
        manifestSha256: hash,
        sealedManifestSha256: hash,
        treeSha256: hash,
      },
      rootDiskGiB: 8,
      socketRoot: join(root, 's'),
      jobCleanupTimeoutMs: 10000,
    },
    disk: {
      root: join(root, 'disks'),
      keyRoot: join(root, 'keys'),
      capacityGiB: 8,
    },
    memory: {
      persistentDirectory: '/work',
      policyRef: 'synthetic-source-not-a-production-policy',
      policy: {
        physicalBytes: platform.memoryMiB * 1024 ** 2,
        swapBytes: 64,
        dshLowBytes: 1,
        dshSwapMaxBytes: 1,
        commandHighBytes: 1,
        commandMaxBytes: 2,
        commandSwapMaxBytes: 1,
        commandOomGroup: 0,
        dshOomScoreAdj: -1,
        commandOomScoreAdj: 1,
      },
    },
    web: {
      cliPath: `/opt/allrice/dsh/${hash}/cli.mjs`,
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
  const loaded: Awaited<ReturnType<typeof readProductionHostConfiguration>> = {
    configuration,
    platform,
    applicationBuild: Object.freeze({
      sourceSha: 'a'.repeat(40),
      sourceTree: 'b'.repeat(40),
      manifestDigest: `sha256:${hash}`,
    }),
  };
  return { root, loaded };
}
