import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as forwardRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import {
  browserOriginAllowed,
  browserPrivateSiteAddress,
  type BrowserProfile,
} from '@allrice/contracts';
import { resolveLocalBrowserPublicAddress } from './local-browser-dns.js';

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
  if (profile.network === 'local_sites') {
    // Even explicit sites cannot expose services on this very computer through
    // a private-interface alias. Project previews retain their separate lease.
    return (
      browserPrivateSiteAddress(hostname) &&
      !Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .some((item) => item.address === hostname)
    );
  }
  if (
    /\.(local|localhost|internal|test|invalid|onion)$/.test(hostname) ||
    hostname === 'localhost'
  )
    return false;
  return !isIP(hostname) || localBrowserPublicAddress(hostname);
}
/** Native-browser-only proxy. TLS stays end-to-end (Chrome checks SNI,
 * certificate and hostname); sockets connect only to a validated public IP or
 * an explicitly granted private IPv4/site/port, never this computer's services. */
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
  let closed = false;
  const server = createServer((req, res) => {
    if (input.profile.network !== 'local_sites') {
      res.writeHead(403, { connection: 'close' });
      res.end();
      return;
    }
    void (async () => {
      const supplied = Buffer.from(req.headers['proxy-authorization'] ?? '');
      if (
        supplied.length !== authorization.length ||
        !timingSafeEqual(supplied, authorization)
      ) {
        res.writeHead(407, {
          'proxy-authenticate': 'Basic realm="AllRice browser"',
          connection: 'close',
        });
        res.end();
        return;
      }
      const url = new URL(req.url ?? '');
      if (
        closed ||
        input.profile.network !== 'local_sites' ||
        url.protocol !== 'http:' ||
        !localBrowserUrlAllowed(url.href, input.profile)
      )
        throw denied();
      await input.assertCurrent();
      if (closed || res.destroyed) throw denied();
      const headers: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: url.host,
        connection: 'close',
      };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = forwardRequest(
        {
          host: url.hostname,
          port: Number(url.port || 80),
          family: 4,
          path: url.pathname + url.search,
          method: req.method,
          headers,
          timeout: 30000,
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.once('socket', track);
      upstream.once('timeout', () => upstream.destroy(denied()));
      upstream.once('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.once('close', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(403, { connection: 'close' });
      res.end();
    });
  });
  function track(socket: Socket) {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(30000, () => socket.destroy());
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
      if (closed) throw denied();
      const target = request.url ?? '';
      const url = new URL(`https://${target}`);
      if (
        !/^.+:[0-9]+$/.test(target) ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        !localBrowserUrlAllowed(url.href, input.profile)
      )
        throw denied();
      await input.assertCurrent();
      const address =
        input.profile.network === 'local_sites'
          ? { address: url.hostname, family: 4 }
          : await resolveLocalBrowserPublicAddress(
              url.hostname,
              localBrowserPublicAddress,
            );
      await input.assertCurrent();
      if (closed || client.destroyed) throw denied();
      upstream = connect({
        host: address.address,
        port: Number(url.port || 443),
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
