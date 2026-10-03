import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  FileDerivationArgumentsSchema,
  FileDerivationPayloadSchema,
  FileDerivationResultSchema,
  fileDerivationResultMatches,
} from './file-derivation.ts';
const sha = 'sha256:' + 'a'.repeat(64);
const source = {
  path: '原件.pdf',
  expected: {
    checksum: sha,
    version: sha,
    sizeBytes: 1,
    mediaType: 'application/pdf',
  },
};
it('rejects duplicate pages, incompatible image extensions, pixel excess and ambiguous multi-source edits', () => {
  for (const request of [
    { kind: 'pdf_extract', pages: [1, 1], fileName: 'out.pdf' },
    { kind: 'image_format', format: 'jpeg', fileName: 'out.png' },
    {
      kind: 'image_resize',
      format: 'png',
      fileName: 'out.png',
      width: 8192,
      height: 8192,
    },
  ])
    expect(
      FileDerivationArgumentsSchema.safeParse({ inputs: [source], request })
        .success,
    ).toBe(false);
  expect(
    FileDerivationArgumentsSchema.safeParse({
      inputs: [source, { ...source, path: 'second.pdf' }],
      request: { kind: 'pdf_rotate', degrees: 90, fileName: 'out.pdf' },
    }).success,
  ).toBe(false);
});
it('ordered extraction is retained and a completed physical receipt is mandatory for document success', () => {
  const payload = FileDerivationPayloadSchema.parse({
    capability: 'local.file.derive',
    arguments: {
      inputs: [source],
      request: { kind: 'pdf_extract', pages: [2, 1], fileName: 'out.pdf' },
    },
    outputObjectId: randomUUID(),
  });
  const result = FileDerivationResultSchema.parse({
    contractVersion: 1,
    status: 'derived',
    inputs: payload.arguments.inputs,
    request: payload.arguments.request,
    entries: [],
    object: {
      objectId: payload.outputObjectId,
      checksum: sha,
      sizeBytes: 1,
      fileName: 'out.pdf',
      mediaType: 'application/pdf',
    },
  });
  expect(fileDerivationResultMatches(payload, result)).toBe(false);
  expect(
    fileDerivationResultMatches(payload, {
      ...result,
      processing: {
        stopped: true,
        reason: 'completed',
        guardianPid: 12,
        readerPid: 13,
        observedPeakRssBytes: 1,
      },
    }),
  ).toBe(true);
});
