import { createHash } from 'node:crypto';

import { load } from 'cheerio';

import { HandlerError } from './errors.js';

const searchEndpoint = 'https://weixin.sogou.com/weixin';
const cookieEndpoint = 'https://v.sogou.com/v?ie=utf8&query=&p=40030600';
// Public WeChat pages often carry large inline style/script payloads even when
// the article itself is short. Keep transport bounded, then separately cap the
// normalized text sent to the model.
const maximumResponseBytes = 8_000_000;
const maximumArticleCharacters = 40_000;
const requestTimeoutMs = 15_000;
const maximumRedirects = 3;
const searchCacheTtlMs = 5 * 60_000;
const articleCacheTtlMs = 10 * 60_000;
const maximumCacheEntries = 100;

const searchHosts = new Set(['v.sogou.com', 'weixin.sogou.com']);
const articleHosts = new Set(['mp.weixin.qq.com']);

export interface WechatArticleSearchResult {
  title: string;
  account: string | null;
  publishedAt: string | null;
  snippet: string;
  url: string;
}

export interface WechatArticle {
  title: string;
  account: string | null;
  publishedAt: string | null;
  description: string | null;
  content: string;
  images: string[];
  url: string;
  retrievedAt: string;
  truncated: boolean;
  externalContent: {
    source: 'wechat.article.read';
    untrusted: true;
    wrapped: true;
  };
}

interface HttpResponse {
  status: number;
  headers: Headers;
  body: string;
  url: string;
}

export type WechatHttpRequest = (
  url: string,
  init: RequestInit,
) => Promise<HttpResponse>;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const searchCache = new Map<string, CacheEntry<WechatArticleSearchResult[]>>();
const articleCache = new Map<string, CacheEntry<WechatArticle>>();

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return structuredClone(entry.value);
}

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
) {
  cache.delete(key);
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value: structuredClone(value),
  });
  while (cache.size > maximumCacheEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function decodeHtml(value: string) {
  return load(`<body>${value}</body>`).text().trim();
}

function normalizeText(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function allowedUrl(value: string, hosts: Set<string>, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HandlerError(
      'WECHAT_URL_INVALID',
      `${label}地址格式不正确`,
      false,
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.has(url.hostname.toLowerCase())
  ) {
    throw new HandlerError(
      'WECHAT_URL_BLOCKED',
      `${label}仅允许访问获准的微信公众号公开页面`,
      false,
    );
  }
  url.hash = '';
  return url;
}

export function validateWechatArticleUrl(value: string) {
  const url = allowedUrl(value, articleHosts, '文章');
  const isLegacyArticleUrl = url.pathname === '/s';
  const isShortArticleUrl = /^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
  if (!isLegacyArticleUrl && !isShortArticleUrl) {
    throw new HandlerError(
      'WECHAT_URL_BLOCKED',
      '仅允许读取微信公众号公开文章链接',
      false,
    );
  }
  return url;
}

async function defaultHttpRequest(url: string, init: RequestInit) {
  const signal = AbortSignal.any([
    init.signal ?? new AbortController().signal,
    AbortSignal.timeout(requestTimeoutMs),
  ]);
  const response = await fetch(url, {
    ...init,
    signal,
    redirect: 'manual',
  });
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maximumResponseBytes) {
    throw new HandlerError(
      'WECHAT_RESPONSE_TOO_LARGE',
      '公众号页面超过云端读取上限',
      false,
    );
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > maximumResponseBytes) {
    throw new HandlerError(
      'WECHAT_RESPONSE_TOO_LARGE',
      '公众号页面超过云端读取上限',
      false,
    );
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    url: response.url || url,
  };
}

async function requestWithRedirects(input: {
  url: URL;
  hosts: Set<string>;
  headers: Record<string, string>;
  request: WechatHttpRequest;
}) {
  let url = input.url;
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    const response = await input.request(url.toString(), {
      method: 'GET',
      headers: input.headers,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirect === maximumRedirects) {
        throw new HandlerError(
          'WECHAT_REDIRECT_INVALID',
          '公众号页面重定向无效或过多',
          true,
        );
      }
      url = allowedUrl(new URL(location, url).toString(), input.hosts, '页面');
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new HandlerError(
        'WECHAT_HTTP_ERROR',
        `公众号服务返回 HTTP ${response.status}`,
        true,
      );
    }
    return { ...response, url: url.toString() };
  }
  throw new HandlerError(
    'WECHAT_REDIRECT_INVALID',
    '公众号页面重定向过多',
    true,
  );
}

