import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const service = 'ai.traditionow.allrice.rice-bridge';

export type KeychainUnavailableReason =
  'interaction-not-allowed' | 'item-not-found' | 'timed-out' | 'unavailable';

/** Never retain the subprocess error: it may contain token-bearing argv. */
export class KeychainUnavailableError extends Error {
  constructor(public readonly reason: KeychainUnavailableReason) {
    super('KEYCHAIN_UNAVAILABLE');
    this.name = 'KeychainUnavailableError';
  }
}

function unavailableReason(error: unknown): KeychainUnavailableReason {
  if (!error || typeof error !== 'object') return 'unavailable';
  const failure = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return 'unavailable';
  if (failure.killed === true && failure.signal === 'SIGKILL')
    return 'timed-out';
  // A CLI exit code alone is not an OSStatus diagnosis. Only recognize the
  // known code/text pairs; do not infer whether the user's Keychain is locked.
  const stderr =
    typeof failure.stderr === 'string'
      ? failure.stderr.slice(0, 64 * 1024)
      : '';
  if (
    failure.code === 36 &&
    /\bUser interaction is not allowed\.\s*$/i.test(stderr)
  )
    return 'interaction-not-allowed';
  if (
    failure.code === 44 &&
    /\bThe specified item could not be found in the keychain\.\s*$/i.test(
      stderr,
    )
  )
    return 'item-not-found';
  return 'unavailable';
}

async function run(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('/usr/bin/security', args, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 64 * 1024,
      // This signal is limited to the exact security child created above.
      // Await execFile's completion; no Promise.race or detached late writer.
      killSignal: 'SIGKILL',
    });
    return result.stdout;
  } catch (error) {
    throw new KeychainUnavailableError(unavailableReason(error));
  }
}

export async function readKeychainToken(deviceId: string): Promise<string> {
  const token = (
    await run(['find-generic-password', '-s', service, '-a', deviceId, '-w'])
  ).trim();
  if (!token) throw new KeychainUnavailableError('unavailable');
  return token;
}

export async function storeKeychainToken(
  deviceId: string,
  token: string,
): Promise<void> {
  // Preserve the existing exact command. Token exposure in child argv remains
  // a known limitation until a separately reviewed native Keychain API exists.
  await run([
    'add-generic-password',
    '-U',
    '-s',
    service,
    '-a',
    deviceId,
    '-w',
    token,
  ]);
}

export async function deleteKeychainToken(deviceId: string): Promise<void> {
  await run(['delete-generic-password', '-s', service, '-a', deviceId]);
}
