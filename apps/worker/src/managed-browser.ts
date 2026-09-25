import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, isIP, type Socket } from 'node:net';

import { chromium, type Page } from 'playwright-core';

import { HandlerError } from './errors.js';
import { isPublicWebAddress, validatePublicWebUrl } from './web-fetch.js';

const defaultMaximumCharacters = 30_000;
const maximumAllowedCharacters = 100_000;
const defaultNavigationTimeoutMs = 20_000;
const maximumNavigationTimeoutMs = 45_000;
const maximumSteps = 12;
const maximumSelectorCharacters = 500;
const maximumSnapshotBytes = 1_000_000;
const maximumSnapshotHtmlCharacters = 100_000;
const maximumSnapshotNodes = 20_000;
const maximumTitleCharacters = 500;
const managedBrowserViewport = { width: 1_280, height: 720 } as const;
const maximumScreenshotBytes = 5_000_000;
const dnsOverHttpsTimeoutMs = 5_000;
const maximumDnsOverHttpsResponseBytes = 64_000;
const cloudflareDnsOverHttpsAddress = '1.1.1.1';
const cloudflareDnsOverHttpsHostname = 'cloudflare-dns.com';

export type ManagedBrowserStep =
  | {
      type: 'waitFor';
      selector: string;
      timeoutMs?: number;
    }
  | {
      type: 'followLink';
      selector: string;
    }
  | {
      type: 'scroll';
      direction?: 'down' | 'up';
      pixels?: number;
    };

export interface ManagedBrowserTaskInput {
  startUrl: string;
  allowedDomains: string[];
  steps?: ManagedBrowserStep[];
  captureScreenshot?: boolean;
  maxCharacters?: number;
  navigationTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ManagedBrowserAction {
  type: 'navigate' | ManagedBrowserStep['type'];
  status: 'succeeded';
  startedAt: string;
  completedAt: string;
  url: string;
  detail?: string;
}

export interface ManagedBrowserTaskResult {
  finalUrl: string;
  title: string;
  text: string;
  capturedAt: string;
  actions: ManagedBrowserAction[];
  contentSnapshot: {
    mediaType: 'application/json';
    bytes: Buffer;
    checksum: string;
  };
  screenshot?: {
    mediaType: 'image/png';
    bytes: Buffer;
    checksum: string;
  };
}

interface PreparedManagedBrowserTask extends Omit<
  ManagedBrowserTaskInput,
  'allowedDomains' | 'steps'
> {
  startUrl: string;
  allowedDomains: string[];
  steps: ManagedBrowserStep[];
  maxCharacters: number;
  navigationTimeoutMs: number;
  assertRequestAllowed: (
    value: string,
    options?: { documentNavigation?: boolean },
  ) => Promise<URL | null>;
  resolvePublicAddresses: (hostname: string) => Promise<HostnameAddress[]>;
}

export type ManagedBrowserRunner = (
  input: PreparedManagedBrowserTask,
) => Promise<ManagedBrowserTaskResult>;

export interface ManagedBrowserDependencies {
  runner?: ManagedBrowserRunner;
  assertHostnamePublic?: (hostname: string) => Promise<void>;
  resolveHostnamePublic?: (hostname: string) => Promise<HostnameAddress[]>;
}

export interface HostnameAddress {
  address: string;
  family?: number;
}

interface ManagedBrowserHostnameValidationDependencies {
  lookupHostname?: (hostname: string) => Promise<HostnameAddress[]>;
  lookupDnsOverHttps?: (hostname: string) => Promise<string[]>;
}

function browserError(code: string, message: string, retryable = false) {
  return new HandlerError(code, message, retryable);
}

function normalizeAllowedDomain(value: string) {
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^\*\./, '')
    .replace(/\.$/, '');
  if (
    !domain ||
    domain.includes('/') ||
    domain.includes(':') ||
    domain.includes('@')
  ) {
    throw browserError(
      'BROWSER_DOMAIN_INVALID',
      `浏览器允许域名格式不正确：${value}`,
    );
  }
  return domain;
}

export function isManagedBrowserDomainAllowed(
  hostname: string,
  allowedDomains: string[],
) {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, '');
  return allowedDomains.some(
    (domain) =>
      normalizedHostname === domain ||
      normalizedHostname.endsWith(`.${domain}`),
  );
}

