import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { browserOriginAllowed } from '@allrice/contracts';
import {
  createControlledBrowserRenderer,
  type BrowserDriver,
  type BrowserDriverOptions as RendererOptions,
} from '@allrice/browser-control';
import {
  createManagedBrowserPinnedAddressResolver,
  managedBrowserChromiumSandboxEnabled,
  resolveManagedBrowserExecutable,
  resolveManagedBrowserHostnamePublic,
  startManagedBrowserPinnedProxy,
} from '../managed-browser.js';
export type {
  BrowserDriver,
  BrowserRequestEffect,
} from '@allrice/browser-control';
export type BrowserDriverOptions = Omit<RendererOptions, 'authorizeUrl'>;
/** This only configures a new cloud context; it cannot attach to a user's Chrome. */
export async function startBrowserControlDriver(
  options: BrowserDriverOptions,
): Promise<BrowserDriver> {
  const executablePath = await resolveManagedBrowserExecutable();
  if (!executablePath) throw Error('BROWSER_EXECUTABLE_MISSING');
  const origins = new Set(
    options.profile.origins.map((o) => new URL(o).hostname),
  );
  const resolvePublicAddresses = createManagedBrowserPinnedAddressResolver(
    async (hostname) => {
      if (!origins.has(hostname)) throw Error('BROWSER_ORIGIN_DENIED');
      return resolveManagedBrowserHostnamePublic(hostname);
    },
  );
  const proxy = await startManagedBrowserPinnedProxy({
    resolvePublicAddresses,
    maximumBytes: 40000000,
  });
  let browser: Browser | undefined, context: BrowserContext | undefined;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: managedBrowserChromiumSandboxEnabled(),
      proxy: {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password,
      },
      args: [
        '--disable-quic',
        '--disable-features=DnsOverHttps',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--proxy-bypass-list=<-loopback>',
      ],
    });
    context = await browser.newContext({
      acceptDownloads: options.profile.allowDownloads,
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 720 },
    });
    return await attachControlledContext(
      context,
      browser,
      options,
      proxy.close,
    );
  } catch {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
    throw Error('BROWSER_START_FAILED');
  }
}

/** This cloud adapter's trusted origin policy cannot be overridden by callers. */
export function attachControlledContext(
  context: BrowserContext,
  browser: Browser,
  options: BrowserDriverOptions,
  closeProxy: () => Promise<void>,
) {
  return createControlledBrowserRenderer(
    context,
    browser,
    {
      ...options,
      authorizeUrl: (url) => browserOriginAllowed(url, options.profile),
    },
    closeProxy,
  );
}
