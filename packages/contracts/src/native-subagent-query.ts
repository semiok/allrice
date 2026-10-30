import { z } from 'zod';
import { UuidSchema } from './common.ts';

// Business root address; the same Host verifies any selected native child.
export const NativeSubagentQueryRequestSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    // A local hot probe: absence is not global coldness or an empty tree.
    liveOnly: z.boolean().optional(),
    follow: z.literal(true).optional(),
    childId: z.string().min(1).optional(),
  })
  .strict();
