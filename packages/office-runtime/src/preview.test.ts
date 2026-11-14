import process from 'node:process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  readdir: vi.fn(),
  plugin: vi.fn(),
  convert: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ readdir: ports.readdir }));
vi.mock('@deepseek-ai/dsh-office-to-pdf', () => ({
  OfficeToPdf: class {},
  OfficeSourceKey: (value: string) => value,
}));
vi.mock('@deepseek-ai/cordis', () => ({
  Context: class {
    officeToPdf = { convert: ports.convert };
    plugin(plugin: unknown, config: unknown) {
      ports.plugin(plugin, config);
      return { await: async () => {} };
    }
  },
}));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  ports.convert.mockResolvedValue({ pdf: Uint8Array.of(1), missingFonts: [] });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
});

async function open(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
  const { previewOfficePdf } = await import('./preview.js');
  const signal = new AbortController().signal;
  await previewOfficePdf({
    objectId: 'immutable-object',
    checksum: 'sha256:version',
    sizeBytes: 3,
    format: 'docx',
    signal,
    read: async () => Uint8Array.of(1, 2, 3),
  });
  return signal;
}

it('opens a DOCX with explicit Mac system and MobileAsset roots, retaining native limits and source cancellation', async () => {
  ports.readdir.mockResolvedValue([
    'com_apple_MobileAsset_Font7',
    'com_apple_MobileAsset_Font6',
    'com_apple_MobileAsset_Other',
    'com_apple_MobileAsset_Font7/../../private',
  ]);
  const signal = await open('darwin');
  expect(ports.readdir).toHaveBeenCalledExactlyOnceWith(
    '/System/Library/AssetsV2',
  );
  const config = ports.plugin.mock.calls[0]![1];
  expect(config).toEqual({
    fontDirectories: [
      '/System/Library/Fonts',
      '/Library/Fonts',
      '/System/Library/AssetsV2/com_apple_MobileAsset_Font6',
      '/System/Library/AssetsV2/com_apple_MobileAsset_Font7',
    ],
  });
  const [request, receivedSignal] = ports.convert.mock.calls[0]!;
  expect(receivedSignal).toBe(signal);
  expect(request).toMatchObject({
    extension: 'docx',
    priority: 'foreground',
    source: {
      key: 'allrice-object:immutable-object',
      version: 'sha256:version',
      bytes: 3,
    },
  });
  expect(await request.source.read(signal, 3)).toEqual({
    bytes: Uint8Array.of(1, 2, 3),
    version: 'sha256:version',
  });
  expect(JSON.stringify(config)).not.toMatch(
    /Group Containers|Office|Applications|Users/,
  );
});

it('keeps the Linux image Noto/DejaVu roots without discovering user or Office directories', async () => {
  await open('linux');
  expect(ports.readdir).not.toHaveBeenCalled();
  expect(ports.plugin.mock.calls[0]![1]).toEqual({
    fontDirectories: ['/usr/local/share/fonts', '/usr/share/fonts'],
  });
});

it.each([
  ['D:\\Windows Root', 'D:\\Windows Root\\Fonts'],
  [undefined, 'C:\\Windows\\Fonts'],
] as const)(
  'uses the inherited Windows system root (%s) without Office discovery',
  async (systemRoot, expected) => {
    vi.stubEnv('SYSTEMROOT', systemRoot);
    await open('win32');
    expect(ports.readdir).not.toHaveBeenCalled();
    expect(ports.plugin.mock.calls[0]![1]).toEqual({
      fontDirectories: [expected],
    });
  },
);

it.each(['ENOENT', 'EACCES', 'EPERM'])(
  'keeps safe Mac system fonts when optional MobileAsset roots are unavailable (%s)',
  async (code) => {
    ports.readdir.mockRejectedValue(
      Object.assign(Error('not present'), { code }),
    );
    await open('darwin');
    expect(ports.plugin.mock.calls[0]![1]).toEqual({
      fontDirectories: ['/System/Library/Fonts', '/Library/Fonts'],
    });
  },
);
