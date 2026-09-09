import { createHash, randomUUID } from 'node:crypto';
import type {
  Browser,
  BrowserContext,
  ElementHandle,
  Request,
} from 'playwright-core';
import {
  BrowserObservationSchema,
  browserObservationLifetimeMs,
  reservedLocalPreviewUrl,
  runtimeContractEqual,
  type BrowserAction,
  type BrowserObservation,
  type BrowserProfile,
} from '@allrice/contracts';
const hash = (value: string | Buffer) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const browserObservationUrl = (value: string) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:'
      ? u.origin + u.pathname
      : 'about:blank';
  } catch {
    return 'about:blank';
  }
};
const safeUrl = browserObservationUrl;
export type BrowserRequestEffect = {
  url: string;
  urlDigest: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  bodyDigest: string;
  bodyBytes: number;
};
export type BrowserDriverOptions = {
  profileId: string;
  profile: BrowserProfile;
  /** Trusted target adapter only, never model/UI supplied. */
  authorizeUrl: (url: string) => boolean | Promise<boolean>;
  /** Called immediately before every request, including all redirects/subresources. */
  assertCurrent: () => Promise<void>;
  requestApproval: (
    effect: BrowserRequestEffect,
  ) => Promise<{ complete: (confirmed: boolean) => Promise<void> }>;
  requestSent: () => void;
  /** Synchronous ownership reservation before any asynchronous request checks. */
  requestStarted: () => () => void;
  /** P23 trusted process adapter only. Reserved origins NEVER fall back to
   * normal network/DNS, and this hook runs after the same current-authority
   * and exact write-request approval gates as ordinary browser traffic. */
  localPreviewRelay?: (request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: Buffer;
  }) => Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }>;
};
export type BrowserDriver = {
  observe: (
    fence: number,
  ) => Promise<{ observation: BrowserObservation; screenshot: Buffer }>;
  perform: (
    action: BrowserAction,
    observation: BrowserObservation | null,
    input?: Buffer,
  ) => Promise<{
    download?: { bytes: Buffer; name: string; mediaType: string };
  }>;
  close: () => Promise<void>;
};

