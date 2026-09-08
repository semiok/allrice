import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const reference = 'deployment:gemini-default';
const maxDirectoryBytes = 1_048_576;

export class GeminiCredentialError extends Error {
  constructor(public readonly code: 'unavailable' | 'invalid_key' | 'busy') {
    super(code);
  }
}

function credentialPath() {
  const path = process.env.ALLRICE_DSH_CREDENTIALS_FILE;
  // Never write a file shadowed by the Worker's higher-priority inline directory.
  if (process.env.ALLRICE_DSH_CREDENTIALS_JSON || !path || !isAbsolute(path))
    throw new GeminiCredentialError('unavailable');
  return path;
}

export function validateGeminiApiKey(value: unknown): string {
  if (typeof value !== 'string') throw new GeminiCredentialError('invalid_key');
  // Reject pasted multiline commands/control characters; do not echo any input.
  const key = value.trim();
  // Treat the key as opaque: Google Auth keys (AQ.) also contain a dot.
  if (
    !/^[A-Za-z0-9_.-]{20,256}$/.test(key) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new GeminiCredentialError('invalid_key');
  return key;
}

async function readDirectory(path: string) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o022) !== 0)
    throw new GeminiCredentialError('unavailable');
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { encoded: null, directory: {} as Record<string, unknown> };
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.uid !== process.getuid?.() ||
      metadata.size > maxDirectoryBytes
    )
      throw new GeminiCredentialError('unavailable');
    const encoded = await file.readFile('utf8');
    const directory: unknown = JSON.parse(encoded);
    if (!directory || typeof directory !== 'object' || Array.isArray(directory))
      throw new GeminiCredentialError('unavailable');
    return { encoded, directory: directory as Record<string, unknown> };
  } finally {
    await file.close();
  }
}

function status(directory: Record<string, unknown>) {
  const value = directory[reference];
  const binding =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const configured =
    binding?.scope === 'deployment' &&
    typeof binding.apiKey === 'string' &&
    Boolean(binding.apiKey.trim()) &&
    !/[\r\n]/.test(binding.apiKey);
  return {
    configured,
    updatedAt:
      configured &&
      typeof binding?.updatedAt === 'string' &&
      !Number.isNaN(Date.parse(binding.updatedAt))
        ? new Date(binding.updatedAt).toISOString()
        : null,
  };
}

export async function getGeminiCredentialStatus() {
  try {
    return {
      ...status((await readDirectory(credentialPath())).directory),
      writable: true,
    };
  } catch {
    // Configuration and filesystem errors may contain sensitive data; never surface them.
    throw new GeminiCredentialError('unavailable');
  }
}

/** Platform-shared credential only. Tenant scope/references are not accepted from HTTP. */
export async function saveGeminiCredential(apiKey: string, actorId: string) {
  const key = validateGeminiApiKey(apiKey);
  const path = credentialPath();
  let lock;
  let temporaryPath: string | undefined;
  try {
    await readDirectory(path);
    try {
      lock = await open(`${path}.lock`, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new GeminiCredentialError('busy');
      throw error;
    }
    const current = await readDirectory(path);
    const previous = current.directory[reference];
    if (
      previous &&
      (typeof previous !== 'object' ||
        Array.isArray(previous) ||
        (previous as Record<string, unknown>).scope !== 'deployment')
    )
      throw new GeminiCredentialError('unavailable');
    const updatedAt = new Date().toISOString();
    const next = {
      ...current.directory,
      [reference]: {
        scope: 'deployment',
        apiKey: key,
        updatedAt,
        updatedBy: actorId,
      },
    };
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > maxDirectoryBytes)
      throw new GeminiCredentialError('unavailable');
    const candidate = `${path}.${randomUUID()}.tmp`;
    const temporary = await open(candidate, 'wx', 0o600);
    temporaryPath = candidate;
    try {
      await temporary.writeFile(encoded, 'utf8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    // Refuse an external edit while a save was being prepared.
    if ((await readDirectory(path)).encoded !== current.encoded)
      throw new GeminiCredentialError('busy');
    await rename(candidate, path);
    temporaryPath = undefined;
    return { configured: true, writable: true, updatedAt };
  } catch (error) {
    if (error instanceof GeminiCredentialError) throw error;
    throw new GeminiCredentialError('unavailable');
  } finally {
    if (temporaryPath) await unlink(temporaryPath).catch(() => {});
    if (lock) {
      await lock.close().catch(() => {});
      await unlink(`${path}.lock`).catch(() => {});
    }
  }
}
