import { describe, expect, it } from 'vitest';
import { ChangePasswordInputSchema, LoginInputSchema } from './identity.ts';
import {
  organizationInitialPassword,
  OrganizationImportSchema,
  OrganizationPasswordResetSchema,
} from './organization-administration.ts';

describe('organization initial passwords', () => {
  it('uses the normalized English account, including short and punctuated names', () => {
    expect(organizationInitialPassword(' Snow ')).toBe('snow@123');
    expect(organizationInitialPassword('Li')).toBe('li@123');
    expect(organizationInitialPassword('Snow.01')).toBe('snow.01@123');
    expect(() => organizationInitialPassword('小雪')).toThrow();
  });

  it('leaves defaults to the server while retaining custom password validation', () => {
    const value = OrganizationImportSchema.parse({
      people: [{ username: 'LI', displayName: '小李' }],
    });
    expect(value.people[0]).toMatchObject({ username: 'li' });
    expect(value.people[0]?.password).toBeUndefined();
    expect(OrganizationPasswordResetSchema.parse({})).toEqual({});
    expect(() =>
      OrganizationImportSchema.parse({
        people: [{ username: 'li', displayName: '小李', password: 'short' }],
      }),
    ).toThrow();
  });

  it('accepts a short existing credential without lowering the chosen-new-password policy', () => {
    expect(
      LoginInputSchema.parse({ username: 'li', password: 'li@123' }).password,
    ).toBe('li@123');
    expect(
      ChangePasswordInputSchema.parse({
        currentPassword: 'li@123',
        newPassword: 'changed-password',
      }).currentPassword,
    ).toBe('li@123');
    expect(() =>
      ChangePasswordInputSchema.parse({
        currentPassword: 'li@123',
        newPassword: 'short',
      }),
    ).toThrow();
    expect(() =>
      LoginInputSchema.parse({ username: 'li', password: '' }),
    ).toThrow();
  });
});
