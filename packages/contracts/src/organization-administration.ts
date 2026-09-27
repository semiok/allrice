import { z } from 'zod';
import { EmailSchema, PasswordSchema, UsernameSchema } from './identity.ts';
import { UuidSchema } from './common.ts';
import type { AdminTenantEmployee } from './tenant-employees.ts';

export const OrganizationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    businessContext: z.string().trim().max(8000).default(''),
  })
  .strict();
export const OrganizationUpdateSchema = OrganizationInputSchema.extend({
  expectedRevision: z.number().int().positive(),
});
export const OrganizationPersonInputSchema = z
  .object({
    username: UsernameSchema,
    displayName: z.string().trim().min(1).max(120),
    jobTitle: z.string().trim().max(160).default(''),
    responsibilities: z.string().trim().max(8000).default(''),
    email: EmailSchema.optional(),
    password: PasswordSchema.default('admin@321'),
  })
  .strict();
export const OrganizationImportSchema = z
  .object({
    people: z.array(OrganizationPersonInputSchema).min(1).max(100),
  })
  .strict()
  .superRefine((input, context) => {
    const names = new Set<string>();
    input.people.forEach((person, index) => {
      if (names.has(person.username))
        context.addIssue({
          code: 'custom',
          path: ['people', index, 'username'],
          message: 'Duplicate username',
        });
      names.add(person.username);
    });
  });
export const OrganizationPersonUpdateSchema =
  OrganizationPersonInputSchema.omit({ email: true, password: true }).extend({
    expectedVersion: z.string().regex(/^[a-f0-9]{32}$/),
  });
export const OrganizationAccountStatusSchema = z
  .object({
    active: z.boolean(),
    expectedVersion: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export const OrganizationPasswordResetSchema = z
  .object({ password: PasswordSchema.default('admin@321') })
  .strict();

export interface ManagedOrganization {
  id: string;
  name: string;
  slug: string;
  businessContext: string;
  revision: number;
  defaultWorkspaceId: string | null;
  workspaces: { id: string; name: string; slug: string }[];
  peopleCount: number;
}
export interface OrganizationPerson {
  userId: string;
  username: string | null;
  displayName: string;
  jobTitle: string;
  responsibilities: string;
  email: string | null;
  status: 'active' | 'invited' | 'disabled';
  membershipActive: boolean;
  version: string;
}

export const OrganizationAiTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }).strict(),
  z
    .object({
      type: z.literal('selected'),
      userIds: z.array(UuidSchema).min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal('search'),
      search: z.string().trim().min(1).max(160),
    })
    .strict(),
]);
export type OrganizationAiTarget = z.infer<typeof OrganizationAiTargetSchema>;
export const OrganizationAiChangeSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    revisionId: UuidSchema,
    expectedVersion: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    action: z.enum(['include', 'exclude', 'inherit', 'default']),
    target: OrganizationAiTargetSchema.default({ type: 'all' }),
    defaultEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.action !== 'default' || typeof v.defaultEnabled === 'boolean',
    { message: 'Default roster changes require defaultEnabled' },
  );

export interface OrganizationAiCatalog {
  organizationId: string;
  workspaceId: string;
  targetCount: number;
  employees: (AdminTenantEmployee & {
    inheritedByDefault: boolean;
    targetAssignedCount: number;
    targetExcludedCount: number;
    targetIncludedCount: number;
  })[];
}
