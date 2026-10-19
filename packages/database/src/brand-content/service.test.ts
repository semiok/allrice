import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BrandContentMutationReceipt,
  RequestContext,
} from '@allrice/contracts';
import type { BrandContentDatabase, Tx } from './types.ts';

const mock = vi.hoisted(() => ({
  requireScope: vi.fn(),
  readBrand: vi.fn(),
  readContext: vi.fn(),
  file: vi.fn(),
  images: vi.fn(),
  document: vi.fn(),
  session: vi.fn(),
  db: vi.fn(),
}));
vi.mock('../core/client.ts', () => ({ getDatabase: mock.db }));
vi.mock('./authority.ts', () => ({
  requireBrandContentScope: mock.requireScope,
  assertBrandContentFile: mock.file,
  assertBrandContentImages: mock.images,
  assertBrandContentDocument: mock.document,
  assertBrandContentSession: mock.session,
}));
vi.mock('./queries.ts', () => ({
  readBrand: mock.readBrand,
  readBrandContext: mock.readContext,
  scopedRow: vi.fn(),
  assertBrandBundle: vi.fn(),
}));
import {
  mutateBrandContent,
  mutateBrandContentInTransaction,
} from './service.ts';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  ownerId: id(3),
  instanceId: id(4),
};
const context = {
  organizationId: scope.organizationId,
  workspaceId: scope.workspaceId,
  actor: { type: 'user', id: scope.ownerId },
  sessionId: id(5),
  requestId: id(6),
  memberships: [],
  authenticatedAt: '2026-10-20T00:00:00Z',
} as RequestContext;
const action = {
  workspaceId: scope.workspaceId,
  instanceId: scope.instanceId,
  operation: 'context.save',
  requestId: 'stable-command-key',
  expectedRevision: 0,
  name: '独立演示品牌',
  content: {
    audience: '上班族',
    tone: '温和具体',
    requirements: '只用来源事实',
    facts: [{ id: 'size', text: 'A5' }],
  },
};
function memoryReceiptTransaction() {
  const receipts = new Map<
    string,
    { input_digest: string; response: BrandContentMutationReceipt }
  >();
  let inserts = 0;
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('pg_advisory_xact_lock')) return [];
    if (sql.includes('select input_digest,response'))
      return receipts.has(String(values[4]))
        ? [receipts.get(String(values[4]))]
        : [];
    if (sql.includes('insert into allrice_brand_content_requests')) {
      receipts.set(String(values[4]), {
        input_digest: String(values[5]),
        response: values[7] as BrandContentMutationReceipt,
      });
      return [];
    }
    if (
      sql.includes('insert into allrice_brand_content_brands') ||
      sql.includes('insert into allrice_brand_content_contexts')
    ) {
      inserts++;
      return [];
    }
    if (sql.includes('insert into allrice_audit_events')) return [];
    throw Error('unexpected statement in retry test');
  };
  const tx = Object.assign(query, { json: (x: unknown) => x }) as unknown as Tx;
  const db = {
    begin: async (work: (tx: Tx) => unknown) => work(tx),
  } as unknown as BrandContentDatabase;
  return { db, tx, writes: () => inserts };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.requireScope.mockResolvedValue(scope);
  mock.readBrand.mockResolvedValue({ id: id(11), revision: 1 });
  mock.readContext.mockResolvedValue({ id: id(12), content: {} });
  mock.db.mockImplementation(() => {
    throw Error('A database was not explicitly supplied in this unit test');
  });
});
describe('native business mutation receipts', () => {
  it('replays stable request input without another brand/context write', async () => {
    const store = memoryReceiptTransaction();
    const first = await mutateBrandContent(context, action, { db: store.db });
    const second = await mutateBrandContent(
      context,
      { ...action, content: { ...action.content } },
      { db: store.db },
    );
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ ...first, replayed: true });
    expect(store.writes()).toBe(2);
    expect(mock.readContext).toHaveBeenCalled();
  });
  it('rejects changed payload with the same key', async () => {
    const store = memoryReceiptTransaction();
    await mutateBrandContent(context, action, { db: store.db });
    await expect(
      mutateBrandContent(
        context,
        { ...action, name: '被改变的内容' },
        { db: store.db },
      ),
    ).rejects.toThrow('request_conflict');
    expect(store.writes()).toBe(2);
  });
  it('does not replay stale file access or stale authorization', async () => {
    const store = memoryReceiptTransaction();
    await mutateBrandContent(context, action, { db: store.db });
    mock.readContext.mockRejectedValueOnce(Error('source_unavailable'));
    await expect(
      mutateBrandContent(context, action, { db: store.db }),
    ).rejects.toThrow('source_unavailable');
    mock.requireScope.mockRejectedValueOnce(Error('authority_denied'));
    await expect(
      mutateBrandContent(context, action, { db: store.db }),
    ).rejects.toThrow('authority_denied');
  });
  it('checks create revision before any business write', async () => {
    const store = memoryReceiptTransaction();
    await expect(
      mutateBrandContent(
        context,
        { ...action, expectedRevision: 2 },
        { db: store.db },
      ),
    ).rejects.toThrow('version_conflict');
    expect(store.writes()).toBe(0);
  });
  it('rejects raw authority spoofing before DB access', async () => {
    await expect(
      mutateBrandContent(context, { ...action, authority: 'user' }),
    ).rejects.toThrow();
    expect(mock.db).not.toHaveBeenCalled();
  });
  it('a workflow cannot create a human approval even with an exact package pin', async () => {
    await expect(
      mutateBrandContent(
        context,
        {
          workspaceId: scope.workspaceId,
          instanceId: scope.instanceId,
          operation: 'article.review',
          requestId: 'forged-review',
          expectedRevision: 1,
          brandId: id(11),
          articleId: id(12),
          bundleDigest: 'sha256:' + 'a'.repeat(64),
          decision: 'approved',
          reason: 'model says yes',
          workflow: {
            workflowRevisionId: id(13),
            packageDigest: 'sha256:' + 'b'.repeat(64),
          },
        },
        { authority: 'workflow' },
      ),
    ).rejects.toThrow('authority_denied');
    expect(mock.db).not.toHaveBeenCalled();
    expect(mock.requireScope).not.toHaveBeenCalled();
  });
  it('requires a current Run fence for workflow writes before any database work', async () => {
    await expect(
      mutateBrandContent(
        context,
        {
          ...action,
          workflow: {
            workflowRevisionId: id(13),
            packageDigest: 'sha256:' + 'b'.repeat(64),
          },
        },
        { authority: 'workflow' },
      ),
    ).rejects.toThrow('authority_denied');
    expect(mock.db).not.toHaveBeenCalled();
  });
  it('awaits the trusted commit fence for both the first write and exact replay', async () => {
    const store = memoryReceiptTransaction();
    const fence = vi.fn(async () => undefined);
    await mutateBrandContent(context, action, {
      db: store.db,
      beforeCommit: fence,
    });
    expect(fence).toHaveBeenCalledTimes(1);
    const expired = vi.fn(async () => {
      throw Error('lease_lost');
    });
    await expect(
      mutateBrandContent(context, action, {
        db: store.db,
        beforeCommit: expired,
      }),
    ).rejects.toThrow('lease_lost');
    expect(expired).toHaveBeenCalledTimes(1);
    expect(store.writes()).toBe(2);
  });
  it('composes the same receipt logic in the supplied transaction without starting another database transaction', async () => {
    const store = memoryReceiptTransaction();
    const fence = vi.fn(async (tx: Tx) => {
      expect(tx).toBe(store.tx);
    });
    const first = await mutateBrandContentInTransaction(
      context,
      action,
      store.tx,
      {
        beforeCommit: fence,
      },
    );
    const replay = await mutateBrandContentInTransaction(
      context,
      action,
      store.tx,
      {
        beforeCommit: fence,
      },
    );
    expect(replay).toEqual({ ...first, replayed: true });
    expect(store.writes()).toBe(2);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(mock.requireScope).toHaveBeenCalledWith(
      store.tx,
      context,
      expect.anything(),
      true,
      'user',
    );
    expect(mock.db).not.toHaveBeenCalled();
  });
  it('rejects a raw transaction argument and still requires the workflow commit fence in a composed call', async () => {
    const store = memoryReceiptTransaction();
    await expect(
      mutateBrandContentInTransaction(
        context,
        { ...action, transaction: store.tx },
        store.tx,
      ),
    ).rejects.toThrow();
    await expect(
      mutateBrandContentInTransaction(
        context,
        {
          ...action,
          workflow: {
            workflowRevisionId: id(13),
            packageDigest: 'sha256:' + 'b'.repeat(64),
          },
        },
        store.tx,
        { authority: 'workflow' },
      ),
    ).rejects.toThrow('authority_denied');
    expect(store.writes()).toBe(0);
    expect(mock.requireScope).not.toHaveBeenCalled();
  });
});
