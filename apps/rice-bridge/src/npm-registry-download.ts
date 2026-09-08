import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import {
  runtimeNpmPackageUrl,
  RuntimeNpmPackageSchema,
  type RuntimeNpmPackage,
} from '@allrice/contracts';
import { LocalCommandError } from './local-command-inputs.js';

const blocked = new BlockList();
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
  blocked.addSubnet(address, prefix, 'ipv4');
export function publicRegistryAddress(address: string) {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}

/** GET a canonical, explicitly approved public archive. No auth, proxy, redirect,
 * project URL, host cookies, npmrc, second DNS lookup, or automatic retry.
 * IPv6-only/proxied registries are unsupported, never an implicit unsafe fallback.
 */
export async function downloadNpmArchive(
  pkg: RuntimeNpmPackage,
  signal: AbortSignal,
) {
  const url = new URL(runtimeNpmPackageUrl(RuntimeNpmPackageSchema.parse(pkg)));
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new LocalCommandError('EXECUTION_REVOKED'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const addresses = await Promise.race([
    lookup(url.hostname, { family: 4, all: true }),
    aborted,
  ]).finally(() => signal.removeEventListener('abort', onAbort));
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some((a) => !publicRegistryAddress(a.address))
  )
    throw new LocalCommandError('DEPENDENCY_SOURCE_DENIED');
  const address = addresses[0]!.address;
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        family: 4,
        signal,
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
        headers: {
          Accept: 'application/octet-stream',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          (res.headers['content-encoding'] &&
            res.headers['content-encoding'] !== 'identity')
        ) {
          res.destroy();
          req.destroy();
          reject(new LocalCommandError('DEPENDENCY_DOWNLOAD_REJECTED'));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 131072)
            req.destroy(new LocalCommandError('DEPENDENCY_ARCHIVE_LIMIT'));
          else chunks.push(chunk);
        });
        res.once('error', reject);
        res.once('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    req.once('error', reject);
    req.end();
  });
}
