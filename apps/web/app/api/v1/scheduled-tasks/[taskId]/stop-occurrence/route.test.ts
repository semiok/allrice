import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  auth: vi.fn(),
  stop: vi.fn(),
  read: vi.fn(),
  context: { principal: 'current-user' },
}));
vi.mock('@allrice/database', () => ({
  DataAccessError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  stopAutomationCatalogOccurrence: f.stop,
  getAutomationCatalogOccurrenceRun: f.read,
  NativeRecurringProductError: class extends Error {},
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: f.auth,
}));
vi.mock('../../../../../../lib/execution/responses', () => ({
  executionErrorResponse: (error: { code?: string }) =>
    Response.json(
      {},
      { status: error.code === 'authentication_required' ? 401 : 400 },
    ),
}));
vi.mock('../../../../../../lib/storage/responses', () => ({
  storageErrorResponse: vi.fn(),
}));
import { GET, POST } from './route';
const WORKSPACE = '11111111-1111-4111-8111-111111111111',
  TASK = '22222222-2222-4222-8222-222222222222',
  OCCURRENCE = '33333333-3333-4333-8333-333333333333',
  RUN = '44444444-4444-4444-8444-444444444444';
const url = `https://fixture.test/api/v1/scheduled-tasks/${TASK}/stop-occurrence?workspaceId=${WORKSPACE}`;
const params = { params: Promise.resolve({ taskId: TASK }) };
const body = { occurrenceId: OCCURRENCE, runId: RUN };
function post(target = url, origin = 'https://fixture.test') {
  return new Request(target, {
    method: 'POST',
    headers: {
      origin,
      host: 'fixture.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  f.auth.mockResolvedValue(f.context);
  f.stop.mockResolvedValue({ exact: true });
  f.read.mockResolvedValue({ exact: true });
});
describe('occurrence stop transport', () => {
  it('requires same-origin authenticated browser authority', async () => {
    expect((await POST(post(url, 'https://other.test'), params)).status).toBe(
      403,
    );
    expect(f.auth).not.toHaveBeenCalled();
    f.auth.mockResolvedValue(null);
    expect((await POST(post(), params)).status).toBe(401);
    expect(
      (
        await GET(
          new Request(url + `&occurrenceId=${OCCURRENCE}&runId=${RUN}`),
          params,
        )
      ).status,
    ).toBe(401);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('passes only the original exact task/occurrence/Run to one stop call', async () => {
    expect((await POST(post(), params)).status).toBe(200);
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(
      f.context,
      WORKSPACE,
      TASK,
      body,
    );
    expect(f.read).not.toHaveBeenCalled();
  });
  it('readback never invokes the write, even while the Run remains active', async () => {
    expect(
      (
        await GET(
          new Request(url + `&occurrenceId=${OCCURRENCE}&runId=${RUN}`),
          params,
        )
      ).status,
    ).toBe(200);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(
      f.context,
      WORKSPACE,
      TASK,
      body,
    );
    expect(f.stop).not.toHaveBeenCalled();
  });
  it('rejects missing, duplicate and scope-broadening queries before either service', async () => {
    for (const suffix of [
      `&workspaceId=${WORKSPACE}`,
      `&ownerId=${RUN}`,
      `&runId=${RUN}`,
    ])
      expect((await POST(post(url + suffix), params)).status).toBe(400);
    for (const suffix of [
      '',
      `&occurrenceId=${OCCURRENCE}`,
      `&occurrenceId=${OCCURRENCE}&runId=${RUN}&latest=true`,
      `&occurrenceId=${OCCURRENCE}&runId=${RUN}&runId=${RUN}`,
    ])
      expect((await GET(new Request(url + suffix), params)).status).toBe(400);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('preserves explicit manual source during readback on a native parent', async () => {
    expect(
      (
        await GET(
          new Request(
            url + `&occurrenceId=${OCCURRENCE}&runId=${RUN}&source=manual`,
          ),
          params,
        )
      ).status,
    ).toBe(200);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.context, WORKSPACE, TASK, {
      ...body,
      source: 'manual',
    });
    expect(f.stop).not.toHaveBeenCalled();
  });
});
