import { expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({ read: vi.fn(), update: vi.fn() }));
vi.mock('@allrice/database', () => ({
  getBridgeSandboxNetwork: port.read,
  updateBridgeSandboxNetwork: port.update,
}));
import { GET, PATCH } from './route';
it('retires the old form without reading or changing any owner grant', async () => {
  const read = await GET();
  expect(read.status).toBe(404);
  const write = await PATCH();
  expect(write.status).toBe(410);
  expect(await write.json()).toEqual({
    error: { message: '联网已改为自动检查，无需配置网站地址。请刷新页面。' },
  });
  for (const response of [read, write])
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(port.read).not.toHaveBeenCalled();
  expect(port.update).not.toHaveBeenCalled();
});
