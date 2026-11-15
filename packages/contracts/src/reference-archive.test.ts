import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ReferenceArchiveListInputSchema,
  ReferenceArchiveReadInputSchema,
  ReferenceArchiveReadSchema,
  ReferenceReadsSchema,
  ReferenceReadImageResultSchema,
  ChatMessageContentSchema,
  KnowledgeDefinitionSchema,
  CreateKnowledgeSourceInputSchema,
} from './index.ts';
const sha = (c: string) => 'sha256:' + c.repeat(64);
const pin = {
  sourceId: randomUUID(),
  revisionId: randomUUID(),
  digest: sha('a'),
  checksum: sha('b'),
};
const reference = {
  ...pin,
  revision: 1,
  fileName: 'bundle.zip',
  purpose: '',
  ownership: { scope: 'company', organizationId: randomUUID() },
};
const member = {
  entryId: 'entry:' + sha('e'),
  path: 'folder/image.png',
  checksum: sha('c'),
  sizeBytes: 90,
  mediaType: 'image/png',
};
describe('v1.8 strict archive contracts', () => {
  it('validates exact pins, cursors and discriminated member paging without accepting authority or paths', () => {
    expect(ReferenceArchiveListInputSchema.parse(pin).limit).toBe(50);
    for (const extra of [
      { objectId: randomUUID() },
      { path: 'x' },
      { limit: 51 },
      { cursor: { version: 2 } },
    ])
      expect(
        ReferenceArchiveListInputSchema.safeParse({ ...pin, ...extra }).success,
      ).toBe(false);
    const base = { ...pin, entryId: member.entryId };
    expect(
      ReferenceArchiveReadInputSchema.parse({ ...base, as: 'text' }),
    ).toMatchObject({ offset: 0, limit: 4000 });
    for (const extra of [
      { as: 'image', offset: 0 },
      { as: 'image', expectedTextChecksum: sha('e') },
      { as: 'text', offset: 1 },
      { as: 'text', limit: 4001 },
      { as: 'text', entryId: '../x' },
      { as: 'text', path: member.path },
    ])
      expect(
        ReferenceArchiveReadInputSchema.safeParse({ ...base, ...extra })
          .success,
      ).toBe(false);
    expect(
      ReferenceArchiveReadInputSchema.safeParse({
        ...base,
        as: 'text',
        offset: 1,
        expectedTextChecksum: sha('e'),
      }).success,
    ).toBe(true);
  });
  it('round-trips directory and text receipts through cold chat consumers without pretending directories are text', () => {
    const runId = randomUUID(),
      generationId = randomUUID();
    const reads = ['archive_directory', 'archive_member_text'].map(
      (kind, i) => {
        const id = randomUUID();
        return {
          schemaVersion: 2,
          readKind: kind,
          receiptId: id,
          origin: {
            kind: 'tool',
            toolName:
              'workspace.reference.' + (i ? 'archive_read' : 'archive_list'),
          },
          call: {
            id: `call-${i}`,
            name:
              'workspace.reference.' + (i ? 'archive_read' : 'archive_list'),
            nativeSessionId: 'native-1',
          },
          citation: {
            type: 'reference',
            id,
            label: 'bundle.zip',
            reference,
            referenceLabel: `R${i + 1}`,
            locator: i
              ? {
                  kind,
                  member,
                  textChecksum: sha('d'),
                  start: 0,
                  end: 3,
                  locations: [],
                }
              : {
                  kind,
                  directoryChecksum: sha('d'),
                  startEntryIndex: 0,
                  endEntryIndex: 1,
                  totalEntries: 1,
                  pageChecksum: sha('f'),
                },
          },
          contentChecksum: sha('f'),
          runId,
          generationId,
          jobId: randomUUID(),
          workerId: 'worker',
          readAt: new Date().toISOString(),
        };
      },
    );
    expect(
      ReferenceReadsSchema.parse(JSON.parse(JSON.stringify(reads))),
    ).toEqual(reads);
    expect(
      ChatMessageContentSchema.parse({
        text: 'result',
        citations: reads.map((read) => read.citation),
      }).citations,
    ).toEqual(reads.map((read) => read.citation));
    expect(
      ReferenceArchiveReadSchema.safeParse({
        ...reads[0],
        contentChecksum: sha('a'),
      }).success,
    ).toBe(false);
    expect(
      ReferenceArchiveReadSchema.safeParse({
        ...reads[0],
        call: reads[1]!.call,
      }).success,
    ).toBe(false);
  });
  it('keeps parent, member and normalized image identities distinct and rejects forged format facts', () => {
    const id = randomUUID();
    const image = {
      attachmentId: sha('d'),
      mediaType: 'image/webp',
      bytes: 50,
      width: 1,
      height: 1,
    };
    const value = {
      kind: 'image',
      reference,
      member,
      image,
      sourceChecksum: member.checksum,
      receiptId: id,
      warnings: [],
      citation: {
        type: 'reference',
        id,
        label: 'bundle.zip',
        reference,
        referenceLabel: 'R1',
        locator: {
          kind: 'image',
          member,
          sourceChecksum: member.checksum,
          image,
        },
      },
    };
    expect(ReferenceReadImageResultSchema.parse(value)).toEqual(value);
    expect(
      ReferenceReadImageResultSchema.safeParse({ ...value, member: undefined })
        .success,
    ).toBe(false);
    expect(
      ReferenceReadImageResultSchema.safeParse({
        ...value,
        sourceChecksum: pin.checksum,
      }).success,
    ).toBe(false);
    const definition = {
      schemaVersion: 1,
      sourceKind: 'managed',
      connectorBindingId: null,
      resourceRef: 'file:' + randomUUID(),
      indexing: 'hybrid',
      updatePolicy: 'manual',
      citationRequired: true,
      allowedScopes: ['organization'],
      referenceArchiveFacts: {
        checksum: pin.checksum,
        sizeBytes: 123,
        mediaType: 'application/zip',
      },
    };
    expect(KnowledgeDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(
      CreateKnowledgeSourceInputSchema.safeParse({ name: 'forged', definition })
        .success,
    ).toBe(false);
  });
});
