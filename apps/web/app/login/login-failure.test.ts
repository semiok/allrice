import { describe, expect, it, vi } from 'vitest';
import { LoginInputSchema } from '@allrice/contracts';
import { IdentityError } from '@allrice/database';
import { identityErrorResponse } from '../../lib/identity/responses';
import { loginFailure } from './login-failure';

const entry = {
  adminHost: 'allrice-admin.bplabs.xyz',
  employeeHost: 'allrice.bplabs.xyz',
};
/** The login route answers every failure through identityErrorResponse. */
async function shown(error: unknown) {
  const response = identityErrorResponse(error);
  const body = (await response.json()) as { error: { code: string } };
  return loginFailure(response.status, body.error.code, entry);
}

describe('login failure wording from the real identity responses', () => {
  it('blames the account or password only for credential problems', async () => {
    expect(await shown(new IdentityError('authentication_failed'))).toBe(
      '账号或密码不对，请检查后重新输入。',
    );
    expect(
      await shown(
        LoginInputSchema.safeParse({ username: '张', password: 'x' }).error,
      ),
    ).toBe('账号或密码不对，请检查后重新输入。');
  });

  it('says the service is down when the database fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await shown(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
      ).toBe('暂时登录不了，请稍后再试。');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps the entry hint for an account of the other portal', async () => {
    expect(await shown(new IdentityError('portal_account_mismatch'))).toBe(
      '此账号无法登录这个入口。管理员请从 allrice-admin.bplabs.xyz 登录；员工请从 allrice.bplabs.xyz 登录。',
    );
  });

  it('asks to wait after too many attempts', () => {
    expect(loginFailure(429, undefined, entry)).toBe(
      '尝试次数太多，请稍后再试。',
    );
  });
});
