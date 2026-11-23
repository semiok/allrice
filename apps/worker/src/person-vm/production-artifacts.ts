import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { readProductionHostConfiguration } from './production-config.js';

export class ProductionPersonVmArtifactsUnavailable extends Error {
  constructor() {
    super('PERSON_VM_ARTIFACTS_UNAVAILABLE');
  }
}

/** The expected hashes must come from the existing verified service seal.
 * This reads actual artifact bytes; no artifact, provider or process is launched.
 * The trusted operator owns these installed files, as for the readonly publisher. */
export async function readVerifiedProductionPersonVmInputs(
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const loaded = await readProductionHostConfiguration(signal);
  for (const name of ['binary', 'libkrunfw', 'agentd'] as const) {
    signal.throwIfAborted();
    try {
      const file = await open(
        loaded.configuration.native[name],
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let checksum: string;
      try {
        signal.throwIfAborted();
        const stat = await file.stat();
        signal.throwIfAborted();
        if (!stat.isFile()) throw new ProductionPersonVmArtifactsUnavailable();
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let size = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          signal.throwIfAborted();
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
          size += bytesRead;
        }
        if (size !== stat.size)
          throw new ProductionPersonVmArtifactsUnavailable();
        checksum = 'sha256:' + hash.digest('hex');
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      if (checksum !== loaded.configuration.native.artifactChecksums[name])
        throw new ProductionPersonVmArtifactsUnavailable();
    } catch {
      signal.throwIfAborted();
      throw new ProductionPersonVmArtifactsUnavailable();
    }
  }
  signal.throwIfAborted();
  return loaded;
}
