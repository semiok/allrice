import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { ArtifactReviewError } from '@allrice/database';
import { POST } from './route';

const ports = vi.hoisted(() => ({ context: vi.fn(), send: vi.fn() }));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  sendChatMessage: ports.send,
}));
const sessionId = randomUUID(),
  workspaceId = randomUUID();
const context = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId,
};
const input = {
  clientMessageId: randomUUID(),
  text: 'synthetic input',
  mode: 'follow_up',
};
const request = (body = JSON.stringify(input), origin = 'http://localhost') =>
  new Request(
    `http://localhost/api/v1/sessions/${sessionId}/messages?workspaceId=${workspaceId}`,
    {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json' },
      body,
    },
  );
const call = (req = request()) =>
  POST(req, { params: Promise.resolve({ id: sessionId }) });
describe('typed message browser boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.context.mockResolvedValue(context);
    ports.send.mockResolvedValue({ created: true });
  });
  it('rejects missing or foreign Origin without enqueueing', async () => {
    const missing = request();
    missing.headers.delete('origin');
    expect((await call(missing)).status).toBe(403);
    const forged = request(undefined, 'https://foreign.invalid');
    forged.headers.set('x-forwarded-host', 'foreign.invalid');
    expect((await call(forged)).status).toBe(403);
    expect(ports.context).not.toHaveBeenCalled();
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('requires a logged-in actor before reading input', async () => {
    ports.context.mockResolvedValue(null);
    expect((await call(request('{invalid'))).status).toBe(401);
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('limits actual streamed bytes, not Content-Length or character count', async () => {
    const req = request(JSON.stringify({ text: '测'.repeat(100_001) }));
    req.headers.set('content-length', '1');
    expect((await call(req)).status).toBe(413);
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('rejects malformed or empty JSON without reflecting content', async () => {
    const response = await call(request('{SYNTHETIC_PRIVATE'));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE');
    expect(
      (
        await call(
          new Request(request().url, {
            method: 'POST',
            headers: { origin: 'http://localhost' },
          }),
        )
      ).status,
    ).toBe(400);
    expect(ports.send).not.toHaveBeenCalled();
  });
  it('preserves the authenticated actor and returns non-cacheable new/replayed receipts', async () => {
    const created = await call();
    expect(created.status).toBe(202);
    expect(created.headers.get('cache-control')).toContain('no-store');
    expect(ports.send).toHaveBeenCalledWith(
      context,
      workspaceId,
      sessionId,
      input,
    );
    ports.send.mockResolvedValue({ created: false });
    expect((await call()).status).toBe(200);
  });
  it('explains version and turn conflicts without executing a fallback', async () => {
    for (const error of [
      new ArtifactReviewError('version_conflict'),
      new ArtifactReviewError('input_turn_changed'),
    ]) {
      ports.send.mockRejectedValueOnce(error);
      const response = await call();
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect((await response.json()).error.code).toBe(error.code);
    }
    expect(ports.send).toHaveBeenCalledTimes(2);
  });
});
