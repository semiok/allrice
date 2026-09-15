import { lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareP27PlatformEnvironment } from './p27-assistant-preflight.ts';

describe('P27 empty private Gemini platform startup (no credential content)', () => {
  it('creates a new mode-0700 empty home and does not seed an old Codex store', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'p27-platform-startup-'));
    const environment = {
      PATH: '/synthetic/bin',
      GEMINI_API_KEY: 'synthetic-unselected',
      ALLRICE_DSH_PLATFORM_HOME: '/synthetic-old-codex',
    };
    const before = { ...environment };
    try {
      const result = await prepareP27PlatformEnvironment({
        environment,
        temporary,
        providerRoute: 'gemini',
        credentialFile: '/synthetic-explicit-dev-file',
      });
      const platform = join(temporary, 'platform');
      expect(result.ALLRICE_DSH_PLATFORM_HOME).toBe(platform);
      expect((await lstat(platform)).mode & 0o777).toBe(0o700);
      expect(await readdir(platform)).toEqual([]);
      await expect(
        lstat(join(platform, '.credentials.yaml')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result.ALLRICE_DSH_CREDENTIALS_FILE).toBe(
        '/synthetic-explicit-dev-file',
      );
      expect(result).not.toHaveProperty('GEMINI_API_KEY');
      expect(environment).toEqual(before);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it('rejects passing an existing Codex home to Gemini before creating a platform directory', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'p27-platform-denied-'));
    try {
      await expect(
        prepareP27PlatformEnvironment({
          environment: {},
          temporary,
          providerRoute: 'gemini',
          codexPlatformHome: '/synthetic-old-codex',
          credentialFile: '/synthetic-explicit-dev-file',
        }),
      ).rejects.toThrow('p27_gemini_existing_platform_home_denied');
      expect(await readdir(temporary)).toEqual([]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it('startup mkdir failure stays inside owner cleanup and never mutates ambient environment', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'p27-platform-failure-'));
    const environment = {
      ALLRICE_DSH_PLATFORM_HOME: '/synthetic-old-home',
      ALLRICE_DSH_CREDENTIALS_JSON: 'synthetic-unselected',
    };
    const before = { ...environment };
    let reachedExecution = false;
    let cleanupRan = false;
    await mkdir(join(temporary, 'platform'));
    await expect(
      (async () => {
        try {
          await prepareP27PlatformEnvironment({
            environment,
            temporary,
            providerRoute: 'gemini',
            credentialFile: '/synthetic-explicit-dev-file',
          });
          reachedExecution = true;
        } finally {
          await rm(temporary, { recursive: true, force: true });
          cleanupRan = true;
        }
      })(),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(reachedExecution).toBe(false);
    expect(cleanupRan).toBe(true);
    expect(environment).toEqual(before);
    await expect(lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
