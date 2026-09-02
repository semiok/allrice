import { createHash } from 'node:crypto';

import type { PromptImageAttachment } from '@allrice/contracts';
import { describe, expect, it, vi } from 'vitest';

import { loadHarnessImages } from './prompt-images.js';

function attachment(input: {
  bytes: Uint8Array;
  checksumBytes?: Uint8Array;
  declaredSize?: number;
}): PromptImageAttachment {
  const checksumBytes = input.checksumBytes ?? input.bytes;
  return {
    fileName: 'chart.png',
    object: {
      id: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      ownerId: '44444444-4444-4444-8444-444444444444',
      key: 'organizations/22222222-2222-4222-8222-222222222222/workspaces/33333333-3333-4333-8333-333333333333/owners/44444444-4444-4444-8444-444444444444/uploads/11111111-1111-4111-8111-111111111111',
      checksum: `sha256:${createHash('sha256').update(checksumBytes).digest('hex')}`,
      mediaType: 'image/png',
      sizeBytes: input.declaredSize ?? input.bytes.byteLength,
      retentionUntil: null,
      deletedAt: null,
      immutable: true,
    },
  };
}

function storageReturning(bytes: Uint8Array) {
  return {
    get: vi.fn().mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    ),
  };
}

describe('loadHarnessImages', () => {
  it('maps immutable bytes to an ordered base64 Harness image', async () => {
    const bytes = new TextEncoder().encode('image-bytes');
    const storage = storageReturning(bytes);

    await expect(
      loadHarnessImages([attachment({ bytes })], { storage }),
    ).resolves.toEqual([
      {
        mediaType: 'image/png',
        data: Buffer.from(bytes).toString('base64'),
        name: 'chart.png',
      },
    ]);
    expect(storage.get).toHaveBeenCalledTimes(1);
  });

  it('rejects a single image above the 20 MiB admission limit before I/O', async () => {
    const bytes = new Uint8Array();
    const storage = storageReturning(bytes);

    await expect(
      loadHarnessImages(
        [attachment({ bytes, declaredSize: 20 * 1024 * 1024 + 1 })],
        { storage },
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_ATTACHMENT_TOO_LARGE' });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('rejects a declared batch above 200 MiB before I/O', async () => {
    const bytes = new Uint8Array();
    const storage = storageReturning(bytes);

    await expect(
      loadHarnessImages(
        [attachment({ bytes, declaredSize: 200 * 1024 * 1024 + 1 })],
        { storage },
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_ATTACHMENT_BATCH_TOO_LARGE' });
    expect(storage.get).not.toHaveBeenCalled();
  });

  it('rejects bytes that no longer match the immutable Run snapshot', async () => {
    const expected = new TextEncoder().encode('expected');
    const actual = new TextEncoder().encode('tampered');
    const storage = storageReturning(actual);

    await expect(
      loadHarnessImages(
        [attachment({ bytes: actual, checksumBytes: expected })],
        { storage },
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_ATTACHMENT_INTEGRITY_FAILED' });
  });
});
