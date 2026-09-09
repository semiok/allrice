import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, RuntimePolicyError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  list: vi.fn(),
  act: vi.fn(),
  control: vi.fn(),
  input: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock('../../../../../lib/identity/session', () => ({
  requireRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listBrowserWorkspaces: mocks.list,
  createBrowserOperation: mocks.act,
  requestBrowserControl: mocks.control,
  createBrowserDirectInput: mocks.input,
  installBrowserControlGrant: mocks.grant,
  revokeBrowserControlGrant: mocks.revoke,
}));
import { GET, POST } from './route';
const workspace = randomUUID(),
  run = randomUUID(),
  browser = randomUUID(),
  url = `https://allrice.test/api/v1/runtime/browser-workspaces?workspaceId=${workspace}&runId=${run}`;
const post = (body: unknown, origin = 'https://allrice.test') =>
  new Request(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
describe('P21 browser HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      actor: { type: 'user', id: randomUUID() },
      workspaceId: workspace,
    });
    mocks.list.mockResolvedValue([]);
    mocks.control.mockResolvedValue({ requested: true });
    mocks.input.mockResolvedValue({ inputId: randomUUID() });
  });
  it('requires identity and returns only owner-scoped history with no-store', async () => {
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: workspace }),
      run,
    );
    mocks.context.mockRejectedValueOnce(
      new DataAccessError('authentication_required'),
    );
    expect((await GET(new Request(url))).status).toBe(401);
    mocks.list.mockRejectedValueOnce(new RuntimePolicyError('run_not_owned'));
    expect((await GET(new Request(url))).status).toBe(403);
  });
  it('cross origin, agent impersonation, network request forgery and JS fail before state write', async () => {
    const command = {
      version: 1,
      workspaceId: browser,
      profileId: randomUUID(),
      actor: 'agent',
      fence: 1,
      observationId: null,
      action: { type: 'observe' },
    };
    expect(
      (await POST(post({ kind: 'act', requestId: randomUUID(), command })))
        .status,
    ).toBe(400);
    expect(
      (
        await POST(
          post(
            { kind: 'control', id: browser, request: {} },
            'https://foreign.test',
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          post({
            kind: 'act',
            requestId: randomUUID(),
            command: {
              ...command,
              actor: 'human',
              action: { type: 'evaluate', script: 'alert(1)' },
            },
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.act).not.toHaveBeenCalled();
    expect(mocks.control).not.toHaveBeenCalled();
  });
  it('one-time sensitive input never echoes in success, schema failures or database exceptions', async () => {
    const value = 'SYNTHETIC-ONLY-PRIVATE';
    const body = {
      kind: 'input',
      id: browser,
      fence: 1,
      observationId: randomUUID(),
      elementId: 'e1',
      value,
    };
    const good = await POST(post(body));
    expect(good.status).toBe(200);
    expect(await good.text()).not.toContain(value);
    mocks.input.mockRejectedValueOnce(Error(value));
    const failure = await POST(post(body));
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain(value);
    const invalid = await POST(post({ ...body, elementId: value }));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(value);
    expect(
      (await POST(post({ ...body, value: 'x'.repeat(21000) }))).status,
    ).toBe(400);
  });
  it('close responds requested only, never stopped acknowledgement', async () => {
    const response = await POST(
      post({
        kind: 'control',
        id: browser,
        request: {
          requestId: randomUUID(),
          expectedFence: 1,
          control: 'closed',
          observationId: null,
        },
      }),
    );
    expect(await response.json()).toEqual({ requested: true });
    expect(mocks.control).toHaveBeenCalledOnce();
  });
});
