import { createHash } from 'node:crypto';
import {
  FileDerivationResultSchema,
  fileDerivationResultMatches,
  type FileDerivationPayload,
  type FileDerivationContentSchema,
  type LocalFileObject,
  type LocalFileVersion,
} from '@allrice/contracts';
import type { z } from 'zod';
import { createFileArchive, readFileArchive } from './file-archives.js';
import { readLocalFileBytes, LocalFileError } from './local-files.js';

export type FileDerivationContent = z.infer<typeof FileDerivationContentSchema>;
export class FileDerivationError extends Error {
  constructor(
    readonly code: string,
    readonly unknown = false,
  ) {
    super(code);
  }
}
const checksum = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export async function executeFileDerivation(
  root: string,
  payload: FileDerivationPayload,
  options: {
    signal?: AbortSignal;
    authorize: () => Promise<boolean>;
    /** Internal byte port for hermetic codec/DB tests. Packaged execution uses
     * the fixed native reader; this is not a tool argument or user executable. */
    readSource?: (
      root: string,
      path: string,
      expected: LocalFileVersion,
      controls: { signal: AbortSignal; authorize: () => Promise<boolean> },
    ) => Promise<Uint8Array>;
    upload: (
      metadata: FileDerivationContent,
      bytes: Uint8Array,
      signal: AbortSignal,
    ) => Promise<LocalFileObject>;
  },
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(30_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const controls = { signal, authorize: options.authorize };
  const sources = [];
  for (const input of payload.arguments.inputs)
    sources.push({
      path: input.path,
      bytes: await (options.readSource ?? readLocalFileBytes)(
        root,
        input.path,
        input.expected,
        controls,
      ),
    });
  const request = payload.arguments.request;
  let bytes: Uint8Array;
  if (request.kind === 'zip_pack')
    bytes = await createFileArchive(sources, controls);
  else {
    const entries = await readFileArchive(sources[0]!.bytes, controls);
    if (request.kind === 'zip_list')
      return FileDerivationResultSchema.parse({
        contractVersion: 1,
        status: 'listed',
        inputs: payload.arguments.inputs,
        request,
        entries: entries.map((e) => ({
          path: e.path,
          checksum: checksum(e.bytes),
          sizeBytes: e.bytes.byteLength,
        })),
        object: null,
      });
    const entry = entries.find((e) => e.path === request.entry);
    if (!entry) throw new FileDerivationError('FILE_ARCHIVE_ENTRY_NOT_FOUND');
    bytes = entry.bytes;
  }
  signal.throwIfAborted();
  if (!(await options.authorize())) throw new LocalFileError('FILE_CANCELED');
  const object = await options.upload(
    {
      checksum: checksum(bytes),
      sizeBytes: bytes.byteLength,
      mediaType:
        request.kind === 'zip_pack'
          ? 'application/zip'
          : 'application/octet-stream',
      fileName: request.fileName,
    },
    bytes,
    signal,
  );
  const result = FileDerivationResultSchema.parse({
    contractVersion: 1,
    status: 'derived',
    inputs: payload.arguments.inputs,
    request,
    entries: [],
    object,
  });
  if (
    !fileDerivationResultMatches(payload, result) ||
    object.checksum !== checksum(bytes) ||
    object.sizeBytes !== bytes.byteLength
  )
    throw new FileDerivationError('FILE_DERIVATION_RESULT_UNKNOWN', true);
  return result;
}
