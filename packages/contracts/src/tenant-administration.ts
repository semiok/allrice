import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { RoleSchema } from './authorization.ts';

export const TenantMemberChangeSchema = z
  .object({
    workspaceId: UuidSchema.nullable(),
    expectedVersion: z.string().regex(/^[a-f0-9]{32}$/),
    role: RoleSchema,
    active: z.boolean(),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export interface AdminTenant {
  id: string;
  name: string;
  slug: string;
  workspaces: { id: string; name: string; slug: string }[];
}
export interface AdminTenantMember {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  userStatus: 'active' | 'invited' | 'disabled';
  workspaceId: string | null;
  role: z.infer<typeof RoleSchema>;
  active: boolean;
  version: string;
}
export interface AdminTenantMembers {
  organizationId: string;
  workspaceId: string | null;
  members: AdminTenantMember[];
  nextCursor: string | null;
}
