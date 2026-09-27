import { z } from 'zod';
import { EmailSchema, PasswordSchema, UsernameSchema } from './identity.ts';

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
