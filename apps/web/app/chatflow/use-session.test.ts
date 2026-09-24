import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { History, Session, Workspace } from './chatflow-types';

// Exercises the actual hook's async control flow, not a DOM/React renderer.
// State is retained between explicit renders; effects are deliberately not run.
const hooks = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    reset() {
      slots = [];
      cursor = 0;
    },
    render() {
      cursor = 0;
    },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots))
        slots[index] =
          typeof initial === 'function' ? (initial as () => T)() : initial;
      return [
        slots[index] as T,
        (next: T | ((old: T) => T)) => {
          slots[index] =
            typeof next === 'function'
              ? (next as (old: T) => T)(slots[index] as T)
              : next;
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useMemo<T>(factory: () => T) {
      return factory();
    },
    useCallback<T>(callback: T) {
      return callback;
    },
    useEffect() {},
  };
});
vi.mock('react', () => hooks);
import { useSession } from './use-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function session(id: string): Session {
  return {
    id,
    title: id,
    employeeAssignmentId: 'employee',
    employeeVersionId: 'version',
    visibility: 'private',
    updatedAt: '',
    archivedAt: null,
  };
}
function history(id: string): History {
  return {
    session: session(id),
    messages: [],
    contextStatus: {
      percentage: 0,
      pressureTokens: 0,
      thresholdTokens: 40_000,
      compactionDue: false,
    },
    nativeContextStatus: null,
  };
}
const workspace: Workspace = {
  organizationId: 'organization',
  workspaceId: 'workspace',
  employeeProfiles: [],
  canAdminister: false,
  sessionModels: [],
  sessions: [session('A'), session('B')],
  employees: [
    {
      id: 'employee',
      employeeId: 'employee',
      isDefault: true,
      currentVersion: { id: 'version', manifest: { name: 'Rice' } },
      versions: [],
    },
  ],
};
describe('P26 History selection async control flow (synthetic fetch, explicit hook harness)', () => {
  let requests: Array<{
    url: string;
    init: RequestInit | undefined;
    result: ReturnType<typeof deferred<Response>>;
  }>;
  const setError = vi.fn();
  function render() {
    hooks.render();
    return useSession({ setError });
  }
  async function ready() {
    let state = render();
    const initial = state.loadWorkspace();
    requests[0]!.result.resolve(Response.json({ workspace }));
    await Promise.resolve();
    // Workspace and capabilities load concurrently.
    requests[1]!.result.resolve(Response.json({ capabilities: {} }));
    await initial;
    state = render();
    expect(state.activeId).toBe('A');
    requests = [];
    return state;
  }
  beforeEach(() => {
    hooks.reset();
    requests = [];
    vi.clearAllMocks();
    vi.stubGlobal('window', { location: { search: '', assign: vi.fn() } });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const result = deferred<Response>();
        requests.push({ url, init, result });
        return result.promise;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears an uncached selection immediately and restores a visited one without waiting for HTTP', async () => {
    const state = await ready();
    state.setHistory(history('A'));
    state.setActiveId('B');
    expect(render().history).toBeNull();
    state.setHistory(history('B'));
    state.setActiveId('A');
    expect(render().history?.session.id).toBe('A');
    const refresh = render().loadHistory('A');
    expect(render().history?.session.id).toBe('A');
    state.setHistory((old) => ({
      ...old!,
      session: { ...old!.session, title: 'new local receipt' },
    }));
    requests[0]!.result.resolve(Response.json({ history: history('A') }));
    await refresh;
    expect(render().history?.session.title).toBe('new local receipt');
  });

  it('adopts the in-flight preload on selection instead of requesting the same history twice', async () => {
    const state = await ready();
    state.prefetchHistory('B');
    state.setActiveId('B');
    const load = render().loadHistory('B');
    expect(requests).toHaveLength(1);
    requests[0]!.result.resolve(Response.json({ history: history('B') }));
    await load;
    expect(render().history?.session.id).toBe('B');
  });

  it('does not adopt an aborted preload after switching away and back', async () => {
    const state = await ready();
    state.prefetchHistory('B');
    state.setActiveId('B');
    const old = render().loadHistory('B');
    state.setActiveId('A');
    state.setActiveId('B');
    const latest = render().loadHistory('B');
    expect(requests).toHaveLength(2);
    requests[1]!.result.resolve(Response.json({ history: history('B') }));
    await latest;
    requests[0]!.result.reject(new Error('aborted preload'));
    await old;
    expect(render().history?.session.id).toBe('B');
  });

  it('revalidates an aged preload and removes a snapshot when access is revoked', async () => {
    const state = await ready();
    state.prefetchHistory('B');
    requests[0]!.result.resolve(Response.json({ history: history('B') }));
    // Drain Response.json parsing and the preload continuation.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    try {
      state.setActiveId('B');
      expect(render().history?.session.id).toBe('B');
      const load = render().loadHistory('B');
      expect(requests).toHaveLength(2);
      requests[1]!.result.resolve(
        Response.json(
          { error: { message: 'Access removed' } },
          { status: 403 },
        ),
      );
      await expect(load).rejects.toThrow('Access removed');
      expect(render().history).toBeNull();
      state.setActiveId('A');
      state.setActiveId('B');
      expect(render().history).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('clears retained history and pending preloads when the viewer changes', async () => {
    const state = await ready();
    state.setHistory(history('A'));
    state.setActiveId('B');
    state.setActiveId('A');
    render().prefetchHistory('B');
    const refresh = render().loadWorkspace();
    requests[1]!.result.resolve(
      Response.json({
        workspace: { ...workspace, viewerId: 'another-viewer' },
      }),
    );
    requests[2]!.result.resolve(Response.json({ capabilities: {} }));
    await refresh;
    expect(requests[0]!.init?.signal?.aborted).toBe(true);
    requests[0]!.result.resolve(Response.json({ history: history('B') }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(render().history).toBeNull();
    render().setActiveId('B');
    expect(render().history).toBeNull();
    render().setActiveId('A');
    expect(render().history).toBeNull();
  });

  it('ignores late A History and refuses an old POST history request while B is selected', async () => {
    const state = await ready();
    const old = state.loadHistory('A');
    state.setActiveId('B');
    const next = render();
    const current = next.loadHistory('B');
    expect((requests[0]!.init?.signal as AbortSignal).aborted).toBe(true);
    await state.loadHistory('A');
    expect(requests).toHaveLength(2);
    requests[1]!.result.resolve(Response.json({ history: history('B') }));
    await current;
    requests[0]!.result.resolve(Response.json({ history: history('A') }));
    await old;
    expect(render().history?.session.id).toBe('B');
    expect(render().activeId).toBe('B');
  });
  it('returning A→B→A invalidates the first A epoch even when its request is last to finish', async () => {
    const state = await ready();
    const old = state.loadHistory('A');
    state.setActiveId('B');
    state.setActiveId('A');
    const newer = render().loadHistory('A');
    const newerHistory = history('A');
    newerHistory.session.title = 'current epoch';
    requests[1]!.result.resolve(Response.json({ history: newerHistory }));
    await newer;
    requests[0]!.result.resolve(Response.json({ history: history('A') }));
    await old;
    expect(render().history?.session.title).toBe('current epoch');
  });
  it('does not publish a response with the wrong Session ID even for the latest request', async () => {
    const state = await ready();
    const pending = state.loadHistory('A');
    requests[0]!.result.resolve(Response.json({ history: history('B') }));
    await pending;
    expect(render().history).toBeNull();
  });
  it('same-session superseding requests protect the new owner against late old finally', async () => {
    const state = await ready();
    const old = state.loadHistory('A');
    const newer = state.loadHistory('A');
    requests[0]!.result.reject(new Error('old network failure'));
    await old;
    state.setActiveId('B');
    expect((requests[1]!.init?.signal as AbortSignal).aborted).toBe(true);
    requests[1]!.result.resolve(Response.json({ history: history('A') }));
    await newer;
    expect(render().history).toBeNull();
    expect(setError).not.toHaveBeenCalled();
  });
  it('New(null) cannot be overwritten by late History or a prior Workspace refresh', async () => {
    const state = await ready();
    const oldHistory = state.loadHistory('A');
    const oldWorkspace = state.loadWorkspace();
    state.setActiveId(null);
    state.setHistory(null);
    requests[0]!.result.resolve(Response.json({ history: history('A') }));
    await oldHistory;
    requests[1]!.result.resolve(Response.json({ workspace }));
    await Promise.resolve();
    requests[2]!.result.resolve(Response.json({ capabilities: {} }));
    await oldWorkspace;
    expect(render().activeId).toBeNull();
    expect(render().history).toBeNull();
  });
  it('a late createSession response cannot steal B or trigger a first message there', async () => {
    const state = await ready();
    state.setActiveId(null);
    const pending = render().createSession('new');
    state.setActiveId('B');
    requests[0]!.result.resolve(Response.json({ session: session('C') }));
    expect(await pending).toBeNull();
    expect(render().activeId).toBe('B');
    expect(requests).toHaveLength(1); // server creation is not treated as cancellation
  });
  it('preserves the authoritative null→new seed and optimistic first message', async () => {
    const state = await ready();
    const old = state.loadHistory('A');
    state.setActiveId(null);
    const pending = render().createSession('first task');
    requests[1]!.result.resolve(Response.json({ session: session('C') }));
    expect(await pending).toBe('C');
    const created = render();
    expect(created.activeId).toBe('C');
    expect(created.history).toEqual(history('C'));
    created.setHistory((current) =>
      current
        ? {
            ...current,
            messages: [
              {
                id: 'optimistic',
                role: 'assistant',
                status: 'pending',
                runId: null,
                content: { text: 'Rice 正在处理…' },
                createdAt: '',
              },
            ],
          }
        : current,
    );
    requests[0]!.result.resolve(Response.json({ history: history('A') }));
    await old;
    expect(render().history?.session.id).toBe('C');
    expect(render().history?.messages[0]?.id).toBe('optimistic');
    expect(requests).toHaveLength(2); // no premature empty-history fetch for C
  });
  it('uses explicit assignment instead of a conflicting URL or default employee', async () => {
    const state = await ready();
    state.setActiveId(null, true);
    window.location.search = '?employee=unavailable';
    const pending = render().createSession('explicit', 'employee');
    expect(
      JSON.parse(String(requests[0]!.init?.body)).employeeAssignmentId,
    ).toBe('employee');
    requests[0]!.result.resolve(Response.json({ session: session('C') }));
    expect(await pending).toBe('C');
  });
  it('does not fall back when an explicit employee was withdrawn', async () => {
    await ready();
    await expect(
      render().createSession('no fallback', 'withdrawn'),
    ).rejects.toThrow('未分配');
    expect(requests).toHaveLength(0);
  });
  it('invalidates a late create when the user chooses another new employee draft', async () => {
    const state = await ready();
    state.setActiveId(null, true);
    const pending = render().createSession('old draft', 'employee');
    state.setActiveId(null, true);
    state.setPendingEmployeeAssignmentId('new-target');
    requests[0]!.result.resolve(Response.json({ session: session('C') }));
    expect(await pending).toBeNull();
    expect(render().activeId).toBeNull();
    expect(render().newSessionEmployee).toBeUndefined();
  });
  it('preserves current-session history failures instead of swallowing real errors', async () => {
    const state = await ready();
    const pending = state.loadHistory('A');
    requests[0]!.result.reject(new Error('real failure'));
    await expect(pending).rejects.toThrow('real failure');
  });
});
