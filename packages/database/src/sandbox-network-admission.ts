import { get } from 'node:https';
import { isIP } from 'node:net';
import { SandboxNetworkRequestSchema } from '@allrice/contracts';
import { browserGrantOriginDenial } from './browser-control-origin.ts';
import { RuntimePolicyError } from './runtime-policy.ts';

type QuestionType = 1 | 28;
type Query = (hostname: string, type: QuestionType) => Promise<unknown>;
type Verdict = { expiresAt: number };
const blocked = () =>
  new RuntimePolicyError('sandbox_network_destination_blocked');
const unavailable = () =>
  new RuntimePolicyError('sandbox_network_check_unavailable');

/** A backend check, not a user-maintained address list. Only the public hostname
 * goes to the malware/phishing-filtering resolver; no task, file or credential.
 * The execution transport still checks and pins its own actual destination IP.
 * https://developers.cloudflare.com/1.1.1.1/setup/#1111-for-families */
function queryThreatDns(
  hostname: string,
  type: QuestionType,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(
      {
        hostname: '1.1.1.2',
        servername: 'security.cloudflare-dns.com',
        path: `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        headers: {
          accept: 'application/dns-json',
          host: 'security.cloudflare-dns.com',
        },
        agent: false,
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          !response.headers['content-type']?.startsWith('application/dns-json')
        ) {
          response.destroy();
          reject(unavailable());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) response.destroy(unavailable());
          else chunks.push(chunk);
        });
        response.once('error', () => reject(unavailable()));
        response.once('aborted', () => reject(unavailable()));
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(unavailable());
          }
        });
      },
    );
    const timer = setTimeout(() => request.destroy(unavailable()), 4000);
    request.once('error', () => reject(unavailable()));
    request.once('close', () => clearTimeout(timer));
  });
}

function answer(value: unknown, hostname: string, type: QuestionType) {
  if (!value || typeof value !== 'object') throw unavailable();
  const body = value as {
    Status?: unknown;
    TC?: unknown;
    Question?: unknown;
    Answer?: unknown;
  };
  if (
    body.Status !== 0 ||
    body.TC !== false ||
    !Array.isArray(body.Question) ||
    body.Question.length !== 1 ||
    body.Question[0]?.type !== type ||
    typeof body.Question[0]?.name !== 'string' ||
    body.Question[0].name.toLowerCase().replace(/\.$/, '') !== hostname
  )
    throw unavailable();
  if (body.Answer === undefined) return { count: 0, ttl: 60 };
  if (!Array.isArray(body.Answer) || body.Answer.length > 64)
    throw unavailable();
  let count = 0,
    ttl = 60;
  for (const row of body.Answer) {
    if (!row || typeof row !== 'object') throw unavailable();
    if (row.type !== 5 && row.type !== 1 && row.type !== 28)
      throw unavailable();
    if (
      typeof row.TTL !== 'number' ||
      !Number.isSafeInteger(row.TTL) ||
      row.TTL < 0
    )
      throw unavailable();
    ttl = Math.min(ttl, row.TTL);
    if (row.type === 5) continue;
    if (
      typeof row.data !== 'string' ||
      isIP(row.data) !== (row.type === 1 ? 4 : 6)
    )
      throw unavailable();
    // The resolver uses 0.0.0.0/:: for blocked names. All other private,
    // metadata, synthetic and mixed answers are refused as well.
    const literal = row.type === 1 ? row.data : `[${row.data}]`;
    if (browserGrantOriginDenial(`https://${literal}`)) throw blocked();
    count++;
  }
  return { count, ttl };
}

export function createSandboxNetworkAdmission(
  query: Query = queryThreatDns,
  now: () => number = Date.now,
) {
  const verified = new Map<string, Verdict>(),
    pending = new Map<string, Promise<void>>();
  async function hostnameAllowed(hostname: string) {
    if ((verified.get(hostname)?.expiresAt ?? 0) > now()) return;
    verified.delete(hostname);
    const existing = pending.get(hostname);
    if (existing) return existing;
    if (pending.size >= 64) throw unavailable();
    const check = (async () => {
      const types = [1, 28] as const;
      // Keep the admission slot until BOTH lookups settle. A fast rejection
      // must not release it while its sibling still holds a socket.
      const results = await Promise.allSettled(
        types.map(async (type) =>
          answer(await query(hostname, type), hostname, type),
        ),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length) {
        throw (
          failures.find(
            (r) =>
              r.reason instanceof RuntimePolicyError &&
              r.reason.code === 'sandbox_network_destination_blocked',
          )?.reason ?? failures[0]!.reason
        );
      }
      const replies = results.flatMap((r) =>
        r.status === 'fulfilled' ? [r.value] : [],
      );
      if (!replies.some((reply) => reply.count > 0)) throw unavailable();
      const ttl = Math.min(...replies.map((reply) => reply.ttl));
      if (ttl > 0) {
        if (verified.size >= 128)
          verified.delete(verified.keys().next().value!);
        verified.set(hostname, { expiresAt: now() + ttl * 1000 });
      }
    })()
      .catch((error: unknown) => {
        if (error instanceof RuntimePolicyError) throw error;
        throw unavailable();
      })
      .finally(() => pending.delete(hostname));
    pending.set(hostname, check);
    return check;
  }
  return async (input: unknown) => {
    const parsed = SandboxNetworkRequestSchema.safeParse(input);
    if (!parsed.success) throw blocked();
    await Promise.all(
      parsed.data.origins.map((origin) =>
        hostnameAllowed(new URL(origin).hostname),
      ),
    );
  };
}

export const assertAutomaticSandboxNetwork = createSandboxNetworkAdmission();
