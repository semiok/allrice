import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ReferenceReadImageInputSchema,
  ReferenceReadImageResultSchema,
  ReferenceReadsSchema,
  ReferenceImageReadSchema,
  ChatMessageContentSchema,
  CreateKnowledgeSourceInputSchema,
  KnowledgeDefinitionSchema,
} from './index.ts';

const sha = (character: string) => `sha256:${character.repeat(64)}`;
const reference = {
  sourceId: randomUUID(),
  revisionId: randomUUID(),
  revision: 1,
  fileName: 'diagram.png',
  purpose: 'diagram',
  digest: sha('a'),
  checksum: sha('b'),
  ownership: { scope: 'company', organizationId: randomUUID() },
};
const image = {
  attachmentId: sha('c'),
  mediaType: 'image/png',
  width: 1,
  height: 1,
  bytes: 90,
};
function receipt() {
  const id = randomUUID();
  return {
    schemaVersion: 2,
    readKind: 'image',
    receiptId: id,
    origin: { kind: 'tool', toolName: 'workspace.reference.read_image' },
    call: {
      id: 'call-1',
      name: 'workspace.reference.read_image',
      nativeSessionId: 'native-1',
    },
    citation: {
      type: 'reference',
      id,
      label: 'diagram.png',
      reference,
      referenceLabel: 'R1',
      locator: {
        kind: 'image',
        member: null,
        sourceChecksum: reference.checksum,
        image,
      },
    },
    contentChecksum: image.attachmentId,
    runId: randomUUID(),
    generationId: randomUUID(),
    jobId: randomUUID(),
    workerId: 'worker-1',
    readAt: new Date().toISOString(),
  };
}
describe('v1.8 strict image identities and historical receipt union', () => {
  it('rejects model-supplied identity, locations and fake image values', () => {
    const pin = {
      sourceId: reference.sourceId,
      revisionId: reference.revisionId,
      digest: reference.digest,
      checksum: reference.checksum,
    };
    expect(ReferenceReadImageInputSchema.parse(pin)).toEqual(pin);
    for (const key of [
      'ownerId',
      'objectId',
      'url',
      'call',
      'image',
      'path',
      'offset',
    ])
      expect(
        ReferenceReadImageInputSchema.safeParse({ ...pin, [key]: 'forged' })
          .success,
      ).toBe(false);
    const read = receipt();
    const result = {
      kind: 'image',
      reference,
      image,
      sourceChecksum: reference.checksum,
      receiptId: read.receiptId,
      citation: read.citation,
      warnings: [],
    };
    expect(ReferenceReadImageResultSchema.parse(result)).toEqual(result);
    for (const patch of [
      { sourceChecksum: image.attachmentId },
      { receiptId: randomUUID() },
      { image: { ...image, attachmentId: reference.checksum } },
      { image: 'data:image/png;base64,AA==' },
    ])
      expect(
        ReferenceReadImageResultSchema.safeParse({ ...result, ...patch })
          .success,
      ).toBe(false);
  });
  it('round-trips V2 through chat and cold receipt parsers, with normalized checksum separate', () => {
    const value = receipt();
    expect(
      ReferenceReadsSchema.parse(JSON.parse(JSON.stringify([value]))),
    ).toEqual([value]);
    expect(
      ChatMessageContentSchema.parse({
        text: 'diagram',
        citations: [value.citation],
      }).citations,
    ).toEqual([value.citation]);
    expect(
      ReferenceImageReadSchema.safeParse({
        ...value,
        contentChecksum: reference.checksum,
      }).success,
    ).toBe(false);
    expect(
      ReferenceImageReadSchema.safeParse({ ...value, call: undefined }).success,
    ).toBe(false);
    expect(
      ReferenceImageReadSchema.safeParse({ ...value, schemaVersion: undefined })
        .success,
    ).toBe(false);
  });
  it('preserves old strict text receipts without inventing new fields', () => {
    const v = receipt();
    const { schemaVersion: _version, readKind: _kind, call: _call, ...old } = v;
    const value = {
      ...old,
      origin: { kind: 'explicit' },
      citation: {
        type: 'knowledge',
        id: v.receiptId,
        label: 'old',
        knowledgeRevisionId: reference.revisionId,
        documentId: randomUUID(),
        sourceKind: 'managed',
        scope: 'user',
        locator: { sourceRef: 'file:old', chunk: 0, start: 0, end: 4 },
        updatedAt: v.readAt,
        score: 1,
        reference,
        referenceLabel: 'R1',
      },
    };
    expect(ReferenceReadsSchema.parse([value])).toEqual([value]);
    expect(
      ReferenceReadsSchema.safeParse([{ ...value, readKind: 'image' }]).success,
    ).toBe(false);
  });
  it('accepts server facts in reads but forbids public source creation from forging them', () => {
    const definition = {
      schemaVersion: 1,
      sourceKind: 'managed',
      connectorBindingId: null,
      resourceRef: 'file:fixed',
      indexing: 'hybrid',
      updatePolicy: 'manual',
      citationRequired: true,
      allowedScopes: ['user'],
      referenceImageFacts: {
        checksum: reference.checksum,
        sizeBytes: 90,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        static: true,
      },
    };
    expect(KnowledgeDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(
      CreateKnowledgeSourceInputSchema.safeParse({
        workspaceId: randomUUID(),
        slug: 'fake',
        name: 'fake',
        description: 'fake',
        definition,
        acl: [
          {
            principalType: 'user',
            principalId: randomUUID(),
            permission: 'read',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
