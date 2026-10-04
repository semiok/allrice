import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import {
  StaticBrowserDocumentSchema,
  BrowserVerificationPlanSchema,
  staticBrowserDocumentUrl,
} from '@allrice/contracts';
import {
  createControlledBrowserRenderer,
  verifyStaticBrowser,
  type BrowserDriver,
} from '@allrice/browser-control';
import type { BrowserObservation } from '@allrice/contracts';

/** Fixed image entry point. The document is data; no tenant command, URL,
 * filesystem, host browser, cookies or credentials enters this process. */
let input = '',
  inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += Buffer.byteLength(chunk);
  if (inputBytes > 300_000) throw Error('STATIC_BROWSER_INPUT_LIMIT');
  input += chunk.toString();
  if (input.includes('\n')) break;
}
const raw: unknown = JSON.parse(input);
if (!raw || typeof raw !== 'object' || !('document' in raw) || !('plan' in raw))
  throw Error('STATIC_BROWSER_INPUT_INVALID');
const document = StaticBrowserDocumentSchema.parse(raw.document),
  plan = BrowserVerificationPlanSchema.parse(raw.plan),
  url = staticBrowserDocumentUrl(document.target),
  expires = Date.now() + 90_000;
const assertCurrent = async () => {
  if (Date.now() >= expires) throw Error('STATIC_BROWSER_DEADLINE');
};
// Chromium's own namespace sandbox is unavailable inside gVisor. The Docker
// operator must prove runsc/read-only/no-network/cgroup isolation separately.
const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  chromiumSandbox: false,
  timeout: 30_000,
  args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-quic'],
});
const browserVersion = browser.version();
let renderer: BrowserDriver | undefined;
try {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    permissions: [],
    acceptDownloads: false,
    viewport: { width: 1280, height: 720 },
  });
  renderer = await createControlledBrowserRenderer(
    context,
    browser,
    {
      profileId: randomUUID(),
      profile: {
        version: 1,
        origins: [new URL(url).origin],
        maximumFileBytes: 100_000,
        lifetimeMs: 90_000,
        allowUploads: false,
        allowDownloads: false,
        allowHumanCredentials: false,
      },
      authorizeUrl: (value) => value === url,
      assertCurrent,
      requestApproval: async () => {
        throw Error('STATIC_BROWSER_NETWORK_DENIED');
      },
      requestSent: () => {},
      requestStarted: () => () => {},
      staticDocument: document,
    },
    async () => {},
  );
  const driver = renderer;
  let capture: { observation: BrowserObservation; screenshot: Buffer } | null =
    null;
  const report = await verifyStaticBrowser({
    target: document.target,
    plan,
    assertCurrent,
    observe: async () => {
      capture = await driver.observe(1);
      return capture.observation;
    },
    perform: async (action, observation) => {
      await driver.perform(action, observation);
    },
  });
  const last = capture ?? (await renderer.observe(1));
  const screenshot = last.screenshot;
  await renderer.close();
  renderer = undefined;
  await browser.close();
  // A failed assertion is a completed verification, with retained evidence.
  // Physical container exit/stop, not this message, gates publication.
  process.stdout.write(
    JSON.stringify({
      type: 'static_verification',
      report,
      browserVersion,
      screenshotBase64: screenshot.toString('base64'),
      screenshotObservationId: last.observation.id,
    }) + '\n',
  );
} finally {
  await renderer?.close();
  await browser.close();
}
