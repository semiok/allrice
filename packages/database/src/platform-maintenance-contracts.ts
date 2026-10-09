import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';

export const MaintenanceModeSchema = z.enum(['report_only', 'repair_and_pr']);
export const MaintenanceModuleSchema = z.enum([
  'web',
  'worker',
  'project-runtime',
  'contracts',
  'skills',
]);
export const MaintenancePolicySchema = z
  .object({
    mode: MaintenanceModeSchema,
    paused: z.boolean(),
    checkIntervalMinutes: z.number().int().min(15).max(10080),
    repairTimeoutMinutes: z.number().int().min(5).max(120),
    maxCandidateRevisions: z.number().int().min(1).max(3),
    maxOutputTokens: z.number().int().min(1000).max(100000),
    dailyRepairLimit: z.number().int().min(1).max(20),
    allowedModules: z.array(MaintenanceModuleSchema).min(1).max(5),
    automaticAuthorizationUntil: z
      .string()
      .datetime({ offset: true })
      .nullable(),
  })
  .strict()
  .refine(
    (p) => new Set(p.allowedModules).size === p.allowedModules.length,
    'Duplicate modules are not allowed',
  )
  .refine(
    (p) => p.mode !== 'repair_and_pr' || p.automaticAuthorizationUntil !== null,
    'Automatic repair requires an explicit authorization expiry',
  );
export type MaintenancePolicy = z.infer<typeof MaintenancePolicySchema>;
export const defaultMaintenancePolicy: MaintenancePolicy = {
  mode: 'report_only',
  paused: false,
  checkIntervalMinutes: 60,
  repairTimeoutMinutes: 30,
  maxCandidateRevisions: 2,
  maxOutputTokens: 30000,
  dailyRepairLimit: 3,
  allowedModules: ['web', 'worker', 'project-runtime'],
  automaticAuthorizationUntil: null,
};
export const RegisterMaintenanceDeploymentSchema = z
  .object({
    requestId: UuidSchema,
    companySlug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    companyName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(
        (s) =>
          Array.from(s).every(
            (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127,
          ),
        'Control characters are not allowed',
      ),
    deploymentName: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(
        (s) =>
          Array.from(s).every(
            (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127,
          ),
        'Control characters are not allowed',
      ),
  })
  .strict();
export const UpdateMaintenanceDeploymentSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    policy: MaintenancePolicySchema,
  })
  .strict();
export const RotateMaintenanceCredentialSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    action: z.enum(['rotate', 'revoke']),
  })
  .strict();
export const MaintenanceDeploymentSchema = z
  .object({
    id: UuidSchema,
    companySlug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    companyName: z.string().min(1).max(80),
    deploymentName: z.string().min(1).max(80),
    policy: MaintenancePolicySchema,
    revision: z.number().int().positive(),
    credentialRevision: z.number().int().positive(),
    enabledAt: z.string().datetime({ offset: true }).nullable(),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MaintenanceDeployment = z.infer<typeof MaintenanceDeploymentSchema>;
export const MaintenanceRegistrationSchema = z
  .object({
    deployment: MaintenanceDeploymentSchema,
    installationKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .nullable(),
  })
  .strict();
export const MaintenanceCatalogSchema = z
  .object({
    deployments: z.array(MaintenanceDeploymentSchema).max(100),
    capabilities: z
      .object({
        repairReady: z.boolean(),
        automaticMerge: z.literal(false),
        automaticDeployment: z.literal(false),
        globalRepairConcurrency: z.literal(1),
      })
      .strict(),
  })
  .strict();
