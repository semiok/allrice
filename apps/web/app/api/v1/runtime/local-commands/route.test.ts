import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '@allrice/database';
import { RuntimePolicyError } from '@allrice/database';
import { GET, POST } from './route';

const ports = vi.hoisted(() => ({
  enabled: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
  context: vi.fn(),
}));
vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  localCommandFeatureEnabled: ports.enabled,
  listLocalCommandOperations: ports.list,
  cancelLocalCommandRun: ports.cancel,
}));
const context = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
};
const runId = randomUUID();
const request = (
  method = 'GET',
  origin = 'http://localhost',
  query = `runId=${runId}`,
) =>
  new Request(`http://localhost/api/v1/runtime/local-commands?${query}`, {
    method,
    headers: { origin },
  });
describe('local command browser boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.enabled.mockReturnValue(true);
    ports.context.mockResolvedValue(context);
    ports.list.mockResolvedValue([]);
    ports.cancel.mockResolvedValue({ status: 'cancel_requested' });
  });
  it('keeps the opt-in route invisible and does not authenticate while off', async () => {
    ports.enabled.mockReturnValue(false);
    expect((await GET(request())).status).toBe(404);
    expect((await POST(request('POST'))).status).toBe(404);
    expect(ports.context).not.toHaveBeenCalled();
    expect(ports.cancel).not.toHaveBeenCalled();
  });
  it('does not accept cross-origin cancellation or forwarded-origin spoofing', async () => {
    expect(
      (await POST(request('POST', 'https://attacker.invalid'))).status,
    ).toBe(403);
    const input = request('POST', 'https://attacker.invalid');
    input.headers.set('x-forwarded-host', 'attacker.invalid');
    expect((await POST(input)).status).toBe(403);
    expect(ports.cancel).not.toHaveBeenCalled();
  });
  it('requires an authenticated actor for reads and writes', async () => {
    ports.context.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect((await POST(request('POST'))).status).toBe(401);
    expect(ports.list).not.toHaveBeenCalled();
    expect(ports.cancel).not.toHaveBeenCalled();
  });
  it('validates both identifiers before the database and never reflects submitted input', async () => {
    for (const query of [
      'runId=synthetic-private',
      `runId=${runId}&workspaceId=bad`,
    ]) {
      const response = await GET(request('GET', 'http://localhost', query));
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('{"code":"INVALID_REQUEST"}');
    }
    expect(ports.list).not.toHaveBeenCalled();
  });
  it('retains the authenticated actor and delegates workspace ownership to the authoritative database', async () => {
    const workspaceId = randomUUID();
    const response = await GET(
      request(
        'GET',
        'http://localhost',
        `runId=${runId}&workspaceId=${workspaceId}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(ports.list).toHaveBeenCalledWith({ ...context, workspaceId }, runId);
    expect(ports.cancel).not.toHaveBeenCalled();
  });
  it('returns cancellation intent, not fabricated process termination', async () => {
    const response = await POST(request('POST'));
    expect(await response.json()).toEqual({ status: 'cancel_requested' });
    expect(ports.cancel).toHaveBeenCalledWith(context, runId);
  });
  it('hides database diagnostics and preserves scope denials', async () => {
    ports.list.mockRejectedValueOnce(new Error('SYNTHETIC_SECRET_DB'));
    let response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('SYNTHETIC');
    ports.list.mockRejectedValueOnce(
      new RuntimePolicyError('operation_not_found'),
    );
    response = await GET(request());
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});
