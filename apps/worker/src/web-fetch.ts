import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { HandlerError } from './errors.js';
import { createPinnedLookup } from './pinned-lookup.js';
import {
  resolvePublicWebHostname,
  validatePublicWebUrl,
} from './public-web-network.js';

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

export {
  isPublicWebAddress,
  validatePublicWebUrl,
} from './public-web-network.js';

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

async function readOnce(url: URL) {
  const [address] = await resolvePublicWebHostname(url.hostname);
  const resolved = {
    address: address!.address,
    family: address!.family as 4 | 6,
  };
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
