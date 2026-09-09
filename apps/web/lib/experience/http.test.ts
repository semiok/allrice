import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { ExperienceError } from '@allrice/database';
import { experienceHttp } from './http';
const ports = vi.hoisted(() => ({
  enabled: vi.fn(),
  context: vi.fn(),
  list: vi.fn(),
  sources: vi.fn(),
  create: vi.fn(),
  review: vi.fn(),
}));
vi.mock('../identity/session', () => ({ getRequestContext: ports.context }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  experienceReviewEnabled: ports.enabled,
  createExperienceStore: () => ports,
}));
const context = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
};
const request = (data?: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/experiences', {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
describe('P20 HTTP boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.enabled.mockReturnValue(true);
    ports.context.mockResolvedValue(context);
    ports.list.mockResolvedValue([]);
    ports.create.mockResolvedValue({ id: randomUUID() });
  });
  it('default-off does not resolve credentials or database', async () => {
    ports.enabled.mockReturnValue(false);
    expect((await experienceHttp(request(), 'list')).status).toBe(404);
    expect(ports.context).not.toHaveBeenCalled();
    expect(ports.list).not.toHaveBeenCalled();
  });
  it('separates authentication and browser origin without a mutation', async () => {
    ports.context.mockResolvedValue(null);
    expect((await experienceHttp(request(), 'list')).status).toBe(401);
    expect(
      (
        await experienceHttp(
          request({ decision: 'approve' }, 'https://foreign.invalid'),
          'review',
          randomUUID(),
        )
      ).status,
    ).toBe(403);
    expect(ports.review).not.toHaveBeenCalled();
  });
  it('delegates exact authenticated workspace and persists through the store only', async () => {
    const response = await experienceHttp(
      request({ content: 'rule' }),
      'create',
    );
    expect(response.status).toBe(201);
    expect(ports.create).toHaveBeenCalledWith(context, { content: 'rule' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('bounds JSON and validates route identity before mutation', async () => {
    expect(
      (await experienceHttp(request('x'.repeat(40_001)), 'create')).status,
    ).toBe(400);
    expect((await experienceHttp(request({}), 'review', 'wrong')).status).toBe(
      400,
    );
    expect(
      (
        await experienceHttp(
          new Request('http://localhost/experiences?workspaceId=wrong'),
          'list',
        )
      ).status,
    ).toBe(400);
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.review).not.toHaveBeenCalled();
  });
  it.each([
    ['conflict', 409],
    ['source_changed', 409],
    ['identity_denied', 403],
    ['platform_publication_required', 403],
    ['not_found', 404],
    ['invalid_source', 400],
  ] as const)('maps %s without leaking record data', async (code, status) => {
    ports.review.mockRejectedValue(new ExperienceError(code));
    const response = await experienceHttp(request({}), 'review', randomUUID());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
  });
  it('does not reflect unexpected database diagnostics', async () => {
    ports.list.mockRejectedValue(
      new Error('PRIVATE DATABASE CONNECTION STRING'),
    );
    const response = await experienceHttp(request(), 'list');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE');
  });
});
