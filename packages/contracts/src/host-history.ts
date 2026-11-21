import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

const seq = z.number().int().nonnegative().safe();
const cursor = z.number().int().min(-1).safe();
const ref = z.string().min(1);

/** Host-owned immutable thread/storage pin. Never accept this from guest JSON.
 * configurationRef is the thread's recorded release, not today's employee edit. */
export const HostHistoryBindingSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    personId: UuidSchema,
    employeeInstanceId: UuidSchema,
    threadId: UuidSchema,
    nativeInstanceRef: ref,
    nativeProfileRef: ref,
    nativeSessionId: ref,
    rootNativeSessionId: ref,
    parentNativeSessionId: ref.nullable(),
    configurationRef: ref,
    configurationDigest: ChecksumSchema,
    executionGeneration: z.literal('4.0'),
  })
  .strict()
  .superRefine((binding, ctx) => {
    const root = binding.nativeSessionId === binding.rootNativeSessionId;
    if (root !== (binding.parentNativeSessionId === null))
      ctx.addIssue({ code: 'custom', message: 'Invalid native root pin' });
  });
export type HostHistoryBinding = z.infer<typeof HostHistoryBindingSchema>;

/** Host-authorized immutable bytes only. No guest path, URI or storage key. */
export const HostHistoryAttachmentSchema = z
  .object({
    sourceSeq: seq,
    objectId: UuidSchema,
    checksum: ChecksumSchema,
    sizeBytes: seq,
    mediaType: ref,
    fileName: z
      .string()
      .min(1)
      .refine((name) =>
        Array.from(name).every(
          (c) => c !== '/' && c !== '\\' && c.charCodeAt(0) >= 32,
        ),
      ),
  })
  .strict();
export type HostHistoryAttachment = z.infer<typeof HostHistoryAttachmentSchema>;

/** These are text slots, never HTML or executable native result metadata.
 * A native result is diagnostic evidence, never an external delivery receipt. */
export const HostHistoryEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('message'),
      seq,
      time: seq,
      role: z.enum(['user', 'assistant']),
      text: z.string(),
      interrupted: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool'),
      seq,
      time: seq,
      callId: ref,
      name: ref,
      arguments: z.string(),
      outcome: z.enum([
        'unfinished',
        'outcome-unknown',
        'not-started',
        'error-recorded',
        'result-recorded',
      ]),
      result: z
        .object({
          seq,
          text: z.string(),
          isError: z.boolean().nullable(),
          errorCode: ref.nullable(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('turn-end'),
      seq,
      time: seq,
      turn: seq,
      reason: ref,
    })
    .strict(),
]);
export type HostHistoryEntry = z.infer<typeof HostHistoryEntrySchema>;

export const HostHistorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: HostHistoryBindingSchema,
    source: z
      .object({
        dshVersion: z.literal('0.2.1-rc.2'),
        sessionFormatVersion: z.literal(4),
        headerHash: ChecksumSchema,
        inheritedEventCount: seq,
        throughSeq: cursor,
        eventHashes: z.array(ChecksumSchema),
      })
      .strict(),
    entries: z.array(HostHistoryEntrySchema),
    attachments: z.array(HostHistoryAttachmentSchema),
    /** Native facts only. null means no such native boundary was observed. */
    lastTurn: z
      .object({
        startSeq: seq.nullable(),
        endSeq: seq.nullable(),
        reason: ref.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const through = snapshot.source.throughSeq;
    const positions = snapshot.entries.map((entry) => entry.seq);
    const invalid =
      through !== snapshot.source.eventHashes.length - 1 ||
      snapshot.source.inheritedEventCount > through + 1 ||
      positions.some(
        (n, i) => n > through || (i > 0 && n < positions[i - 1]!),
      ) ||
      snapshot.entries.some(
        (entry) =>
          entry.kind === 'tool' &&
          entry.result !== null &&
          (entry.result.seq > through || entry.result.seq <= entry.seq),
      ) ||
      snapshot.attachments.some(
        (attachment) => attachment.sourceSeq > through,
      ) ||
      [snapshot.lastTurn.startSeq, snapshot.lastTurn.endSeq].some(
        (n) => n !== null && n > through,
      ) ||
      (snapshot.lastTurn.endSeq === null) !==
        (snapshot.lastTurn.reason === null);
    if (invalid)
      ctx.addIssue({ code: 'custom', message: 'Invalid source cursor' });
  });
export type HostHistorySnapshot = z.infer<typeof HostHistorySnapshotSchema>;

export const HostHistoryCursorSchema = z
  .object({
    snapshotDigest: ChecksumSchema,
    afterSeq: cursor,
  })
  .strict();
export const HostHistoryPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotDigest: ChecksumSchema,
    source: HostHistorySnapshotSchema.shape.source.omit({ eventHashes: true }),
    entries: z.array(HostHistoryEntrySchema),
    attachments: z.array(HostHistoryAttachmentSchema),
    nextCursor: HostHistoryCursorSchema.nullable(),
    notice: z.enum(['interrupted', 'unfinished']).nullable(),
    /** Native tool return/unknown/not-started never establishes external effect. */
    externalEffects: z.literal('unverified'),
  })
  .strict();
export type HostHistoryPage = z.infer<typeof HostHistoryPageSchema>;

export interface HostHistoryStorePort {
  publish(snapshot: HostHistorySnapshot, signal: AbortSignal): Promise<string>;
  read(
    binding: HostHistoryBinding,
    signal: AbortSignal,
    snapshotDigest?: string,
  ): Promise<{ digest: string; snapshot: HostHistorySnapshot } | null>;
}
