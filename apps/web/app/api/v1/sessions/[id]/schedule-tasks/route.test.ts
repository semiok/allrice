import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  context: { marker: 'current-browser-principal' },
  auth: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  change: vi.fn(),
}));
vi.mock('@allrice/database', () => ({
  createRecurringTask: f.create,
  listRecurringTasks: f.list,
  getRecurringTask: f.get,
  changeRecurringTask: f.change,
  NativeRecurringProductError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  DataAccessError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: f.auth,
}));
vi.mock('../../../../../../lib/storage/responses', () => ({
  storageErrorResponse: (error: unknown) =>
    Response.json(
      {},
      {
        status:
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'authentication_required'
            ? 401
            : 400,
      },
    ),
}));
import { GET, POST } from './route';
import { GET as DETAIL, PATCH } from './[taskId]/route';
const id = '11111111-1111-4111-8111-111111111111',
  taskId = '22222222-2222-4222-8222-222222222222';
const args = { params: Promise.resolve({ id, taskId }) };
const url = `http://fixture/api/v1/sessions/${id}/schedule-tasks`;
beforeEach(() => {
  vi.clearAllMocks();
  f.auth.mockResolvedValue(f.context);
});
describe('recurring task HTTP transport boundaries', () => {
  it('requires the actual authenticated principal for every read and write', async () => {
    f.auth.mockResolvedValue(null);
    for (const response of [
      await GET(new Request(url), args),
      await POST(new Request(url, { method: 'POST', body: '{}' }), args),
      await DETAIL(new Request(url + '/' + taskId), args),
      await PATCH(
        new Request(url + '/' + taskId, { method: 'PATCH', body: '{}' }),
        args,
      ),
    ])
      expect(response.status).toBe(401);
    for (const call of [f.create, f.list, f.get, f.change])
      expect(call).not.toHaveBeenCalled();
  });
  it('rejects duplicate, unknown and mixed exact/pagination reads before database work', async () => {
    for (const query of [
      '?cursor=a&cursor=b',
      '?ownerId=' + id,
      '?clientRequestId=' + id + '&cursor=a',
    ])
      expect((await GET(new Request(url + query), args)).status).toBe(400);
    expect(
      (
        await DETAIL(
          new Request(url + '/' + taskId + '?operationId=' + id + '&cursor=a'),
          args,
        )
      ).status,
    ).toBe(400);
    expect(f.list).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });
  it('forwards the complete original create input once and returns its stored task', async () => {
    const input = {
      clientRequestId: id,
      name: '每周前的日核对',
      prompt: '请核对 A、B；只保留长期约定。',
      rule: { kind: 'daily', time: '09:00:00', timezone: 'Asia/Shanghai' },
    };
    f.create.mockResolvedValue({ id: taskId });
    const response = await POST(
      new Request(url, { method: 'POST', body: JSON.stringify(input) }),
      args,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ task: { id: taskId } });
    expect(f.create).toHaveBeenCalledExactlyOnceWith(f.context, id, input);
  });
  it('returns a persisted rejected operation as 409 rather than losing exact readback identity', async () => {
    const input = { operationId: id, expectedRevision: 3, action: 'pause' };
    const operation = {
      operationId: id,
      taskId,
      request: input,
      status: 'rejected',
      errorMessage: '已更新',
      task: null,
    };
    f.change.mockResolvedValue(operation);
    const response = await PATCH(
      new Request(url + '/' + taskId, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
      args,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ operation });
    expect(f.change).toHaveBeenCalledExactlyOnceWith(
      f.context,
      id,
      taskId,
      input,
    );
    f.get.mockResolvedValue({ operation });
    const readback = await DETAIL(
      new Request(url + '/' + taskId + '?operationId=' + id),
      args,
    );
    expect(readback.status).toBe(200);
    expect(await readback.json()).toEqual({ operation });
    expect(f.get).toHaveBeenCalledExactlyOnceWith(f.context, id, taskId, {
      operationId: id,
    });
  });
});
