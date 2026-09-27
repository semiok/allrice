import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import { GET, PUT, POST, DELETE } from './route';
const context = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: context,
}));
beforeEach(() => {
  context.mockReset();
  context.mockResolvedValue({});
});
describe('retired Gemini credential endpoint', () => {
  it.each([GET, PUT, POST, DELETE])(
    'returns 410 without reading credential inputs (%#)',
    async (handler) => {
      const request = new Request('https://example.test/api', {
        method: 'PUT',
        body: 'not-json-and-never-read',
      });
      const response = await handler(request);
      expect(response.status).toBe(410);
      expect(request.bodyUsed).toBe(false);
      expect(await response.text()).not.toContain('not-json-and-never-read');
    },
  );
  it.each(['authentication_required', 'authorization_denied'] as const)(
    'preserves authorization boundary: %s',
    async (code) => {
      context.mockRejectedValue(new DataAccessError(code));
      expect((await PUT(new Request('https://example.test'))).status).toBe(
        code === 'authentication_required' ? 401 : 403,
      );
    },
  );
});
