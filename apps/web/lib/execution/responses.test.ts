import { describe, expect, it } from 'vitest';

import { IdentityError } from '@allrice/database';

import { executionErrorResponse } from './responses';

it.each([
  ['platform_employee_published_revision_immutable', '先保存为新草稿'],
  ['platform_employee_draft_unavailable', '保存新草稿'],
  ['platform_employee_publish_snapshot_changed', '重新试用'],
  ['platform_employee_publish_policy_changed', '重新预检并确认发布范围'],
  ['platform_employee_publish_workspace_unavailable', '重新选择'],
  ['platform_employee_publish_provider_unavailable', '服务恢复'],
  ['platform_employee_publish_test_unavailable', '重新试用'],
])(
  'explains publication conflict %s without an automatic retry',
  async (reason, guidance) => {
    const response = executionErrorResponse(new Error(reason));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: 'CONFLICT', retryable: false });
    expect(body.error.message).toContain(guidance);
  },
);

describe('execution error responses', () => {
  it('returns 403 when tenant selection is outside the actor membership', async () => {
    const response = executionErrorResponse(
      new IdentityError('tenant_context_invalid'),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED', retryable: false },
    });
  });

  it('returns 401 when session authentication fails', async () => {
    const response = executionErrorResponse(
      new IdentityError('authentication_failed'),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED', retryable: false },
    });
  });
});
