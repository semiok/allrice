import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { BrowserProfileSchema } from './runtime-v2/browser-control.ts';
import type { WorkspaceCapability } from './workspace-readiness.ts';
import type { BridgeDevice, BridgeFolderGrant } from './bridge.ts';

const base = {
  workspaceId: UuidSchema,
  subjectId: UuidSchema,
  reason: z.string().trim().min(5).max(500),
};
export const TenantConnectorEnvelopeSchema = z.object({
  ...base,
  expectedConnectionRevision: z.number().int().positive().optional(),
  expectedToolGrantRevision: z.number().int().positive().optional(),
});
export const TenantEnvironmentMutationSchema = z.discriminatedUnion('action', [
  z
    .object({ ...base, action: z.literal('cloud_grant'), targetId: UuidSchema })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('browser_grant'),
      targetId: UuidSchema,
      profile: BrowserProfileSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('local_browser_grant'),
      deviceId: UuidSchema,
      profile: BrowserProfileSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('revoke'),
      kind: z.enum(['cloud', 'browser', 'local_browser']),
      grantId: UuidSchema,
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
]);
export interface AdminTenantEnvironments {
  organizationId: string;
  workspaceId: string;
  subjectId: string;
  observedAt: string;
  prerequisites: WorkspaceCapability[][];
  devices: (BridgeDevice & { folderGrants: BridgeFolderGrant[] })[];
  targets: {
    id: string;
    label: string;
    kind: string;
    state: string;
    capabilities: string[];
  }[];
  grants: {
    id: string;
    targetId: string;
    ownerId: string;
    deviceId: string | null;
    kind: 'cloud' | 'browser' | 'local_browser';
    version: number;
    enabled: boolean;
    revokedAt: string | null;
    profile: unknown;
    cleanupRequested: boolean;
    cleanupConfirmed: boolean;
  }[];
  approvalDiagnostics: {
    id: string;
    runId: string;
    expiresAt: string;
    state: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';
  }[];
  approvalDiagnosticsTruncated: boolean;
  nativeConsent: 'confirm_on_device';
}
