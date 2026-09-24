import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  rm,
  chmod,
  readFile,
  lstat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeConfig, type BridgeConfig } from './config.js';
import { saveSandboxOptIn } from './sandbox-settings.js';
import * as sandboxSettings from './sandbox-settings.js';
import {
  readLocalMcpOptIn,
  saveLocalMcpOptIn,
  localMcpEnabledForBinding,
  localMcpSettingsCli,
} from './local-mcp-settings.js';
import { LocalCommandRunner } from './local-command-runner.js';
import { testImage } from '../test/toolchain.js';

let directory: string, config: BridgeConfig;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'allrice-p17-optin-'));
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', join(directory, 'config.json'));
  vi.stubEnv('ALLRICE_BRIDGE_STATIC_DEVICE_ID', undefined);
  vi.stubEnv('ALLRICE_LOCAL_MCP_ENABLED', undefined);
  config = {
    deviceId: randomUUID(),
    server: 'https://synthetic.example',
    deviceName: 'Synthetic',
    grants: [],
  };
  await writeConfig(config);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('P17 normal App persistent explicit local MCP opt-in', () => {
  it('is disabled by default and normal App can consume a saved choice without inherited flags', async () => {
    expect(await readLocalMcpOptIn(config)).toBe(null);
    expect(await localMcpEnabledForBinding(config)).toBe(false);
    await saveSandboxOptIn(config, true);
    await saveLocalMcpOptIn(config, true);
    expect(process.env.ALLRICE_LOCAL_MCP_ENABLED).toBeUndefined();
    expect(await localMcpEnabledForBinding(config)).toBe(true);
    expect(
      (await lstat(join(directory, 'config.json.mcp-settings'))).mode & 0o777,
    ).toBe(0o700);
    expect(
      (await lstat(join(directory, 'config.json.mcp-settings/opt-in.json')))
        .mode & 0o777,
    ).toBe(0o600);
  });
  it.each(['device', 'server', 'unpair'] as const)(
    'invalidates a held instance when the pairing changes: %s',
    async (mutation) => {
      await saveSandboxOptIn(config, true);
      await saveLocalMcpOptIn(config, true);
      if (mutation === 'unpair') await rm(join(directory, 'config.json'));
      else {
        const next = {
          ...config,
          ...(mutation === 'device'
            ? { deviceId: randomUUID() }
            : { server: 'https://other.example' }),
        };
        await writeConfig(next);
        await saveSandboxOptIn(next, true);
        expect(await readLocalMcpOptIn(next)).toBe(false);
        await saveLocalMcpOptIn(next, true);
      }
      expect(await localMcpEnabledForBinding(config)).toBe(false);
    },
  );
  it('cannot override an explicit sandbox pause or saved MCP opt-out using the development flag', async () => {
    await saveSandboxOptIn(config, false);
    vi.stubEnv('ALLRICE_LOCAL_MCP_ENABLED', '1');
    expect(await localMcpEnabledForBinding(config)).toBe(false);
    await saveSandboxOptIn(config, true);
    expect(await localMcpEnabledForBinding(config)).toBe(true);
    await saveLocalMcpOptIn(config, false);
    expect(await localMcpEnabledForBinding(config)).toBe(false);
    await saveLocalMcpOptIn(config, true);
    vi.stubEnv('ALLRICE_LOCAL_MCP_ENABLED', '0');
    expect(await localMcpEnabledForBinding(config)).toBe(false);
  });
  it('fails closed on unsafe/corrupt files without changing permissions or clearing pairing', async () => {
    await saveSandboxOptIn(config, true);
    await saveLocalMcpOptIn(config, true);
    const path = join(directory, 'config.json.mcp-settings/opt-in.json');
    await chmod(path, 0o644);
    expect(await localMcpEnabledForBinding(config)).toBe(false);
    await expect(saveLocalMcpOptIn(config, true)).rejects.toThrow(
      'LOCAL_MCP_SETTINGS_UNAVAILABLE',
    );
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    await chmod(path, 0o600);
    await writeFile(path, '{bad json');
    expect(await localMcpEnabledForBinding(config)).toBe(false);
    expect(
      JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))
        .deviceId,
    ).toBe(config.deviceId);
  });
  it('enable honors an explicit sandbox pause and requires preflight, while status/disable do not touch Docker', async () => {
    await saveSandboxOptIn(config, false);
    // This is a settings transaction test, not a native Mac/VM acceptance.
    // Model a supported sandbox explicitly on every test host; Linux must not
    // accidentally reach the real Mac-only config before the preflight mock.
    vi.spyOn(sandboxSettings, 'nativeSandboxConfig').mockReturnValue({
      socketPath: join(directory, 'absent-test-docker.sock'),
      imageDigest: testImage,
    });
    const preflight = vi
      .spyOn(LocalCommandRunner.prototype, 'preflight')
      .mockResolvedValue({
        backend: 'local-vm-container-v1',
        imageDigest: testImage,
        architecture: process.arch === 'arm64' ? 'arm64' : 'amd64',
        features: [],
      });
    const output = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    await expect(localMcpSettingsCli(['enable'])).rejects.toThrow(
      'LOCAL_MCP_SANDBOX_REQUIRED',
    );
    expect(preflight).not.toHaveBeenCalled();
    await saveSandboxOptIn(config, true);
    preflight.mockRejectedValueOnce(Error('synthetic Docker unavailable'));
    await expect(localMcpSettingsCli(['enable'])).rejects.toThrow(
      'LOCAL_MCP_SETTINGS_UNAVAILABLE',
    );
    expect(await readLocalMcpOptIn(config)).toBe(null);
    await localMcpSettingsCli(['enable']);
    expect(await localMcpEnabledForBinding(config)).toBe(true);
    preflight.mockClear();
    await localMcpSettingsCli(['status']);
    await localMcpSettingsCli(['disable']);
    expect(preflight).not.toHaveBeenCalled();
    expect(await localMcpEnabledForBinding(config)).toBe(false);
    expect(
      JSON.parse(String(output.mock.calls.at(-1)![0])).serverAuthorization,
    ).toBe('not_checked');
  });
  it('keeps the actual host platform gate before any Docker preflight or opt-in write', async () => {
    const preflight = vi.spyOn(LocalCommandRunner.prototype, 'preflight');
    await saveSandboxOptIn(config, true);
    const supported =
      process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch);
    if (supported) {
      // Construction only: do not probe or install a developer's real VM.
      expect(sandboxSettings.nativeSandboxConfig()).toMatchObject({
        imageDigest: testImage,
      });
    } else {
      expect(() => sandboxSettings.nativeSandboxConfig()).toThrow(
        'UNSUPPORTED_NATIVE_PLATFORM',
      );
      await expect(localMcpSettingsCli(['enable'])).rejects.toThrow(
        'LOCAL_MCP_SETTINGS_UNAVAILABLE',
      );
      expect(await readLocalMcpOptIn(config)).toBe(null);
      expect(await localMcpEnabledForBinding(config)).toBe(false);
    }
    expect(preflight).not.toHaveBeenCalled();
  });
});
