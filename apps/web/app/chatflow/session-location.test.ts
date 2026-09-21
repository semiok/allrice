import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberSessionLocation } from './session-location';

afterEach(() => vi.unstubAllGlobals());
describe('Session reload navigation hint', () => {
  function browser(
    href = 'https://rice.example/chatflow?session=A&view=wide#approval-A',
  ) {
    const history = {
      state: { __NA: true, tree: ['unchanged'] },
      replaceState: vi.fn(),
    };
    vi.stubGlobal('window', { location: { href }, history });
    return history;
  }
  it('remembers the chosen Session without losing Next state or other parameters', () => {
    const h = browser();
    rememberSessionLocation('B');
    expect(h.replaceState).toHaveBeenCalledExactlyOnceWith(
      h.state,
      '',
      '/chatflow?session=B&view=wide',
    );
  });
  it('new work removes the stale Session and approval anchor', () => {
    const h = browser();
    rememberSessionLocation(null);
    expect(h.replaceState).toHaveBeenCalledExactlyOnceWith(
      h.state,
      '',
      '/chatflow?view=wide',
    );
  });
  it('same Session does not clear its current approval anchor or rewrite history', () => {
    const h = browser();
    rememberSessionLocation('A');
    expect(h.replaceState).not.toHaveBeenCalled();
  });
  it('does not break the task when History writes are unavailable', () => {
    browser().replaceState.mockImplementation(() => {
      throw Error('SecurityError');
    });
    expect(() => rememberSessionLocation('B')).not.toThrow();
    vi.stubGlobal('window', undefined);
    expect(() => rememberSessionLocation('B')).not.toThrow();
  });
});
