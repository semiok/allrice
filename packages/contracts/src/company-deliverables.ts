import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { DeliveryFormatSchema, type DeliveryFormat } from './operations.ts';
import { OrganizationDashboardFilterSchema } from './organization-dashboard.ts';
import type { RunStatus } from './runs.ts';
import { ArtifactSourceFileSchema } from './runtime-v2/artifact-review.ts';
import { OfficeDeliveryReceiptSchema } from './office-quality.ts';
export {
  OfficeDeliveryReceiptSchema,
  type OfficeDeliveryReceipt,
} from './office-quality.ts';
export const CompanyDeliverableEvidenceSchema = z.object({
  objectId: UuidSchema,
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceFile: ArtifactSourceFileSchema.nullable(),
  companyTemplate: z
    .object({
      assetId: UuidSchema,
      revisionId: UuidSchema,
      digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      title: z.string(),
      revision: z.number().int().positive(),
      sourceChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .optional(),
  office: OfficeDeliveryReceiptSchema.nullable(),
});
export type CompanyDeliverableEvidence = z.infer<
  typeof CompanyDeliverableEvidenceSchema
>;

export const CompanyDeliverablesFilterSchema =
  OrganizationDashboardFilterSchema.safeExtend({
    format: DeliveryFormatSchema.optional(),
    includeUnavailable: z.boolean().default(false),
    periodOnly: z.boolean().default(false),
    before: UuidSchema.optional(),
    seriesId: UuidSchema.optional(),
  });
export interface CompanyDeliverable {
  id: string;
  seriesId: string;
  workspaceId: string;
  ownerId: string;
  ownerName: string;
  sessionId: string;
  sessionTitle: string;
  runId: string | null;
  runStatus: RunStatus | null;
  employeeId: string | null;
  employeeName: string | null;
  fileName: string;
  format: DeliveryFormat;
  version: number;
  latestPublishedVersion: number;
  createdAt: string;
  sizeBytes: number;
  state: 'ready' | 'expired' | 'deleted' | 'unavailable';
}
export interface CompanyDeliverables {
  organizationId: string;
  deliverables: CompanyDeliverable[];
  nextCursor: string | null;
  seriesId: string | null;
}
