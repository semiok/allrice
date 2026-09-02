import { Socket } from 'node:net';

import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { HandlerError } from './errors.js';
import {
  assertManagedBrowserHostnamePublic,
  captureBoundedManagedBrowserPage,
  connectManagedBrowserPinnedTarget,
  createManagedBrowserPinnedAddressResolver,
  isManagedBrowserDomainAllowed,
  isRfc2544SyntheticAddress,
  managedBrowserChromiumSandboxEnabled,
  normalizeManagedBrowserSteps,
  resolveManagedBrowserHostnamePublic,
  runManagedBrowserTask,
  type ManagedBrowserRunner,
} from './managed-browser.js';

function fixtureResult() {
  const content = Buffer.from('{}');
  return {
    finalUrl: 'https://docs.example.com/report',
    title: 'Report',
    text: 'Evidence',
    capturedAt: '2026-08-31T00:00:00.000Z',
    actions: [],
    contentSnapshot: {
      mediaType: 'application/json' as const,
      bytes: content,
      checksum: 'fixture',
    },
  };
}

describe('managed browser task', () => {
  it('recognizes only the RFC 2544 synthetic IPv4 range', () => {
    expect(isRfc2544SyntheticAddress('198.18.0.0')).toBe(true);
    expect(isRfc2544SyntheticAddress('198.19.255.255')).toBe(true);
    expect(isRfc2544SyntheticAddress('198.17.255.255')).toBe(false);
    expect(isRfc2544SyntheticAddress('198.20.0.0')).toBe(false);
    expect(isRfc2544SyntheticAddress('127.0.0.1')).toBe(false);
    expect(isRfc2544SyntheticAddress('not-an-address')).toBe(false);
  });

  it('accepts normal public system DNS without calling DNS-over-HTTPS', async () => {
    const lookupDnsOverHttps = vi.fn();
    await expect(
      assertManagedBrowserHostnamePublic('example.com', {
        lookupHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        lookupDnsOverHttps,
      }),
    ).resolves.toBeUndefined();
    expect(lookupDnsOverHttps).not.toHaveBeenCalled();
  });

  it('returns the exact validated public addresses used by task pinning', async () => {
    await expect(
      resolveManagedBrowserHostnamePublic('example.com', {
        lookupHostname: async () => [
          { address: '93.184.216.34', family: 4 },
          {
            address: '2606:2800:220:1:248:1893:25c8:1946',
            family: 6,
          },
        ],
      }),
    ).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
      {
        address: '2606:2800:220:1:248:1893:25c8:1946',
        family: 6,
      },
    ]);
  });

  it('pins one public DNS answer for validation and every actual task connection', async () => {
    const resolveHostname = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const resolvePublicAddresses =
      createManagedBrowserPinnedAddressResolver(resolveHostname);
    const socket = new Socket();
    const connectTcp = vi.fn(async () => socket);

    await expect(resolvePublicAddresses('EXAMPLE.com.')).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
    await expect(
      connectManagedBrowserPinnedTarget('example.com', 443, {
        resolvePublicAddresses,
        connectTcp,
      }),
    ).resolves.toBe(socket);

    expect(resolveHostname).toHaveBeenCalledOnce();
    expect(resolveHostname).toHaveBeenCalledWith('example.com');
    expect(connectTcp).toHaveBeenCalledWith('93.184.216.34', 443, 4);
    socket.destroy();
  });

  it('rejects private or mixed pin sets before opening a socket', async () => {
    const connectTcp = vi.fn(async () => new Socket());
    for (const addresses of [
      [{ address: '127.0.0.1', family: 4 }],
      [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
    ]) {
      const resolvePublicAddresses = createManagedBrowserPinnedAddressResolver(
        async () => addresses,
      );
      await expect(
        connectManagedBrowserPinnedTarget('example.com', 443, {
          resolvePublicAddresses,
          connectTcp,
        }),
      ).rejects.toMatchObject({ code: 'BROWSER_ADDRESS_BLOCKED' });
    }
    expect(connectTcp).not.toHaveBeenCalled();
  });

  it('allows an RFC 2544 TUN answer only after independent public DNS confirmation', async () => {
    const lookupDnsOverHttps = vi
      .fn()
      .mockResolvedValue([
        '93.184.216.34',
        '2606:2800:220:1:248:1893:25c8:1946',
      ]);
    await expect(
      assertManagedBrowserHostnamePublic('example.com', {
        lookupHostname: async () => [{ address: '198.18.12.34', family: 4 }],
        lookupDnsOverHttps,
      }),
    ).resolves.toBeUndefined();
    expect(lookupDnsOverHttps).toHaveBeenCalledWith('example.com');
  });

  it('rejects a TUN answer when independent DNS is empty, private, or malformed', async () => {
    const lookupHostname = async () => [{ address: '198.19.12.34', family: 4 }];
    for (const independentAddresses of [
      [],
      ['127.0.0.1'],
      ['93.184.216.34', '10.0.0.1'],
      ['not-an-address'],
    ]) {
      await expect(
        assertManagedBrowserHostnamePublic('example.com', {
          lookupHostname,
          lookupDnsOverHttps: async () => independentAddresses,
        }),
      ).rejects.toMatchObject({ code: 'BROWSER_ADDRESS_BLOCKED' });
    }
  });

  it('fails closed when independent DNS confirmation is unavailable', async () => {
    await expect(
      assertManagedBrowserHostnamePublic('example.com', {
        lookupHostname: async () => [{ address: '198.18.12.34', family: 4 }],
        lookupDnsOverHttps: async () => {
          throw new Error('offline');
        },
      }),
    ).rejects.toMatchObject({
      code: 'BROWSER_DNS_VALIDATION_FAILED',
      retryable: true,
    });
  });

  it('never applies the TUN fallback to literals, mixed answers, or other private ranges', async () => {
    const lookupDnsOverHttps = vi.fn().mockResolvedValue(['93.184.216.34']);
    await expect(
      assertManagedBrowserHostnamePublic('198.18.1.1', {
        lookupDnsOverHttps,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_ADDRESS_BLOCKED' });
    await expect(
      assertManagedBrowserHostnamePublic('example.com', {
        lookupHostname: async () => [
          { address: '198.18.1.1', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
        lookupDnsOverHttps,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_ADDRESS_BLOCKED' });
    await expect(
      assertManagedBrowserHostnamePublic('example.com', {
        lookupHostname: async () => [{ address: '192.168.1.1', family: 4 }],
        lookupDnsOverHttps,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_ADDRESS_BLOCKED' });
    expect(lookupDnsOverHttps).not.toHaveBeenCalled();
  });

  it('matches exact and child domains without suffix confusion', () => {
    expect(isManagedBrowserDomainAllowed('example.com', ['example.com'])).toBe(
      true,
    );
    expect(
      isManagedBrowserDomainAllowed('docs.example.com', ['example.com']),
    ).toBe(true);
    expect(
      isManagedBrowserDomainAllowed('notexample.com', ['example.com']),
    ).toBe(false);
  });

  it('normalizes the bounded read-only step set', () => {
    expect(
      normalizeManagedBrowserSteps([
        { type: 'waitFor', selector: ' main ', timeoutMs: 99_000 },
        { type: 'followLink', selector: 'a.more' },
        { type: 'scroll', pixels: 99_000 },
      ]),
    ).toEqual([
      { type: 'waitFor', selector: 'main', timeoutMs: 45_000 },
      { type: 'followLink', selector: 'a.more' },
      { type: 'scroll', direction: 'down', pixels: 5_000 },
    ]);
    expect(() =>
      normalizeManagedBrowserSteps([{ type: 'followLink', selector: ' ' }]),
    ).toThrow(HandlerError);
  });

  it('materializes only bounded renderer content and a fixed viewport screenshot', async () => {
    const evaluate = vi.fn(
      async (
        _callback: unknown,
        limits: {
          maxTextCharacters: number;
          maxHtmlCharacters: number;
          maxNodes: number;
          maxTitleCharacters: number;
        },
      ) => ({
        title: 'Report',
        text: 'x'.repeat(limits.maxTextCharacters),
        html: 'y'.repeat(limits.maxHtmlCharacters),
        textTruncated: true,
        htmlTruncated: true,
        nodeLimitReached: false,
      }),
    );
    const screenshot = vi.fn(async () => Buffer.from('png'));
    const content = vi.fn(() => {
      throw new Error('unbounded page.content() must not be called');
    });
    const locator = vi.fn(() => {
      throw new Error('unbounded locator.innerText() must not be called');
    });
    const page = { evaluate, screenshot, content, locator } as unknown as Page;

    const capture = await captureBoundedManagedBrowserPage(page, {
      maxCharacters: 1_234,
      captureScreenshot: true,
    });

    expect(evaluate.mock.calls[0]?.[1]).toEqual({
      maxTextCharacters: 1_234,
      maxHtmlCharacters: 100_000,
      maxNodes: 20_000,
      maxTitleCharacters: 500,
    });
    expect(capture.text).toHaveLength(1_234);
    expect(capture.html).toHaveLength(100_000);
    expect(content).not.toHaveBeenCalled();
    expect(locator).not.toHaveBeenCalled();
    expect(screenshot).toHaveBeenCalledWith({
      type: 'png',
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    });
  });

  it('rejects an oversized viewport screenshot before evidence storage', async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        title: '',
        text: '',
        html: '',
        textTruncated: false,
        htmlTruncated: false,
        nodeLimitReached: false,
      })),
      screenshot: vi.fn(async () => Buffer.alloc(5_000_001)),
    } as unknown as Page;

    await expect(
      captureBoundedManagedBrowserPage(page, {
        maxCharacters: 1_000,
        captureScreenshot: true,
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_SCREENSHOT_TOO_LARGE' });
  });

  it('keeps the Chromium sandbox on by default and forbids disabling it in production', () => {
    expect(managedBrowserChromiumSandboxEnabled({})).toBe(true);
    expect(
      managedBrowserChromiumSandboxEnabled({
        NODE_ENV: 'development',
        ALLRICE_MANAGED_BROWSER_DISABLE_CHROMIUM_SANDBOX: '1',
      }),
    ).toBe(false);
    expect(() =>
      managedBrowserChromiumSandboxEnabled({
        NODE_ENV: 'production',
        ALLRICE_MANAGED_BROWSER_DISABLE_CHROMIUM_SANDBOX: '1',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'BROWSER_SANDBOX_REQUIRED' }),
    );
  });

  it('prepares an isolated task for an injectable runner', async () => {
    const runner = vi
      .fn<ManagedBrowserRunner>()
      .mockResolvedValue(fixtureResult());
    const result = await runManagedBrowserTask(
      {
        startUrl: 'https://example.com/report#section',
        allowedDomains: ['*.example.com', 'example.com'],
        captureScreenshot: false,
        maxCharacters: 999_999,
        steps: [{ type: 'scroll', direction: 'up', pixels: 600 }],
      },
      { runner, assertHostnamePublic: async () => undefined },
    );

    expect(result.title).toBe('Report');
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0]).toMatchObject({
      startUrl: 'https://example.com/report',
      allowedDomains: ['example.com'],
      maxCharacters: 100_000,
      navigationTimeoutMs: 20_000,
      steps: [{ type: 'scroll', direction: 'up', pixels: 600 }],
    });
  });

  it('uses the same task pins for navigation, redirects, subresources, and the socket', async () => {
    const resolveHostnamePublic = vi.fn(async (hostname: string) => [
      {
        address:
          hostname === 'docs.example.com' ? '93.184.216.35' : '93.184.216.34',
        family: 4,
      },
    ]);
    const socket = new Socket();
    const connectTcp = vi.fn(async () => socket);
    const runner: ManagedBrowserRunner = async (task) => {
      await task.assertRequestAllowed('https://example.com/app.js');
      await task.assertRequestAllowed('https://docs.example.com/report', {
        documentNavigation: true,
      });
      await task.assertRequestAllowed('https://docs.example.com/styles.css');
      await connectManagedBrowserPinnedTarget('example.com', 443, {
        resolvePublicAddresses: task.resolvePublicAddresses,
        connectTcp,
      });
      return fixtureResult();
    };

    await runManagedBrowserTask(
      {
        startUrl: 'https://example.com',
        allowedDomains: ['example.com'],
      },
      { runner, resolveHostnamePublic },
    );

    expect(resolveHostnamePublic).toHaveBeenCalledTimes(2);
    expect(resolveHostnamePublic).toHaveBeenCalledWith('example.com');
    expect(resolveHostnamePublic).toHaveBeenCalledWith('docs.example.com');
    expect(connectTcp).toHaveBeenCalledWith('93.184.216.34', 443, 4);
    socket.destroy();
  });

  it('rejects a start URL outside the configured domain boundary', async () => {
    const runner = vi.fn<ManagedBrowserRunner>();
    await expect(
      runManagedBrowserTask(
        {
          startUrl: 'https://example.org',
          allowedDomains: ['example.com'],
        },
        { runner, assertHostnamePublic: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_DOMAIN_BLOCKED' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('blocks inherited and private document navigation before launch', async () => {
    const runner = vi.fn<ManagedBrowserRunner>();
    await expect(
      runManagedBrowserTask(
        {
          startUrl: 'data:text/html,private',
          allowedDomains: ['example.com'],
        },
        { runner, assertHostnamePublic: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_ADDRESS_BLOCKED' });
    await expect(
      runManagedBrowserTask(
        {
          startUrl: 'http://127.0.0.1/admin',
          allowedDomains: ['127.0.0.1'],
        },
        { runner, assertHostnamePublic: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_ADDRESS_BLOCKED' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('stops before launch when the parent run is canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn<ManagedBrowserRunner>();
    await expect(
      runManagedBrowserTask(
        {
          startUrl: 'https://example.com',
          allowedDomains: ['example.com'],
          signal: controller.signal,
        },
        { runner },
      ),
    ).rejects.toMatchObject({ code: 'BROWSER_TASK_CANCELED' });
    expect(runner).not.toHaveBeenCalled();
  });
});
