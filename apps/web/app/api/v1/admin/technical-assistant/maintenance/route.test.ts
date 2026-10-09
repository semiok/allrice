import { beforeEach, describe, it, expect, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  update: vi.fn(),
  credential: vi.fn(),
  authorize: vi.fn(),
  authority: vi.fn(),
  control: vi.fn(),
  botRead: vi.fn(),
  botWrite: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listMaintenanceDeployments: mocks.list,
  registerMaintenanceDeployment: mocks.register,
  updateMaintenanceDeployment: mocks.update,
  rotateMaintenanceCredential: mocks.credential,
  authorizeMaintenanceReport: mocks.authorize,
  getMaintenanceReportAuthority: mocks.authority,
  controlMaintenanceGrant: mocks.control,
  getMaintenanceGithubBot: mocks.botRead,
  updateMaintenanceGithubBot: mocks.botWrite,
}));
import { DataAccessError, MaintenanceConflict } from '@allrice/database';
import { GET, POST } from './route';
import { PUT } from './[id]/route';
import { PUT as credential } from './[id]/credential/route';
import {
  POST as authorize,
  GET as authority,
} from './reports/[id]/authority/route';
import { POST as control } from './grants/[id]/route';
import { GET as botRead, PUT as botWrite } from './github-bot/route';
describe('maintenance routes', () => {
  const origin = 'https://admin.allrice.test',
    url = origin + '/api/v1/admin/technical-assistant/maintenance',
    id = 'a675ff40-e4dd-487b-93c8-cf09f9af8832';
  const params = { params: Promise.resolve({ id }) };
  const request = (
    method = 'POST',
    body = '{}',
    headers: Record<string, string> = {
      origin,
      'content-type': 'application/json',
    },
  ) => new Request(url, { method, body, headers });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ actor: { type: 'user', id } });
    mocks.list.mockResolvedValue({ deployments: [] });
    mocks.register.mockResolvedValue({ created: true });
    mocks.update.mockResolvedValue({ saved: true });
    mocks.credential.mockResolvedValue({ rotated: true });
    mocks.authority.mockResolvedValue({ diagnoses: [], grants: [] });
    mocks.authorize.mockResolvedValue({ diagnoses: [], grants: [] });
    mocks.control.mockResolvedValue({ diagnoses: [], grants: [] });
    const bot = {
      repository: 'semiok/allrice',
      revision: 0,
      configured: false,
      state: 'not_configured',
      identity: null,
      verifiedAt: null,
      updatedAt: null,
      lastWriteRequestId: null,
    };
    mocks.botRead.mockResolvedValue(bot);
    mocks.botWrite.mockResolvedValue(bot);
  });
  it('enforces same origin and JSON media type before any writes', async () => {
    for (const action of [
      (r: Request) => POST(r),
      (r: Request) => PUT(r, params),
      (r: Request) => credential(r, params),
      (r: Request) => authorize(r, params),
      (r: Request) => control(r, params),
    ]) {
      expect(
        (
          await action(
            request('PUT', '{}', {
              origin: 'https://other.test',
              'content-type': 'application/json',
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await action(
            request('PUT', '{}', { origin, 'content-type': 'text/plain' }),
          )
        ).status,
      ).toBe(415);
    }
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });
  it('returns no-store readback and bounded request errors, without bypassing admin checks', async () => {
    const response = await GET(new Request(url));
    expect(await response.json()).toEqual({ deployments: [] });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await POST(request('POST', 'x'.repeat(2001)))).status).toBe(400);
    expect((await PUT(request('PUT', 'x'.repeat(4001)), params)).status).toBe(
      400,
    );
    expect(
      (await credential(request('PUT', 'x'.repeat(1001)), params)).status,
    ).toBe(400);
    expect((await POST(request('POST', '{'))).status).toBe(400);
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect((await POST(request())).status).toBe(403);
    expect((await GET(new Request(url))).status).toBe(403);
  });
  it('passes exact request and exposes concurrent conflicts without retrying writes', async () => {
    await PUT(request('PUT', '{"expectedRevision":2}'), params);
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), id, {
      expectedRevision: 2,
    });
    mocks.register.mockRejectedValue(new MaintenanceConflict());
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'maintenance_configuration_conflict',
    });
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
  it('fences report authorization, bot secrets and controls before dispatch; no merge or deploy control exists', async () => {
    const exact = {
      requestId: crypto.randomUUID(),
      reportId: id,
      expectedReportDigest: 'sha256:' + 'a'.repeat(64),
      expectedDiagnosisDigest: 'sha256:' + 'b'.repeat(64),
      expectedDeploymentRevision: 1,
    };
    expect(
      (
        await authorize(
          request(
            'POST',
            JSON.stringify({ ...exact, reportId: crypto.randomUUID() }),
          ),
          params,
        )
      ).status,
    ).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(
      (await authorize(request('POST', JSON.stringify(exact)), params)).status,
    ).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), exact);
    for (const action of ['merge', 'deploy', 'ready', 'publish'])
      expect(
        (await control(request('POST', JSON.stringify({ action })), params))
          .status,
      ).toBe(400);
    expect(mocks.control).not.toHaveBeenCalled();
    expect(
      (await control(request('POST', '{"action":"inspect"}'), params)).status,
    ).toBe(200);
    expect(mocks.control).toHaveBeenCalledWith(
      expect.anything(),
      id,
      'inspect',
    );
    expect((await botWrite(request('PUT', 'x'.repeat(2049)))).status).toBe(413);
    expect(
      (
        await botWrite(
          request('PUT', '{}', {
            origin: 'https://foreign.test',
            'content-type': 'application/json',
          }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.botWrite).not.toHaveBeenCalled();
    for (const read of [(r: Request) => authority(r, params), botRead]) {
      const r = await read(new Request(url));
      expect(r.headers.get('cache-control')).toBe('private, no-store');
    }
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    for (const run of [
      () => authority(new Request(url), params),
      () => botRead(new Request(url)),
      () => botWrite(request('PUT')),
      () => authorize(request('POST', JSON.stringify(exact)), params),
      () => control(request('POST', '{"action":"revoke"}'), params),
    ])
      expect((await run()).status).toBe(403);
    expect(mocks.botWrite).not.toHaveBeenCalled();
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
  });
});
