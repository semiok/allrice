import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';

const synthetic4 = new BlockList();
synthetic4.addSubnet('198.18.0.0', 15, 'ipv4');
const denied = () => Error('LOCAL_BROWSER_POLICY_DENIED');
type Address = { address: string; family: number };

/** Only compensate for a synthetic DNS proxy. Private/mixed system answers
 * remain denied. All browser sockets still connect to validated literal IPs. */
export async function resolveLocalBrowserPublicAddress(
  hostname: string,
  publicAddress: (address: string) => boolean,
) {
  const literal = hostname.replace(/^\[|\]$/g, '');
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
  )
    answers = await queryPublicDns(literal);
  if (
    !answers.length ||
    answers.some(
      (item) =>
        !publicAddress(item.address) || isIP(item.address) !== item.family,
    )
  )
    throw denied();
  return answers[0]!;
}

function queryPublicDns(hostname: string): Promise<Address[]> {
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
          reject(denied());
          return;
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16 * 1024) response.destroy(denied());
          else chunks.push(chunk);
        });
        response.once('error', () => reject(denied()));
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
            resolve(addresses);
          } catch {
            reject(denied());
          }
        });
      },
    );
    const timeout = setTimeout(() => request.destroy(denied()), 4000);
    request.once('error', () => reject(denied()));
    request.once('close', () => clearTimeout(timeout));
  });
}