function browserHeaders(cookie?: string) {
  return {
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 AllRice/1.0',
    ...(cookie ? { cookie } : {}),
  };
}

function blockedPage(body: string) {
  return /请输入验证码|访问过于频繁|环境异常|异常访问|antispider|verify_page/i.test(
    body,
  );
}

function assertUsablePage(body: string) {
  if (blockedPage(body)) {
    throw new HandlerError(
      'WECHAT_ACCESS_BLOCKED',
      '公众号服务要求验证码或暂时限制访问，请稍后重试',
      true,
    );
  }
}

function parseSetCookie(headers: Headers, name: string) {
  const values =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];
  for (const value of values) {
    const match = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`).exec(value);
    if (match?.[1]) return match[1];
  }
  return null;
}

function sogouArticleUrl(body: string) {
  const parts = [...body.matchAll(/url\s*\+=\s*['"]([^'"]*)['"]/g)].map(
    (match) => match[1] ?? '',
  );
  if (!parts.length) return null;
  const candidate = decodeHtml(parts.join(''))
    .replaceAll('@', '')
    .replace('src=11×tamp', 'src=11&timestamp');
  try {
    return validateWechatArticleUrl(candidate).toString();
  } catch {
    return null;
  }
}

function timestamp(value: string | undefined) {
  if (!value || !/^\d{9,13}$/.test(value)) return null;
  const number = Number(value);
  const date = new Date(value.length > 10 ? number : number * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseSogouWechatResults(html: string) {
  assertUsablePage(html);
  const $ = load(html);
  return $('li[id^="sogou_vr_11002601_box_"]')
    .toArray()
    .map((element) => {
      const item = $(element);
      const link = item.find('a[target="_blank"]').first().attr('href');
      const script = item.find('span.s2 script').first().text();
      const epoch = /['"](\d{9,13})['"]/.exec(script)?.[1];
      return {
        title: normalizeText(item.find('h3').first().text()),
        account:
          normalizeText(item.find('span.all-time-y2').first().text()) || null,
        publishedAt: timestamp(epoch),
        snippet: normalizeText(item.find('p.txt-info').first().text()),
        redirectUrl: link
          ? allowedUrl(
              new URL(link, 'https://weixin.sogou.com').toString(),
              searchHosts,
              '搜索结果',
            ).toString()
          : null,
      };
    })
    .filter((item) => item.title && item.redirectUrl);
}

export async function searchWechatArticles(
  queryInput: string,
  limitInput = 5,
  options: { request?: WechatHttpRequest } = {},
): Promise<WechatArticleSearchResult[]> {
  const query = normalizeText(queryInput);
  if (!query || query.length > 200) {
    throw new HandlerError(
      'TOOL_INPUT_INVALID',
      '公众号搜索词必须为 1 到 200 个字符',
      false,
    );
  }
  const limit = Math.min(Math.max(Math.trunc(limitInput), 1), 10);
  const cacheKey = createHash('sha256')
    .update(`${query}\0${limit}`)
    .digest('hex');
  const cached = cacheGet(searchCache, cacheKey);
  if (cached) return cached;
  const request = options.request ?? defaultHttpRequest;
  const cookieResponse = await request(cookieEndpoint, {
    method: 'GET',
    headers: browserHeaders(),
  });
  const snuid = parseSetCookie(cookieResponse.headers, 'SNUID');
  const searchUrl = allowedUrl(searchEndpoint, searchHosts, '搜索');
  searchUrl.searchParams.set('type', '2');
  searchUrl.searchParams.set('query', query);
  searchUrl.searchParams.set('page', '1');
  const response = await requestWithRedirects({
    url: searchUrl,
    hosts: searchHosts,
    headers: browserHeaders(snuid ? `SNUID=${snuid}` : undefined),
    request,
  });
  const candidates = parseSogouWechatResults(response.body).slice(0, limit);
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const redirect = await requestWithRedirects({
          url: allowedUrl(candidate.redirectUrl!, searchHosts, '搜索结果'),
          hosts: searchHosts,
          headers: browserHeaders(snuid ? `SNUID=${snuid}` : undefined),
          request,
        });
        const url = sogouArticleUrl(redirect.body);
        return url ? { ...candidate, url } : null;
      } catch {
        return null;
      }
    }),
  );
  const results = resolved
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({
      title: item.title,
      account: item.account,
      publishedAt: item.publishedAt,
      snippet: item.snippet,
      url: item.url,
    }));
  if (!results.length) {
    throw new HandlerError(
      'WECHAT_NO_RESULTS',
      '没有找到可读取的微信公众号公开文章，或搜索服务暂时受限',
      true,
    );
  }
  cacheSet(searchCache, cacheKey, results, searchCacheTtlMs);
  return results;
}

function meta($: ReturnType<typeof load>, property: string) {
  return normalizeText(
    $(`meta[property="${property}"], meta[name="${property}"]`)
      .first()
      .attr('content') ?? '',
  );
}

function articleText($: ReturnType<typeof load>) {
  const article = $('#js_content').first();
  if (!article.length) return '';
  article.find('script,style,noscript,svg,canvas').remove();
  article.find('br').replaceWith('\n');
  article.find('p,section,div,li,h1,h2,h3,h4,h5,h6').each((_, element) => {
    $(element).append('\n');
  });
  return normalizeText(article.text());
}

export function parseWechatArticle(
  html: string,
  sourceUrl: string,
): WechatArticle {
  assertUsablePage(html);
  const $ = load(html);
  const rawContent = articleText($);
  const title =
    meta($, 'og:title') || normalizeText($('#activity-name').first().text());
  if (!title || !rawContent) {
    throw new HandlerError(
      'WECHAT_ARTICLE_UNAVAILABLE',
      '该微信公众号文章已删除、不可公开访问或正文无法解析',
      true,
    );
  }
  const account =
    normalizeText($('#js_name').first().text()) || meta($, 'author') || null;
  const scriptText = $('script')
    .toArray()
    .map((element) => $(element).text())
    .join('\n');
  const epoch = /(?:publish_time|ct)\s*=\s*['"](\d{9,13})['"]/.exec(
    scriptText,
  )?.[1];
  const publishedAt = meta($, 'article:published_time') || timestamp(epoch);
  const images = [
    ...new Set(
      $('#js_content img')
        .toArray()
        .map(
          (element) =>
            $(element).attr('data-src') || $(element).attr('src') || '',
        )
        .filter((value) => {
          try {
            return (
              value.startsWith('https://') && new URL(value).hostname.length > 0
            );
          } catch {
            return false;
          }
        }),
    ),
  ].slice(0, 30);
  const truncated = rawContent.length > maximumArticleCharacters;
  const content = rawContent.slice(0, maximumArticleCharacters);
  return {
    title,
    account,
    publishedAt: publishedAt || null,
    description: meta($, 'og:description') || null,
    content: `<external-content source="wechat.article.read" trust="untrusted">\n${content}\n</external-content>`,
    images,
    url: validateWechatArticleUrl(sourceUrl).toString(),
    retrievedAt: new Date().toISOString(),
    truncated,
    externalContent: {
      source: 'wechat.article.read',
      untrusted: true,
      wrapped: true,
    },
  };
}

export async function readWechatArticle(
  urlInput: string,
  options: { request?: WechatHttpRequest } = {},
) {
  const url = validateWechatArticleUrl(urlInput);
  const cacheKey = url.toString();
  const cached = cacheGet(articleCache, cacheKey);
  if (cached) return cached;
  const response = await requestWithRedirects({
    url,
    hosts: articleHosts,
    headers: browserHeaders(),
    request: options.request ?? defaultHttpRequest,
  });
  const article = parseWechatArticle(response.body, response.url);
  cacheSet(articleCache, cacheKey, article, articleCacheTtlMs);
  return article;
}
