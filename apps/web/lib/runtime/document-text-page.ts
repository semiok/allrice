import { createHash } from 'node:crypto';
import { ArtifactReviewError } from '@allrice/database';
import type { StorageObject, StoragePort } from '@allrice/contracts';
import { documentPreviewLimits as limits } from '../chatflow/document-preview-policy';

/** Bounded line window. Validate the immutable stream without retaining the whole file. */
export async function readDocumentTextPage(
  storage: StoragePort,
  object: StorageObject,
  offset = 1,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(offset) || offset < 1)
    throw new ArtifactReviewError('invalid_page');
  const reader = (await storage.get(object)).getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const hash = createHash('sha256');
  const lines: string[] = [];
  let line = 1,
    size = 0,
    pageBytes = 0,
    current = '',
    trailing = false;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  const deadline = AbortSignal.timeout(10_000);
  const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
  lifetime.addEventListener('abort', cancel, { once: true });
  const consume = (text: string) => {
    if (text.includes('\0')) throw new ArtifactReviewError('preview_not_text');
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (line >= offset && line < offset + limits.pageLines) {
        pageBytes += Buffer.byteLength(part) + (i < parts.length - 1 ? 1 : 0);
        if (pageBytes > limits.pageBytes)
          throw new ArtifactReviewError('preview_page_too_large');
        current += part;
      }
      if (i < parts.length - 1) {
        if (line >= offset && line < offset + limits.pageLines) {
          lines.push(current);
          current = '';
        }
        line++;
        trailing = false;
      } else if (part.length) trailing = true;
    }
  };
  try {
    lifetime.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      lifetime.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > object.sizeBytes)
        throw new ArtifactReviewError('content_changed');
      hash.update(next.value);
      consume(decoder.decode(next.value, { stream: true }));
    }
    consume(decoder.decode());
    if (trailing && line >= offset && line < offset + limits.pageLines)
      lines.push(current);
    if (
      size !== object.sizeBytes ||
      `sha256:${hash.digest('hex')}` !== object.checksum
    )
      throw new ArtifactReviewError('content_changed');
    const totalLines = trailing ? line : line - 1;
    return {
      text: lines.join('\n'),
      offset,
      lines: lines.length,
      eof: offset + lines.length > totalLines,
    };
  } catch (error) {
    cancel();
    if (error instanceof TypeError)
      throw new ArtifactReviewError('preview_not_text');
    throw error;
  } finally {
    lifetime.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
