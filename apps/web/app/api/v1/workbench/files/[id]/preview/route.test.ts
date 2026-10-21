import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocked = vi.hoisted(() => ({
  context: vi.fn(),
  file: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../../../../../../../lib/identity/session', () => ({
  getRequestContext: mocked.context,
}));
vi.mock('@allrice/database', async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  readWorkbenchFile: mocked.file,
}));
vi.mock('../../../../../../../lib/runtime/static-artifact-preview', () => ({
  readStaticArtifactPreview: mocked.preview,
}));
import { DataAccessError } from '@allrice/database';
import { GET } from './route';
const workspaceId = '00000000-0000-4000-8000-000000000004',
  id = '00000000-0000-4000-8000-000000000901';
const request = () =>
  new Request(
    `http://localhost/api/v1/workbench/files/${id}/preview?workspaceId=${workspaceId}`,
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocked.context.mockResolvedValue({
    actor: { type: 'user', id },
    organizationId: id,
    workspaceId,
  });
  mocked.file.mockResolvedValue({
    object: { id },
    row: { file_name: '收入.txt' },
  });
  mocked.preview.mockResolvedValue({
    kind: 'text',
    text: 'private file bytes',
    mediaType: 'text/plain',
  });
});
it('uses the authoritative filename and checks live file-only authority before and after preview IO', async () => {
  const result = await GET(request(), { params: Promise.resolve({ id }) });
  expect(result.status).toBe(200);
  expect(mocked.file).toHaveBeenCalledTimes(2);
  expect(mocked.preview).toHaveBeenCalledWith(
    expect.objectContaining({ version: { fileName: '收入.txt' } }),
    expect.anything(),
  );
  expect(result.headers.get('cache-control')).toBe('private, no-store');
});
it('discards rendered bytes when file access was withdrawn during IO', async () => {
  mocked.file.mockRejectedValueOnce(new DataAccessError('not_found'));
  const denied = await GET(request(), { params: Promise.resolve({ id }) });
  expect(denied.status).toBe(404);
  expect(mocked.preview).not.toHaveBeenCalled();
  mocked.file
    .mockResolvedValueOnce({ object: { id }, row: { file_name: '收入.txt' } })
    .mockRejectedValueOnce(new DataAccessError('not_found'));
  const withdrawn = await GET(request(), { params: Promise.resolve({ id }) });
  expect(withdrawn.status).toBe(404);
  expect(await withdrawn.text()).not.toContain('private file bytes');
});
it('requires an authenticated current workspace before any file read', async () => {
  mocked.context.mockResolvedValue(null);
  expect(
    (await GET(request(), { params: Promise.resolve({ id }) })).status,
  ).toBe(401);
  expect(mocked.file).not.toHaveBeenCalled();
});
