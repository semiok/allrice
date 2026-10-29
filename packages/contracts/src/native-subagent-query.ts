import { z } from 'zod';
import { UuidSchema } from './common.ts';

// Business address only. The Worker resolves the native root and storage.
export const NativeSubagentQueryRequestSchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
  })
  .strict();
