import { createHash, createPublicKey, verify } from 'node:crypto';

export const updateBundleId = 'xyz.bplabs.rice-bridge';
const metadataDomain = 'AllRice Bridge update metadata v1\n';
const packageDomain = 'AllRice Bridge update package v1\n';
export const maximumUpdateBytes = 256 * 1024 * 1024;

export type UpdateTrust = {
  teamId: string;
  channel: 'dev' | 'stable';
  origin: string;
  keys: Readonly<Record<string, string>>;
};
export type UpdatePackage = {
  arch: 'x64' | 'arm64';
  url: string;
  bytes: number;
  sha256: string;
  signature: string;
};
export type UpdateRelease = {
  v: 1;
  sequence: number;
  version: string;
  channel: 'dev' | 'stable';
  issuedAt: string;
  expiresAt: string;
  bundleId: string;
  teamId: string;
  minimumMacOS: string;
  protocol: { min: number; max: number };
  credentials: { min: number; max: number };
  journal: { min: number; max: number };
  writes: { credentials: number; journal: number };
  packages: UpdatePackage[];
};
export type UpdateEnvironment = {
  version: string;
  sequence: number;
  arch: 'x64' | 'arm64';
  macOS: string;
  protocol: number;
  credentials: number;
  journal: number;
  now: number;
};
export type VerifiedUpdate = {
  release: UpdateRelease;
  artifact: UpdatePackage;
  publicKey: string;
};
// Provisioned through a reviewed source change and a Developer ID signed bundle,
// never an environment variable, downloaded manifest or first-use TOFU key.
export const bridgeUpdateTrust: UpdateTrust | null = null;

