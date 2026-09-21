import { createHash, randomUUID } from 'node:crypto';
import {
  RuntimeLocalCommandSchema,
  type ChangesetDocument,
} from '@allrice/contracts';
import { testImage } from './toolchain.js';

export const checksum = (text: string) =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;
export const side = (text: string | null) =>
  text === null ? null : { text, checksum: checksum(text) };
export const change = (
  path: string,
  before: string | null,
  after: string | null,
) => ({ path, before: side(before), after: side(after) });
export function candidateCommand(
  files: ChangesetDocument['files'],
  base = [{ path: 'test.mjs', sha256: checksum('throw Error("old source");') }],
) {
  const grantId = randomUUID();
  const content = JSON.stringify({
    contractVersion: 1,
    comparisonScope: 'changeset',
    execution: {
      targetId: randomUUID(),
      targetKind: 'rice_bridge',
      deviceId: randomUUID(),
      grantId,
      grantVersion: 1,
      scopeDigest: checksum('fixture'),
      workCopy: { id: grantId, kind: 'in_place' },
    },
    files,
  });
  return RuntimeLocalCommandSchema.parse({
    capability: 'local.process.execute',
    arguments: {
      executable: '/usr/local/bin/node',
      args: ['test.mjs'],
      path: '.',
      files: base,
      candidate: {
        artifactId: randomUUID(),
        checksum: checksum(content),
        content,
      },
      imageDigest: testImage,
      isolation: 'local-vm-container-v1',
      network: 'none',
      limits: {
        timeoutMs: 10000,
        outputBytes: 8192,
        memoryMiB: 128,
        cpuMillis: 500,
        pids: 32,
      },
    },
  });
}
