import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import type * as CredentialStore from '../../../../../../../lib/providers/gemini-credential-store';
import { DataAccessError } from '@allrice/database';
import { GET, PUT } from './route';
import { GeminiCredentialError } from '../../../../../../../lib/providers/gemini-credential-store';

const ports = vi.hoisted(() => ({
  context: vi.fn(),
  platformAdmin: vi.fn(),
  audit: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  isPlatformAdmin: ports.platformAdmin,
  recordGeminiCredentialChange: ports.audit,
}));
vi.mock(
  '../../../../../../../lib/providers/gemini-credential-store',
  async (original) => ({
    ...(await original<typeof CredentialStore>()),
    getGeminiCredentialStatus: ports.read,
    saveGeminiCredential: ports.save,
  }),
);

const key = 'SYNTHETIC_GEMINI_KEY_NOT_FOR_NETWORK';
const context = {
  actor: { id: 'platform-admin', type: 'user' },
  organizationId: 'platform-org',
  workspaceId: 'platform-ws',
};
const credential = {
  configured: true,
  writable: true,
  updatedAt: '2026-09-07T12:00:00.000Z',
};
function request(
  body: unknown = { apiKey: key },
  headers: Record<string, string> = {},
) {
  return new Request(
    'https://allrice-dsh.bplabs.xyz/api/v1/admin/providers/gemini/credential',
    {
      method: 'PUT',
      headers: {
        host: 'allrice-dsh.bplabs.xyz',
        origin: 'https://allrice-dsh.bplabs.xyz',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ALLRICE_PORTAL_AUTH_ENABLED', '1');
  ports.context.mockResolvedValue(context);
  ports.platformAdmin.mockResolvedValue(true);
  ports.read.mockResolvedValue(credential);
  ports.save.mockResolvedValue(credential);
  ports.audit.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('Gemini credential administration HTTP boundary', () => {
  it('GET returns status only and is never cached', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ credential });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(ports.save).not.toHaveBeenCalled();
  });
  it.each([GET, PUT])('requires authentication (%#)', async (handler) => {
    ports.context.mockRejectedValue(
      new DataAccessError('authentication_required'),
    );
    expect((await handler(request())).status).toBe(401);
    expect(ports.read).not.toHaveBeenCalled();
    expect(ports.save).not.toHaveBeenCalled();
  });
  it.each([GET, PUT])(
    'rejects tenant admins even if membership helper accepted them (%#)',
    async (handler) => {
      ports.platformAdmin.mockResolvedValue(false);
      expect((await handler(request())).status).toBe(403);
      expect(ports.read).not.toHaveBeenCalled();
      expect(ports.save).not.toHaveBeenCalled();
    },
  );
  it('rejects tenant portal requests even for a platform user', async () => {
    expect(
      (
        await PUT(
          request(undefined, {
            host: 'allrice-snow.bplabs.xyz',
            origin: 'https://allrice-snow.bplabs.xyz',
          }),
        )
      ).status,
    ).toBe(403);
    expect(ports.save).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'null',
    'https://attacker.example',
    'http://allrice-dsh.bplabs.xyz',
    'https://allrice-dsh.bplabs.xyz.attacker.example',
    'https://allrice-dsh.bplabs.xyz/path',
  ])('rejects absent/cross-origin writes (%#)', async (origin) => {
    expect((await PUT(request(undefined, { origin }))).status).toBe(403);
    expect(ports.audit).not.toHaveBeenCalled();
    expect(ports.save).not.toHaveBeenCalled();
  });
  it('rejects form bodies', async () => {
    expect(
      (await PUT(request(undefined, { 'content-type': 'text/plain' }))).status,
    ).toBe(415);
    expect(ports.save).not.toHaveBeenCalled();
  });
  it.each([
    { apiKey: '' },
    { apiKey: 'x'.repeat(5000) },
    { apiKey: `${key}\n` },
    { apiKey: key, reference: 'tenant:other' },
    { apiKey: key, enabled: true },
    [],
  ])(
    'rejects invalid/oversize/extra fields before storage or audit (%#)',
    async (body) => {
      const response = await PUT(request(body));
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(key);
      expect(ports.save).not.toHaveBeenCalled();
      expect(ports.audit).not.toHaveBeenCalled();
    },
  );
  it('saves to the fixed server-side reference and audits intent before save and outcome afterward', async () => {
    const response = await PUT(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ credential, auditRecorded: true });
    expect(ports.save).toHaveBeenCalledWith(key, context.actor.id);
    expect(ports.audit.mock.calls.map((args) => args[2])).toEqual([
      'requested',
      'saved',
    ]);
    expect(ports.audit.mock.invocationCallOrder[0]).toBeLessThan(
      ports.save.mock.invocationCallOrder[0]!,
    );
    expect(ports.save.mock.invocationCallOrder[0]).toBeLessThan(
      ports.audit.mock.invocationCallOrder[1]!,
    );
    expect(JSON.stringify(ports.audit.mock.calls)).not.toContain(key);
  });
  it('does not change credentials when durable audit intent fails; never logs exceptions', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.audit.mockRejectedValue(new Error(key));
    const response = await PUT(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(key);
    expect(ports.save).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('reports already-saved credentials truthfully if completion audit fails', async () => {
    ports.audit
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error(key));
    expect(await (await PUT(request())).json()).toEqual({
      credential,
      auditRecorded: false,
    });
  });
  it('audits failed storage attempts without the key and preserves typed errors', async () => {
    ports.save.mockRejectedValue(new GeminiCredentialError('busy'));
    expect((await PUT(request())).status).toBe(409);
    expect(ports.audit.mock.calls.map((args) => args[2])).toEqual([
      'requested',
      'failed',
    ]);
    expect(JSON.stringify(ports.audit.mock.calls)).not.toContain(key);
  });
  it('does not serialize or log raw read failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    ports.read.mockRejectedValue(new Error(key));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(key);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
