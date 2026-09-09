import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import {
  createControlledBrowserRenderer,
  type BrowserDriver,
  type BrowserDriverOptions,
} from '@allrice/browser-control';
import type { LocalBrowserProfileBinding } from '@allrice/contracts';
import type { LocalBrowserProfiles } from './local-browser-profiles.js';
import {
  localBrowserUrlAllowed,
  startLocalBrowserProxy,
} from './local-browser-network.js';
import {
  resolveLocalBrowserLauncher,
  startLocalBrowserSupervisor,
} from './local-browser-supervisor.js';

/** Fixed installed engines only: no user executable/argv, CDP attach, personal
 * profile, automatic browser install, extension or host shell input. */
export async function resolveLocalBrowserExecutable(): Promise<string> {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'linux'
        ? ['/usr/bin/chromium', '/usr/bin/chromium-browser']
        : [];
  for (const path of candidates) {
    try {
      const resolved = await realpath(path);
      const stat = await lstat(resolved);
      if (
        !stat.isFile() ||
        (stat.mode & 0o002) !== 0 ||
        (stat.mode & 0o111) === 0 ||
        (stat.uid !== 0 && stat.uid !== process.getuid?.())
      )
        continue;
      if (process.platform === 'darwin') {
        // Verify executable code identity, not mutable Finder/resource metadata.
        // Google distributes admin-group-writable bundles on some Macs. Never
        // change permissions/xattrs to force a check to pass; non-Google engines
        // retain the narrower non-group-writable requirement below.
        if (path.includes('/Google Chrome.app/')) {
          if (resolved !== path) continue;
          await promisify(execFile)(
            '/usr/bin/codesign',
            [
              '--verify',
              '--ignore-resources',
              '-R=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"',
              resolved,
            ],
            { timeout: 5000, maxBuffer: 16 * 1024, killSignal: 'SIGKILL' },
          );
        } else if ((stat.mode & 0o020) !== 0) continue;
      } else if ((stat.mode & 0o020) !== 0) continue;
      return resolved;
    } catch {
      /* Only try other fixed installed candidates. */
    }
  }
  throw Error('LOCAL_BROWSER_UNAVAILABLE');
}

export const localBrowserLaunchArguments = Object.freeze([
  '--disable-quic',
  '--disable-features=DnsOverHttps,MediaRouter,OptimizationHints,AutofillServerCommunication',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  '--proxy-bypass-list=<-loopback>',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  // Credentials belong only to this isolated context/private state file. Do
  // not consult the user's OS password store or create Keychain prompts.
  '--password-store=basic',
  '--use-mock-keychain',
]);

export type LocalBrowserDriver = Omit<BrowserDriver, 'close'> & {
  close: (disposition: 'completed' | 'revoked' | 'lost') => Promise<void>;
  checkpoint: () => Promise<void>;
};