function fail(code: string): never {
  throw Error(code);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail('UPDATE_METADATA_INVALID');
  return value as Record<string, unknown>;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    fail('UPDATE_METADATA_INVALID');
  return value;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length > 2048 || !pattern.test(value))
    fail('UPDATE_METADATA_INVALID');
  return value;
}
function base64(value: unknown, length?: number) {
  const source = text(value, /^[A-Za-z0-9+/]+={0,2}$/);
  const bytes = Buffer.from(source, 'base64');
  if (
    bytes.toString('base64') !== source ||
    (length && bytes.length !== length)
  )
    fail('UPDATE_SIGNATURE_INVALID');
  return bytes;
}
function key(pem: string) {
  try {
    const parsed = createPublicKey(pem);
    if (parsed.asymmetricKeyType !== 'ed25519') fail('UPDATE_TRUST_INVALID');
    return parsed;
  } catch {
    return fail('UPDATE_TRUST_INVALID');
  }
}
function range(value: unknown) {
  const row = record(value, ['min', 'max']);
  const min = integer(row.min),
    max = integer(row.max);
  if (min > max) fail('UPDATE_METADATA_INVALID');
  return { min, max };
}
function version(value: unknown): [number, number, number, number] {
  const match = text(value, /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/).match(
    /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/,
  )!;
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n) || n > 999999))
    fail('UPDATE_METADATA_INVALID');
  const pre = match[4] === undefined ? 1000000 : Number(match[4]);
  if (!Number.isSafeInteger(pre) || (match[4] !== undefined && pre >= 1000000))
    fail('UPDATE_METADATA_INVALID');
  return [numbers[0]!, numbers[1]!, numbers[2]!, pre];
}
export function compareUpdateVersions(left: string, right: string) {
  const a = version(left),
    b = version(right);
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
export function updatePackageSigningBytes(
  release: Pick<UpdateRelease, 'version' | 'sequence'>,
  artifact: Pick<UpdatePackage, 'arch' | 'bytes' | 'sha256'>,
) {
  return Buffer.from(
    packageDomain +
      JSON.stringify([
        release.version,
        release.sequence,
        artifact.arch,
        artifact.bytes,
        artifact.sha256,
      ]),
  );
}
export function updateMetadataSigningBytes(payload: Uint8Array) {
  return Buffer.concat([Buffer.from(metadataDomain), payload]);
}
export function assertUpdateURL(value: string, trust: UpdateTrust) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('UPDATE_ORIGIN_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== trust.origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.port
  )
    fail('UPDATE_ORIGIN_INVALID');
  return url;
}
export function verifyUpdateMetadata(
  bytes: Uint8Array,
  trust: UpdateTrust | null,
  environment: UpdateEnvironment,
): VerifiedUpdate {
  if (!trust || !Object.keys(trust.keys).length)
    fail('UPDATE_TRUST_UNCONFIGURED');
  if (bytes.length > 32768) fail('UPDATE_METADATA_LIMIT');
  let outer: Record<string, unknown>;
  try {
    outer = record(JSON.parse(Buffer.from(bytes).toString('utf8')), [
      'keyId',
      'payload',
      'signature',
    ]);
  } catch {
    return fail('UPDATE_METADATA_INVALID');
  }
  const keyId = text(outer.keyId, /^[a-zA-Z0-9_-]{1,80}$/);
  if (!Object.hasOwn(trust.keys, keyId)) fail('UPDATE_PUBLISHER_UNKNOWN');
  // Payload is bounded by the envelope, and authenticated before JSON parsing.
  if (typeof outer.payload !== 'string' || outer.payload.length > 24000)
    fail('UPDATE_METADATA_LIMIT');
  const payload = Buffer.from(outer.payload, 'base64');
  if (payload.toString('base64') !== outer.payload)
    fail('UPDATE_METADATA_INVALID');
  const publicKey = trust.keys[keyId]!;
  if (
    !verify(
      null,
      updateMetadataSigningBytes(payload),
      key(publicKey),
      base64(outer.signature, 64),
    )
  )
    fail('UPDATE_SIGNATURE_INVALID');
  let row: Record<string, unknown>;
  try {
    row = record(JSON.parse(payload.toString('utf8')), [
      'v',
      'sequence',
      'version',
      'channel',
      'issuedAt',
      'expiresAt',
      'bundleId',
      'teamId',
      'minimumMacOS',
      'protocol',
      'credentials',
      'journal',
      'writes',
      'packages',
    ]);
  } catch {
    return fail('UPDATE_METADATA_INVALID');
  }
  if (
    row.v !== 1 ||
    row.channel !== trust.channel ||
    row.bundleId !== updateBundleId ||
    row.teamId !== trust.teamId
  )
    fail('UPDATE_PUBLISHER_MISMATCH');
  const releaseVersion = text(row.version, /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/);
  if (trust.channel === 'stable' && releaseVersion.includes('-'))
    fail('UPDATE_CHANNEL_INVALID');
  const timestamp = (value: unknown) => {
    const time = text(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    if (
      !Number.isFinite(Date.parse(time)) ||
      new Date(time).toISOString() !== time
    )
      fail('UPDATE_METADATA_INVALID');
    return time;
  };
  const issuedAt = timestamp(row.issuedAt),
    expiresAt = timestamp(row.expiresAt);
  if (
    Date.parse(issuedAt) > environment.now + 60000 ||
    Date.parse(expiresAt) <= environment.now ||
    Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    Date.parse(expiresAt) - Date.parse(issuedAt) > 30 * 86400000
  )
    fail('UPDATE_METADATA_EXPIRED');
  const sequence = integer(row.sequence);
  if (
    sequence <= environment.sequence ||
    compareUpdateVersions(releaseVersion, environment.version) <= 0
  )
    fail('UPDATE_DOWNGRADE_BLOCKED');
  const minimumMacOS = text(row.minimumMacOS, /^\d+\.\d+\.\d+$/);
  if (compareUpdateVersions(environment.macOS, minimumMacOS) < 0)
    fail('UPDATE_OS_INCOMPATIBLE');
  const protocol = range(row.protocol),
    credentials = range(row.credentials),
    journal = range(row.journal);
  const formats = record(row.writes, ['credentials', 'journal']);
  const writes = {
    credentials: integer(formats.credentials),
    journal: integer(formats.journal),
  };
  if (
    writes.credentials !== environment.credentials ||
    writes.journal !== environment.journal
  )
    fail('UPDATE_FORMAT_INCOMPATIBLE');
  for (const [supported, current] of [
    [protocol, environment.protocol],
    [credentials, environment.credentials],
    [journal, environment.journal],
  ] as const)
    if (current < supported.min || current > supported.max)
      fail('UPDATE_FORMAT_INCOMPATIBLE');
  if (!Array.isArray(row.packages) || row.packages.length !== 2)
    fail('UPDATE_ARCHITECTURE_INVALID');
  const packages = row.packages.map((value): UpdatePackage => {
    const p = record(value, ['arch', 'url', 'bytes', 'sha256', 'signature']);
    if (p.arch !== 'x64' && p.arch !== 'arm64')
      fail('UPDATE_ARCHITECTURE_INVALID');
    const url = text(p.url, /^https:\/\//);
    assertUpdateURL(url, trust);
    const item: UpdatePackage = {
      arch: p.arch,
      url,
      bytes: integer(p.bytes, maximumUpdateBytes),
      sha256: text(p.sha256, /^[a-f0-9]{64}$/),
      signature: text(p.signature, /^[A-Za-z0-9+/]+={0,2}$/),
    };
    if (
      !verify(
        null,
        updatePackageSigningBytes({ version: releaseVersion, sequence }, item),
        key(publicKey),
        base64(item.signature, 64),
      )
    )
      fail('UPDATE_PACKAGE_SIGNATURE_INVALID');
    return item;
  });
  if (new Set(packages.map((p) => p.arch)).size !== 2)
    fail('UPDATE_ARCHITECTURE_INVALID');
  const release: UpdateRelease = {
    v: 1,
    sequence,
    version: releaseVersion,
    channel: trust.channel,
    issuedAt,
    expiresAt,
    bundleId: updateBundleId,
    teamId: trust.teamId,
    minimumMacOS,
    protocol,
    credentials,
    journal,
    writes,
    packages,
  };
  return {
    release,
    artifact:
      packages.find((p) => p.arch === environment.arch) ??
      fail('UPDATE_ARCHITECTURE_INVALID'),
    publicKey,
  };
}
export function verifyUpdatePackage(bytes: Uint8Array, update: VerifiedUpdate) {
  if (
    bytes.length !== update.artifact.bytes ||
    bytes.length > maximumUpdateBytes ||
    createHash('sha256').update(bytes).digest('hex') !== update.artifact.sha256
  )
    fail('UPDATE_PACKAGE_INTEGRITY');
  if (
    !verify(
      null,
      updatePackageSigningBytes(update.release, update.artifact),
      key(update.publicKey),
      base64(update.artifact.signature, 64),
    )
  )
    fail('UPDATE_PACKAGE_SIGNATURE_INVALID');
}
/** No credential headers, redirects, arbitrary mirrors or unbounded responses. */
export async function downloadUpdate(
  url: string,
  trust: UpdateTrust,
  maximum: number,
  signal?: AbortSignal,
) {
  assertUpdateURL(url, trust);
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > maximumUpdateBytes
  )
    fail('UPDATE_DOWNLOAD_LIMIT');
  const response = await fetch(url, {
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body) fail('UPDATE_DOWNLOAD_FAILED');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maximum) fail('UPDATE_DOWNLOAD_LIMIT');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
