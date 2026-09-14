/** Operator-side offline signing. Not imported by the desktop client. No key
 * discovery, Keychain export, network publishing, first-use trust or defaults. */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BridgeProtocolVersion } from '../packages/contracts/src/bridge.js';
import {
  bridgeUpdateTrust,
  maximumUpdateBytes,
  updateMetadataSigningBytes,
  updatePackageSigningBytes,
  verifyUpdateMetadata,
  type UpdateRelease,
} from '../apps/rice-bridge/src/trusted-update.js';
import { inspectUpdateZip } from '../apps/rice-bridge/src/update-installer.js';

async function main() {
  if (!bridgeUpdateTrust) throw Error('UPDATE_TRUST_UNCONFIGURED');
  const [templatePath, keyPath, outputPath, ...rest] = process.argv.slice(2);
  if (!templatePath || !keyPath || !outputPath || rest.length)
    throw Error('UPDATE_SIGNING_ARGUMENTS_REQUIRED');
  const input = JSON.parse(await readFile(resolve(templatePath), 'utf8')) as {
    keyId: string;
    release: UpdateRelease;
    packages: Record<'x64' | 'arm64', string>;
  };
  if (
    Object.keys(input).sort().join(',') !== 'keyId,packages,release' ||
    typeof input.keyId !== 'string' ||
    !Object.hasOwn(bridgeUpdateTrust.keys, input.keyId) ||
    Object.keys(input.packages).sort().join(',') !== 'arm64,x64'
  )
    throw Error('UPDATE_SIGNING_INPUT_INVALID');
  const handle = await open(
    resolve(keyPath),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let privateBytes: Buffer;
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 4096
    )
      throw Error('UPDATE_SIGNING_KEY_UNSAFE');
    privateBytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(privateBytes);
  } finally {
    privateBytes.fill(0);
  }
  if (
    privateKey.asymmetricKeyType !== 'ed25519' ||
    !createPublicKey(privateKey)
      .export({ type: 'spki', format: 'der' })
      .equals(
        createPublicKey(bridgeUpdateTrust.keys[input.keyId]!).export({
          type: 'spki',
          format: 'der',
        }),
      )
  )
    throw Error('UPDATE_SIGNING_PUBLISHER_MISMATCH');
  const release = { ...input.release, packages: [] } as UpdateRelease;
  for (const arch of ['x64', 'arm64'] as const) {
    const file = await open(
      resolve(input.packages[arch]),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > maximumUpdateBytes || info.nlink !== 1)
        throw Error('UPDATE_PACKAGE_INTEGRITY');
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    inspectUpdateZip(bytes);
    const artifact = {
      arch,
      url: `${bridgeUpdateTrust.origin}/bridge/${bridgeUpdateTrust.channel}/${release.sequence}/RiceBridge-App-${arch === 'arm64' ? 'M' : 'Intel'}.zip`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signature: '',
    };
    artifact.signature = sign(
      null,
      updatePackageSigningBytes(release, artifact),
      privateKey,
    ).toString('base64');
    release.packages.push(artifact);
  }
  const payload = Buffer.from(JSON.stringify(release));
  const metadata = Buffer.from(
    JSON.stringify({
      keyId: input.keyId,
      payload: payload.toString('base64'),
      signature: sign(
        null,
        updateMetadataSigningBytes(payload),
        privateKey,
      ).toString('base64'),
    }) + '\n',
  );
  for (const arch of ['x64', 'arm64'] as const)
    verifyUpdateMetadata(metadata, bridgeUpdateTrust, {
      version: '0.0.0',
      sequence: 0,
      arch,
      macOS: '999.0.0',
      protocol: BridgeProtocolVersion,
      credentials: 2,
      journal: 1,
      now: Date.now(),
    });
  const output = resolve(outputPath);
  await mkdir(output, { mode: 0o700 });
  const file = await open(join(output, 'candidate.signed.json'), 'wx', 0o600);
  try {
    await file.writeFile(metadata);
    await file.sync();
  } finally {
    await file.close();
  }
  console.info(
    JSON.stringify({
      publisherMetadataSigned: true,
      version: release.version,
      sequence: release.sequence,
      architectures: ['x64', 'arm64'],
      appleVerification:
        'must separately validate final ZIPs on both target Macs before publishing',
      published: false,
    }),
  );
}
void main().catch(() => {
  console.error('UPDATE_METADATA_SIGNING_FAILED');
  process.exitCode = 1;
});
