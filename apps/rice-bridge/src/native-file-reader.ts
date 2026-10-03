import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  LocalFilePathSchema,
  LocalFileVersionSchema,
  ChecksumSchema,
  localFileMaximumBytes,
  localFileMediaType,
  type LocalFileVersion,
} from '@allrice/contracts';
import {
  invokeFileGuardian,
  FileGuardianError,
  type FileGuardianControls,
} from './file-guardian.js';

const nativeReadResult = z
  .object({
    checksum: ChecksumSchema,
    sizeBytes: z.number().int().min(0).max(localFileMaximumBytes),
    identity: z
      .object({
        dev: z.number().int().finite(),
        ino: z.number().int().finite(),
        size: z.number().int().min(0).max(localFileMaximumBytes),
        mtimeMs: z.number().finite(),
        ctimeMs: z.number().finite(),
      })
      .strict(),
    bytesBase64: z.string().max(12_000_000),
  })
  .strict();
// Same PR3 extension projection. MIME is a selection field, not sniffed data.

const checksumOf = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Original bytes only. No host open/realpath fallback or base64 model receipt. */
export async function readNativeFileBytes(
  root: string,
  path: string,
  expected: LocalFileVersion,
  controls: FileGuardianControls = {},
  executable?: string,
): Promise<Uint8Array> {
  const selectedPath = LocalFilePathSchema.parse(path);
  const selected = LocalFileVersionSchema.parse(expected);
  const mediaType = localFileMediaType(selectedPath);
  if (selected.mediaType !== mediaType)
    throw new FileGuardianError('FILE_CHANGED');
  const raw = await invokeFileGuardian(
    {
      mode: 'read',
      root,
      path: selectedPath,
      expected: selected,
    },
    controls,
    executable,
  );
  const parsed = nativeReadResult.safeParse(raw);
  if (!parsed.success) throw new FileGuardianError('FILE_RESULT_INVALID');
  const result = parsed.data;
  const bytes = Buffer.from(result.bytesBase64, 'base64');
  if (bytes.toString('base64') !== result.bytesBase64)
    throw new FileGuardianError('FILE_RESULT_INVALID');
  const version = checksumOf(
    Buffer.from(
      JSON.stringify([
        selectedPath,
        result.identity.dev,
        result.identity.ino,
        result.identity.size,
        result.identity.mtimeMs,
        result.identity.ctimeMs,
        result.checksum,
      ]),
    ),
  );
  if (
    bytes.byteLength !== result.sizeBytes ||
    result.sizeBytes !== selected.sizeBytes ||
    result.identity.size !== selected.sizeBytes ||
    result.checksum !== selected.checksum ||
    checksumOf(bytes) !== selected.checksum ||
    version !== selected.version
  )
    throw new FileGuardianError('FILE_CHANGED');
  if (controls.signal?.aborted) throw new FileGuardianError('FILE_CANCELED');
  if (controls.authorize) {
    let allowed = false;
    try {
      allowed = await controls.authorize();
    } catch {
      /* Refuse revoked authority. */
    }
    if (!allowed || controls.signal?.aborted)
      throw new FileGuardianError('FILE_CANCELED');
  }
  return bytes;
}
