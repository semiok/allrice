import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { repairFixture } from '../../test/platform-repair-fixture';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  mutation: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  createPlatformRepairTask: mocks.mutation,
  cancelPlatformRepairTask: mocks.mutation,
  createPlatformRepositoryAction: mocks.mutation,
  cancelPlatformRepositoryAction: mocks.mutation,
  createPlatformRepositoryReview: mocks.mutation,
  cancelPlatformRepositoryReview: mocks.mutation,
  createPlatformRepositoryMerge: mocks.mutation,
  cancelPlatformRepositoryMerge: mocks.mutation,
  listPlatformRepairTasks: mocks.list,
}));
import {
  GET as repairs,
  POST as repair,
} from '../../app/api/v1/admin/technical-assistant/repair/route';
import { DELETE as cancelRepair } from '../../app/api/v1/admin/technical-assistant/repair/[id]/route';
import { POST as publish } from '../../app/api/v1/admin/technical-assistant/repository-publications/route';
import { DELETE as cancelPublish } from '../../app/api/v1/admin/technical-assistant/repository-publications/[id]/route';
import { POST as review } from '../../app/api/v1/admin/technical-assistant/repository-reviews/route';
import { DELETE as cancelReview } from '../../app/api/v1/admin/technical-assistant/repository-reviews/[id]/route';
import { POST as merge } from '../../app/api/v1/admin/technical-assistant/repository-merges/route';
import { DELETE as cancelMerge } from '../../app/api/v1/admin/technical-assistant/repository-merges/[id]/route';

describe('production diagnosis/report-only boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({
      actor: { type: 'user', id: crypto.randomUUID() },
    });
  });
  it('refuses every source/repository mutation even for an authenticated platform admin', async () => {
    const origin = 'https://admin.allrice.test';
    const context = { params: Promise.resolve({ id: crypto.randomUUID() }) };
    for (const [name, create, cancel] of [
      ['repair', repair, cancelRepair],
      ['repository-publications', publish, cancelPublish],
      ['repository-reviews', review, cancelReview],
      ['repository-merges', merge, cancelMerge],
    ] as const) {
      const url = origin + '/api/v1/admin/technical-assistant/' + name;
      for (const response of [
        await create(
          new Request(url, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: '{}',
          }),
        ),
        await cancel(
          new Request(
            url +
              '/' +
              crypto.randomUUID() +
              '?actionId=' +
              crypto.randomUUID(),
            { method: 'DELETE', headers: { origin } },
          ),
          context,
        ),
      ]) {
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: 'platform_autonomous_actions_deferred',
        });
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
    }
    expect(mocks.auth).toHaveBeenCalledTimes(8);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it('keeps historical repair results readable through the unchanged typed GET', async () => {
    const task = repairFixture();
    mocks.list.mockResolvedValue([task]);
    const response = await repairs(
      new Request(
        'https://admin.allrice.test/api/v1/admin/technical-assistant/repair',
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([task]);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
