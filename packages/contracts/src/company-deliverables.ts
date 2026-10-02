import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { DeliveryFormatSchema, type DeliveryFormat } from './operations.ts';
import { OrganizationDashboardFilterSchema } from './organization-dashboard.ts';
import type { RunStatus } from './runs.ts';
import { ArtifactSourceFileSchema } from './runtime-v2/artifact-review.ts';

/** A typed projection of the actual exporter receipt, never model prose. */
export const OfficeDeliveryReceiptSchema = z.object({
  quality: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('checked'),
      format: z.enum(['docx', 'xlsx', 'pptx']),
      pageCount: z.number().int().positive(),
      formulaCount: z.number().int().nonnegative(),
      formulaErrorCount: z.number().int().nonnegative(),
      layout: z.literal('rendered_not_visually_reviewed'),
    }),
    z.object({
      status: z.literal('unavailable'),
      reason: z.string().max(4000),
    }),
  ]),
  warnings: z.array(z.string().max(4000)).max(50),
});
export type OfficeDeliveryReceipt = z.infer<typeof OfficeDeliveryReceiptSchema>;
export const CompanyDeliverableEvidenceSchema = z.object({
  objectId: UuidSchema,
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sourceFile: ArtifactSourceFileSchema.nullable(),
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
