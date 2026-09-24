import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  file: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  getStoredFile: mocks.file,
}));
vi.mock('../../../../../../lib/runtime/static-artifact-preview', () => ({
  readStaticArtifactPreview: mocks.preview,
}));
import { DataAccessError } from '@allrice/database';
import { GET } from './route';
const workspaceId = '00000000-0000-4000-8000-000000000004';
const id = '00000000-0000-4000-8000-000000000901';
const request = () =>
  new Request(
    `http://localhost/api/v1/files/${id}/preview?workspaceId=${workspaceId}`,
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({
    organizationId: 'org',
    userId: 'user',
    workspaceId,
  });
  mocks.file.mockResolvedValue({ object: { id, workspaceId } });
  mocks.preview.mockResolvedValue({
    kind: 'text',
    text: 'private contents',
    mediaType: 'text/plain',
  });
});
it('uses the existing file authority and rechecks it after preview IO', async () => {
  const response = await GET(request(), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  expect(mocks.file).toHaveBeenCalledTimes(2);
  expect(mocks.file).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId, userId: 'user' }),
    id,
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
it('does not return private bytes if access is revoked during rendering', async () => {
  mocks.file
    .mockResolvedValueOnce({ object: { id, workspaceId } })
    .mockRejectedValueOnce(new DataAccessError('authorization_denied'));
  const response = await GET(request(), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('private contents');
});
it('rejects unauthenticated reads before touching storage', async () => {
  mocks.context.mockResolvedValue(null);
  expect(
    (await GET(request(), { params: Promise.resolve({ id }) })).status,
  ).toBe(401);
  expect(mocks.file).not.toHaveBeenCalled();
  expect(mocks.preview).not.toHaveBeenCalled();
});
