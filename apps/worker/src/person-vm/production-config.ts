import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join, normalize, posix, sep } from 'node:path';
import {
  readServiceBuildIdentity,
  ServiceBuildManifestSchema,
} from '@allrice/database';
import { readPlatformPersonVmConfiguration } from '@allrice/contracts';
import { z } from 'zod';

const configPath = '.local/person-vm-host.json';
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const bareHash = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z
  .string()
  .refine(
    (path) =>
      isAbsolute(path) &&
      normalize(path) === path &&
      path !== '/' &&
      !path.includes('\0'),
  );
const guestPath = z
  .string()
  .refine(
    (path) =>
      posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      path !== '/' &&
      !path.includes('\0'),
  );
const positive = z.number().int().positive().safe();
const bytes = z.number().int().nonnegative().safe();
const score = z.number().int().min(-1000).max(1000);
const configuration = z
  .object({
    version: z.literal(1),
    native: z
      .object({
        binary: absolute,
        libkrunfw: absolute,
        agentd: absolute,
        artifactChecksums: z
          .object({ binary: checksum, libkrunfw: checksum, agentd: checksum })
          .strict(),
        image: z.string().regex(/^\S+@sha256:[a-f0-9]{64}$/),
        readonlyDshDirectory: z
          .object({
            descriptorPath: absolute,
            hostDirectory: absolute,
            guestDirectory: guestPath,
            artifactSha256: bareHash,
            manifestSha256: bareHash,
            sealedManifestSha256: bareHash,
            treeSha256: bareHash,
          })
          .strict(),
        rootDiskGiB: positive,
        socketRoot: absolute,
        jobCleanupTimeoutMs: positive,
      })
      .strict(),
    disk: z
      .object({ root: absolute, keyRoot: absolute, capacityGiB: positive })
      .strict(),
    memory: z
      .object({
        persistentDirectory: guestPath,
        policyRef: z.string().trim().min(1),
        policy: z
          .object({
            physicalBytes: positive,
            swapBytes: positive,
            dshLowBytes: bytes,
            dshSwapMaxBytes: bytes,
            commandHighBytes: bytes,
            commandMaxBytes: bytes,
            commandSwapMaxBytes: bytes,
            commandOomGroup: z.literal(0),
            dshOomScoreAdj: score,
            commandOomScoreAdj: score,
          })
          .strict()
          .refine(
            (policy) => policy.commandHighBytes <= policy.commandMaxBytes,
          ),
      })
      .strict(),
    web: z
      .object({
        cliPath: guestPath,
        guestAddress: z
          .string()
          .refine(
            (value) => isIP(value) !== 0 && !['0.0.0.0', '::'].includes(value),
          ),
        startupTimeoutMs: positive,
        publicOrigin: z.string().refine((value) => {
          try {
            const url = new URL(value);
            return (
              ['http:', 'https:'].includes(url.protocol) &&
              url.origin === value &&
              !url.username &&
              !url.password
            );
          } catch {
            return false;
          }
        }),
      })
      .strict(),
    lifecycle: z
      .object({
        leaseTtlMs: positive,
        activityMaxAgeMs: positive,
        cleanupTimeoutMs: positive,
      })
      .strict(),
  })
  .strict()
  .refine((value) => {
    const platform = readPlatformPersonVmConfiguration();
    const policy = value.memory.policy;
    return (
      policy.commandHighBytes === platform.commandHighBytes &&
      policy.commandMaxBytes === platform.commandMaxBytes &&
      policy.commandSwapMaxBytes === platform.commandSwapMaxBytes
    );
  })
  .refine((value) => {
    const roots = [
      value.disk.root,
      value.disk.keyRoot,
      value.native.socketRoot,
    ];
    if (
      value.memory.policy.physicalBytes !==
      readPlatformPersonVmConfiguration().memoryMiB * 1024 ** 2
    )
      return false;
    return roots.every((root, i) =>
      roots.every(
        (other, j) =>
          i === j || (root !== other && !root.startsWith(other + sep)),
      ),
    );
  });

export type ProductionHostConfiguration = z.infer<typeof configuration>;
export class ProductionHostConfigurationUnavailable extends Error {
  constructor() {
    super('PERSON_VM_HOST_CONFIGURATION_UNAVAILABLE');
  }
}
const digest = (value: Buffer | string) =>
  'sha256:' + createHash('sha256').update(value).digest('hex');
function unavailable(): never {
  throw new ProductionHostConfigurationUnavailable();
}

/** Fixed private release file, authenticated by the existing service seal.
 * This returns configuration, not an artifact/readiness/permission receipt.
 * No env/RC/request override, phase4 policy, path or Linux hash fallback exists. */
export async function readProductionHostConfiguration(signal: AbortSignal) {
  signal.throwIfAborted();
  const build = await readServiceBuildIdentity('worker');
  signal.throwIfAborted();
  if (!build || build.service !== 'worker' || build.mode !== 'production')
    unavailable();
  try {
    if (!process.argv[1]) unavailable();
    const entrypoint = await realpath(process.argv[1]);
    signal.throwIfAborted();
    const ending = '/apps/worker/dist/index.js';
    if (!entrypoint.endsWith(ending)) unavailable();
    const root = entrypoint.slice(0, -ending.length);
    const manifest = ServiceBuildManifestSchema.parse(
      JSON.parse(
        await readFile(join(root, '.local/dev-build-identity.json'), 'utf8'),
      ),
    );
    signal.throwIfAborted();
    const { manifestDigest, ...body } = manifest;
    if (
      digest(JSON.stringify(body)) !== manifestDigest ||
      manifestDigest !== build.manifestDigest ||
      body.sourceSha !== build.sourceSha ||
      body.sourceTree !== build.sourceTree
    )
      unavailable();
    const selected = manifest.files.filter((file) => file.path === configPath);
    const expected = selected[0];
    if (selected.length !== 1 || !expected || expected.scope !== 'worker')
      unavailable();
    const file = await open(
      join(root, configPath),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let value: ProductionHostConfiguration;
    try {
      signal.throwIfAborted();
      const stat = await file.stat();
      signal.throwIfAborted();
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.() ||
        stat.size !== expected.bytes
      )
        unavailable();
      const contents = await file.readFile();
      signal.throwIfAborted();
      if (
        contents.length !== expected.bytes ||
        digest(contents) !== expected.checksum
      )
        unavailable();
      value = configuration.parse(JSON.parse(contents.toString('utf8')));
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    return Object.freeze({
      configuration: value,
      platform: readPlatformPersonVmConfiguration(),
      applicationBuild: Object.freeze({
        sourceSha: build.sourceSha,
        sourceTree: build.sourceTree,
        manifestDigest,
      }),
    });
  } catch {
    signal.throwIfAborted();
    unavailable();
  }
}
