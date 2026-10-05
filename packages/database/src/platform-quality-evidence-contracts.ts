import { z } from 'zod';
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Sha = z.string().regex(/^[a-f0-9]{40}$/);
export const RegressionEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(['available', 'not_configured', 'invalid', 'unavailable']),
    deployedSha: Sha.nullable(),
    currentDevAcceptance: z.literal('not_claimed'),
    records: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            group: z.enum(['native', 'postgres', 'office']),
            source: z
              .object({ sha: Sha, treeDigest: Digest, dirty: z.boolean() })
              .strict(),
            relation: z.enum([
              'exact_source',
              'same_material',
              'historical',
              'unconfirmed',
            ]),
            capturedAt: z.string().datetime({ offset: true }),
            recordedAt: z.string().datetime({ offset: true }),
            registryDigest: Digest,
            originalReportChecksum: Digest,
            runnerSucceeded: z.boolean(),
            executionExitStatus: z.enum(['confirmed', 'not_recorded']),
            fullyVerified: z.boolean(),
            passedScenarioCount: z.number().int().nonnegative(),
            scenarioCount: z.number().int().nonnegative(),
            versions: z
              .object({
                node: z.string().max(150).nullable(),
                dshAgent: z.string().max(150).nullable(),
                dshWeb: z.string().max(150).nullable(),
                officeSkillPin: z.string().max(150).nullable(),
                officeConversionPackage: z.string().max(150).nullable(),
                lockDigest: Digest.nullable(),
                actualOfficeImage: z.string().max(150).nullable(),
                actualBridgeVersion: z.string().max(150).nullable(),
              })
              .strict(),
            scenarios: z
              .array(
                z
                  .object({
                    id: z.string().max(150),
                    title: z.string().max(200),
                    status: z.enum([
                      'passed',
                      'assertion_failed',
                      'execution_failed',
                      'unknown',
                      'skipped',
                      'partially_verified',
                    ]),
                    boundary: z.string().max(1500),
                    inputDigest: Digest,
                    assertionDigest: Digest,
                    executed: z.number().int().nonnegative(),
                    skipped: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .max(100),
            scope: z.string().max(1500),
            physicalDeviceValidation: z.literal('not_executed'),
            realModelUsed: z.literal(false),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
export type RegressionEvidence = z.infer<typeof RegressionEvidenceSchema>;
