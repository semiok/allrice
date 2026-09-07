import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DatabaseModule from '@allrice/database';
import { GET, POST, DELETE } from './route';

const ports = vi.hoisted(() => ({
  get: vi.fn(),
  decide: vi.fn(),
  revoke: vi.fn(),
  context: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof DatabaseModule>()),
  getRuntimeActionApproval: ports.get,
  decideRuntimeActionApproval: ports.decide,
  revokeRuntimeActionApproval: ports.revoke,
}));
const params = {
  params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }),
};
const context = {
  actor: { type: 'user', id: 'actor' },
  organizationId: 'trusted-tenant',
  workspaceId: 'trusted-workspace',
};
const request = (body: unknown) =>
  new Request('http://localhost/api/v1/runtime/approvals/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  });
describe('runtime approval HTTP boundary', () => {
  beforeEach(() => {
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
    vi.clearAllMocks();
    ports.context.mockResolvedValue(context);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('default-off route does not authenticate or touch approval state', async () => {
    vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '0');
    expect((await POST(request({}), params)).status).toBe(404);
    expect(ports.context).not.toHaveBeenCalled();
    expect(ports.decide).not.toHaveBeenCalled();
  });
  it('requires existing authenticated context', async () => {
    ports.context.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost'), params)).status).toBe(
      401,
    );
    expect(ports.get).not.toHaveBeenCalled();
  });
  it('read uses trusted context and is no-store; does not dispatch', async () => {
    ports.get.mockResolvedValue({
      request: { kind: 'action_approval' },
      consumedAt: null,
    });
    const response = await GET(new Request('http://localhost'), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(ports.get).toHaveBeenCalledWith(context, (await params.params).id);
    expect(ports.decide).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON without returning or logging its payload', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await POST(
      new Request('http://localhost', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
        },
        body: 'SECRET_SYNTHETIC_NOT_JSON',
      }),
      params,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('SECRET_SYNTHETIC');
    expect(log).not.toHaveBeenCalled();
    expect(ports.decide).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('bounds chunked bodies without trusting Content-Length', async () => {
    const response = await POST(
      request({ content: 'x'.repeat(70_000) }),
      params,
    );
    expect(response.status).toBe(413);
    expect(ports.decide).not.toHaveBeenCalled();
  });
  it('does not serialize or log internal database/adapter errors', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.get.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_INPUT'));
    const response = await GET(new Request('http://localhost'), params);
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_INPUT');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('forwards typed decision to persistent authority, not arbitrary tool execution', async () => {
    ports.decide.mockResolvedValue({ decision: 'approved' });
    const input = { kind: 'action_approval', decision: 'approved' };
    expect((await POST(request(input), params)).status).toBe(200);
    expect(ports.decide).toHaveBeenCalledWith(
      context,
      (await params.params).id,
      input,
    );
  });
  it('revocation does not claim actual device stop', async () => {
    ports.revoke.mockResolvedValue({ revoked: true, executionStopped: false });
    const response = await DELETE(
      new Request('http://localhost', {
        method: 'DELETE',
        headers: { origin: 'http://localhost' },
      }),
      params,
    );
    expect(await response.json()).toEqual({
      revoked: true,
      executionStopped: false,
    });
  });
});
