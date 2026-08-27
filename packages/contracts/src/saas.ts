import { z } from 'zod';

export const SaasRoleSchema = z.enum([
  'member',
  'tenant_admin',
  'platform_admin',
]);

export const SaasActionSchema = z.enum([
  'conversation:read',
  'conversation:create',
  'conversation:send',
  'conversation:cancel',
  'conversation:recover',
  'file:upload',
  'employee:read',
  'employee:manage',
  'skill:assign',
  'workflow:manage',
  'knowledge:manage',
  'model_policy:manage',
  'model_connection:manage',
  'platform_audit:read',
]);

export const SaasSurfaceSchema = z.enum([
  'chatflow',
  'tenant_admin',
  'platform_admin',
]);

export const SaasCapabilityManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    roles: z.array(SaasRoleSchema).min(1),
    actions: z.array(SaasActionSchema),
    surfaces: z.array(SaasSurfaceSchema),
    features: z
      .object({
        chatFlowV3: z.literal(true),
        nativeHarnessEvents: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type SaasCapabilityManifest = z.infer<
  typeof SaasCapabilityManifestSchema
>;
