import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { RoleSchema } from './authorization.ts';

export const EmailSchema = z.string().trim().toLowerCase().email().max(320);
export const PasswordSchema = z.string().min(12).max(256);

export const LoginInputSchema = z
  .object({ email: EmailSchema, password: PasswordSchema })
  .strict();

export const AcceptInvitationInputSchema = z
  .object({
    token: z.string().min(32).max(256),
    displayName: z.string().trim().min(1).max(120),
    password: PasswordSchema,
  })
  .strict();

export const CreateInvitationInputSchema = z
  .object({
    email: EmailSchema,
    workspaceId: UuidSchema.nullable(),
    role: RoleSchema,
    expiresAt: TimestampSchema,
  })
  .strict();

export const SettingsScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system'), id: z.literal('allrice') }).strict(),
  z.object({ type: z.literal('organization'), id: UuidSchema }).strict(),
  z.object({ type: z.literal('workspace'), id: UuidSchema }).strict(),
  z.object({ type: z.literal('user'), id: UuidSchema }).strict(),
]);
