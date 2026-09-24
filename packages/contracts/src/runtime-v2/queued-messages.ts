import { z } from 'zod';

export const QueuedMessageActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['edit', 'remove']) }).strict(),
  z
    .object({
      action: z.literal('steer'),
      expectedTurnId: z.string().trim().min(1).max(255),
      expectedGeneration: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type QueuedMessageAction = z.infer<typeof QueuedMessageActionSchema>;
