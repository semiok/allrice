import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError } from '@allrice/database';
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
  it('refuses new repair, review, publication and merge writes for platform administrators', async () => {
    const origin = 'https://admin.allrice.test',
      uuid = () => crypto.randomUUID();
    for (const [name, create, body] of [
      ['repair', repair, {}],
      ['repository-reviews', review, {}],
      [
        'repository-publications',
        publish,
        {
          action: 'publish',
          requestId: uuid(),
          repairTaskId: uuid(),
          credentialRevision: 1,
        },
      ],
      [
        'repository-merges',
        merge,
        {
          action: 'merge',
          requestId: uuid(),
          publicationId: uuid(),
          reviewSubjectId: uuid(),
          expectedSubjectDigest: 'sha256:' + 'a'.repeat(64),
          credentialRevision: 1,
        },
      ],
    ] as const) {
      const response = await create(
        new Request(origin + '/api/v1/admin/technical-assistant/' + name, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'platform_autonomous_actions_deferred',
      });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
  it('keeps cancellation and read-only result reconciliation available without enabling repair or merge', async () => {
    const origin = 'https://admin.allrice.test',
      uuid = () => crypto.randomUUID();
    mocks.mutation.mockRejectedValue(new DataAccessError('not_found'));
    for (const [name, cancel] of [
      ['repair', cancelRepair],
      ['repository-publications', cancelPublish],
      ['repository-reviews', cancelReview],
      ['repository-merges', cancelMerge],
    ] as const) {
      const response = await cancel(
        new Request(
          origin +
            '/api/v1/admin/technical-assistant/' +
            name +
            '/' +
            uuid() +
            '?actionId=' +
            uuid(),
          { method: 'DELETE', headers: { origin } },
        ),
        { params: Promise.resolve({ id: uuid() }) },
      );
      expect(response.status).toBe(404);
    }
    for (const [action, body] of [
      [
        publish,
        {
          action: 'inspect',
          requestId: uuid(),
          publicationId: uuid(),
          credentialRevision: 1,
        },
      ],
      [
        merge,
        {
          action: 'reconcile',
          requestId: uuid(),
          mergeId: uuid(),
          credentialRevision: 1,
        },
      ],
    ] as const) {
      const response = await action(
        new Request(origin + '/api/v1/admin/technical-assistant/repository', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(mocks.mutation).toHaveBeenCalledTimes(6);
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
