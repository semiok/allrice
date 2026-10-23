import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  auth: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  context: { principal: 'current-browser' },
}));
vi.mock('@allrice/database', () => ({
  DataAccessError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  ManualAutomationRunError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  NativeRecurringProductError: class extends Error {},
  runManualAutomation: f.write,
  getManualAutomationRun: f.read,
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: f.auth,
}));
vi.mock('../../../../../../lib/execution/responses', () => ({
  executionErrorResponse: (error: { code?: string }) =>
    Response.json(
      { error: error.code ?? 'unknown' },
      { status: error.code === 'authentication_required' ? 401 : 400 },
    ),
}));
vi.mock('../../../../../../lib/storage/responses', () => ({
  storageErrorResponse: vi.fn(),
}));
import { ManualAutomationRunError } from '@allrice/database';
import { GET, POST } from './route';
const WORKSPACE = '11111111-1111-4111-8111-111111111111',
  TASK = '22222222-2222-4222-8222-222222222222',
  REQUEST = '33333333-3333-4333-8333-333333333333',
  RUN = '44444444-4444-4444-8444-444444444444';
const url = `https://fixture.test/api/v1/scheduled-tasks/${TASK}/run?workspaceId=${WORKSPACE}`,
  params = { params: Promise.resolve({ taskId: TASK }) },
  body = { requestId: REQUEST, expectedRevision: 3 };
function post(
  value: unknown = body,
  target = url,
  origin = 'https://fixture.test',
) {
  return new Request(target, {
    method: 'POST',
    headers: {
      origin,
      host: 'fixture.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  f.auth.mockResolvedValue(f.context);
  f.write.mockResolvedValue({ exact: true });
  f.read.mockResolvedValue({ exact: true });
});
describe('native plan manual transport', () => {
  it('requires same-origin authenticated browser authority before creation', async () => {
    expect(
      (await POST(post(body, url, 'https://foreign.test'), params)).status,
    ).toBe(403);
    expect(f.auth).not.toHaveBeenCalled();
    f.auth.mockResolvedValue(null);
    expect((await POST(post(), params)).status).toBe(401);
    expect(
      (await GET(new Request(url + `&requestId=${REQUEST}`), params)).status,
    ).toBe(401);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('passes only one original request and expected revision to the transactional service', async () => {
    expect((await POST(post(), params)).status).toBe(202);
    expect(f.write).toHaveBeenCalledExactlyOnceWith(
      f.context,
      WORKSPACE,
      TASK,
      body,
    );
    expect(f.read).not.toHaveBeenCalled();
  });
  it('reads only the original request/optional Run and never replays a create', async () => {
    expect(
      (
        await GET(
          new Request(url + `&requestId=${REQUEST}&runId=${RUN}`),
          params,
        )
      ).status,
    ).toBe(200);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(
      f.context,
      WORKSPACE,
      TASK,
      REQUEST,
      RUN,
    );
    expect(f.write).not.toHaveBeenCalled();
  });
  it('rejects fake native inputs, duplicate queries and latest selectors before business admission', async () => {
    for (const value of [
      { ...body, scheduledAt: '2026-10-22T00:00:00Z' },
      { ...body, source: 'native' },
      { ...body, expectedRevision: 0 },
    ])
      expect((await POST(post(value), params)).status).toBe(400);
    for (const suffix of [
      `&workspaceId=${WORKSPACE}`,
      `&ownerId=${RUN}`,
      `&requestId=${REQUEST}`,
    ])
      expect((await POST(post(body, url + suffix), params)).status).toBe(400);
    for (const suffix of [
      '',
      `&requestId=${REQUEST}&latest=true`,
      `&requestId=${REQUEST}&requestId=${REQUEST}`,
    ])
      expect((await GET(new Request(url + suffix), params)).status).toBe(400);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('echoes the exact rejected request only for confirmed pre-commit rejection, never unknown binding/COMMIT outcomes', async () => {
    for (const code of [
      'revision_conflict',
      'request_conflict',
      'unavailable',
      'authority_denied',
      'content_limit',
    ] as const) {
      f.write.mockRejectedValueOnce(new ManualAutomationRunError(code));
      const response = await POST(post(), params);
      expect(response.status).toBe(code === 'authority_denied' ? 403 : 409);
      expect(await response.json()).toMatchObject({
        source: 'manual',
        status: 'rejected',
        taskId: TASK,
        request: body,
        code,
      });
    }
    for (const error of [
      new ManualAutomationRunError('binding_conflict'),
      Error('lost COMMIT ACK'),
    ]) {
      f.write.mockRejectedValueOnce(error);
      const response = await POST(post(), params);
      expect(await response.json()).not.toHaveProperty('status', 'rejected');
    }
  });
});
