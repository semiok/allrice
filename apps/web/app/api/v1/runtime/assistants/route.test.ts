import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  tree: vi.fn(),
  session: vi.fn(),
  child: vi.fn(),
  root: vi.fn(),
}));
vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', () => ({
  AssistantRuntimeError: class AssistantRuntimeError extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  createAssistantRuntime: () => ({
    getTree: mocks.tree,
    getSessionTrees: mocks.session,
    cancelChild: mocks.child,
    cancelRoot: mocks.root,
  }),
}));
import { AssistantRuntimeError } from '@allrice/database';
import { GET, POST } from './route';

const workspaceId = randomUUID(),
  runId = randomUUID(),
  sessionId = randomUUID();
const url = `https://allrice.test/api/v1/runtime/assistants?workspaceId=${workspaceId}&runId=${runId}`;
const post = (body: unknown, origin = 'https://allrice.test') =>
  new Request(url, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('P26 assistants HTTP boundary (database authorization tested separately)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      actor: { type: 'user', id: randomUUID() },
      organizationId: randomUUID(),
      workspaceId,
    });
    mocks.tree.mockResolvedValue({ rootRunId: runId });
    mocks.session.mockResolvedValue([]);
    mocks.child.mockResolvedValue({ cancelRequested: true });
    mocks.root.mockResolvedValue({ cancelRequested: true });
  });
  it('requires identity and forwards trusted context, never hides history when disabled', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.tree).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
      { runId, includeTiming: true },
    );
    mocks.context.mockResolvedValueOnce(null);
    expect((await GET(new Request(url))).status).toBe(401);
    mocks.tree.mockRejectedValueOnce(new AssistantRuntimeError('not_found'));
    expect((await GET(new Request(url))).status).toBe(404);
    vi.unstubAllEnvs();
  });
  it('uses separate session and run reads and rejects ambiguous or malformed scope', async () => {
    expect(
      (await GET(new Request(`${url}&sessionId=${sessionId}`))).status,
    ).toBe(400);
    expect(
      (await GET(new Request(url.replace(runId, 'not-a-run')))).status,
    ).toBe(400);
    const response = await GET(
      new Request(url.replace(`runId=${runId}`, `sessionId=${sessionId}`)),
    );
    expect(response.status).toBe(200);
    expect(mocks.session).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
      { sessionId, includeTiming: true },
    );
  });
  it('rejects cross-origin writes before authentication or cancellation', async () => {
    expect(
      (
        await POST(
          post(
            { action: 'cancel_root', requestId: randomUUID() },
            'https://foreign.test',
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.root).not.toHaveBeenCalled();
  });
  it('stops one child or the tree with exact request identity, never reports stopped', async () => {
    const requestId = randomUUID(),
      childRunId = randomUUID();
    const response = await POST(
      post({ action: 'stop_child', requestId, childRunId }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      result: { cancelRequested: true },
    });
    expect(mocks.child).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
      { runId, childRunId, requestId },
    );
    expect(mocks.root).not.toHaveBeenCalled();
    expect(
      (await POST(post({ action: 'cancel_root', requestId }))).status,
    ).toBe(202);
    expect(mocks.root).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId }),
      { runId, requestId },
    );
  });
  it('does not expose start, mode switch, tool grants or delegated ownership APIs', async () => {
    for (const extra of [
      { action: 'start', requestId: randomUUID() },
      { action: 'cancel_root', requestId: randomUUID(), tools: ['shell'] },
      {
        action: 'cancel_root',
        requestId: randomUUID(),
        organizationId: randomUUID(),
      },
    ]) {
      expect((await POST(post(extra))).status).toBe(400);
    }
    expect(mocks.root).not.toHaveBeenCalled();
    expect(mocks.child).not.toHaveBeenCalled();
    expect((await POST(post({ text: 'x'.repeat(5000) }))).status).toBe(413);
  });
  it('does not leak underlying error details and preserves conflict status', async () => {
    mocks.root.mockRejectedValueOnce(new AssistantRuntimeError('conflict'));
    expect(
      (await POST(post({ action: 'cancel_root', requestId: randomUUID() })))
        .status,
    ).toBe(409);
    mocks.tree.mockRejectedValueOnce(new Error('PRIVATE-DATABASE-CONTENT'));
    const response = await GET(new Request(url));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('PRIVATE-DATABASE-CONTENT');
  });
});
