import { BlockList, isIP } from 'node:net';

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

/** Admission-time syntax preflight only. It never resolves DNS and cannot
 * replace the renderer's per-connection public-address check and IP pinning. */
export function browserGrantOriginDenial(
  origin: string,
): 'browser_reserved_origin_denied' | 'browser_public_origin_required' | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'browser_public_origin_required';
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host === 'preview.allrice.invalid' ||
    host.endsWith('.preview.allrice.invalid')
  )
    return 'browser_reserved_origin_denied';
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    host.includes('%')
  )
    return 'browser_public_origin_required';
  const family = isIP(host);
  if (family === 4)
    return denied4.check(host, 'ipv4')
      ? 'browser_public_origin_required'
      : null;
  if (family === 6)
    return global6.check(host, 'ipv6') && !denied6.check(host, 'ipv6')
      ? null
      : 'browser_public_origin_required';
  if (
    !host.includes('.') ||
    /\.(local|localhost|internal|test|invalid|onion)$/.test(host)
  )
    return 'browser_public_origin_required';
  return null;
}
