import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { GET, POST } from './route';
const ports = vi.hoisted(() => ({
  context: vi.fn(),
  enabled: vi.fn(),
  list: vi.fn(),
  owns: vi.fn(),
  cancel: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../../../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  changesetFeatureEnabled: ports.enabled,
  listChangesetRuns: ports.list,
  getChangesetRun: ports.owns,
  cancelRun: ports.cancel,
  cancelLocalCommandRun: ports.stop,
}));
const sessionId = randomUUID(),
  artifactId = randomUUID(),
  workspaceId = randomUUID(),
  runId = randomUUID();
const context = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId,
};
const route = { params: Promise.resolve({ id: sessionId, artifactId }) };
const request = (
  body = JSON.stringify({ runId }),
  origin = 'http://localhost',
) =>
  new Request(
    `http://localhost/api/v1/sessions/${sessionId}/artifacts/${artifactId}/executions?workspaceId=${workspaceId}`,
    {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body,
    },
  );
describe('P08 execution browser boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.enabled.mockReturnValue(true);
    ports.context.mockResolvedValue(context);
    ports.list.mockResolvedValue([]);
    ports.owns.mockResolvedValue(true);
  });
  it('flag off is inert; missing/foreign Origin cannot cancel', async () => {
    ports.enabled.mockReturnValue(false);
    expect((await POST(request(), route)).status).toBe(404);
    expect(ports.context).not.toHaveBeenCalled();
    ports.enabled.mockReturnValue(true);
    const req = request();
    req.headers.delete('origin');
    expect((await POST(req, route)).status).toBe(403);
    expect(
      (await POST(request(undefined, 'https://foreign.invalid'), route)).status,
    ).toBe(403);
    expect(ports.cancel).not.toHaveBeenCalled();
  });
  it('requires login before parsing and does not cache scoped reads', async () => {
    ports.context.mockResolvedValue(null);
    expect((await POST(request('{bad'), route)).status).toBe(401);
    expect(ports.list).not.toHaveBeenCalled();
    ports.context.mockResolvedValue(context);
    const result = await GET(new Request(request().url), route);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(ports.list).toHaveBeenCalledWith(context, sessionId, artifactId);
  });
  it('bounds actual bytes, not Content-Length; rejects extra mutable authority', async () => {
    const req = request(JSON.stringify({ runId, text: 'x'.repeat(5000) }));
    req.headers.set('content-length', '1');
    expect((await POST(req, route)).status).toBe(413);
    expect(
      (await POST(request(JSON.stringify({ runId, approved: true })), route))
        .status,
    ).toBe(400);
    expect(ports.cancel).not.toHaveBeenCalled();
  });
  it('cannot cancel another artifact/session Run; rechecks association before intent', async () => {
    expect((await POST(request(), route)).status).toBe(404);
    ports.list.mockResolvedValue([{ runId, snapshot: {} }]);
    ports.owns.mockResolvedValue(false);
    expect((await POST(request(), route)).status).toBe(404);
    expect(ports.cancel).not.toHaveBeenCalled();
    ports.owns.mockResolvedValue(true);
    const response = await POST(request(), route);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'cancel_requested' });
    expect(ports.cancel).toHaveBeenCalledWith(context, workspaceId, runId, {
      reason: '用户取消文件任务',
    });
    expect(ports.stop).toHaveBeenCalledWith(context, runId);
  });
  it('does not reflect private database/file errors', async () => {
    ports.list.mockRejectedValue(Error('SYNTHETIC_PRIVATE_PATH'));
    const r = await GET(new Request(request().url), route);
    expect(r.status).toBe(409);
    expect(await r.text()).not.toContain('SYNTHETIC_PRIVATE_PATH');
  });
});
