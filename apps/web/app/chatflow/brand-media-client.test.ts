import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrandMediaClient } from './brand-media/frontend-wiring';

const id = (n: number) =>
  `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
  instanceId: id(4),
  headers: { 'x-allrice-workspace-id': id(2) },
};
const pin = {
  origin: 'reference' as const,
  sourceId: id(5),
  revisionId: id(6),
};
const checksum = 'sha256:' + 'a'.repeat(64);
const receipt = () => ({
  viewerId: scope.ownerId,
  workspaceId: scope.workspaceId,
  selection: {
    sourceId: pin.sourceId,
    revisionId: pin.revisionId,
    revision: 3,
    fileName: '已固定的品牌资料.pdf',
    purpose: '',
    digest: checksum,
    checksum,
    ownership: { scope: 'company', organizationId: scope.organizationId },
  },
});

afterEach(() => vi.unstubAllGlobals());

describe('brand-media reference display metadata', () => {
  it('reads the exact frozen revision with the current scope and abort signal, without writing or choosing latest', async () => {
    const fetch = vi.fn(async () => Response.json(receipt()));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    expect(
      await createBrandMediaClient(scope).referenceLabel(pin, signal),
    ).toBe('已固定的品牌资料.pdf');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/references/revisions/${pin.revisionId}/selection?workspaceId=${scope.workspaceId}`,
      {
        headers: { 'Content-Type': 'application/json', ...scope.headers },
        cache: 'no-store',
        signal,
      },
    );
    expect(pin).toEqual({
      origin: 'reference',
      sourceId: id(5),
      revisionId: id(6),
    });
  });

  it.each(['viewer', 'workspace', 'source', 'revision'] as const)(
    'refuses a filename from a mismatched %s receipt',
    async (field) => {
      const wrong = receipt();
      if (field === 'viewer') wrong.viewerId = id(99);
      if (field === 'workspace') wrong.workspaceId = id(99);
      if (field === 'source') wrong.selection.sourceId = id(99);
      if (field === 'revision') wrong.selection.revisionId = id(99);
      const fetch = vi.fn(async () => Response.json(wrong));
      vi.stubGlobal('fetch', fetch);
      await expect(
        createBrandMediaClient(scope).referenceLabel(pin),
      ).rejects.toThrow('资料版本或当前权限已变化');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an authorization failure instead of searching for a substitute revision', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ message: '无权读取资料' }, { status: 403 }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      createBrandMediaClient(scope).referenceLabel(pin),
    ).rejects.toThrow('无权读取资料');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
