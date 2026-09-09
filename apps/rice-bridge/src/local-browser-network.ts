import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer } from 'node:http';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import { browserOriginAllowed, type BrowserProfile } from '@allrice/contracts';

const denied4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied4.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList();
// Conservatively exclude IETF special-purpose and transition prefixes rather
// than accepting alternative spellings of private IPv4 or IPv6 literals.
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied6.addSubnet(address, prefix, 'ipv6');
export function localBrowserPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) return !denied4.check(address, 'ipv4');
  return (
    family === 6 &&
    global6.check(address, 'ipv6') &&
    !denied6.check(address, 'ipv6')
  );
}
const denied = () => Error('LOCAL_BROWSER_POLICY_DENIED');
export function localBrowserUrlAllowed(value: string, profile: BrowserProfile) {
  if (!browserOriginAllowed(value, profile)) return false;
  const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '');
  if (
    /\.(local|localhost|internal|test|invalid|onion)$/.test(hostname) ||
    hostname === 'localhost'
  )
    return false;
  return !isIP(hostname) || localBrowserPublicAddress(hostname);
}
async function resolvePublic(hostname: string) {
  const literal = hostname.replace(/^\[|\]$/g, '');
  const answers = isIP(literal)
    ? [{ address: literal, family: isIP(literal) }]
    : await lookup(literal, { all: true, verbatim: true });
  if (
    !answers.length ||
    answers.some(
      (item) =>
        !localBrowserPublicAddress(item.address) ||
        isIP(item.address) !== item.family,
    )
  )
    throw denied();
  return answers[0]!;
}

/** Native-browser-only CONNECT proxy. TLS stays end-to-end (Chrome checks SNI,
 * certificate and hostname); upstream sockets connect only to a validated IP.
 * No HTTP forwarder, arbitrary ports, fake-IP, localhost or preview exception. */
export async function startLocalBrowserProxy(input: {
  profile: BrowserProfile;
  assertCurrent: () => Promise<void>;
}) {
  const username = randomBytes(18).toString('hex');
  const password = randomBytes(24).toString('hex');
  const authorization = Buffer.from(
    `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
  );
  const sockets = new Set<Socket>();
  let closed = false,
    bytes = 0,
    tunnels = 0;
  const server = createServer((_req, res) => {
    res.writeHead(403, { connection: 'close' });
    res.end();
  });
  function track(socket: Socket) {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(30000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 40 * 1024 * 1024)
        for (const tracked of sockets) tracked.destroy();
    });
  }
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', (request, rawClient, head) => {
    const client = rawClient as Socket;
    let upstream: Socket | undefined;
    const timer = setTimeout(() => {
      client.destroy();
      upstream?.destroy();
    }, 5000);
    const stop = () => {
      clearTimeout(timer);
      client.destroy();
      upstream?.destroy();
    };
    client.once('close', () => {
      clearTimeout(timer);
      upstream?.destroy();
    });
    void (async () => {
      const supplied = Buffer.from(
        request.headers['proxy-authorization'] ?? '',
      );
      // Chromium obtains configured proxy credentials through the standard 407
      // challenge; dropping this first CONNECT makes a valid proxy unusable.
      if (
        supplied.length !== authorization.length ||
        !timingSafeEqual(supplied, authorization)
      ) {
        clearTimeout(timer);
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="AllRice browser"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
        );
        return;
      }
      if (closed || bytes > 40 * 1024 * 1024 || ++tunnels > 200) throw denied();
      const target = request.url ?? '';
      const url = new URL(`https://${target}`);
      if (
        !target.endsWith(':443') ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        !localBrowserUrlAllowed(url.href, input.profile)
      )
        throw denied();
      await input.assertCurrent();
      const address = await resolvePublic(url.hostname);
      await input.assertCurrent();
      if (closed || client.destroyed) throw denied();
      upstream = connect({
        host: address.address,
        port: 443,
        family: address.family,
        autoSelectFamily: false,
      });
      track(upstream);
      upstream.once('close', () => client.destroy());
      upstream.once('connect', () => {
        clearTimeout(timer);
        if (closed || client.destroyed) {
          upstream?.destroy();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream!.write(head);
        client.pipe(upstream!);
        upstream!.pipe(client);
      });
    })().catch(stop);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw denied();
  return {
    server: `http://127.0.0.1:${address.port}`,
    username,
    password,
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      authorization.fill(0);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(denied()) : resolve())),
      );
    },
  };
}