function validateSelector(value: string) {
  const selector = value.trim();
  if (!selector || selector.length > maximumSelectorCharacters) {
    throw browserError(
      'BROWSER_SELECTOR_INVALID',
      '浏览器选择器为空或超过长度上限',
    );
  }
  return selector;
}

export function normalizeManagedBrowserSteps(
  steps: ManagedBrowserStep[] | undefined,
) {
  if (!steps) return [];
  if (!Array.isArray(steps) || steps.length > maximumSteps) {
    throw browserError(
      'BROWSER_STEPS_INVALID',
      `浏览器任务最多允许 ${maximumSteps} 个只读步骤`,
    );
  }
  return steps.map((step): ManagedBrowserStep => {
    if (step.type === 'waitFor') {
      return {
        type: 'waitFor',
        selector: validateSelector(step.selector),
        timeoutMs: Math.min(
          Math.max(Math.trunc(step.timeoutMs ?? 10_000), 250),
          maximumNavigationTimeoutMs,
        ),
      };
    }
    if (step.type === 'followLink') {
      return {
        type: 'followLink',
        selector: validateSelector(step.selector),
      };
    }
    if (step.type === 'scroll') {
      return {
        type: 'scroll',
        direction: step.direction === 'up' ? 'up' : 'down',
        pixels: Math.min(Math.max(Math.trunc(step.pixels ?? 800), 1), 5_000),
      };
    }
    throw browserError(
      'BROWSER_STEP_UNSUPPORTED',
      '浏览器任务只允许等待、跟随公开链接和滚动页面',
    );
  });
}

function ipv4Number(address: string) {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return null;
  }
  return (
    (((parts[0]! << 24) >>> 0) +
      (parts[1]! << 16) +
      (parts[2]! << 8) +
      parts[3]!) >>>
    0
  );
}

/**
 * RFC 2544 reserves 198.18.0.0/15 for benchmark tests. Some local TUN
 * implementations deliberately synthesize addresses from this range while
 * proxying an otherwise public hostname. Literal uses of the range remain
 * blocked; this predicate is only used to decide whether an independent DNS
 * confirmation may be attempted for a hostname.
 */
export function isRfc2544SyntheticAddress(address: string) {
  const value = ipv4Number(address);
  const base = ipv4Number('198.18.0.0')!;
  return value !== null && (value & 0xfffe0000) >>> 0 === base;
}

interface DnsOverHttpsResponse {
  Status?: number;
  Answer?: Array<{
    type?: number;
    data?: string;
  }>;
}

