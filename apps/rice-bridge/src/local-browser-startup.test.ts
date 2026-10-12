import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext } from 'playwright-core';
import { BrowserProfileSchema } from '@allrice/contracts';
import { createControlledBrowserRenderer } from '@allrice/browser-control';
import { awaitLocalBrowserStartup } from './local-browser-startup.js';

afterEach(() => vi.useRealTimers());

function stalledPage() {
  let rejectPage!: (error: Error) => void;
  const newPage = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => {
        rejectPage = reject;
      }),
  );
  const context = { newPage } as unknown as BrowserContext;
  const initialize = () =>
    createControlledBrowserRenderer(
      context,
      {} as Browser,
      {
        profileId: randomUUID(),
        profile: BrowserProfileSchema.parse({
          version: 1,
          network: 'public_https',
          origins: [],
        }),
        authorizeUrl: () => false,
        assertCurrent: async () => {},
        requestStarted: () => () => {},
        requestSent: () => {},
        requestApproval: async () => {
          throw Error('PROBE_WRITE_DENIED');
        },
      },
      async () => {},
    );
  return {
    initialize,
    newPage,
    rejectPage: () => rejectPage(Error('LATE_BROWSER_DISCONNECT')),
  };
}

it('cancels a real renderer waiting forever for a blank page so native cleanup can run', async () => {
  vi.useFakeTimers();
  const f = stalledPage();
  const stop = new AbortController();
  const startup = awaitLocalBrowserStartup(f.initialize, stop.signal);
  const rejected = expect(startup).rejects.toThrow('STOP_REQUESTED');
  expect(f.newPage).toHaveBeenCalledOnce();
  stop.abort(Error('STOP_REQUESTED'));
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  // A delayed SDK rejection after cancellation stays handled.
  f.rejectPage();
  await Promise.resolve();
});

it('bounds a lost newPage response even without a user stop request', async () => {
  vi.useFakeTimers();
  const f = stalledPage();
  const startup = awaitLocalBrowserStartup(f.initialize);
  const rejected = expect(startup).rejects.toThrow(
    'LOCAL_BROWSER_STARTUP_TIMEOUT',
  );
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  f.rejectPage();
});

it('does not start page creation when shutdown was already requested', async () => {
  const f = stalledPage();
  const stop = new AbortController();
  stop.abort(Error('ALREADY_STOPPING'));
  await expect(
    awaitLocalBrowserStartup(f.initialize, stop.signal),
  ).rejects.toThrow('ALREADY_STOPPING');
  expect(f.newPage).not.toHaveBeenCalled();
});
