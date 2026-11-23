/** HTTP adapter tests with mocked identity/Port. Real PG audience/audit proof
 * remains in the memory Port and candidate-memory browser integration suites. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const ports = vi.hoisted(() => ({
  source: vi.fn(),
  admin: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  createEmployeeMemoryPort: () => ({ source: ports.source }),
}));
vi.mock('../identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.admin,
}));
vi.mock('../storage/responses', () => ({ storageErrorResponse: ports.error }));
import { GET } from '../../app/api/v1/admin/organizations/[organizationId]/employee-memories/[id]/source/route';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = {
  actor: { type: 'user', id: id(1) },
  memberships: [],
  requestId: id(2),
};
const source = {
  sourceType: 'user',
  sourceLabel: '',
  capturedAt: '2026-11-20T17:34:00.000Z',
};
const params = { organizationId: id(3), id: id(4) };
const url = `https://allrice.test/api/v1/admin/organizations/${params.organizationId}/employee-memories/${params.id}/source?ownerId=${id(5)}&instanceId=${id(6)}`;
const route = () => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.resetAllMocks();
  ports.admin.mockResolvedValue(context);
  ports.source.mockResolvedValue(source);
  ports.error.mockImplementation((cause) =>
    Response.json(
      { error: 'closed' },
      { status: cause instanceof z.ZodError ? 400 : (cause.status ?? 500) },
    ),
  );
});

describe('administrator memory source HTTP adapter', () => {
  it('keeps the real administrator context and passes the exact target and request cancellation', async () => {
    const request = new Request(url);
    const response = await GET(request, route());
    expect(ports.admin).toHaveBeenCalledExactlyOnceWith(request);
    expect(ports.source).toHaveBeenCalledExactlyOnceWith(
      context,
      {
        organizationId: id(3),
        ownerId: id(5),
        instanceId: id(6),
        memoryId: id(4),
      },
      request.signal,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(source);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each([401, 403])(
    'rejects a non-admin identity (%s) before reading any memory',
    async (status) => {
      ports.admin.mockRejectedValueOnce({ status });
      const response = await GET(new Request(url), route());
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(ports.source).not.toHaveBeenCalled();
    },
  );
  it.each([
    '&workspaceId=' + id(7),
    '&memoryId=' + id(8),
    '&organizationId=' + id(8),
    '&audience=personal',
  ])('rejects an extra selector %s', async (extra) => {
    const response = await GET(new Request(url + extra), route());
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(ports.source).not.toHaveBeenCalled();
  });
  it('validates path IDs and forwards a lawful cross-target denial without substituting the owner', async () => {
    expect(
      (
        await GET(new Request(url), {
          params: Promise.resolve({ ...params, id: 'invalid' }),
        })
      ).status,
    ).toBe(400);
    expect(ports.source).not.toHaveBeenCalled();
    ports.source.mockRejectedValueOnce({ status: 404 });
    const other = { organizationId: id(9), id: id(10) };
    const response = await GET(new Request(url), {
      params: Promise.resolve(other),
    });
    expect(ports.source).toHaveBeenCalledWith(
      context,
      {
        organizationId: id(9),
        memoryId: id(10),
        ownerId: id(5),
        instanceId: id(6),
      },
      expect.any(AbortSignal),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'closed' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('rejects raw source fields and preserves no-store on unexpected Port errors', async () => {
    ports.source.mockResolvedValueOnce({ ...source, rawMessage: 'private' });
    const malformed = await GET(new Request(url), route());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'closed' });
    ports.source.mockRejectedValueOnce({ status: 503 });
    const unavailable = await GET(new Request(url), route());
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('cache-control')).toBe('private, no-store');
  });
  it('propagates request cancellation while the Port owns completion and audit lifetime', async () => {
    let release!: () => void;
    ports.source.mockImplementationOnce(
      async (_context, _input, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        signal.throwIfAborted();
        return source;
      },
    );
    const controller = new AbortController();
    const request = new Request(url, { signal: controller.signal });
    const pending = GET(request, route());
    await vi.waitFor(() => expect(ports.source).toHaveBeenCalledOnce());
    expect(ports.source.mock.calls[0]?.[2]).toBe(request.signal);
    controller.abort();
    release();
    const response = await pending;
    expect(request.signal.aborted).toBe(true);
    expect(ports.error).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'AbortError' }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'closed' });
  });
});
