import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const ports = vi.hoisted(() => ({
  context: vi.fn(),
  file: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('../../../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readWorkbenchFile: ports.file,
}));
vi.mock('../../../../../../../lib/storage/runtime', () => ({
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
const object = { id, mediaType: 'application/pdf', sizeBytes: bytes.length };
const request = (workspace = workspaceId) =>
  new Request(
    `https://allrice.test/api/v1/workbench/files/${id}/download?workspaceId=${workspace}&name=untrusted-name.pdf`,
  );
const params = { params: Promise.resolve({ id }) };
beforeEach(() => {
  vi.resetAllMocks();
  ports.context.mockResolvedValue(context);
  ports.file.mockResolvedValue({ object, row: { file_name: '原件.pdf' } });
  ports.stream.mockImplementation(() => new Blob([bytes]).stream());
});
it.each([
  'a'.repeat(156) + '（2）.pdf',
  'a'.repeat(155) + '（2）.😀xx',
  'a'.repeat(248) + '（2）.pdf',
])(
  'uses the complete authorized final name %s and original bytes',
  async (name) => {
    ports.file.mockResolvedValue({ object, row: { file_name: name } });
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(ports.file).toHaveBeenCalledTimes(2);
    expect(ports.file).toHaveBeenNthCalledWith(1, context, id);
    expect(ports.file).toHaveBeenNthCalledWith(2, context, id);
    expect(ports.stream).toHaveBeenCalledExactlyOnceWith(object);
  },
);
it('preserves file-only sanitization, including DEL, without trusting the URL name', async () => {
  ports.file.mockResolvedValue({
    object,
    row: { file_name: 'before/after\\end\r\n\x7f.pdf' },
  });
  const response = await GET(request(), params);
  expect(response.headers.get('content-disposition')).toBe(
    `attachment; filename*=UTF-8''before-after-end---.pdf`,
  );
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});
it('cancels private bytes if file authority is withdrawn during IO', async () => {
  const cancel = vi.fn();
  ports.stream.mockResolvedValue(new ReadableStream({ cancel }));
  ports.file
    .mockResolvedValueOnce({ object, row: { file_name: '原件.pdf' } })
    .mockRejectedValueOnce(new DataAccessError('not_found'));
  const response = await GET(request(), params);
  expect(response.status).toBe(404);
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});
it('keeps current login/workspace checks before any file or storage read', async () => {
  expect((await GET(request(id), params)).status).toBe(403);
  ports.context.mockResolvedValue(null);
  expect((await GET(request(), params)).status).toBe(401);
  expect(ports.file).not.toHaveBeenCalled();
  expect(ports.stream).not.toHaveBeenCalled();
});
