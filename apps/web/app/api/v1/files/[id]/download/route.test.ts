import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const ports = vi.hoisted(() => ({
  context: vi.fn(),
  file: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getStoredFile: ports.file,
}));
vi.mock('../../../../../../lib/storage/runtime', () => ({
  getStorageAdapter: () => ({ get: ports.stream }),
}));
import { DataAccessError } from '@allrice/database';
import { GET } from './route';
const id = '00000000-0000-4000-8000-000000000901',
  workspaceId = '00000000-0000-4000-8000-000000000004',
  bytes = new Uint8Array([0, 255, 13, 10, 65]);
const context = {
  actor: { type: 'user', id },
  organizationId: id,
  workspaceId,
};
const object = {
  id,
  mediaType: 'application/pdf',
  sizeBytes: bytes.length,
};
const request = (name: string) =>
  new Request(
    `https://allrice.test/api/v1/files/${id}/download?name=${encodeURIComponent(name)}`,
  );
const params = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.resetAllMocks();
  ports.context.mockResolvedValue(context);
  ports.file.mockResolvedValue({ object });
  ports.stream.mockImplementation(() => new Blob([bytes]).stream());
});
it.each([
  'a'.repeat(156) + '（2）.pdf',
  'a'.repeat(155) + '（2）.😀xx',
  'a'.repeat(248) + '（2）.pdf',
])(
  'downloads the complete persisted final name %s and original bytes',
  async (name) => {
    const response = await GET(request(name), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(ports.file).toHaveBeenCalledExactlyOnceWith(context, id);
    expect(ports.stream).toHaveBeenCalledExactlyOnceWith(object);
  },
);
it('keeps existing dangerous-character cleanup and truncates untrusted excess only at a code point', async () => {
  for (const [raw, name] of [
    ['before/after\\end\r\n.txt', 'before-after-end--.txt'],
    ['a'.repeat(254) + '😀.pdf', 'a'.repeat(254)],
  ]) {
    const response = await GET(request(raw!), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(name!)}`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  }
});
it('retains current login and file authorization before any private byte read', async () => {
  ports.context.mockResolvedValue(null);
  expect((await GET(request('file.pdf'), params)).status).toBe(401);
  expect(ports.file).not.toHaveBeenCalled();
  expect(ports.stream).not.toHaveBeenCalled();
  ports.context.mockResolvedValue(context);
  ports.file.mockRejectedValue(new DataAccessError('authorization_denied'));
  const denied = await GET(request('file.pdf'), params);
  expect(denied.status).toBe(403);
  expect(denied.headers.get('content-disposition')).toBeNull();
  expect(ports.stream).not.toHaveBeenCalled();
});
