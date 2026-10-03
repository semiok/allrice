import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ChangesetProposalSchema,
  ChangesetDocumentSchema,
} from './artifact-review.ts';
import {
  RuntimeChangesetSchema,
  changesetFileAppliedMatches,
  fileOrganizationRestoration,
  type ChangesetFileResult,
} from './changeset-execution.ts';

const checksum = `sha256:${'a'.repeat(64)}`,
  version = `sha256:${'b'.repeat(64)}`;
const item = {
  path: '原文件.xlsx',
  target: '整理后.xlsx',
  operation: 'move' as const,
  source: { checksum, version, sizeBytes: 100 },
  expectedDestination: null,
};
const file = { path: item.path, before: null, after: null, organization: item };
const receipt: ChangesetFileResult = {
  path: item.path,
  status: 'applied',
  beforeChecksum: checksum,
  afterChecksum: checksum,
  organization: {
    target: item.target,
    operation: item.operation,
    stage: 'complete',
    sourceRemoved: true,
    file: { ...item.source, version: `sha256:${'c'.repeat(64)}` },
    recovery: { path: item.target, checksum },
  },
};
describe('reviewed binary file organization', () => {
  it('keeps the legacy text payload byte shape and rejects a binary plan without its discriminant', () => {
    const arguments_ = {
      path: '.',
      artifactId: randomUUID(),
      checksum,
      direction: 'apply',
      files: [
        { path: 'old.txt', before: null, after: { text: 'new', checksum } },
      ],
    };
    expect(
      RuntimeChangesetSchema.parse({
        capability: 'local.fs.changeset',
        arguments: arguments_,
      }).arguments,
    ).toEqual(arguments_);
    expect(
      RuntimeChangesetSchema.safeParse({
        capability: 'local.fs.changeset',
        arguments: { ...arguments_, files: [file] },
      }).success,
    ).toBe(false);
    expect(
      RuntimeChangesetSchema.safeParse({
        capability: 'local.fs.changeset',
        arguments: {
          ...arguments_,
          files: [file],
          comparisonScope: 'file_organization',
        },
      }).success,
    ).toBe(true);
  });
  it.each([
    '../outside',
    '/outside',
    'folder\\outside',
    '.',
    'folder/../outside',
  ])('rejects an unsafe destination %s', (target) => {
    expect(
      ChangesetProposalSchema.safeParse({ operations: [{ ...item, target }] })
        .success,
    ).toBe(false);
  });
  it('rejects case collisions, overlapping paths, cycles, overwrites and ambiguous text/binary plans', () => {
    for (const operations of [
      [item, { ...item, path: 'Other.xlsx', target: '整理后.XLSX' }],
      [item, { ...item, path: '整理后.xlsx/child', target: 'child' }],
      [item, { ...item, path: item.target, target: item.path }],
      [{ ...item, expectedDestination: item.source }],
    ])
      expect(ChangesetProposalSchema.safeParse({ operations }).success).toBe(
        false,
      );
    expect(
      ChangesetProposalSchema.safeParse({ operations: [item], files: [] })
        .success,
    ).toBe(false);
  });
  it('does not permit a binary plan to become an empty text deletion or a disposable candidate', () => {
    const grant = randomUUID();
    const document = {
      contractVersion: 1,
      comparisonScope: 'file_organization',
      files: [file],
      execution: {
        targetId: randomUUID(),
        targetKind: 'rice_bridge',
        deviceId: randomUUID(),
        grantId: grant,
        grantVersion: 1,
        scopeDigest: checksum,
        workCopy: { id: grant, kind: 'in_place' },
      },
    };
    expect(ChangesetDocumentSchema.safeParse(document).success).toBe(true);
    expect(
      ChangesetDocumentSchema.safeParse({
        ...document,
        comparisonScope: 'changeset',
      }).success,
    ).toBe(false);
    expect(
      ChangesetDocumentSchema.safeParse({
        ...document,
        execution: {
          ...document.execution,
          workCopy: { id: grant, kind: 'local_copy' },
        },
      }).success,
    ).toBe(false);
  });
  it('restores only a confirmed move using the actual destination identity; copies and unknowns remain', () => {
    expect(changesetFileAppliedMatches(file, receipt)).toBe(true);
    const restored = fileOrganizationRestoration([file], [receipt]);
    expect(restored[0]?.organization).toMatchObject({
      path: item.target,
      target: item.path,
      source: receipt.organization!.file,
      expectedDestination: null,
    });
    for (const bad of [
      { ...receipt, status: 'unknown' as const },
      {
        ...receipt,
        organization: { ...receipt.organization!, sourceRemoved: false },
      },
      {
        ...receipt,
        organization: { ...receipt.organization!, target: 'wrong.xlsx' },
      },
      {
        ...receipt,
        organization: {
          ...receipt.organization!,
          stage: 'destination_committed',
        },
      },
      {
        ...receipt,
        organization: {
          ...receipt.organization!,
          file: { ...item.source, sizeBytes: 99 },
        },
      },
    ]) {
      expect(changesetFileAppliedMatches(file, bad)).toBe(false);
      expect(fileOrganizationRestoration([file], [bad])).toEqual([]);
    }
    const copy = {
      ...file,
      organization: { ...item, operation: 'copy' as const },
    };
    expect(
      fileOrganizationRestoration(
        [copy],
        [
          {
            ...receipt,
            organization: {
              ...receipt.organization!,
              operation: 'copy',
              sourceRemoved: false,
            },
          },
        ],
      ),
    ).toEqual([]);
  });
});
