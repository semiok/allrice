import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from './chatflow-types';

// Runs the hook's effects once, synchronously; enough to reach its listeners.
vi.mock('react', () => ({
  useMemo: <T>(factory: () => T) => factory(),
  useSyncExternalStore: <T>(_: unknown, snapshot: () => T) => snapshot(),
  useLayoutEffect: (effect: () => void) => effect(),
  useEffect: (effect: () => void) => effect(),
}));
import { useRunStream } from './use-run-stream';

describe('reconnecting refreshes the conversation through the shared read', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads History again when the network returns and logs a failure', async () => {
    vi.stubGlobal('window', new EventTarget());
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loadHistory = vi.fn(async () => {
      throw new Error('offline');
    });
    useRunStream({
      activeId: 'A',
      history: null,
      loadHistory,
      loadWorkspace: async () => {},
      setError: () => {},
      tenantHeaders: {},
      workspace: { workspaceId: 'workspace' } as Workspace,
    });
    window.dispatchEvent(new Event('online'));
    expect(loadHistory).toHaveBeenCalledWith('A');
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        'Chat history refresh after reconnecting failed',
        expect.any(Error),
      ),
    );
  });
});
