import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({ context: vi.fn(), create: vi.fn() }));
vi.mock('../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createChatSession: mocks.create,
}));
import { POST } from './route';

describe('ordinary conversation capability freeze', () => {
  beforeEach(() => vi.clearAllMocks());
  it('enables the server-side freeze independently of request input', async () => {
    const context = { actor: { type: 'user', id: 'owner' } };
    const body = {
      workspaceId: 'workspace',
      title: 'Conversation',
      freezeAccountCapabilities: false,
    };
    mocks.context.mockResolvedValue(context);
    mocks.create.mockResolvedValue({ id: 'session' });
    const response = await POST(
      new Request('https://allrice.test/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(context, body, {
      freezeAccountCapabilities: true,
    });
  });
  it('does not create a conversation without authentication', async () => {
    mocks.context.mockResolvedValue(null);
    expect(
      (
        await POST(
          new Request('https://allrice.test/api/v1/sessions', {
            method: 'POST',
            body: '{}',
          }),
        )
      ).status,
    ).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
