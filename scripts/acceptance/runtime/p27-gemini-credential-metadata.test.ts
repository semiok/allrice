import { beforeEach, describe, expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
  readFile: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('node:fs/promises', () => fs);
import {
  AUTHORIZED_DEV_ROOT,
  AUTHORIZED_GEMINI_CREDENTIAL_FILE,
  authorizedGeminiCredentialFile,
  authorizedPlatformHome,
} from './p27-assistant-preflight.ts';

const file = `${AUTHORIZED_DEV_ROOT}/synthetic/credentials.json`;
const metadata = () => ({
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  uid: process.getuid?.(),
  nlink: 1,
  mode: 0o600,
  size: 80,
});

describe('P27 Gemini credential boundary (synthetic metadata only)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fs.realpath.mockImplementation(async (value: string) => value);
    fs.lstat.mockImplementation(async () => metadata());
  });
  it('validates an explicit private Dev file without reading its bytes', async () => {
    await expect(authorizedGeminiCredentialFile(file)).resolves.toBe(file);
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it('accepts only the exact existing Dev binding outside the fixture root, not its siblings', async () => {
    await expect(
      authorizedGeminiCredentialFile(AUTHORIZED_GEMINI_CREDENTIAL_FILE),
    ).resolves.toBe(AUTHORIZED_GEMINI_CREDENTIAL_FILE);
    await expect(
      authorizedGeminiCredentialFile(
        '/Users/a123/.config/allrice/dsh-credentials.prod.json',
      ),
    ).rejects.toThrow('gemini_credential_metadata_denied');
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it('refuses missing selection before inspecting any path', async () => {
    await expect(authorizedGeminiCredentialFile(undefined)).rejects.toThrow(
      'gemini_credential_file_required',
    );
    expect(fs.lstat).not.toHaveBeenCalled();
    expect(fs.realpath).not.toHaveBeenCalled();
  });
  it.each([
    { nlink: 2 },
    { mode: 0o644 },
    { uid: (process.getuid?.() ?? 0) + 1 },
    { size: 0 },
    { size: 65537 },
    { isFile: () => false },
    { isSymbolicLink: () => true },
  ])('rejects unsafe metadata %j', async (override) => {
    fs.lstat.mockResolvedValue({ ...metadata(), ...override });
    await expect(authorizedGeminiCredentialFile(file)).rejects.toThrow(
      'gemini_credential_metadata_denied',
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it.each([
    AUTHORIZED_DEV_ROOT,
    `${AUTHORIZED_DEV_ROOT}-lookalike/key`,
    '/outside/key',
  ])('rejects a path resolving to %s', async (canonical) => {
    fs.realpath.mockImplementation(async (value: string) =>
      value === file ? canonical : value,
    );
    await expect(authorizedGeminiCredentialFile(file)).rejects.toThrow(
      'gemini_credential_metadata_denied',
    );
    expect(fs.readFile).not.toHaveBeenCalled();
  });
  it('the existing-home validator continues checking Codex credentials (Gemini must not call it)', async () => {
    fs.lstat.mockResolvedValue({
      ...metadata(),
      isDirectory: () => true,
      mode: 0o700,
    });
    const home = `${AUTHORIZED_DEV_ROOT}/synthetic-platform`;
    await expect(authorizedPlatformHome(home)).resolves.toBe(home);
    expect(fs.lstat).toHaveBeenCalledTimes(2);
    expect(fs.lstat).toHaveBeenLastCalledWith(`${home}/.credentials.yaml`);
    expect(fs.readFile).not.toHaveBeenCalled();
  });
});
