import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ReferenceReadImageInputSchema,
  ReferenceImageCallSchema,
  ReferenceImageRouteResultSchema,
  ReferenceImageSaveResultSchema,
  referenceImagePolicy,
  type ReferenceImageAttachment,
  type ReferenceImageError,
} from '@allrice/contracts';
import type { StoragePort } from '@allrice/contracts';
import type { ContentIdentity } from './content-maintenance.ts';
import { getDatabase } from './core/client.ts';
import {
  readReferenceSelection,
  ReferenceRuntimeError,
} from './reference-runtime.ts';
import { inspectReferenceImage } from './reference-image.ts';

/** Private Worker binding, never a model argument or a transferable capability. */
export interface ReferenceImagePort {
  route(): Promise<{ supported: true } | { error: ReferenceImageError }>;
  save(input: {
    data: Buffer;
    mediaType: 'image/png' | 'image/jpeg';
    name: string;
  }): Promise<
    { image: ReferenceImageAttachment } | { error: ReferenceImageError }
  >;
}
export interface ReferenceImageExecution {
  storage: StoragePort;
  native: ReferenceImagePort;
  call: {
    id: string;
    name: 'workspace.reference.read_image';
    nativeSessionId: string;
  };
}
export class ReferenceImageReadError extends Error {
  readonly code: ReferenceImageError['code'];
  readonly reason: ReferenceImageError['reason'];
  readonly retryable: boolean;
  constructor(value: ReferenceImageError) {
    super(value.message);
    this.code = value.code;
    this.reason = value.reason;
    this.retryable = value.retryable;
  }
}
export function referenceImageLimit(
  reason: ReferenceImageError['reason'],
  message: string,
): never {
  throw new ReferenceImageReadError({
    code: 'REFERENCE_READ_LIMIT',
    reason,
    message,
    retryable: false,
  });
}
export function checkReferenceImageSignal(signal: AbortSignal) {
  if (
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError'
  )
    throw new ReferenceImageReadError({
      code: 'REFERENCE_READ_TIMEOUT',
      reason: 'operation_budget',
      message: '本次图片读取超过时限，未自动重试。',
      retryable: true,
    });
  signal.throwIfAborted();
}
export async function requireReferenceImagePin(
  reader: ContentIdentity,
  input: unknown,
  sql: Parameters<typeof readReferenceSelection>[2],
  lock: boolean,
) {
  const pin = ReferenceReadImageInputSchema.parse(input);
  const current = await readReferenceSelection(
    reader,
    pin.revisionId,
    sql,
    lock,
    undefined,
    'image',
  );
  if (
    !isDeepStrictEqual(
      ReferenceReadImageInputSchema.parse({
        sourceId: current.selection.sourceId,
        revisionId: current.selection.revisionId,
        digest: current.selection.digest,
        checksum: current.selection.checksum,
      }),
      pin,
    )
  )
    throw new ReferenceRuntimeError();
  return current;
}

/** Storage I/O and native transforms never run under content/admission locks. */
export async function prepareReferenceImage(
  reader: ContentIdentity,
  input: unknown,
  execution: ReferenceImageExecution,
  signal: AbortSignal,
) {
  ReferenceImageCallSchema.parse(execution.call);
  const current = await requireReferenceImagePin(
    reader,
    input,
    getDatabase(),
    false,
  );
  checkReferenceImageSignal(signal);
  const route = ReferenceImageRouteResultSchema.parse(
    await execution.native.route(),
  );
  if ('error' in route) throw new ReferenceImageReadError(route.error);
  checkReferenceImageSignal(signal);
  if (current.object.sizeBytes > referenceImagePolicy.maximumBytes)
    referenceImageLimit('image_bytes', '图片原件超过 20 MiB，无法读取。');
  const stream = (await execution.storage.get(current.object)).getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const cancel = () => {
    void stream.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    for (;;) {
      checkReferenceImageSignal(signal);
      const chunk = await stream.read();
      checkReferenceImageSignal(signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > referenceImagePolicy.maximumBytes)
        referenceImageLimit('image_bytes', '图片原件超过 20 MiB，无法读取。');
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await stream.cancel().catch(() => {});
    stream.releaseLock();
  }
  const data = Buffer.concat(chunks, bytes);
  if (
    bytes !== current.object.sizeBytes ||
    'sha256:' + createHash('sha256').update(data).digest('hex') !==
      current.selection.checksum
  )
    throw new ReferenceRuntimeError();
  const png = data
    .subarray(0, 8)
    .equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = data.length >= 2 && data.readUInt16BE(0) === 0xffd8;
  if (!png && !jpeg)
    throw new ReferenceImageReadError({
      code: 'REFERENCE_READ_UNSUPPORTED',
      reason: 'media_type',
      message: '当前企业资料看图只支持静态 PNG 或 JPEG。',
      retryable: false,
    });
  const facts = inspectReferenceImage(data, false);
  if (!facts)
    throw new ReferenceImageReadError({
      code: 'REFERENCE_READ_INVALID',
      reason: 'image_decode',
      message: '该图片无法确认为完整的静态 PNG 或 JPEG，未返回图片内容。',
      retryable: false,
    });
  if (
    facts.width > referenceImagePolicy.maximumDimension ||
    facts.height > referenceImagePolicy.maximumDimension
  )
    referenceImageLimit(
      'image_dimensions',
      '图片单边超过 8192 像素，无法读取。',
    );
  if (facts.width * facts.height > referenceImagePolicy.maximumPixels)
    referenceImageLimit('image_pixels', '图片超过 6400 万像素，无法读取。');
  checkReferenceImageSignal(signal);
  const saved = ReferenceImageSaveResultSchema.parse(
    await execution.native.save({
      data,
      mediaType: facts.mediaType,
      name: current.selection.fileName,
    }),
  );
  if ('error' in saved) throw new ReferenceImageReadError(saved.error);
  checkReferenceImageSignal(signal);
  return { selection: current.selection, image: saved.image };
}
