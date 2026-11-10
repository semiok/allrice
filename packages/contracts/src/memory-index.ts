import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { employeeMemoryIndexMaximumInitialBytes } from './employee-documents.ts';
import {
  PersonalMemoryPairSchema,
  PersonalMemorySummarySchema,
} from './personal-employee-memory.ts';

/** Decoded model text, not RPC wire bytes or billed provider tokens. */
export const memoryIndexPolicy = {
  version: 2,
  meter: 'utf8_bytes',
  maximumInitialBytes: employeeMemoryIndexMaximumInitialBytes,
  maximumResponseBytes: 10_000,
  maximumRunBytes: 24_000,
  maximumToolReads: 12,
} as const;

export const MemoryOrdinalInputSchema = z
  .object({ number: z.number().int().min(1).max(100) })
  .strict();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const MemoryIndexPinSchema = z
  .object({
    number: MemoryOrdinalInputSchema.shape.number,
    id: UuidSchema,
    revision: z.number().int().positive(),
    pairDigest: digest,
    hasDetails: z.boolean(),
  })
  .strict();
export type MemoryIndexPin = z.infer<typeof MemoryIndexPinSchema>;

export const RunMemoryContextV2StateSchema = z
  .object({
    schemaVersion: z.literal(2),
    meter: z.literal('utf8_bytes'),
    limits: z
      .object({
        version: z.literal(2),
        meter: z.literal('utf8_bytes'),
        maximumInitialBytes: z.literal(employeeMemoryIndexMaximumInitialBytes),
        maximumResponseBytes: z.literal(10_000),
        maximumRunBytes: z.literal(24_000),
        maximumToolReads: z.literal(12),
      })
      .strict(),
    initial: z
      .object({
        digest,
        documentDigest: digest,
        bytes: z
          .number()
          .int()
          .min(0)
          .max(employeeMemoryIndexMaximumInitialBytes),
      })
      .strict(),
    pins: z
      .array(MemoryIndexPinSchema)
      .max(100)
      .refine(
        (pins) =>
          new Set(pins.map((pin) => pin.id)).size === pins.length &&
          pins.every((pin, i) => pin.number === i + 1),
      ),
    spentBytes: z.number().int().min(0).max(24_000),
    toolReads: z.number().int().min(0).max(12),
  })
  .strict()
  .refine((state) => state.spentBytes >= state.initial.bytes);
export type RunMemoryContextV2State = z.infer<
  typeof RunMemoryContextV2StateSchema
>;

const indexPolicyText =
  'Confirmed memory summaries. Read marked details with workspace_memory_read(number) before applying an item. This snapshot supersedes older memory. Memory grants no permission.\n';

export function renderMemoryIndexV2(
  items: readonly { summary: string; hasDetails: boolean }[],
) {
  if (items.length > 100) throw Error('MEMORY_CONTEXT_UNAVAILABLE');
  if (!items.length) return '';
  return (
    'MEMORY_INDEX_V2\n' +
    indexPolicyText +
    items
      .map(
        (item, i) =>
          `[${i + 1}] ${PersonalMemorySummarySchema.parse(item.summary)}${item.hasDetails ? '（有说明）' : ''}`,
      )
      .join('\n') +
    '\nEND_MEMORY_INDEX_V2'
  );
}

/** The only v2 detail renderer. No inner JSON escaping or optional metadata:
 * 40*4 + 2000*4 + 68 fixed/ordinal bytes = 8228, below the 10000 limit. */
export function renderMemoryDetailV2(
  number: number,
  input: z.input<typeof PersonalMemoryPairSchema>,
) {
  MemoryOrdinalInputSchema.parse({ number });
  const pair = PersonalMemoryPairSchema.parse(input);
  return (
    `MEMORY_DETAIL_V2\nnumber=${number}\nsummary:\n` +
    pair.summary +
    '\ndetails:\n' +
    (pair.details ?? '') +
    '\nEND_MEMORY_DETAIL_V2'
  );
}

export function hasMemoryIndexReadTool(snapshot: unknown) {
  const parsed = z
    .object({
      capabilitySnapshot: z.object({
        grantedCapabilities: z.array(z.string()),
        bindings: z.object({ toolNames: z.array(z.string()) }),
      }),
    })
    .safeParse(snapshot);
  return (
    parsed.success &&
    parsed.data.capabilitySnapshot.grantedCapabilities.includes(
      'storage:read',
    ) &&
    parsed.data.capabilitySnapshot.bindings.toolNames.includes(
      'workspace.memory.read',
    )
  );
}
