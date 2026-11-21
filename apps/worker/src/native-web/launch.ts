import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import {
  nativeWebAuthArtifact,
  PersonVmError,
  type PersonVmBinding,
  type PersonVmGuestCommand,
  type PersonVmMemoryGuestPlan,
  type PersonVmNativeWebAuthRequest,
} from '@allrice/person-vm';

/** Trusted host configuration for an ALREADY published loopback endpoint. No
 * port allocation, guest-selected target, or running-VM restart is performed. */
export type NativeWebConfiguration = Readonly<{
  origin: string;
  publicUrl: string;
  guestAddress: string;
  guestPort: number;
  dshHome: string;
  agentsHome: string;
  workdir: string;
  cliPath: string;
  startupTimeoutMs: number;
}>;
export type NativeWebLaunch = Readonly<{
  binding: PersonVmBinding;
  auth: PersonVmNativeWebAuthRequest;
  files: PersonVmMemoryGuestPlan['files'];
  command: PersonVmGuestCommand;
}>;

export async function prepareNativeWebLaunch(
  config: NativeWebConfiguration,
  binding: PersonVmBinding,
): Promise<NativeWebLaunch> {
  let origin: URL, publicUrl: URL;
  try {
    origin = new URL(config.origin);
    publicUrl = new URL(config.publicUrl);
  } catch {
    throw new PersonVmError('PROVIDER_FAILED');
  }
  const auth = Object.freeze({
    dshHome: config.dshHome,
    nonce: randomUUID(),
    origin: origin.href,
    timeoutMs: config.startupTimeoutMs,
  });
  const artifact = nativeWebAuthArtifact(auth);
  if (
    !isIP(config.guestAddress) ||
    ['0.0.0.0', '::'].includes(config.guestAddress) ||
    !Number.isInteger(config.guestPort) ||
    config.guestPort < 1 ||
    config.guestPort > 65535 ||
    !['http:', 'https:'].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    [config.agentsHome, config.workdir, config.cliPath].some(
      (path) =>
        !posix.isAbsolute(path) ||
        posix.normalize(path) !== path ||
        path.includes('\0'),
    )
  )
    throw new PersonVmError('PROVIDER_FAILED');
  const directory = `${config.dshHome}/native-web`;
  const plugin = `${directory}/owner.mjs`,
    patch = `${directory}/owner.patch.json`;
  const source = await readFile(
    new URL('../../dsh/allrice-native-web-owner.mjs', import.meta.url),
    'utf8',
  );
  return Object.freeze({
    binding: Object.freeze({ ...binding }),
    auth,
    files: Object.freeze([
      { path: plugin, contents: source, mode: 0o600 },
      {
        path: patch,
        contents: JSON.stringify([
          { id: 'web-runtime', config: { printUrl: false } },
          {
            insert: [
              {
                id: 'allrice-native-web-owner',
                name: `file://${plugin}`,
                config: {
                  artifactPath: artifact.path,
                  nonce: auth.nonce,
                  baseUrl: auth.origin,
                },
              },
            ],
          },
        ]),
        mode: 0o600,
      },
    ]),
    command: Object.freeze({
      executable: 'node',
      args: Object.freeze([
        config.cliPath,
        '--profile',
        'web',
        '--patch',
        patch,
        '--no-open',
        '--host',
        config.guestAddress,
        '--port',
        String(config.guestPort),
        '--public-url',
        publicUrl.href,
        '--trusted-host',
        new URL(auth.origin).host,
        '--trusted-host',
        publicUrl.host,
      ]),
      env: Object.freeze({
        DSH_HOME: config.dshHome,
        DSH_AGENTS_HOME: config.agentsHome,
      }),
      workdir: config.workdir,
    }),
  });
}
