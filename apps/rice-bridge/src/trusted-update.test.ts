import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  assertUpdateURL,
  bridgeUpdateTrust,
  compareUpdateVersions,
  downloadUpdate,
  updateMetadataSigningBytes,
  updatePackageSigningBytes,
  verifyUpdateMetadata,
  verifyUpdatePackage,
  type UpdateEnvironment,
  type UpdateRelease,
  type UpdateTrust,
} from './trusted-update.js';

const pair = generateKeyPairSync('ed25519');
const trust: UpdateTrust = {
  teamId: 'SYNTHETIC1',
  channel: 'dev',
  origin: 'https://updates.example.test',
  keys: {
    fixture: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  },
};
const now = Date.parse('2026-09-14T00:00:00.000Z');
const environment: UpdateEnvironment = {
  version: '0.5.0-dev.1',
  sequence: 1,
  arch: 'x64',
  macOS: '15.7.0',
  protocol: 1,
  credentials: 2,
  journal: 1,
  now,
};
const bytes = Buffer.from('synthetic package, not an Apple signature');
function fixture(patch: Partial<UpdateRelease> = {}) {
  const release: UpdateRelease = {
    v: 1,
    sequence: 2,
    version: '0.6.0-dev.1',
    channel: 'dev',
    bundleId: 'xyz.bplabs.rice-bridge',
    teamId: trust.teamId,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
    minimumMacOS: '13.0.0',
    protocol: { min: 1, max: 1 },
    credentials: { min: 2, max: 2 },
    journal: { min: 1, max: 1 },
    writes: { credentials: 2, journal: 1 },
    packages: [],
    ...patch,
  };
  release.packages = (['x64', 'arm64'] as const).map((arch) => {
    const artifact = {
      arch,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: `${trust.origin}/${arch}.zip`,
      signature: '',
    };
    artifact.signature = sign(
      null,
      updatePackageSigningBytes(release, artifact),
      pair.privateKey,
    ).toString('base64');
    return artifact;
  });
  return release;
}
function envelope(release = fixture()) {
  const payload = Buffer.from(JSON.stringify(release));
  return Buffer.from(
    JSON.stringify({
      keyId: 'fixture',
      payload: payload.toString('base64'),
      signature: sign(
        null,
        updateMetadataSigningBytes(payload),
        pair.privateKey,
      ).toString('base64'),
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

it('ships no synthetic or TOFU trust anchor', () => {
  expect(bridgeUpdateTrust).toBeNull();
  expect(() =>
    verifyUpdateMetadata(envelope(), bridgeUpdateTrust, environment),
  ).toThrow('UPDATE_TRUST_UNCONFIGURED');
});
it.each(['x64', 'arm64'] as const)(
  'authenticates real Ed25519 metadata and the %s package',
  (arch) => {
    const update = verifyUpdateMetadata(envelope(), trust, {
      ...environment,
      arch,
    });
    expect(update.artifact.arch).toBe(arch);
    expect(() => verifyUpdatePackage(bytes, update)).not.toThrow();
  },
);
it('rejects metadata with a valid hash but forged publisher signature', () => {
  const json = JSON.parse(envelope().toString());
  json.signature = Buffer.alloc(64).toString('base64');
  expect(() =>
    verifyUpdateMetadata(Buffer.from(JSON.stringify(json)), trust, environment),
  ).toThrow('UPDATE_SIGNATURE_INVALID');
});
it('rejects a different real signing key and unknown key IDs', () => {
  const json = JSON.parse(envelope().toString());
  json.signature = sign(
    null,
    updateMetadataSigningBytes(Buffer.from(json.payload, 'base64')),
    generateKeyPairSync('ed25519').privateKey,
  ).toString('base64');
  expect(() =>
    verifyUpdateMetadata(Buffer.from(JSON.stringify(json)), trust, environment),
  ).toThrow('UPDATE_SIGNATURE_INVALID');
  json.keyId = '__proto__';
  expect(() =>
    verifyUpdateMetadata(Buffer.from(JSON.stringify(json)), trust, environment),
  ).toThrow('UPDATE_PUBLISHER_UNKNOWN');
});
it.each([
  [{ sequence: 1 }, 'UPDATE_DOWNGRADE_BLOCKED'],
  [{ version: '0.4.0-dev.1' }, 'UPDATE_DOWNGRADE_BLOCKED'],
  [{ teamId: 'OTHERTEAM1' }, 'UPDATE_PUBLISHER_MISMATCH'],
  [{ bundleId: 'other.app' }, 'UPDATE_PUBLISHER_MISMATCH'],
  [{ channel: 'stable' }, 'UPDATE_PUBLISHER_MISMATCH'],
  [{ expiresAt: new Date(now).toISOString() }, 'UPDATE_METADATA_EXPIRED'],
  [
    { issuedAt: new Date(now + 120000).toISOString() },
    'UPDATE_METADATA_EXPIRED',
  ],
  [{ minimumMacOS: '26.0.0' }, 'UPDATE_OS_INCOMPATIBLE'],
  [{ protocol: { min: 2, max: 3 } }, 'UPDATE_FORMAT_INCOMPATIBLE'],
  [{ credentials: { min: 1, max: 1 } }, 'UPDATE_FORMAT_INCOMPATIBLE'],
  [{ journal: { min: 2, max: 2 } }, 'UPDATE_FORMAT_INCOMPATIBLE'],
  [{ writes: { credentials: 3, journal: 1 } }, 'UPDATE_FORMAT_INCOMPATIBLE'],
  [{ writes: { credentials: 2, journal: 2 } }, 'UPDATE_FORMAT_INCOMPATIBLE'],
] as const)('rejects signed incompatible metadata %j', (patch, code) => {
  expect(() =>
    verifyUpdateMetadata(envelope(fixture(patch)), trust, environment),
  ).toThrow(code);
});
it('rejects replay on equal version even if sequence increases', () => {
  expect(() =>
    verifyUpdateMetadata(
      envelope(fixture({ version: environment.version, sequence: 50 })),
      trust,
      environment,
    ),
  ).toThrow('UPDATE_DOWNGRADE_BLOCKED');
});
it('rejects mutated package bytes, package signatures and cross-architecture substitution', () => {
  const update = verifyUpdateMetadata(envelope(), trust, environment);
  expect(() => verifyUpdatePackage(Buffer.alloc(bytes.length), update)).toThrow(
    'UPDATE_PACKAGE_INTEGRITY',
  );
  update.artifact.signature = Buffer.alloc(64).toString('base64');
  expect(() => verifyUpdatePackage(bytes, update)).toThrow(
    'UPDATE_PACKAGE_SIGNATURE_INVALID',
  );
  const release = fixture();
  release.packages[0]!.signature = release.packages[1]!.signature;
  expect(() =>
    verifyUpdateMetadata(envelope(release), trust, environment),
  ).toThrow('UPDATE_PACKAGE_SIGNATURE_INVALID');
});
it('requires both distinct architecture packages and rejects unknown fields', () => {
  const release = fixture();
  release.packages[1] = release.packages[0]!;
  expect(() =>
    verifyUpdateMetadata(envelope(release), trust, environment),
  ).toThrow('UPDATE_ARCHITECTURE_INVALID');
  expect(() =>
    verifyUpdateMetadata(
      envelope({ ...fixture(), extra: true } as UpdateRelease),
      trust,
      environment,
    ),
  ).toThrow('UPDATE_METADATA_INVALID');
});
it.each([
  'http://updates.example.test/x.zip',
  'https://evil.example.test/x.zip',
  'https://user:secret@updates.example.test/x.zip',
  'https://updates.example.test/x.zip?token=secret',
  'https://updates.example.test:444/x.zip',
  'https://updates.example.test/x.zip#other',
])('rejects update URL %s', (url) => {
  expect(() => assertUpdateURL(url, trust)).toThrow('UPDATE_ORIGIN_INVALID');
});
it('orders dev/stable versions without lexicographic downgrade mistakes', () => {
  expect(compareUpdateVersions('0.6.0-dev.10', '0.6.0-dev.2')).toBe(1);
  expect(compareUpdateVersions('0.6.0', '0.6.0-dev.10')).toBe(1);
  expect(compareUpdateVersions('0.5.10', '0.6.0')).toBe(-1);
});
it('bounds streaming downloads without forwarding Bridge credentials or allowing redirects', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array(5)));
  vi.stubGlobal('fetch', fetch);
  await expect(
    downloadUpdate(`${trust.origin}/x.zip`, trust, 4),
  ).rejects.toThrow('UPDATE_DOWNLOAD_LIMIT');
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('headers');
});
it('rejects oversized envelope before decoding/parsing', () => {
  expect(() =>
    verifyUpdateMetadata(Buffer.alloc(32769), trust, environment),
  ).toThrow('UPDATE_METADATA_LIMIT');
});