export async function startLocalBrowserDriver(input: {
  options: Omit<BrowserDriverOptions, 'authorizeUrl'>;
  binding: LocalBrowserProfileBinding;
  profiles: LocalBrowserProfiles;
  assertAlive: () => Promise<void>;
  leaseExpiresAt: () => number;
}): Promise<LocalBrowserDriver> {
  let directory: string | undefined;
  let directoryIdentity: { dev: number; ino: number } | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let proxy: Awaited<ReturnType<typeof startLocalBrowserProxy>> | undefined;
  let renderer: BrowserDriver | undefined;
  let supervisor:
    Awaited<ReturnType<typeof startLocalBrowserSupervisor>> | undefined;
  let launchAttempted = false;
  let closing: Promise<void> | undefined;
  const closeOnce = async (disposition: 'completed' | 'revoked' | 'lost') => {
    let failed = false;
    if (disposition === 'completed' && context && input.binding.persistLogin) {
      try {
        await input.options.assertCurrent();
        const state = await context.storageState();
        await input.options.assertCurrent();
        await input.profiles.save(input.binding, input.options.profile, state);
      } catch {
        failed = true;
      }
    }
    // A disconnected CDP pipe is not proof of process exit. Stop the native
    // lease mirror, then await the helper's owned child/group reap receipt.
    await supervisor?.stop().catch(() => {
      failed = true;
    });
    let confirmed = !launchAttempted;
    const stopDeadline = Date.now() + 6500;
    while (!confirmed && Date.now() < stopDeadline) {
      confirmed = (await supervisor?.confirmed().catch(() => false)) ?? false;
      if (!confirmed) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    // Do not let Playwright kill its helper before that helper has reaped the
    // separately grouped real Chrome process. Only then release CDP wrappers.
    if (confirmed) {
      const teardown = Promise.allSettled(
        renderer ? [renderer.close()] : [context?.close(), browser?.close()],
      );
      await Promise.race([
        teardown,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    await proxy?.close().catch(() => {
      failed = true;
    });
    // Only remove the exact directory this invocation created, after the
    // browser is confirmed disconnected. No wildcard or user profile target.
    if (directory && confirmed) {
      try {
        const actual = await lstat(directory);
        if (
          !actual.isDirectory() ||
          actual.isSymbolicLink() ||
          actual.dev !== directoryIdentity?.dev ||
          actual.ino !== directoryIdentity.ino ||
          actual.uid !== process.getuid?.() ||
          (actual.mode & 0o7777) !== 0o700
        )
          throw Error();
        await rm(directory, { recursive: true });
      } catch {
        failed = true;
      }
    } else if (directory) failed = true;
    if (failed) throw Error('LOCAL_BROWSER_CLEANUP_PENDING');
  };
  const close = (disposition: 'completed' | 'revoked' | 'lost') => {
    closing ??= closeOnce(disposition);
    return closing;
  };
  try {
    const executablePath = await resolveLocalBrowserExecutable();
    // Native supervision is required. There is deliberately no unsupervised
    // Linux/Chromium fallback when this fixed Google Chrome helper is absent.
    if (
      executablePath !==
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    )
      throw Error('LOCAL_BROWSER_UNAVAILABLE');
    const launcherPath = await resolveLocalBrowserLauncher();
    const state = await input.profiles.load(
      input.binding,
      input.options.profile,
    );
    await input.options.assertCurrent();
    directory = await mkdtemp(join(tmpdir(), 'allrice-browser-'));
    directoryIdentity = await lstat(directory);
    await mkdir(join(directory, 'profile'), { mode: 0o700 });
    proxy = await startLocalBrowserProxy({
      profile: input.options.profile,
      assertCurrent: input.options.assertCurrent,
    });
    supervisor = await startLocalBrowserSupervisor({
      directory,
      proxyPort: Number(new URL(proxy.server).port),
      assertAlive: input.assertAlive,
      expiresAt: input.leaseExpiresAt,
    });
    launchAttempted = true;
    const shellContext = await chromium.launchPersistentContext(
      join(directory, 'profile'),
      {
        executablePath: launcherPath,
        headless: true,
        chromiumSandbox: true,
        timeout: 15000,
        // Playwright owns a fresh random user-data-dir and communicates via pipe.
        // HOME/TMPDIR are owned ephemeral directories, never the user's home.
        env: {
          HOME: directory,
          TMPDIR: directory,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'en_US.UTF-8',
        },
        downloadsPath: directory,
        tracesDir: directory,
        proxy: {
          server: proxy.server,
          username: proxy.username,
          password: proxy.password,
        },
        serviceWorkers: 'block',
        permissions: [],
        args: [
          ...localBrowserLaunchArguments,
          `--allrice-browser-watchdog=${directory}`,
        ],
      },
    );
    browser = shellContext.browser() ?? undefined;
    if (!browser) throw Error('LOCAL_BROWSER_UNAVAILABLE');
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
      acceptDownloads: input.options.profile.allowDownloads,
      storageState: state,
      permissions: [],
      ignoreHTTPSErrors: false,
    });
    await input.options.assertCurrent();
    renderer = await createControlledBrowserRenderer(
      context,
      browser,
      {
        ...input.options,
        authorizeUrl: (url) =>
          localBrowserUrlAllowed(url, input.options.profile),
      },
      proxy.close,
    );
    return {
      observe: renderer.observe,
      perform: renderer.perform,
      close,
      checkpoint: async () => {
        if (closing || !context) throw Error('LOCAL_BROWSER_LEASE_LOST');
        if (!input.binding.persistLogin) return;
        await input.options.assertCurrent();
        const saved = await context.storageState();
        await input.options.assertCurrent();
        await input.profiles.save(input.binding, input.options.profile, saved);
      },
    };
  } catch {
    try {
      await close('lost');
    } catch {
      throw Error('LOCAL_BROWSER_CLEANUP_PENDING');
    }
    // Chromium errors can contain URLs, local paths and process arguments.
    throw Error('LOCAL_BROWSER_UNAVAILABLE');
  }
}
