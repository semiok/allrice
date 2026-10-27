import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from './route';
const mocks = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock('../../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const request = () =>
  new Request('https://synthetic.test/api/v1/bridge/client/macos-arm64');

it('requires a session before serving the configured archive', async () => {
  mocks.context.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
});

it('downloads the Apple silicon build as AllRice-Assistant.zip whatever the server file is called', async () => {
  mocks.context.mockResolvedValue({ actor: { type: 'user', id: 'synthetic' } });
  const root = await mkdtemp(join(tmpdir(), 'bridge-download-'));
  roots.push(root);
  // The Dev package still on disk keeps its old name until it is replaced.
  const archive = join(root, 'RiceBridge-App-M.zip');
  await writeFile(archive, 'synthetic archive');
  vi.stubEnv('ALLRICE_BRIDGE_MACOS_ARM64_PATH', archive);
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toBe(
    'attachment; filename="AllRice-Assistant.zip"',
  );
  expect(response.headers.get('content-type')).toBe('application/zip');
  expect(await response.text()).toBe('synthetic archive');
});
