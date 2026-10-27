import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentAppearance,
  reloadAppearance,
  setAppearance,
} from './appearance';

function element() {
  const attributes = new Map<string, string>();
  return {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
  };
}

function read() {
  let finish!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  return {
    promise,
    finish: (appearance: string) =>
      finish(
        Response.json({ viewerId: 'viewer-a', preferences: { appearance } }),
      ),
  };
}

describe('appearance reads', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { documentElement: element(), body: element() });
    vi.stubGlobal('location', { pathname: '/chatflow' });
    document.documentElement.setAttribute('data-appearance-viewer', 'viewer-a');
    setAppearance('system');
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['older first', 'newer first'])(
    'keeps the latest read when responses finish %s',
    async (order) => {
      const older = read(),
        newer = read();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockReturnValueOnce(older.promise)
          .mockReturnValueOnce(newer.promise),
      );
      const a = reloadAppearance();
      const b = reloadAppearance();
      if (order === 'older first') {
        older.finish('light');
        await a;
        // B has started: A must not change the page even while B is pending.
        expect(currentAppearance()).toBe('system');
        newer.finish('dark');
        await b;
      } else {
        newer.finish('dark');
        await b;
        older.finish('light');
        await a;
      }
      expect(currentAppearance()).toBe('dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    },
  );

  it('discards a pre-save read while the save is pending', async () => {
    const pending = read();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    const response = reloadAppearance();
    setAppearance('dark');
    pending.finish('light');
    await response;
    expect(currentAppearance()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('discards a read started during a save when the save completes', async () => {
    setAppearance('dark');
    const pending = read();
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending.promise));
    const response = reloadAppearance();
    // Save completion reaffirms the choice even if the attribute is unchanged.
    setAppearance('dark');
    pending.finish('light');
    await response;
    expect(currentAppearance()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
