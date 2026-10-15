import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  SandboxNetworkLeaseSchema,
  type SandboxNetworkLease,
  type SandboxNetworkErrorCode,
} from '@allrice/contracts';
import { resolvePublicAddress } from './public-address.js';

export class SandboxNetworkError extends Error {
  constructor(readonly code: SandboxNetworkErrorCode) {
    super(code);
  }
}
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
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  denied6.addSubnet(address, prefix, 'ipv6');

export function sandboxPublicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  if (isIP(address) === 4) return !denied4.check(address, 'ipv4');
  return (
    isIP(address) === 6 &&
    global6.check(address, 'ipv6') &&
    !denied6.check(address, 'ipv6')
  );
}

export function assertSandboxDestination(
  lease: SandboxNetworkLease,
  hostname: string,
  now = Date.now(),
) {
  if (Date.parse(lease.expiresAt) <= now)
    throw new SandboxNetworkError('SANDBOX_NETWORK_REVOKED');
  if (!lease.network.origins.includes(`https://${hostname}`))
    throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
}

/** Resolve on every connection, then connect to this literal without a second
 * lookup. Private/mixed answers and aliases of this host remain denied. */
export async function resolveSandboxDestination(
  leaseInput: SandboxNetworkLease,
  hostname: string,
) {
  const lease = SandboxNetworkLeaseSchema.parse(leaseInput);
  assertSandboxDestination(lease, hostname);
  const own = new Set(
    Object.values(networkInterfaces()).flatMap(
      (items) => items?.map((item) => item.address) ?? [],
    ),
  );
  try {
    const address = await resolvePublicAddress(
      hostname,
      (ip) => sandboxPublicAddress(ip) && !own.has(ip),
    );
    assertSandboxDestination(lease, hostname);
    return address;
  } catch (error) {
    if (error instanceof SandboxNetworkError) throw error;
    if (error instanceof Error && error.message === 'PUBLIC_ADDRESS_DENIED')
      throw new SandboxNetworkError('SANDBOX_NETWORK_DENIED');
    throw new SandboxNetworkError('SANDBOX_NETWORK_DNS');
  }
}

/** Validate a complete initial TLS ClientHello before any tenant bytes leave
 * the broker. No raw TCP, alternate SNI or encrypted ClientHello routing. */
export function sandboxTlsClientHello(
  bytes: Buffer,
  hostname: string,
): 'pending' | 'valid' {
  const bad = () => {
    throw new SandboxNetworkError('SANDBOX_NETWORK_PROTOCOL');
  };
  if (bytes.length > 65_536) return bad();
  if (bytes.length < 5) return 'pending';
  const chunks: Buffer[] = [];
  let offset = 0,
    size = 0;
  while (offset + 5 <= bytes.length) {
    if (
      bytes[offset] !== 22 ||
      bytes[offset + 1] !== 3 ||
      bytes[offset + 2]! > 3
    )
      return bad();
    const length = bytes.readUInt16BE(offset + 3);
    if (length > 18_432 || length === 0) return bad();
    if (offset + 5 + length > bytes.length) return 'pending';
    chunks.push(bytes.subarray(offset + 5, offset + 5 + length));
    size += length;
    offset += 5 + length;
    const body = Buffer.concat(chunks, size);
    if (body.length < 4) continue;
    if (body[0] !== 1 || body.readUIntBE(1, 3) > 60_000) return bad();
    const expected = body.readUIntBE(1, 3) + 4;
    if (body.length < expected) continue;
    if (body.length !== expected || offset !== bytes.length) return bad();
    let p = 4;
    const take = (count: number) => {
      const start = p;
      p += count;
      if (p > body.length) bad();
      return start;
    };
    const u16 = () => body.readUInt16BE(take(2));
    take(34);
    take(body[take(1)]!);
    const ciphers = u16();
    if (ciphers < 2 || ciphers % 2) return bad();
    take(ciphers);
    take(body[take(1)]!);
    const extensionSize = u16();
    if (p + extensionSize !== body.length) return bad();
    let sni: string | undefined;
    const seen = new Set<number>();
    while (p < body.length) {
      const type = u16(),
        length = u16(),
        end = p + length;
      if (end > body.length || seen.has(type) || type === 0xfe0d) return bad();
      seen.add(type);
      if (type === 0) {
        if (u16() !== length - 2 || body[take(1)] !== 0) return bad();
        const nameLength = u16(),
          name = body.subarray(take(nameLength), p);
        if (p !== end || !name.equals(Buffer.from(hostname, 'ascii')))
          return bad();
        sni = name.toString('ascii');
      } else p = end;
    }
    return sni === hostname ? 'valid' : bad();
  }
  return 'pending';
}
