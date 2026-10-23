import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
const newNativeGeneration = 'dsh-0.2.1-rc.2-687f282' as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const NativeRootOriginV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    contextKind: z.enum([
      'chat',
      'platform_technical',
      'experience_consolidation',
      'platform_employee_test',
    ]),
    contextId: UuidSchema,
    rootSeed: z.string().min(1).max(100),
    distributionGeneration: z.literal(newNativeGeneration),
    profileId: z.enum(['restricted', 'technical']),
    artifactId: digest,
    frozenIdentity: z
      .object({
        kind: z.enum(['employee_package', 'internal_recipe']),
        checksum: digest,
        sourceId: UuidSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((origin, ctx) => {
    if (
      origin.contextKind === 'chat' &&
      (origin.frozenIdentity.kind !== 'employee_package' ||
        !origin.frozenIdentity.sourceId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Chat birth requires its immutable published version',
      });
  });
export type NativeRootOriginV1 = z.infer<typeof NativeRootOriginV1Schema>;
