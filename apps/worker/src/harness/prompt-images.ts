import { createHash } from 'node:crypto';

import type { PromptImageAttachment } from '@allrice/contracts';
import { LocalStorageAdapter } from '@allrice/storage';

import { HandlerError } from '../errors.js';
import type { HarnessImageInput } from './adapter.js';

const maximumImageBytes = 20 * 1024 * 1024;
const maximumImageBatchBytes = 200 * 1024 * 1024;

type ImageStorageReader = Pick<LocalStorageAdapter, 'get'>;

async function readImageBytes(
  storage: ImageStorageReader,
  attachment: PromptImageAttachment,
) {
  if (attachment.object.sizeBytes > maximumImageBytes) {
    throw new HandlerError(
      'IMAGE_ATTACHMENT_TOO_LARGE',
      `${attachment.fileName} exceeds the 20 MiB image limit`,
      false,
    );
  }
  const stream = await storage.get(attachment.object);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const checksum = createHash('sha256');
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumImageBytes) {
        throw new HandlerError(
          'IMAGE_ATTACHMENT_TOO_LARGE',
          `${attachment.fileName} exceeds the 20 MiB image limit`,
          false,
        );
      }
      checksum.update(chunk.value);
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const digest = `sha256:${checksum.digest('hex')}`;
  if (
    bytes !== attachment.object.sizeBytes ||
    digest !== attachment.object.checksum
  ) {
    throw new HandlerError(
      'IMAGE_ATTACHMENT_INTEGRITY_FAILED',
      `${attachment.fileName} no longer matches its immutable Run snapshot`,
      false,
    );
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function loadHarnessImages(
  attachments: readonly PromptImageAttachment[],
  options: { storage?: ImageStorageReader; storageRoot?: string } = {},
): Promise<readonly HarnessImageInput[]> {
  const total = attachments.reduce(
    (sum, attachment) => sum + attachment.object.sizeBytes,
    0,
  );
  if (total > maximumImageBatchBytes) {
    throw new HandlerError(
      'IMAGE_ATTACHMENT_BATCH_TOO_LARGE',
      'Image attachments exceed the 200 MiB per-message limit',
      false,
    );
  }
  const storage =
    options.storage ??
    new LocalStorageAdapter(
      options.storageRoot ??
        process.env.ALLRICE_STORAGE_ROOT ??
        '.local/storage',
    );
  return Promise.all(
    attachments.map(async (attachment) => ({
      mediaType: attachment.object.mediaType,
      data: (await readImageBytes(storage, attachment)).toString('base64'),
      name: attachment.fileName,
    })),
  );
}
