import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { HandlerError } from './errors.js';

const dnsOverHttpsTimeoutMs = 5_000;
const maximumDnsOverHttpsResponseBytes = 64_000;
const cloudflareDnsOverHttpsAddress = '1.1.1.1';
const cloudflareDnsOverHttpsHostname = 'cloudflare-dns.com';

export interface HostnameAddress {
  address: string;
  family?: number;
}

export interface PublicWebDnsDependencies {
  lookupHostname?: (hostname: string) => Promise<HostnameAddress[]>;
  lookupDnsOverHttps?: (hostname: string) => Promise<string[]>;
}

function webError(code: string, message: string, retryable = false) {
  return new HandlerError(code, message, retryable);
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

export async function resolvePublicWebHostname(
  hostname: string,
  dependencies: PublicWebDnsDependencies = {},
) {
  if (isIP(hostname)) {
    if (!isPublicWebAddress(hostname)) {
      throw webError('WEB_ADDRESS_BLOCKED', '网页读取不允许访问内部网络地址');
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
    throw webError('WEB_ADDRESS_BLOCKED', '网页读取域名解析到了非公开网络地址');
  }

  let independentAddresses: string[];
  try {
    independentAddresses = await (
      dependencies.lookupDnsOverHttps ?? lookupPublicDnsOverHttps
    )(hostname);
  } catch {
    throw webError(
      'WEB_DNS_VALIDATION_FAILED',
      '网页读取无法独立确认域名的公开网络地址',
      true,
    );
  }
  if (
    !independentAddresses.length ||
    independentAddresses.some(
      (address) => !isIP(address) || !isPublicWebAddress(address),
    )
  ) {
    throw webError(
      'WEB_ADDRESS_BLOCKED',
      '网页读取域名的独立解析包含非公开网络地址',
    );
  }
  return independentAddresses.map((address) => ({
    address,
    family: isIP(address),
  }));
}
