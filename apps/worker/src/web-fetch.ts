import { request as httpRequest } from 'node:http';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
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

function readableWebText(content: string, mediaType: string) {
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
    .trim();
}

export function extractReadableWebText(content: string, mediaType: string) {
  return readableWebText(content, mediaType).slice(
    0,
    maximumExtractedCharacters,
  );
}

async function readOnce(url: URL, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // node:dns lookup cannot be canceled; join it, then check again before
  // opening a socket. The fallback's bounded DNS requests also settle here.
  const [address] = await resolvePublicWebHostname(url.hostname);
  signal?.throwIfAborted();
  const resolved = {
    address: address!.address,
    family: address!.family as 4 | 6,
  };
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  type Response = {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  };
  return new Promise<Response>((resolve, reject) => {
    let result: Response | undefined;
    let failure: Error | undefined;
    const request = transport(
      url,
      {
        method: 'GET',
        signal,
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
        response.on('error', (error) => {
          failure ??= error;
          request.destroy(error);
        });
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
        response.on('end', () => {
          result = {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          };
        });
      },
    );
    request.setTimeout(requestTimeoutMs, () =>
      request.destroy(new HandlerError('WEB_TIMEOUT', '网页读取超时', true)),
    );
    request.on('error', (error) => {
      failure ??= error;
    });
    // An error notification alone does not prove HTTP/socket cleanup. Join
    // close, including cancellation and mid-body failures, before replying.
    request.on('close', () => {
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (result) resolve(result);
      else
        reject(
          new HandlerError(
            'WEB_RESPONSE_INCOMPLETE',
            '网页响应未完整结束',
            true,
          ),
        );
    });
    request.end();
  });
}

export async function fetchPublicWebPage(
  value: string,
  signal?: AbortSignal,
): Promise<WebFetchResult> {
  let url = validatePublicWebUrl(value);
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    const response = await readOnce(url, signal);
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
    const content = readableWebText(response.body, mediaType);
    return {
      url: url.toString(),
      statusCode: response.status,
      body: {
        kind: 'text',
        content: content.slice(0, maximumExtractedCharacters),
      },
      truncated: content.length > maximumExtractedCharacters,
    };
  }
  throw new HandlerError('WEB_REDIRECT_INVALID', '网页重定向过多', false);
}