async function queryCloudflareDnsOverHttps(
  hostname: string,
  type: 'A' | 'AAAA',
) {
  return new Promise<string[]>((resolve, reject) => {
    const path = `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: cloudflareDnsOverHttpsAddress,
        port: 443,
        servername: cloudflareDnsOverHttpsHostname,
        path,
        method: 'GET',
        headers: {
          accept: 'application/dns-json',
          host: cloudflareDnsOverHttpsHostname,
          'user-agent': 'AllRice-ManagedBrowser-DNS/1.0',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maximumDnsOverHttpsResponseBytes) {
            request.destroy(new Error('DNS-over-HTTPS response is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `DNS-over-HTTPS returned HTTP ${response.statusCode ?? 0}`,
              ),
            );
            return;
          }
          try {
            const payload = JSON.parse(
              Buffer.concat(chunks).toString('utf8'),
            ) as DnsOverHttpsResponse;
            if (payload.Status !== 0 && payload.Status !== 3) {
              reject(
                new Error(
                  `DNS-over-HTTPS returned DNS status ${payload.Status ?? -1}`,
                ),
              );
              return;
            }
            resolve(
              (payload.Answer ?? [])
                .filter((answer) => answer.type === (type === 'A' ? 1 : 28))
                .map((answer) => answer.data?.trim() ?? ''),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(dnsOverHttpsTimeoutMs, () => {
      request.destroy(new Error('DNS-over-HTTPS request timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function lookupPublicDnsOverHttps(hostname: string) {
  const answers = await Promise.all([
    queryCloudflareDnsOverHttps(hostname, 'A'),
    queryCloudflareDnsOverHttps(hostname, 'AAAA'),
  ]);
  return answers.flat();
}

export async function resolveManagedBrowserHostnamePublic(
  hostname: string,
  dependencies: ManagedBrowserHostnameValidationDependencies = {},
) {
  if (isIP(hostname)) {
    if (!isPublicWebAddress(hostname)) {
      throw browserError(
        'BROWSER_ADDRESS_BLOCKED',
        '浏览器任务不允许访问内部网络地址',
      );
    }
    return [{ address: hostname, family: isIP(hostname) }];
  }
  const addresses = await (
    dependencies.lookupHostname ??
    ((value: string) => lookup(value, { all: true, verbatim: true }))
  )(hostname);
  if (
    addresses.length &&
    addresses.every((item) => isPublicWebAddress(item.address))
  ) {
    return addresses;
  }

  const onlyRfc2544SyntheticAddresses =
    addresses.length > 0 &&
    addresses.every((item) => isRfc2544SyntheticAddress(item.address));
  if (!onlyRfc2544SyntheticAddresses) {
    throw browserError(
      'BROWSER_ADDRESS_BLOCKED',
      '浏览器任务域名解析到了非公开网络地址',
    );
  }

  let independentAddresses: string[];
  try {
    independentAddresses = await (
      dependencies.lookupDnsOverHttps ?? lookupPublicDnsOverHttps
    )(hostname);
  } catch {
    throw browserError(
      'BROWSER_DNS_VALIDATION_FAILED',
      '浏览器任务无法独立确认域名的公开网络地址',
      true,
    );
  }
  if (
    !independentAddresses.length ||
    independentAddresses.some(
      (address) => !isIP(address) || !isPublicWebAddress(address),
    )
  ) {
    throw browserError(
      'BROWSER_ADDRESS_BLOCKED',
      '浏览器任务域名的独立解析包含非公开网络地址',
    );
  }
  return independentAddresses.map((address) => ({
    address,
    family: isIP(address),
  }));
}

export async function assertManagedBrowserHostnamePublic(
  hostname: string,
  dependencies: ManagedBrowserHostnameValidationDependencies = {},
) {
  await resolveManagedBrowserHostnamePublic(hostname, dependencies);
}

function isInheritedBrowserUrl(value: string) {
  return (
    value === 'about:blank' ||
    value.startsWith('data:') ||
    value.startsWith('blob:')
  );
}

function createRequestValidator(
  allowedDomains: string[],
  validateHostname: (hostname: string) => Promise<void>,
) {
  return async (
    value: string,
    options: { documentNavigation?: boolean } = {},
  ) => {
    if (isInheritedBrowserUrl(value)) {
      if (options.documentNavigation) {
        throw browserError(
          'BROWSER_ADDRESS_BLOCKED',
          '浏览器任务只允许导航到公开 HTTP 或 HTTPS 页面',
        );
      }
      return null;
    }
    let url: URL;
    try {
      url = validatePublicWebUrl(value);
    } catch (error) {
      if (error instanceof HandlerError) {
        throw browserError('BROWSER_ADDRESS_BLOCKED', error.message);
      }
      throw error;
    }
    if (
      options.documentNavigation &&
      !isManagedBrowserDomainAllowed(url.hostname, allowedDomains)
    ) {
      throw browserError(
        'BROWSER_DOMAIN_BLOCKED',
        `浏览器任务不允许导航到域名 ${url.hostname}`,
      );
    }
    await validateHostname(url.hostname);
    return url;
  };
}

export function createManagedBrowserPinnedAddressResolver(
  resolveHostname: (hostname: string) => Promise<HostnameAddress[]>,
) {
  const pinned = new Map<string, Promise<HostnameAddress[]>>();
  return async (hostname: string) => {
    const normalized = hostname.toLowerCase().replace(/\.$/, '');
    let resolution = pinned.get(normalized);
    if (!resolution) {
      resolution = resolveHostname(normalized).then((addresses) => {
        if (
          !addresses.length ||
          addresses.some(
            ({ address }) => !isIP(address) || !isPublicWebAddress(address),
          )
        ) {
          throw browserError(
            'BROWSER_ADDRESS_BLOCKED',
            '浏览器任务域名解析到了非公开网络地址',
          );
        }
        return addresses.map(({ address, family }) => ({
          address,
          family: family ?? isIP(address),
        }));
      });
      pinned.set(normalized, resolution);
    }
    try {
      return await resolution;
    } catch (error) {
      pinned.delete(normalized);
      throw error;
    }
  };
}

export interface ManagedBrowserPinnedConnectionDependencies {
  resolvePublicAddresses: (hostname: string) => Promise<HostnameAddress[]>;
  connectTcp?: (
    address: string,
    port: number,
    family: number,
  ) => Promise<Socket>;
}

function connectTcp(address: string, port: number, family: number) {
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({
      host: address,
      port,
      ...(family === 4 || family === 6 ? { family } : {}),
    });
    const rejectConnection = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    // Keep an owner while the connected socket crosses the async hand-off to
    // its caller; a late reset still destroys the socket after resolve().
    socket.on('error', rejectConnection);
    socket.once('connect', () => {
      resolve(socket);
    });
  });
}

/**
 * Resolve a hostname through the task-scoped pin set, then connect only to a
 * numeric address from that already validated set. The original hostname is
 * deliberately not passed to `net.connect`, so Node cannot perform a second
 * DNS lookup after validation.
 */
export async function connectManagedBrowserPinnedTarget(
  hostname: string,
  port: number,
  dependencies: ManagedBrowserPinnedConnectionDependencies,
) {
  const addresses = await dependencies.resolvePublicAddresses(hostname);
  let lastError: unknown;
  for (const { address, family = isIP(address) } of addresses) {
    if (!isIP(address) || !isPublicWebAddress(address)) {
      throw browserError(
        'BROWSER_ADDRESS_BLOCKED',
        '浏览器代理拒绝连接未经验证的网络地址',
      );
    }
    try {
      return await (dependencies.connectTcp ?? connectTcp)(
        address,
        port,
        family,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw browserError(
    'BROWSER_CONNECTION_FAILED',
    lastError instanceof Error
      ? lastError.message
      : '浏览器代理无法连接已验证的公开网络地址',
    true,
  );
}

function proxyAuthorizationMatches(
  header: string | string[] | undefined,
  expected: Buffer,
) {
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header);
  return (
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  );
}

const proxyHopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sanitizedProxyHeaders(headers: IncomingHttpHeaders) {
  const sanitized: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!proxyHopByHopHeaders.has(name.toLowerCase()) && value !== undefined) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

function connectAuthority(value: string | undefined) {
  if (!value) {
    throw browserError(
      'BROWSER_PROXY_TARGET_INVALID',
      '浏览器代理缺少 HTTPS 目标地址',
    );
  }
  let target: URL;
  try {
    target = new URL(`https://${value}`);
  } catch {
    throw browserError(
      'BROWSER_PROXY_TARGET_INVALID',
      '浏览器代理 HTTPS 目标地址格式不正确',
    );
  }
  if (
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash ||
    (target.port && target.port !== '443')
  ) {
    throw browserError(
      'BROWSER_PROXY_TARGET_INVALID',
      '浏览器代理只允许连接标准 HTTPS 端口',
    );
  }
  return { hostname: target.hostname, port: 443 };
}

interface ManagedBrowserPinnedProxy {
  server: string;
  username: string;
  password: string;
  close: () => Promise<void>;
}

export async function startManagedBrowserPinnedProxy(input: {
  resolvePublicAddresses: (hostname: string) => Promise<HostnameAddress[]>;
  /** Host transport injection; destination validation still precedes connection. */
  connectTcp?: ManagedBrowserPinnedConnectionDependencies['connectTcp'];
  /** Optional task-wide transport cap; legacy read-only callers are unchanged. */
  maximumBytes?: number;
}): Promise<ManagedBrowserPinnedProxy> {
  if (
    input.maximumBytes !== undefined &&
    (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1)
  )
    throw Error('BROWSER_NETWORK_BUDGET_INVALID');
  const username = randomBytes(18).toString('base64url');
  const password = randomBytes(24).toString('base64url');
  const expectedAuthorization = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  );
  const activeSockets = new Set<Socket>();
  let transferredBytes = 0;
  const trackSocket = (socket: Socket) => {
    activeSockets.add(socket);
    // CONNECT detaches Node's HTTP parser; subsequent socket failures need an
    // owner for the lifetime of the tunnel, not just the initial TCP handshake.
    socket.on('error', () => socket.destroy());
    if (input.maximumBytes !== undefined)
      socket.on('data', (chunk) => {
        transferredBytes += chunk.length;
        if (transferredBytes > input.maximumBytes!)
          for (const active of activeSockets) active.destroy();
      });
    socket.once('close', () => activeSockets.delete(socket));
    return socket;
  };

  const server = createHttpServer((request, response) => {
    void (async () => {
      if (
        !proxyAuthorizationMatches(
          request.headers['proxy-authorization'],
          expectedAuthorization,
        )
      ) {
        response.writeHead(407, {
          'proxy-authenticate': 'Basic realm="AllRice"',
        });
        response.end();
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '')) {
        response.writeHead(405);
        response.end();
        return;
      }
      let target: URL;
      try {
        target = validatePublicWebUrl(request.url ?? '');
      } catch {
        response.writeHead(403);
        response.end();
        return;
      }
      if (
        target.protocol !== 'http:' ||
        (target.port && target.port !== '80')
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      let addresses: HostnameAddress[];
      try {
        addresses = await input.resolvePublicAddresses(target.hostname);
      } catch {
        response.writeHead(403);
        response.end();
        return;
      }
      const destination = addresses[0];
      if (
        !destination ||
        !isIP(destination.address) ||
        !isPublicWebAddress(destination.address)
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      const headers = sanitizedProxyHeaders(request.headers);
      headers.host = target.host;
      const upstream = httpRequest(
        {
          protocol: 'http:',
          hostname: destination.address,
          port: 80,
          family: destination.family,
          method: request.method,
          path: `${target.pathname}${target.search}`,
          headers,
          agent: false,
          setHost: false,
        },
        (upstreamResponse) => {
          response.writeHead(
            upstreamResponse.statusCode ?? 502,
            sanitizedProxyHeaders(upstreamResponse.headers),
          );
          upstreamResponse.pipe(response);
        },
      );
      upstream.once('socket', trackSocket);
      upstream.once('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      upstream.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });

  server.on('connection', trackSocket);
  server.on('connect', (request, clientSocket, head) => {
    void (async () => {
      if (
        !proxyAuthorizationMatches(
          request.headers['proxy-authorization'],
          expectedAuthorization,
        )
      ) {
        clientSocket.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="AllRice"\r\n\r\n',
        );
        return;
      }
      let target: { hostname: string; port: number };
      try {
        target = connectAuthority(request.url);
      } catch {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      try {
        const upstreamSocket = trackSocket(
          await connectManagedBrowserPinnedTarget(
            target.hostname,
            target.port,
            {
              resolvePublicAddresses: input.resolvePublicAddresses,
              connectTcp: input.connectTcp,
            },
          ),
        );
        if (clientSocket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        // A lost browser must release the upstream connection. A failed
        // upstream must terminate this tunnel while leaving the Worker alive.
        clientSocket.once('close', () => upstreamSocket.destroy());
        upstreamSocket.once('error', () => clientSocket.destroy());
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.byteLength) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      } catch {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    })().catch(() => clientSocket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw browserError(
      'BROWSER_PROXY_START_FAILED',
      '浏览器安全代理未能分配本地端口',
    );
  }
  return {
    server: `http://127.0.0.1:${address.port}`,
    username,
    password,
    close: async () => {
      for (const socket of activeSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw browserError('BROWSER_TASK_CANCELED', '云端浏览器任务已取消', false);
  }
}

async function firstExistingPath(paths: string[]) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Continue to the next supported Chromium location.
    }
  }
  return undefined;
}

export async function resolveManagedBrowserExecutable() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (configured) {
    try {
      await access(configured);
      return configured;
    } catch {
      throw browserError(
        'BROWSER_EXECUTABLE_MISSING',
        '配置的 Chromium 执行文件不存在',
      );
    }
  }
  return firstExistingPath([
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]);
}

function checksum(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotBytes(value: object) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.byteLength <= maximumSnapshotBytes) return bytes;
  throw browserError(
    'BROWSER_SNAPSHOT_TOO_LARGE',
    '浏览器正文快照超过保存上限',
  );
}

interface ManagedBrowserPageCapture {
  title: string;
  text: string;
  html: string;
  textTruncated: boolean;
  htmlTruncated: boolean;
  nodeLimitReached: boolean;
  screenshotBytes?: Buffer;
}

/**
 * Capture only bounded strings from the renderer process. In particular, do
 * not call `page.content()` or `innerText()` and slice afterwards: both APIs
 * first materialize the entire attacker-controlled page in the shared worker.
 */
export async function captureBoundedManagedBrowserPage(
  page: Page,
  input: { maxCharacters: number; captureScreenshot?: boolean },
): Promise<ManagedBrowserPageCapture> {
  const capture = await page.evaluate(
    ({
      maxTextCharacters,
      maxHtmlCharacters,
      maxNodes,
      maxTitleCharacters,
    }) => {
      const boundedAppend = (current: string, next: string, maximum: number) =>
        current.length >= maximum
          ? current
          : current + next.slice(0, maximum - current.length);
      const escapeText = (value: string) =>
        value
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      const escapeAttribute = (value: string) =>
        escapeText(value).replaceAll('"', '&quot;');

      let text = '';
      let textTruncated = false;
      const body = document.body;
      if (body) {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode();
        while (textNode) {
          const value = textNode.nodeValue ?? '';
          const remaining = maxTextCharacters - text.length;
          if (remaining <= 0) {
            textTruncated = true;
            break;
          }
          text += value.slice(0, remaining);
          if (value.length > remaining) {
            textTruncated = true;
            break;
          }
          textNode = walker.nextNode();
        }
      }

      const voidElements = new Set([
        'area',
        'base',
        'br',
        'col',
        'embed',
        'hr',
        'img',
        'input',
        'link',
        'meta',
        'param',
        'source',
        'track',
        'wbr',
      ]);
      const root = document.documentElement;
      let html = '';
      let htmlTruncated = false;
      let nodeLimitReached = false;
      let visitedNodes = 0;
      let current: Node | null = root;
      let entering = true;
      while (current) {
        if (html.length >= maxHtmlCharacters) {
          htmlTruncated = true;
          break;
        }
        if (entering) {
          visitedNodes += 1;
          if (visitedNodes > maxNodes) {
            nodeLimitReached = true;
            break;
          }
          if (current.nodeType === Node.TEXT_NODE) {
            const remaining = maxHtmlCharacters - html.length;
            const source = (current.nodeValue ?? '').slice(0, remaining);
            const escaped = escapeText(source);
            html = boundedAppend(html, escaped, maxHtmlCharacters);
            if (escaped.length > remaining) htmlTruncated = true;
          } else if (current.nodeType === Node.ELEMENT_NODE) {
            const element = current as Element;
            const tagName = element.tagName.toLowerCase();
            html = boundedAppend(html, `<${tagName}`, maxHtmlCharacters);
            const attributeCount = Math.min(element.attributes.length, 64);
            for (let index = 0; index < attributeCount; index += 1) {
              const attribute = element.attributes.item(index);
              if (!attribute) continue;
              const name = attribute.name.slice(0, 200);
              const value = escapeAttribute(attribute.value.slice(0, 2_000));
              html = boundedAppend(
                html,
                ` ${name}="${value}"`,
                maxHtmlCharacters,
              );
              if (html.length >= maxHtmlCharacters) break;
            }
            html = boundedAppend(html, '>', maxHtmlCharacters);
          }

          const elementName =
            current.nodeType === Node.ELEMENT_NODE
              ? (current as Element).tagName.toLowerCase()
              : '';
          if (!voidElements.has(elementName) && current.firstChild) {
            current = current.firstChild;
            entering = true;
            continue;
          }
        }

        if (current.nodeType === Node.ELEMENT_NODE) {
          const tagName = (current as Element).tagName.toLowerCase();
          if (!voidElements.has(tagName)) {
            html = boundedAppend(html, `</${tagName}>`, maxHtmlCharacters);
          }
        }
        if (current === root) break;
        if (current.nextSibling) {
          current = current.nextSibling;
          entering = true;
        } else {
          current = current.parentNode;
          entering = false;
        }
      }

      return {
        title: document.title.slice(0, maxTitleCharacters),
        text,
        html,
        textTruncated,
        htmlTruncated,
        nodeLimitReached,
      };
    },
    {
      maxTextCharacters: input.maxCharacters,
      maxHtmlCharacters: maximumSnapshotHtmlCharacters,
      maxNodes: maximumSnapshotNodes,
      maxTitleCharacters: maximumTitleCharacters,
    },
  );

  const screenshotBytes = input.captureScreenshot
    ? Buffer.from(
        await page.screenshot({
          type: 'png',
          fullPage: false,
          animations: 'disabled',
          caret: 'hide',
          scale: 'css',
        }),
      )
    : undefined;
  if (screenshotBytes && screenshotBytes.byteLength > maximumScreenshotBytes) {
    throw browserError(
      'BROWSER_SCREENSHOT_TOO_LARGE',
      '浏览器视口截图超过保存上限',
    );
  }
  return {
    ...capture,
    title: capture.title.trim(),
    text: capture.text.trim(),
    ...(screenshotBytes ? { screenshotBytes } : {}),
  };
}

export function managedBrowserChromiumSandboxEnabled(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const disabled =
    environment.ALLRICE_MANAGED_BROWSER_DISABLE_CHROMIUM_SANDBOX === '1';
  if (disabled && environment.NODE_ENV === 'production') {
    throw browserError(
      'BROWSER_SANDBOX_REQUIRED',
      '生产环境禁止关闭 Chromium 沙箱',
    );
  }
  return !disabled;
}

async function defaultManagedBrowserRunner(
  input: PreparedManagedBrowserTask,
): Promise<ManagedBrowserTaskResult> {
  throwIfAborted(input.signal);
  const executablePath = await resolveManagedBrowserExecutable();
  if (!executablePath) {
    throw browserError(
      'BROWSER_EXECUTABLE_MISSING',
      'Worker 未安装可用的 Chromium 浏览器',
    );
  }

  const proxy = await startManagedBrowserPinnedProxy({
    resolvePublicAddresses: input.resolvePublicAddresses,
  });
  const browser = await chromium
    .launch({
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
    })
    .catch(async (error) => {
      await proxy.close().catch(() => undefined);
      throw error;
    });
  const context = await browser
    .newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      viewport: managedBrowserViewport,
    })
    .catch(async (error) => {
      await browser.close().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      throw error;
    });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(input.navigationTimeoutMs);
  page.setDefaultTimeout(input.navigationTimeoutMs);

  const closeBrowser = () => {
    void context
      .close()
      .catch(() => undefined)
      .finally(() => browser.close().catch(() => undefined));
  };
  input.signal?.addEventListener('abort', closeBrowser, { once: true });

  const actions: ManagedBrowserAction[] = [];
  const record = async (
    type: ManagedBrowserAction['type'],
    action: () => Promise<void>,
    detail?: string,
  ) => {
    throwIfAborted(input.signal);
    const startedAt = new Date().toISOString();
    await action();
    throwIfAborted(input.signal);
    actions.push({
      type,
      status: 'succeeded',
      startedAt,
      completedAt: new Date().toISOString(),
      url: page.url(),
      ...(detail ? { detail } : {}),
    });
  };

  try {
    await context.routeWebSocket(/.*/, async (webSocket) => {
      await webSocket.close({
        code: 1008,
        reason: 'AllRice managed browser is read-only',
      });
    });
    await context.route('**/*', async (route) => {
      const request = route.request();
      try {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          throw browserError(
            'BROWSER_METHOD_BLOCKED',
            '云端浏览器任务只允许只读网络请求',
          );
        }
        await input.assertRequestAllowed(request.url(), {
          documentNavigation:
            request.resourceType() === 'document' ||
            request.isNavigationRequest(),
        });
        await route.continue();
      } catch {
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });

    await record('navigate', async () => {
      await page.goto(input.startUrl, { waitUntil: 'domcontentloaded' });
    });

    for (const step of input.steps) {
      if (step.type === 'waitFor') {
        await record(
          'waitFor',
          async () => {
            await page.locator(step.selector).first().waitFor({
              state: 'visible',
              timeout: step.timeoutMs,
            });
          },
          step.selector,
        );
        continue;
      }
      if (step.type === 'followLink') {
        await record(
          'followLink',
          async () => {
            const link = page.locator(step.selector).first();
            await link.waitFor({ state: 'attached' });
            const tagName = await link.evaluate((element) => element.tagName);
            const href = await link.getAttribute('href');
            if (tagName !== 'A' || !href) {
              throw browserError(
                'BROWSER_LINK_REQUIRED',
                '跟随链接步骤只能选择带 href 的链接元素',
              );
            }
            const destination = new URL(href, page.url()).toString();
            await input.assertRequestAllowed(destination, {
              documentNavigation: true,
            });
            await page.goto(destination, { waitUntil: 'domcontentloaded' });
          },
          step.selector,
        );
        continue;
      }
      await record(
        'scroll',
        async () => {
          await page.mouse.wheel(
            0,
            (step.direction === 'up' ? -1 : 1) * (step.pixels ?? 800),
          );
          await page.waitForTimeout(150);
        },
        `${step.direction ?? 'down'}:${step.pixels ?? 800}`,
      );
    }

    throwIfAborted(input.signal);
    const capturedAt = new Date().toISOString();
    const capture = await captureBoundedManagedBrowserPage(page, {
      maxCharacters: input.maxCharacters,
      captureScreenshot: input.captureScreenshot,
    });
    const finalUrl = page.url();
    const contentSnapshotBytes = snapshotBytes({
      schemaVersion: 1,
      capturedAt,
      url: finalUrl,
      title: capture.title,
      text: capture.text,
      html: capture.html,
      truncation: {
        text: capture.textTruncated,
        html: capture.htmlTruncated,
        nodeLimit: capture.nodeLimitReached,
      },
      actions,
    });

    return {
      finalUrl,
      title: capture.title,
      text: capture.text,
      capturedAt,
      actions,
      contentSnapshot: {
        mediaType: 'application/json',
        bytes: contentSnapshotBytes,
        checksum: checksum(contentSnapshotBytes),
      },
      ...(capture.screenshotBytes
        ? {
            screenshot: {
              mediaType: 'image/png' as const,
              bytes: capture.screenshotBytes,
              checksum: checksum(capture.screenshotBytes),
            },
          }
        : {}),
    };
  } catch (error) {
    if (input.signal?.aborted) {
      throw browserError('BROWSER_TASK_CANCELED', '云端浏览器任务已取消');
    }
    if (error instanceof HandlerError) throw error;
    throw browserError(
      'BROWSER_EXECUTION_FAILED',
      error instanceof Error ? error.message : '云端浏览器执行失败',
      true,
    );
  } finally {
    input.signal?.removeEventListener('abort', closeBrowser);
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await proxy.close().catch(() => undefined);
  }
}

export async function runManagedBrowserTask(
  input: ManagedBrowserTaskInput,
  dependencies: ManagedBrowserDependencies = {},
) {
  throwIfAborted(input.signal);
  const allowedDomains = [
    ...new Set(input.allowedDomains.map(normalizeAllowedDomain)),
  ];
  if (!allowedDomains.length) {
    throw browserError(
      'BROWSER_DOMAINS_REQUIRED',
      '云端浏览器任务必须配置允许访问的域名',
    );
  }
  const resolvePublicAddresses = createManagedBrowserPinnedAddressResolver(
    dependencies.resolveHostnamePublic ?? resolveManagedBrowserHostnamePublic,
  );
  const assertRequestAllowed = createRequestValidator(
    allowedDomains,
    dependencies.assertHostnamePublic ??
      (async (hostname) => {
        await resolvePublicAddresses(hostname);
      }),
  );
  const startUrl = (
    await assertRequestAllowed(input.startUrl, { documentNavigation: true })
  )?.toString();
  if (!startUrl) {
    throw browserError('BROWSER_URL_INVALID', '浏览器起始地址无效');
  }
  const maxCharacters = Math.min(
    Math.max(Math.trunc(input.maxCharacters ?? defaultMaximumCharacters), 1),
    maximumAllowedCharacters,
  );
  const navigationTimeoutMs = Math.min(
    Math.max(
      Math.trunc(input.navigationTimeoutMs ?? defaultNavigationTimeoutMs),
      1_000,
    ),
    maximumNavigationTimeoutMs,
  );
  return (dependencies.runner ?? defaultManagedBrowserRunner)({
    ...input,
    startUrl,
    allowedDomains,
    steps: normalizeManagedBrowserSteps(input.steps),
    maxCharacters,
    navigationTimeoutMs,
    assertRequestAllowed,
    resolvePublicAddresses,
  });
}
