import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DataAccessError,
  IdentityError,
  LegacyScheduleRetiredError,
} from '@allrice/database';
import type * as DatabaseModule from '@allrice/database';
import { GET } from '../../app/api/v1/files/[id]/download/route';
import { storageErrorResponse } from './responses';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  file: vi.fn(),
  storage: vi.fn(),
}));
vi.mock('../identity/session', () => ({ getRequestContext: ports.context }));
vi.mock('./runtime', () => ({ getStorageAdapter: ports.storage }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  getStoredFile: ports.file,
}));

describe('file download identity responses', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([
    ['authentication_failed', 401, 'AUTHENTICATION_REQUIRED'],
    ['tenant_context_invalid', 403, 'AUTHORIZATION_DENIED'],
    ['authorization_denied', 403, 'AUTHORIZATION_DENIED'],
  ] as const)(
    'rejects %s before reading any file metadata or bytes',
    async (code, status, problemCode) => {
      ports.context.mockRejectedValueOnce(new IdentityError(code));
      const response = await GET(
        new Request('http://localhost/api/v1/files/id/download'),
        {
          params: Promise.resolve({ id: 'requested-private-object' }),
        },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        error: { code: problemCode, retryable: false },
      });
      expect(ports.file).not.toHaveBeenCalled();
      expect(ports.storage).not.toHaveBeenCalled();
    },
  );
  it('preserves existing storage authorization denials', async () => {
    ports.context.mockResolvedValueOnce({
      actor: { type: 'user', id: 'member' },
    });
    ports.file.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    const response = await GET(
      new Request('http://localhost/api/v1/files/id/download'),
      {
        params: Promise.resolve({ id: 'other-member-object' }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED' },
    });
    expect(ports.storage).not.toHaveBeenCalled();
  });
});

it('returns a permanent private retirement response for the old schedule entry points', async () => {
  const response = storageErrorResponse(new LegacyScheduleRetiredError());
  expect(response.status).toBe(410);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toMatchObject({
    error: {
      code: 'CONFLICT',
      retryable: false,
      message:
        '历史定时任务仅支持查看、暂停和删除。后续执行请在对话中创建新任务。',
    },
  });
});
