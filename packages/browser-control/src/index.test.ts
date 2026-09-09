import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, Request, Route } from 'playwright-core';
import { BrowserProfileSchema } from '@allrice/contracts';
import {
  browserObservationUrl,
  createControlledBrowserRenderer,
} from './index.js';

describe('late network approval is not an execution permit after request closure', () => {
  it.each(['renderer-close', 'request-failure'])(
    'settles late permission once after %s, with zero sent requests',
    async (reason) => {
      const callbacks = new Map<string, (request: Request) => void>();
      let intercept!: (route: Route) => Promise<void>;
      let release!: () => void, entered!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const request = {
        url: () => 'https://example.com/submit',
        method: () => 'POST',
        redirectedFrom: () => null,
        headers: () => ({}),
        postDataBuffer: () => Buffer.from('synthetic'),
      } as unknown as Request;
      const context = {
        newPage: async () => ({
          setDefaultTimeout() {},
          setDefaultNavigationTimeout() {},
        }),
        on: (name: string, callback: (request: Request) => void) => {
          callbacks.set(name, callback);
        },
        routeWebSocket: async () => {},
        route: async (
          _pattern: string,
          handler: (route: Route) => Promise<void>,
        ) => {
          intercept = handler;
        },
        close: async () => {
          callbacks.get('requestfailed')?.(request);
        },
      } as unknown as BrowserContext;
      const complete = vi.fn(async () => {});
      const requestSent = vi.fn();
      const driver = await createControlledBrowserRenderer(
        context,
        { close: async () => {} } as unknown as Browser,
        {
          profileId: 'synthetic',
          profile: BrowserProfileSchema.parse({
            version: 1,
            origins: ['https://example.com'],
          }),
          authorizeUrl: () => true,
          assertCurrent: async () => {},
          requestStarted: () => () => {},
          requestSent,
          requestApproval: async () => {
            entered();
            await pending;
            return { complete };
          },
        },
        async () => {},
      );
      const fallback = vi.fn(async () => {}),
        abort = vi.fn(async () => {});
      const handled = intercept({
        request: () => request,
        fallback,
        abort,
      } as unknown as Route);
      await waiting;
      if (reason === 'renderer-close') await driver.close();
      else callbacks.get('requestfailed')?.(request);
      release();
      await handled;
      expect(complete).toHaveBeenCalledExactlyOnceWith(false);
      expect(fallback).not.toHaveBeenCalled();
      expect(requestSent).not.toHaveBeenCalled();
      callbacks.get('requestfailed')?.(request);
      expect(complete).toHaveBeenCalledTimes(1);
      await driver.close();
    },
  );
});

describe('browser observation URL', () => {
  it('preserves the empty isolated page without inventing a null origin', () => {
    expect(browserObservationUrl('about:blank')).toBe('about:blank');
  });

  it('only displays HTTP origins and paths without credentials, query or hash', () => {
    expect(
      browserObservationUrl(
        'https://user:secret@example.com/login?token=secret#secret',
      ),
    ).toBe('https://example.com/login');
    expect(browserObservationUrl('http://127.0.0.1:3000/status?q=secret')).toBe(
      'http://127.0.0.1:3000/status',
    );
  });

  it('does not expose non-web URL contents', () => {
    for (const value of [
      'file:///private/secret',
      'data:text/plain,secret',
      'javascript:secret()',
      'not a URL',
    ]) {
      expect(browserObservationUrl(value)).toBe('about:blank');
    }
  });
});
