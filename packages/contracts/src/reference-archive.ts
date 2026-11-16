import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { ReferenceSelectionSchema } from './reference-library.ts';
import { ReferenceReadImageInputSchema } from './reference-image.ts';
import {
  ReferenceArchiveEntryIdSchema,
  ReferenceMemberIdentitySchema,
} from './reference-member.ts';
import { ReferenceTextLocationSchema } from './reference-search.ts';

export const ReferenceArchiveCursorSchema = z
  .object({
    version: z.literal(1),
    pinDigest: ChecksumSchema,
    directoryChecksum: ChecksumSchema,
    nextEntryIndex: z.number().int().nonnegative(),
  })
  .strict();
export const ReferenceArchiveListInputSchema =
  ReferenceReadImageInputSchema.extend({
    limit: z.number().int().min(1).max(50).default(50),
    cursor: ReferenceArchiveCursorSchema.optional(),
  }).strict();
const memberInput = ReferenceReadImageInputSchema.extend({
  entryId: ReferenceArchiveEntryIdSchema,
});
export const ReferenceArchiveReadInputSchema = z.discriminatedUnion('as', [
  memberInput
    .extend({
      as: z.literal('text'),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(4000).default(4000),
      expectedTextChecksum: ChecksumSchema.optional(),
    })
    .strict()
    .refine(
      (value) => value.offset === 0 || value.expectedTextChecksum !== undefined,
      'Continuation requires expectedTextChecksum',
    ),
  memberInput.extend({ as: z.literal('image') }).strict(),
]);
export const ReferenceArchiveDirectoryLocatorSchema = z
  .object({
    kind: z.literal('archive_directory'),
    directoryChecksum: ChecksumSchema,
    startEntryIndex: z.number().int().nonnegative(),
    endEntryIndex: z.number().int().nonnegative(),
    totalEntries: z.number().int().nonnegative().max(128),
    pageChecksum: ChecksumSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.startEntryIndex <= value.endEntryIndex &&
      value.endEntryIndex <= value.totalEntries,
  );
export const ReferenceArchiveTextLocatorSchema = z
  .object({
    kind: z.literal('archive_member_text'),
    member: ReferenceMemberIdentitySchema,
    textChecksum: ChecksumSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    locations: z.array(ReferenceTextLocationSchema),
  })
  .strict()
  .refine((value) => value.start < value.end);
const citationBase = z
  .object({
    type: z.literal('reference'),
    id: UuidSchema,
    label: z.string().min(1).max(200),
    reference: ReferenceSelectionSchema,
    referenceLabel: z.string().regex(/^R[1-9]\d?$/),
  })
  .strict();
export const ReferenceArchiveDirectoryCitationSchema = citationBase
  .extend({ locator: ReferenceArchiveDirectoryLocatorSchema })
  .strict();
export const ReferenceArchiveTextCitationSchema = citationBase
  .extend({ locator: ReferenceArchiveTextLocatorSchema })
  .strict();
export const ReferenceArchiveCitationSchema = z.union([
  ReferenceArchiveDirectoryCitationSchema,
  ReferenceArchiveTextCitationSchema,
]);
export const ReferenceArchiveEntrySchema = z
  .object({
    entryId: ReferenceArchiveEntryIdSchema,
    path: z.string().min(1).max(1024),
    kind: z.enum(['file', 'directory']),
    compressedBytes: z.number().int().nonnegative(),
    declaredBytes: z.number().int().nonnegative(),
    compression: z.enum(['store', 'deflate']),
    readAs: z.enum(['text', 'image']).nullable(),
    contentVerification: z.literal('not_read'),
  })
  .strict();
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
export const ReferenceArchiveListResultSchema = z
  .object({
    kind: z.literal('archive_directory'),
    reference: ReferenceSelectionSchema,
    directoryChecksum: ChecksumSchema,
    totalEntries: z.number().int().nonnegative().max(128),
    entries: z.array(ReferenceArchiveEntrySchema).max(50),
    nextCursor: ReferenceArchiveCursorSchema.nullable(),
    citation: ReferenceArchiveDirectoryCitationSchema,
    receiptId: UuidSchema,
    warnings: z.array(z.string()),
  })
  .strict()
  .superRefine((value, ctx) => {
    const locator = value.citation.locator;
    if (
      value.receiptId !== value.citation.id ||
      !same(value.reference, value.citation.reference) ||
      value.directoryChecksum !== locator.directoryChecksum ||
      value.totalEntries !== locator.totalEntries ||
      value.entries.length !==
        locator.endEntryIndex - locator.startEntryIndex ||
      (value.nextCursor
        ? value.nextCursor.directoryChecksum !== value.directoryChecksum ||
          value.nextCursor.nextEntryIndex !== locator.endEntryIndex ||
          value.entries.length === 0 ||
          locator.endEntryIndex >= value.totalEntries
        : locator.endEntryIndex !== value.totalEntries)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Directory result identities must agree',
      });
  });
export const ReferenceArchiveTextResultSchema = z
  .object({
    kind: z.literal('archive_member_text'),
    reference: ReferenceSelectionSchema,
    member: ReferenceMemberIdentitySchema,
    content: z.string().max(4000),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    totalCharacters: z.number().int().nonnegative(),
    textChecksum: ChecksumSchema,
    locations: z.array(ReferenceTextLocationSchema),
    warnings: z.array(z.string()),
    citation: ReferenceArchiveTextCitationSchema.nullable(),
    receiptId: UuidSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const cite = value.citation;
    if (
      value.content.length !== value.end - value.start ||
      value.end > value.totalCharacters ||
      value.nextOffset !==
        (value.end < value.totalCharacters ? value.end : null) ||
      (value.content.length === 0
        ? value.start !== value.totalCharacters ||
          cite !== null ||
          value.receiptId !== null
        : !cite ||
          value.receiptId !== cite.id ||
          !same(value.reference, cite.reference) ||
          !same(value.member, cite.locator.member) ||
          value.textChecksum !== cite.locator.textChecksum ||
          value.start !== cite.locator.start ||
          value.end !== cite.locator.end ||
          !same(value.locations, cite.locator.locations))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Member text result identities must agree',
      });
  });
export const ReferenceArchiveCallSchema = z
  .object({
    id: z.string().min(1).max(240),
    name: z.enum([
      'workspace.reference.archive_list',
      'workspace.reference.archive_read',
    ]),
    nativeSessionId: z.string().min(1).max(240),
  })
  .strict();
