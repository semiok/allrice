import { z } from 'zod';
import { ChecksumSchema, UuidSchema } from '@allrice/contracts';
import { MaintenanceGithubIdentitySchema } from './platform-maintenance-github-contracts.ts';
import { MaintenanceGrantFrozenSchema } from './platform-maintenance-authority-contracts.ts';
import { technicalDigest } from './platform-technical-tasks.ts';

export const MaintenancePublicationProvenanceSchema = z
  .object({
    version: z.literal(1),
    companySlug: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    companyName: z.string().min(1).max(80),
    deploymentName: z.string().min(1).max(80),
    deploymentId: UuidSchema,
    installedReleaseSha: z.string().regex(/^[a-f0-9]{40}$/),
    reportId: UuidSchema,
    reportDigest: ChecksumSchema,
    diagnosisId: UuidSchema,
    diagnosisDigest: ChecksumSchema,
    defectId: UuidSchema,
    grantId: UuidSchema,
    grantDigest: ChecksumSchema,
    attemptId: UuidSchema,
    targetSha: z.string().regex(/^[a-f0-9]{40}$/),
    verificationPlanDigest: ChecksumSchema,
    githubBot: MaintenanceGithubIdentitySchema,
  })
  .strict();
export type MaintenancePublicationProvenance = z.infer<
  typeof MaintenancePublicationProvenanceSchema
>;
export function maintenancePublicationProvenance(
  grantId: string,
  grantDigest: string,
  attemptId: string,
  raw: unknown,
  githubBot: z.infer<typeof MaintenanceGithubIdentitySchema>,
) {
  const f = MaintenanceGrantFrozenSchema.parse(raw);
  return MaintenancePublicationProvenanceSchema.parse({
    version: 1,
    companySlug: f.companySlug,
    companyName: f.companyName,
    deploymentName: f.deploymentName,
    deploymentId: f.deploymentId,
    installedReleaseSha: f.installedReleaseSha,
    reportId: f.reportId,
    reportDigest: f.reportDigest,
    diagnosisId: f.diagnosisId,
    diagnosisDigest: f.diagnosisDigest,
    defectId: f.defectId,
    grantId,
    grantDigest,
    attemptId,
    targetSha: f.baseline.sourceSha,
    verificationPlanDigest: f.verificationPlanDigest,
    githubBot,
  });
}
export function maintenancePublicationText(
  raw: MaintenancePublicationProvenance,
  reportDigest: string,
) {
  const p = MaintenancePublicationProvenanceSchema.parse(raw),
    slug = p.companySlug;
  const companyLabel =
    'company:' +
    (slug.length <= 42
      ? slug
      : slug.slice(0, 32) + '-' + technicalDigest(slug).slice(7, 15));
  return {
    title: `fix(${slug}): repair command output credential masking`,
    message: `fix(${slug}): redact command output credentials`,
    labels: ['allrice-maintenance', companyLabel] as [string, string],
    body: `AllRice maintenance candidate from ${slug}.\n\nThe approved source manifest, original assertions and two registered native package builds passed. Verification receipt: ${reportDigest}.\n\nCompany provenance is separate from the verified GitHub robot author. Related company reports share the same defect attempt; this snapshot records the initiating authorization. This PR does not merge or deploy changes. Review the exact diff, original CI and applicability before choosing to merge.\n\nImmutable provenance:\n\n\`\`\`json\n${JSON.stringify(p, null, 2).replaceAll('@', '\\u0040').replaceAll('<', '\\u003c')}\n\`\`\``,
  };
}
