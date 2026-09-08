import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, RuntimePolicyError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('../../../../../lib/identity/session', () => ({
  requireRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listCloudRuntimeOperations: mocks.list,
  cancelCloudRuntimeRun: mocks.cancel,
}));
import { GET, POST } from './route';
const workspaceId = randomUUID(),
  runId = randomUUID();
const url = `https://allrice.test/api/v1/runtime/cloud-operations?workspaceId=${workspaceId}&runId=${runId}`;
const post = (body: unknown, origin = 'https://allrice.test') =>
  new Request(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('Cloud operation read/cancel HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      actor: { type: 'user', id: randomUUID() },
      workspaceId,
    });
    mocks.list.mockResolvedValue([{ historical: true }]);
    mocks.cancel.mockResolvedValue({ accepted: true, remoteStopped: false });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('reads history with new-execution flags disabled and private no-store responses', async () => {
    vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '0');
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      operations: [{ historical: true }],
    });
  });
  it('only forwards authenticated cancel intent, never a tool payload', async () => {
    expect((await POST(post({ runId, action: 'cancel' }))).status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
      runId,
    );
    expect(
      (await POST(post({ runId, action: 'call', tool: 'records.append' })))
        .status,
    ).toBe(400);
    expect(mocks.cancel).toHaveBeenCalledOnce();
  });
  it('rejects missing/cross origin and oversized inputs', async () => {
    expect(
      (await POST(post({ runId, action: 'cancel' }, 'https://attacker.test')))
        .status,
    ).toBe(403);
    expect((await POST(new Request(url, { method: 'POST' }))).status).toBe(403);
    expect(
      (await POST(post({ runId, action: 'cancel', secret: 'x'.repeat(3000) })))
        .status,
    ).toBe(400);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('requires login and current DB owner authority without reflecting errors', async () => {
    mocks.context.mockRejectedValueOnce(
      new DataAccessError('authentication_required'),
    );
    expect((await GET(new Request(url))).status).toBe(401);
    mocks.list.mockRejectedValueOnce(new RuntimePolicyError('run_not_owned'));
    expect((await GET(new Request(url))).status).toBe(403);
    mocks.list.mockRejectedValueOnce(Error('secret underlying database URL'));
    const result = await GET(new Request(url));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('secret');
  });
});
