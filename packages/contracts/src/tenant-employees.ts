import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const TenantEmployeeChangeSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    action: z.enum(['assign', 'withdraw', 'default']),
    // The selected published revision and deployment are the administrator's snapshot.
    revisionId: UuidSchema,
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    note: z.string().trim().max(500).default(''),
  })
  .strict();

export interface AdminTenantEmployee {
  employeeId: string;
  name: string;
  description: string;
  role: string;
  revisionId: string;
  revision: number;
  publishedAt: string | null;
  toolNames: string[];
  skills: { id: string; name: string }[];
  deployment: {
    name: string;
    role: string;
    description: string;
    active: boolean;
    isDefault: boolean;
    revisionId: string;
    revision: number;
    tenantEmployeeId: string | null;
    tenantVersionId: string | null;
    version: string;
    memberCount: number;
    toolNames: string[];
    skills: { id: string; name: string }[];
  } | null;
  canAssign: boolean;
}
export interface AdminTenantEmployees {
  organizationId: string;
  workspaceId: string;
  employees: AdminTenantEmployee[];
}
