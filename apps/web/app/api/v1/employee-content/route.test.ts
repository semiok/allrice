import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeeContentMutationSchema } from '@allrice/contracts';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  caller: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createBusinessRuntimeCaller: ports.caller,
}));
import { POST } from './route';

const context = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
};
const command = EmployeeContentMutationSchema.parse({
  operation: 'save_draft',
  workspaceId: context.workspaceId,
  setId: randomUUID(),
  requestId: randomUUID(),
  expectedRevision: 3,
  ownership: {
    scope: 'personal',
    organizationId: context.organizationId,
    ownerId: context.actor.id,
  },
  target: { kind: 'instance', instanceId: randomUUID() },
  manifest: {
    schemaVersion: 1,
    common: [],
    scenes: [],
    declaredConflicts: [],
  },
  textEdits: [],
  changeSummary: '保存这份员工工作要求草稿。',
});
const request = (origin = 'https://localhost') =>
  new Request('https://localhost/api/v1/employee-content', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });

describe('employee content original caller production wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ports.context.mockResolvedValue(context);
    ports.caller.mockReturnValue({ mutateEmployeeContent: ports.mutate });
  });

  it('keeps the authenticated actor, original CAS/request fields and exact committed receipt', async () => {
    const receipt = {
      requestId: command.requestId,
      revisionId: randomUUID(),
      revision: 4,
      state: 'draft',
      replayed: false,
    };
    ports.mutate.mockResolvedValue(receipt);
    const incoming = request();
    const response = await POST(incoming);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipt });
    expect(ports.context).toHaveBeenCalledWith(incoming);
    expect(ports.caller).toHaveBeenCalledTimes(1);
    expect(ports.mutate).toHaveBeenCalledExactlyOnceWith(
      context,
      command,
      incoming.signal,
    );
  });

  it('rejects foreign origin and missing login before constructing a source caller', async () => {
    expect((await POST(request('https://other.example'))).status).toBe(403);
    expect(ports.context).not.toHaveBeenCalled();
    ports.context.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);
    expect(ports.caller).not.toHaveBeenCalled();
    expect(ports.mutate).not.toHaveBeenCalled();
  });

  it('preserves current caller denial and never retries the original mutation', async () => {
    ports.mutate.mockRejectedValueOnce(
      new DataAccessError('authorization_denied'),
    );
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED' },
    });
    expect(ports.mutate).toHaveBeenCalledTimes(1);
  });
});
