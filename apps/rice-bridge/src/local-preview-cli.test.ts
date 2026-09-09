import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  sandbox: vi.fn(),
  browser: vi.fn(),
  preview: vi.fn(),
  save: vi.fn(),
  executable: vi.fn(),
  launcher: vi.fn(),
  preflight: vi.fn(),
}));
vi.mock('./config.js', () => ({ readConfig: mocks.readConfig }));
vi.mock('./sandbox-settings.js', () => ({
  sandboxOptIn: mocks.sandbox,
  nativeSandboxConfig: () => ({}),
}));
vi.mock('./local-browser-settings.js', () => ({
  localBrowserOptIn: mocks.browser,
}));
vi.mock('./local-preview-settings.js', () => ({
  localPreviewOptIn: mocks.preview,
  saveLocalPreviewOptIn: mocks.save,
}));
vi.mock('./local-browser-driver.js', () => ({
  resolveLocalBrowserExecutable: mocks.executable,
}));
vi.mock('./local-browser-supervisor.js', () => ({
  resolveLocalBrowserLauncher: mocks.launcher,
}));
vi.mock('./local-command-runner.js', () => ({
  LocalCommandRunner: class {
    preflight = mocks.preflight;
  },
}));
import { localPreviewCli } from './local-preview-cli.js';
const config = {
  deviceId: 'synthetic',
  server: 'https://saas.example',
  grants: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readConfig.mockResolvedValue(config);
  mocks.sandbox.mockResolvedValue(true);
  mocks.browser.mockResolvedValue(true);
  mocks.preview.mockResolvedValue(false);
  mocks.save.mockResolvedValue(undefined);
  mocks.executable.mockResolvedValue('/fixed/browser');
  mocks.launcher.mockResolvedValue('/fixed/helper');
  mocks.preflight.mockResolvedValue(undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
describe('P23 preview explicit CLI consent', () => {
  it('status is read-only and does not launch or probe browser/VM', async () => {
    await localPreviewCli([]);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.executable).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining('"hostPortPublished":false'),
    );
  });
  it.each(['sandbox', 'browser'] as const)(
    'requires existing %s opt-in without implicitly enabling it',
    async (kind) => {
      mocks[kind].mockResolvedValue(false);
      await expect(localPreviewCli(['enable'])).rejects.toThrow(
        'LOCAL_PREVIEW_REQUIRES_BROWSER_AND_SANDBOX',
      );
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.preflight).not.toHaveBeenCalled();
    },
  );
  it('preflights fixed native components before saving consent', async () => {
    await localPreviewCli(['enable']);
    expect(mocks.preflight).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith(config, true);
    expect(mocks.save.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.preflight.mock.invocationCallOrder[0]!,
    );
  });
  it.each(['executable', 'launcher', 'preflight'] as const)(
    'leaves consent unchanged when %s is unavailable',
    async (kind) => {
      mocks[kind].mockRejectedValue(Error('synthetic-detail'));
      await expect(localPreviewCli(['enable'])).rejects.toThrow();
      expect(mocks.save).not.toHaveBeenCalled();
    },
  );
  it('disable requires no working browser or VM and accepts no arbitrary flags or ports', async () => {
    await localPreviewCli(['disable']);
    expect(mocks.save).toHaveBeenCalledWith(config, false);
    expect(mocks.preflight).not.toHaveBeenCalled();
    for (const args of [
      ['enable', '--port=3000'],
      ['open'],
      ['https://user.example'],
    ])
      await expect(localPreviewCli(args)).rejects.toThrow(
        'preview status|enable|disable',
      );
  });
});