/** Pure renderer: no DB, no browser attachment, no network-policy defaults. */
export async function createControlledBrowserRenderer(
  context: BrowserContext,
  browser: Browser,
  options: BrowserDriverOptions,
  closeProxy: () => Promise<void>,
): Promise<BrowserDriver> {
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(15000);
  let closed = false,
    revision = 0,
    requestCount = 0,
    observedDomDigest = '';
  const transientRedactions: string[] = [];
  const redact = (s: string) =>
    transientRedactions.reduce(
      (text, secret) => text.replaceAll(secret, '[private input]'),
      s,
    );
  const elements = new Map<string, ElementHandle<HTMLElement | SVGElement>>();
  let currentObservation: BrowserObservation | null = null;
  const networkSettlers = new WeakMap<
    Request,
    (confirmed: boolean) => Promise<void>
  >();
  const completedRequests = new WeakSet<Request>();
  context.on('requestfinished', (request) => {
    completedRequests.add(request);
    void networkSettlers.get(request)?.(true);
    networkSettlers.delete(request);
  });
  context.on('requestfailed', (request) => {
    completedRequests.add(request);
    void networkSettlers.get(request)?.(false);
    networkSettlers.delete(request);
  });
  context.on('page', (p) => {
    if (p !== page) void p.close().catch(() => undefined);
  });
  await context.routeWebSocket(/.*/, (ws) =>
    ws.close({ code: 1008, reason: 'Browser control websocket denied' }),
  );
  const authorized = new WeakSet<Request>();
  await context.route('**/*', async (route) => {
    const request = route.request();
    const release = !['GET', 'HEAD', 'OPTIONS'].includes(request.method())
      ? options.requestStarted()
      : () => {};
    try {
      if (
        closed ||
        ++requestCount > 200 ||
        !(await options.authorizeUrl(request.url()))
      )
        throw Error();
      // A redirect never inherits a previous body's approval, even if origins match.
      if (
        request.redirectedFrom() &&
        request.method() !== 'GET' &&
        request.method() !== 'HEAD'
      )
        throw Error();
      await options.assertCurrent();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        if (
          !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) ||
          authorized.has(request)
        )
          throw Error();
        const declared = request.headers()['content-length'];
        if (
          declared !== undefined &&
          (!/^\d+$/.test(declared) || Number(declared) > 2500000)
        )
          throw Error();
        const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
        try {
          if (bytes.length > 2500000) throw Error();
          // Query strings may contain login material: bind exact bytes by digest,
          // but only disclose origin/path to the model and durable audit.
          const permission = await options.requestApproval({
            url: safeUrl(request.url()),
            urlDigest: hash(request.url()),
            method: request.method() as BrowserRequestEffect['method'],
            bodyDigest: hash(bytes),
            bodyBytes: bytes.length,
          });
          // A close/failure can occur while authority approval is in flight.
          // Its event has already passed: do not orphan a newly returned permit
          // in the WeakMap, and never send the canceled request after approval.
          if (closed || completedRequests.has(request)) {
            await permission.complete(false);
            throw Error('BROWSER_REQUEST_ALREADY_STOPPED');
          }
          networkSettlers.set(request, permission.complete);
        } finally {
          bytes.fill(0);
        }
        await options.assertCurrent();
        authorized.add(request);
        options.requestSent();
      }
      if (reservedLocalPreviewUrl(request.url())) {
        if (!options.localPreviewRelay) throw Error();
        const body = request.postDataBuffer() ?? Buffer.alloc(0);
        try {
          const result = await options.localPreviewRelay({
            url: request.url(),
            method: request.method(),
            headers: request.headers(),
            body,
          });
          try {
            await options.assertCurrent();
            await route.fulfill(result);
          } finally {
            result.body.fill(0);
          }
        } finally {
          body.fill(0);
        }
      } else await route.fallback();
    } catch {
      await route.abort('blockedbyclient').catch(() => undefined);
    } finally {
      release();
    }
  });
  async function pageSummary() {
    return page.evaluate(() => {
      const body = document.body;
      let text = '';
      if (body) {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        let visited = 0;
        while (
          (node = walker.nextNode()) &&
          visited++ < 10000 &&
          text.length < 12000
        ) {
          if (
            node.parentElement?.closest(
              'script,style,textarea,input,[hidden],[aria-hidden="true"],[data-private]',
            )
          )
            continue;
          text += (node.nodeValue ?? '').slice(0, 12000 - text.length);
        }
      }
      return { title: document.title.slice(0, 200), text };
    });
  }
  async function describe(
    handle: ElementHandle<HTMLElement | SVGElement>,
    id: string,
  ) {
    const description = await handle.evaluate((el, id) => {
      const tag = el.tagName.toLowerCase() as
        'a' | 'button' | 'input' | 'textarea' | 'select';
      const inputType = (el.getAttribute('type') ?? '')
        .toLowerCase()
        .slice(0, 40);
      const hint = [
        el.getAttribute('name'),
        el.getAttribute('autocomplete'),
        el.getAttribute('aria-label'),
      ].join(' ');
      const sensitive =
        inputType === 'password' ||
        /password|passwd|secret|token|otp|one.time|verification|credential/i.test(
          hint,
        );
      return {
        id,
        tag,
        inputType,
        sensitive,
        label: (
          el.getAttribute('aria-label') ??
          el.getAttribute('placeholder') ??
          (tag === 'input' ? '' : el.textContent) ??
          tag
        ).slice(0, 200),
      };
    }, id);
    return { ...description, label: redact(description.label) };
  }
  async function domDigest() {
    // Values/URLs are hashed only in the owned process, never in page observations.
    const state = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a,button,input,textarea,select'))
        .slice(0, 1001)
        .map((el) => ({
          tag: el.tagName,
          attrs: [
            'href',
            'type',
            'name',
            'formaction',
            'formmethod',
            'disabled',
          ].map((key) => el.getAttribute(key)),
          value: ('value' in el ? String(el.value) : '').slice(0, 8192),
          form: el.closest('form')?.getAttribute('action'),
          method: el.closest('form')?.getAttribute('method'),
        })),
    );
    return hash(JSON.stringify(state));
  }
  async function observeOnce(fence: number) {
    await options.assertCurrent();
    const beforeUrl = page.url(),
      beforeDom = await domDigest();
    for (const h of elements.values()) await h.dispose();
    elements.clear();
    const locator = page.locator('a,button,input,textarea,select');
    const handles: ElementHandle<HTMLElement | SVGElement>[] = [];
    const count = await locator.count();
    if (count > 1000) throw Error('BROWSER_PAGE_TOO_COMPLEX');
    for (let i = 0; i < count; i++) {
      const h = await locator.nth(i).elementHandle();
      if (h) handles.push(h as ElementHandle<HTMLElement | SVGElement>);
    }
    const descriptions = [];
    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i]!;
      if (descriptions.length >= 200 || !(await handle.isVisible())) {
        await handle.dispose();
        continue;
      }
      const id: string = `e${descriptions.length + 1}`;
      elements.set(id, handle);
      descriptions.push(await describe(handle, id));
    }
    const rawSummary = await pageSummary(),
      summary = {
        title: redact(rawSummary.title),
        text: redact(rawSummary.text),
      },
      url = safeUrl(page.url());
    observedDomDigest = await domDigest();
    const capturedAt = new Date(),
      expiresAt = new Date(capturedAt.getTime() + browserObservationLifetimeMs);
    const observation = BrowserObservationSchema.parse({
      version: 1,
      id: randomUUID(),
      profileId: options.profileId,
      fence,
      revision: ++revision,
      capturedAt: capturedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      url,
      ...summary,
      pageDigest: hash(
        JSON.stringify({ url, ...summary, elements: descriptions }),
      ),
      elements: descriptions,
      screenshotObjectId: null,
    });
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      mask: [
        page.locator('input,textarea,[data-private]'),
        ...transientRedactions.map((value) =>
          page.getByText(value, { exact: false }),
        ),
      ],
    });
    if (screenshot.length > 5000000)
      throw Error('BROWSER_SCREENSHOT_TOO_LARGE');
    if (page.url() !== beforeUrl || (await domDigest()) !== beforeDom)
      throw Error('BROWSER_OBSERVATION_CHANGED');
    for (const handle of elements.values())
      if (!(await handle.evaluate((el) => el.isConnected)))
        throw Error('BROWSER_OBSERVATION_CHANGED');
    currentObservation = observation;
    return { observation, screenshot };
  }
  async function observe(fence: number) {
    for (let retry = 0; retry < 3; retry++) {
      try {
        return await observeOnce(fence);
      } catch (error) {
        const navigationChanged =
          error instanceof Error &&
          (error.message === 'BROWSER_OBSERVATION_CHANGED' ||
            error.message.startsWith(
              'page.evaluate: Execution context was destroyed',
            ));
        if (!navigationChanged || retry === 2) throw error;
        // Read-only capture retry after a concurrent navigation, never replays input.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw Error('BROWSER_OBSERVATION_CHANGED');
  }
  async function currentElement(
    action: Extract<BrowserAction, { elementId: string }>,
    observation: BrowserObservation | null,
  ) {
    if (
      !observation ||
      !currentObservation ||
      observation.id !== currentObservation.id ||
      Date.parse(observation.expiresAt) <= Date.now()
    )
      throw Error('BROWSER_OBSERVATION_STALE');
    const h = elements.get(action.elementId),
      expected = observation.elements.find((e) => e.id === action.elementId);
    if (
      !h ||
      !expected ||
      !(await h.isVisible()) ||
      !(await h.evaluate((el) => el.isConnected)) ||
      !runtimeContractEqual(await describe(h, action.elementId), expected)
    )
      throw Error('BROWSER_ELEMENT_CHANGED');
    if ((await domDigest()) !== observedDomDigest)
      throw Error('BROWSER_PAGE_CHANGED');
    const rawSummary = await pageSummary(),
      summary = {
        title: redact(rawSummary.title),
        text: redact(rawSummary.text),
      };
    const descriptions = [];
    for (const [id, handle] of elements) {
      if (!(await handle.evaluate((el) => el.isConnected)))
        throw Error('BROWSER_PAGE_CHANGED');
      descriptions.push(await describe(handle, id));
    }
    if (
      hash(
        JSON.stringify({
          url: safeUrl(page.url()),
          ...summary,
          elements: descriptions,
        }),
      ) !== observation.pageDigest
    )
      throw Error('BROWSER_PAGE_CHANGED');
    return { h, expected };
  }
  async function perform(
    action: BrowserAction,
    observation: BrowserObservation | null,
    input?: Buffer,
  ) {
    await options.assertCurrent();
    if (action.type === 'observe') return {};
    if (action.type === 'request') throw Error('BROWSER_REQUEST_SOURCE_DENIED');
    if (action.type === 'navigate') {
      if (!(await options.authorizeUrl(action.url)))
        throw Error('BROWSER_ORIGIN_DENIED');
      await page.goto(action.url, { waitUntil: 'domcontentloaded' });
      return {};
    }
    const { h, expected } = await currentElement(action, observation);
    if (action.type === 'fill') {
      if (expected.sensitive || !['input', 'textarea'].includes(expected.tag))
        throw Error('BROWSER_SENSITIVE_INPUT_DENIED');
      await h.fill(action.value);
      return {};
    }
    if (action.type === 'sensitive_fill') {
      if (
        !expected.sensitive ||
        !input ||
        !options.profile.allowHumanCredentials
      )
        throw Error('BROWSER_SENSITIVE_INPUT_DENIED');
      if (transientRedactions.length >= 10) throw Error('BROWSER_INPUT_LIMIT');
      const value = input.toString('utf8');
      transientRedactions.push(value);
      try {
        await h.fill(value);
      } finally {
        input.fill(0);
      }
      return {};
    }
    if (action.type === 'upload') {
      if (
        !options.profile.allowUploads ||
        expected.inputType !== 'file' ||
        !input ||
        input.length > options.profile.maximumFileBytes ||
        hash(input) !== action.checksum
      )
        throw Error('BROWSER_UPLOAD_DENIED');
      await h.setInputFiles({
        name: action.fileName,
        mimeType: 'application/octet-stream',
        buffer: input,
      });
      return {};
    }
    if (action.type === 'download') {
      if (!options.profile.allowDownloads || expected.tag !== 'a')
        throw Error('BROWSER_DOWNLOAD_DENIED');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        h.click(),
      ]);
      try {
        if (!(await options.authorizeUrl(download.url())))
          throw Error('BROWSER_DOWNLOAD_DENIED');
        const stream = await download.createReadStream();
        if (!stream) throw Error('BROWSER_DOWNLOAD_FAILED');
        const parts: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const part = Buffer.from(chunk);
          size += part.length;
          if (size > options.profile.maximumFileBytes) {
            stream.destroy();
            throw Error('BROWSER_DOWNLOAD_TOO_LARGE');
          }
          parts.push(part);
        }
        return {
          download: {
            bytes: Buffer.concat(parts),
            name:
              download
                .suggestedFilename()
                .replace(/[^A-Za-z0-9._-]/g, '_')
                .slice(0, 100) || 'download.bin',
            mediaType: 'application/octet-stream',
          },
        };
      } finally {
        await download.delete().catch(() => undefined);
      }
    }
    if (expected.inputType === 'file') throw Error('BROWSER_UPLOAD_REQUIRED');
    // Retain the browser's causal navigation barrier. Returning after only the
    // mouse event can precede its intercepted form POST and incorrectly hand
    // control back to observation. Approval may outlive the normal 5s element
    // timeout, but never this cap or the controller's earlier lease/close.
    await h.click({ noWaitAfter: false, timeout: 120000 });
    return {};
  }
  return {
    observe,
    perform,
    close: async () => {
      if (closed) return;
      closed = true;
      // Failure must not skip other owned cleanup, or acknowledge an unconfirmed stop.
      const settled = await Promise.allSettled([
        context.close(),
        browser.close(),
        closeProxy(),
      ]);
      transientRedactions.length = 0;
      if (settled.some((r) => r.status === 'rejected'))
        throw Error('BROWSER_STOP_UNCONFIRMED');
    },
  };
}
