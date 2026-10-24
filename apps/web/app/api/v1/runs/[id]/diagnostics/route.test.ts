import { afterEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type * as Diagnostics from '../../../../../../lib/execution/native-run-diagnostics';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  run: vi.fn(),
  read: vi.fn(),
  cookies: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getRun: mocks.run,
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  requireRequestContext: mocks.context,
  sessionCookieName: 'allrice_session',
}));
vi.mock(
  '../../../../../../lib/execution/native-run-diagnostics',
  async (original) => ({
    ...(await original<typeof Diagnostics>()),
    requestNativeRunDiagnostics: mocks.read,
  }),
);
import { DataAccessError, QueueError } from '@allrice/database';
import { GET } from './route';
afterEach(() => vi.resetAllMocks());
const id = '11111111-1111-4111-8111-111111111111',
  workspaceId = '22222222-2222-4222-8222-222222222222';
const context = { actor: { type: 'user', id: 'owner' }, organizationId: 'org' };
function setup() {
  mocks.context.mockResolvedValue(context);
  mocks.run.mockResolvedValue({ id, ownerId: 'owner' });
  mocks.cookies.mockResolvedValue({ get: () => ({ value: 'session-token' }) });
  mocks.read.mockResolvedValue({ runId: id, status: 'partial' });
}
function request() {
  return GET(
    new Request(
      `http://localhost/api/v1/runs/${id}/diagnostics?workspaceId=${workspaceId}`,
    ),
    { params: Promise.resolve({ id }) },
  );
}
it('uses ordinary Run auth and relays the actual user session only after ownership succeeds', async () => {
  setup();
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mocks.run).toHaveBeenCalledWith(context, workspaceId, id);
  expect(mocks.read).toHaveBeenCalledWith(
    expect.objectContaining({
      token: 'session-token',
      context,
      workspaceId,
      runId: id,
    }),
  );
});
it('refuses a same-company peer without contacting Worker or revealing native state', async () => {
  setup();
  mocks.run.mockResolvedValue({ id, ownerId: 'peer' });
  expect((await request()).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
});
it('preserves foreign Run and anonymous rejections', async () => {
  setup();
  mocks.run.mockRejectedValue(new QueueError('not_found'));
  expect((await request()).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.context.mockRejectedValue(
    new DataAccessError('authentication_required'),
  );
  expect((await request()).status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled();
});
