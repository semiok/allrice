import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import { HandlerError } from './errors.js';
import { createPinnedLookup } from './pinned-lookup.js';

const maximumRedirects = 3;
const maximumResponseBytes = 750_000;
const maximumExtractedCharacters = 20_000;
const requestTimeoutMs = 15_000;
const allowedMediaTypes = [
  'text/html',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/xml',
  'text/xml',
];

function ipv4Number(address: string) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
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

function inIpv4Range(address: number, base: string, prefix: number) {
  const baseNumber = ipv4Number(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

export function isPublicWebAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address)!;
    const blocked: [string, number][] = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return !blocked.some(([base, prefix]) => inIpv4Range(value, base, prefix));
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split('%')[0]!;
    if (normalized.startsWith('::ffff:')) {
      return isPublicWebAddress(normalized.slice('::ffff:'.length));
    }
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

export function validatePublicWebUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HandlerError('WEB_URL_INVALID', '网页地址格式不正确', false);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HandlerError(
      'WEB_URL_INVALID',
      '只允许读取 HTTP 或 HTTPS 网页',
      false,
    );
  }
  const portAllowed =
    !url.port ||
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443');
  if (url.username || url.password || !portAllowed) {
    throw new HandlerError(
      'WEB_URL_INVALID',
      '网页地址包含不允许的认证或端口',
      false,
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new HandlerError(
      'WEB_ADDRESS_BLOCKED',
      '不允许读取内部网络地址',
      false,
    );
  }
  if (isIP(hostname) && !isPublicWebAddress(hostname)) {
    throw new HandlerError(
      'WEB_ADDRESS_BLOCKED',
      '不允许读取内部网络地址',
      false,
    );
  }
  url.hash = '';
  return url;
}

function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

export function extractReadableWebText(content: string, mediaType: string) {
  let text = content;
  if (mediaType === 'text/html') {
    text = text
      .replace(/<(script|style|noscript|svg|canvas)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(
        /<\/?(?:p|div|article|section|main|header|footer|li|h[1-6]|br|tr)[^>]*>/gi,
        '\n',
      )
      .replace(/<[^>]+>/g, ' ');
  }
  return decodeEntities(text)
    .replace(
      /BEGIN[_ -]UNTRUSTED[_ -]CONTENT|END[_ -]UNTRUSTED[_ -]CONTENT/gi,
      '',
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, maximumExtractedCharacters);
}

async function resolvePublicAddress(hostname: string) {
  if (isIP(hostname)) {
    if (!isPublicWebAddress(hostname)) {
      throw new HandlerError(
        'WEB_ADDRESS_BLOCKED',
        '不允许读取内部网络地址',
        false,
      );
    }
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicWebAddress(item.address))
  ) {
    throw new HandlerError(
      'WEB_ADDRESS_BLOCKED',
      '域名解析到了非公开网络地址',
      false,
    );
  }
  return addresses[0]!;
}

async function readOnce(url: URL) {
  const resolved = await resolvePublicAddress(url.hostname);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    const request = transport(
      url,
      {
        method: 'GET',
        headers: {
          accept:
            'text/html,text/plain,text/markdown,application/json,application/xml;q=0.9',
          'accept-encoding': 'identity',
          'user-agent': 'AllRice-WebFetch/1.0',
        },
        family: resolved.family,
        lookup: createPinnedLookup(resolved),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > maximumResponseBytes) {
            request.destroy(
              new HandlerError(
                'WEB_RESPONSE_TOO_LARGE',
                '网页内容超过读取上限',
                false,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.setTimeout(requestTimeoutMs, () =>
      request.destroy(new HandlerError('WEB_TIMEOUT', '网页读取超时', true)),
    );
    request.on('error', reject);
    request.end();
  });
}

export async function fetchPublicWebPage(value: string) {
  let url = validatePublicWebUrl(value);
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    const response = await readOnce(url);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (
        !location ||
        Array.isArray(location) ||
        redirect === maximumRedirects
      ) {
        throw new HandlerError(
          'WEB_REDIRECT_INVALID',
          '网页重定向无效或过多',
          false,
        );
      }
      url = validatePublicWebUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HandlerError(
        'WEB_HTTP_ERROR',
        `网页返回 HTTP ${response.status}`,
        true,
      );
    }
    const mediaType = String(response.headers['content-type'] ?? 'text/plain')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!allowedMediaTypes.includes(mediaType)) {
      throw new HandlerError(
        'WEB_CONTENT_TYPE_BLOCKED',
        '网页内容类型不受支持',
        false,
      );
    }
    const content = extractReadableWebText(response.body, mediaType);
    return {
      url: url.toString(),
      mediaType,
      content: `<external-content source="web.fetch" trust="untrusted">\n${content}\n</external-content>`,
      truncated: content.length >= maximumExtractedCharacters,
      externalContent: { source: 'web.fetch', untrusted: true, wrapped: true },
    };
  }
  throw new HandlerError('WEB_REDIRECT_INVALID', '网页重定向过多', false);
}
