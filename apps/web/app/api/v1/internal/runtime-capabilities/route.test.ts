import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({ inventory: vi.fn(), skills: vi.fn() }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readRuntimeCapabilityInventory: mocks.inventory,
  listPlatformNativeSkills: mocks.skills,
}));
import { GET } from './route';
const token = 'synthetic-readonly-token-at-least-32-bytes';
const request = (authorization = '') =>
  new Request('http://localhost/api/v1/internal/runtime-capabilities', {
    headers: { authorization },
  });
describe('Lab read-only capability sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ALLRICE_CAPABILITY_SYNC_TOKEN', token);
    mocks.inventory.mockResolvedValue({
      checkedAt: new Date().toISOString(),
      workers: [],
      publications: [
        {
          employeeName: 'private-employee',
          workspaceId: 'private-id',
          workspaceName: 'private-workspace',
          version: 7,
          skillIds: ['skill'],
          toolNames: [],
          policyEnabled: false,
          policyMode: null,
        },
      ],
    });
    mocks.skills.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('requires its own scoped token even with a session or unconfigured secret', async () => {
    for (const auth of ['', 'Bearer wrong', `Bearer ${token}x`])
      expect((await GET(request(auth))).status).toBe(401);
    vi.stubEnv('ALLRICE_CAPABILITY_SYNC_TOKEN', '');
    expect((await GET(request('Bearer '))).status).toBe(401);
    expect(mocks.inventory).not.toHaveBeenCalled();
  });
  it('returns only aggregates and shared projections, never tenant manifests or identities', async () => {
    const response = await GET(request(`Bearer ${token}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      schemaVersion: 1,
      onlineWorkers: 0,
      componentCount: '—',
      publications: 1,
      publishedSkills: 1,
    });
    expect(body.capabilities).toContainEqual({
      id: 'assistants',
      status: '运行状态未知',
    });
    expect(JSON.stringify(body)).not.toContain('private-');
    expect(JSON.stringify(body)).not.toContain(token);
  });
  it('never converts failed reads into successful empty inventory', async () => {
    mocks.inventory.mockRejectedValue(
      new Error('private-database-credentials'),
    );
    const response = await GET(request(`Bearer ${token}`));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
  });
});
