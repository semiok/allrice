import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageObject, StoragePort } from '@allrice/contracts';
import { readArtifactBytes, parseChangesetBytes } from './artifact-review.ts';

const content = Buffer.from('first\nsecond');
const object: StorageObject = {
  id: randomUUID(),
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  ownerId: randomUUID(),
  key: 'fixture/review.txt',
  sizeBytes: content.length,
  mediaType: 'text/plain',
  checksum: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  retentionUntil: null,
  deletedAt: null,
  immutable: true,
};
function storage(bytes = content): StoragePort {
  return {
    put: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
    get: vi.fn(async () => new Blob([bytes]).stream()),
  };
}
describe('bounded immutable preview content', () => {
  afterEach(() => vi.useRealTimers());
  it('verifies byte size and checksum after reading storage', async () => {
    expect(await readArtifactBytes(storage(), object)).toEqual(content);
    await expect(
      readArtifactBytes(storage(Buffer.from('other content')), object),
    ).rejects.toThrow('content_changed');
    await expect(
      readArtifactBytes(storage(), {
        ...object,
        checksum: `sha256:${'a'.repeat(64)}`,
      }),
    ).rejects.toThrow('content_changed');
  });
  it('refuses large previews before IO and does not trust a small declared length', async () => {
    const port = storage();
    await expect(
      readArtifactBytes(port, { ...object, sizeBytes: 512_001 }),
    ).rejects.toThrow('preview_too_large');
    expect(port.get).not.toHaveBeenCalled();
    await expect(
      readArtifactBytes(storage(Buffer.alloc(600_000)), object),
    ).rejects.toThrow('content_changed');
  });
  it('ends slow storage operations by absolute deadline and cancels an open stream', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(),
      port = storage();
    port.get = async () => new ReadableStream({ cancel });
    const rejected = expect(readArtifactBytes(port, object)).rejects.toThrow(
      'preview_timeout',
    );
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not parse oversized, binary or malformed Changesets', () => {
    for (const bytes of [
      Buffer.alloc(512_001),
      Buffer.from([255]),
      Buffer.from('{}'),
      Buffer.from('not-json'),
    ])
      expect(() => parseChangesetBytes(bytes)).toThrow();
  });
});
