import { createHash, randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Request, Route } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { BrowserProfileSchema } from '@allrice/contracts';
import { createControlledBrowserRenderer } from './index.js';

describe('preview relay owns only its disposable request copy', () => {
  it.each(['fulfilled', 'relay-failed'] as const)(
    'preserves approved Playwright request bytes after %s',
    async (outcome) => {
      const original = Buffer.from('message=synthetic-p23');
      const expected = Buffer.from(original);
      const url = 'https://synthetic.preview.allrice.invalid/submit';
      let intercept!: (route: Route) => Promise<void>;
      const request = {
        url: () => url,
        method: () => 'POST',
        redirectedFrom: () => null,
        headers: () => ({}),
        // Exactly like Playwright: every call returns the same borrowed Buffer.
        postDataBuffer: () => original,
      } as unknown as Request;
      const context = {
        newPage: async () => ({
          setDefaultTimeout() {},
          setDefaultNavigationTimeout() {},
        }),
        on() {},
        routeWebSocket: async () => {},
        route: async (
          _pattern: string,
          handler: (route: Route) => Promise<void>,
        ) => {
          intercept = handler;
        },
        close: async () => {},
      } as unknown as BrowserContext;
      let relayCopy: Buffer | undefined;
      const response = Buffer.from('saved:synthetic-p23');
      const fulfill = vi.fn(async (result: { body: Buffer }) => {
        expect(result.body.toString()).toBe('saved:synthetic-p23');
      });
      const fallback = vi.fn(async () => {}),
        abort = vi.fn(async () => {});
      const driver = await createControlledBrowserRenderer(
        context,
        { close: async () => {} } as unknown as Browser,
        {
          profileId: randomUUID(),
          profile: BrowserProfileSchema.parse({
            version: 1,
            origins: ['https://example.com'],
          }),
          authorizeUrl: () => true,
          assertCurrent: async () => {},
          requestStarted: () => () => {},
          requestSent: () => {},
          requestApproval: async (effect) => {
            expect(effect.bodyBytes).toBe(expected.length);
            expect(effect.bodyDigest).toBe(
              'sha256:' + createHash('sha256').update(expected).digest('hex'),
            );
            return { complete: async () => {} };
          },
          localPreviewRelay: async (input) => {
            relayCopy = input.body;
            expect(relayCopy).not.toBe(original);
            expect(relayCopy).toEqual(expected);
            expect(original).toEqual(expected);
            if (outcome === 'relay-failed')
              throw Error('SYNTHETIC_RELAY_FAILURE');
            return { status: 200, headers: {}, body: response };
          },
        },
        async () => {},
      );
      try {
        await intercept({
          request: () => request,
          fulfill,
          fallback,
          abort,
        } as unknown as Route);
        expect(original).toEqual(expected);
        expect(relayCopy).toBeDefined();
        expect(relayCopy!.every((byte) => byte === 0)).toBe(true);
        expect(fallback).not.toHaveBeenCalled();
        if (outcome === 'fulfilled') {
          expect(fulfill).toHaveBeenCalledOnce();
          expect(response.every((byte) => byte === 0)).toBe(true);
          expect(abort).not.toHaveBeenCalled();
        } else expect(abort).toHaveBeenCalledOnce();
      } finally {
        await driver.close();
      }
    },
  );
});
