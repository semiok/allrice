import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';

const synthetic4 = new BlockList();
synthetic4.addSubnet('198.18.0.0', 15, 'ipv4');
const denied = () => Error('PUBLIC_ADDRESS_DENIED');
export class PublicAddressUnavailableError extends Error {
  constructor() {
    super('PUBLIC_DNS_UNAVAILABLE');
  }
}
export function isTransientNetworkError(error: unknown) {
  return (
    error instanceof PublicAddressUnavailableError ||
    (error instanceof Error &&
      'code' in error &&
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'EPIPE',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EAI_AGAIN',
      ].includes(String(error.code)))
  );
}
const dnsFailure = (error: unknown) =>
  isTransientNetworkError(error)
    ? new PublicAddressUnavailableError()
    : denied();
type Address = { address: string; family: number };
type DnsAnswer = { addresses: Address[]; expiresAt: number };
const verified = new Map<string, DnsAnswer>();
const pending = new Map<string, Promise<DnsAnswer>>();
const maximumEntries = 64;

function publicDns(hostname: string) {
  const saved = verified.get(hostname);
  if (saved && saved.expiresAt > Date.now()) return Promise.resolve(saved);
  verified.delete(hostname);
  const active = pending.get(hostname);
  if (active) return active;
  const query = queryPublicDns(hostname);
  if (pending.size >= maximumEntries) return query;
  const tracked = query.finally(() => pending.delete(hostname));
  pending.set(hostname, tracked);
  return tracked;
}

/** Only compensate for a synthetic DNS proxy. Private/mixed system answers
 * remain denied. All browser sockets still connect to validated literal IPs. */
export async function resolvePublicAddress(
  hostname: string,
  publicAddress: (address: string) => boolean,
) {
  const literal = hostname.replace(/^\[|\]$/g, '');
  const key = literal.toLowerCase().replace(/\.$/, '');
  let resolved: DnsAnswer | undefined;
  let answers: Address[] = isIP(literal)
    ? [{ address: literal, family: isIP(literal) }]
    : await lookup(literal, { all: true, verbatim: true });
  if (
    !isIP(literal) &&
    answers.length > 0 &&
    answers.every(
      (item) =>
        item.family === 4 &&
        isIP(item.address) === 4 &&
        synthetic4.check(item.address, 'ipv4'),
    )
  ) {
    resolved = await publicDns(key);
    answers = resolved.addresses;
  }
  if (
    !answers.length ||
    answers.some(
      (item) =>
        !publicAddress(item.address) || isIP(item.address) !== item.family,
    )
  )
    throw denied();
  // A cache hit still requires fresh system DNS and this caller's full policy.
  // Only positive, validated fallback answers are retained, for their shortest
  // DNS TTL (at most 30 seconds). No stale-on-error or private-address fallback.
  if (resolved && resolved.expiresAt > Date.now()) {
    if (!verified.has(key) && verified.size >= maximumEntries)
      verified.delete(verified.keys().next().value!);
    verified.set(key, resolved);
  }
  return { ...answers[0]! };
}

function queryPublicDns(hostname: string): Promise<DnsAnswer> {
  return new Promise((resolve, reject) => {
    // Fixed public IP, verified TLS server name; no system DNS recursion,
    // redirect, proxy, custom CA or privileged network exception.
    const request = get(
      {
        hostname: '1.1.1.1',
        servername: 'cloudflare-dns.com',
        path: `/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
        headers: { accept: 'application/dns-json' },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        if (
          response.statusCode !== 200 ||
          !response.headers['content-type']?.startsWith('application/dns-json')
        ) {
          response.destroy();
          reject(
            response.statusCode === 429 || (response.statusCode ?? 0) >= 500
              ? new PublicAddressUnavailableError()
              : denied(),
          );
          return;
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024) response.destroy(denied());
          else chunks.push(chunk);
        });
        response.once('error', (error) => reject(dnsFailure(error)));
        response.once('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (
              body.Status !== 0 ||
              body.TC !== false ||
              !Array.isArray(body.Question) ||
              body.Question.length !== 1 ||
              body.Question[0]?.type !== 1 ||
              typeof body.Question[0]?.name !== 'string' ||
              body.Question[0].name.toLowerCase().replace(/\.$/, '') !==
                hostname.toLowerCase().replace(/\.$/, '') ||
              !Array.isArray(body.Answer) ||
              body.Answer.length > 64
            )
              throw denied();
            const addresses = body.Answer.filter(
              (answer: { type?: unknown }) => answer.type === 1,
            ).map((answer: { data?: unknown }) => {
              if (typeof answer.data !== 'string' || isIP(answer.data) !== 4)
                throw denied();
              return { address: answer.data, family: 4 };
            });
            const ttl = Math.min(
              30,
              ...body.Answer.map((answer: { TTL?: unknown }) =>
                typeof answer.TTL === 'number' &&
                Number.isSafeInteger(answer.TTL) &&
                answer.TTL > 0
                  ? answer.TTL
                  : 0,
              ),
            );
            resolve({ addresses, expiresAt: Date.now() + ttl * 1000 });
          } catch {
            reject(denied());
          }
        });
      },
    );
    const timeout = setTimeout(
      () => request.destroy(new PublicAddressUnavailableError()),
      4000,
    );
    request.once('error', (error) => reject(dnsFailure(error)));
    request.once('close', () => clearTimeout(timeout));
  });
}
