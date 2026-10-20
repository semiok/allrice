import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import type { Tx } from './types.ts';

const mocks = vi.hoisted(() => ({
  stored: vi.fn(),
  principal: vi.fn(),
  instance: vi.fn(),
  session: vi.fn(),
  artifact: vi.fn(),
}));
vi.mock('../data.ts', () => ({ getStoredFile: mocks.stored }));
vi.mock('../content-maintenance.ts', () => ({
  readContentPrincipal: mocks.principal,
}));
vi.mock('../employees/employee-instances.ts', () => ({
  getEmployeeInstance: mocks.instance,
}));
vi.mock('../artifact-review.ts', () => ({
  assertWorkbenchSession: mocks.session,
  readArtifact: mocks.artifact,
}));
import {
  assertBrandContentFile,
  assertBrandContentImages,
  requireBrandContentScope,
} from './authority.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checksum = 'sha256:' + 'a'.repeat(64);
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
const file = { objectId: id(7), checksum };
function transaction(
  options: {
    object?: boolean;
    version?: boolean;
    sessionMatches?: boolean;
    operationReceipt?: unknown;
  } = {},
) {
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('from allrice_storage_objects'))
      return options.object === false ? [] : [{ id: file.objectId }];
    if (sql.includes('from allrice_deliverable_versions'))
      return options.version
        ? [{ id: id(8), session_id: id(9), platform_test_run_id: null }]
        : [];
    if (sql.includes('from allrice_chat_sessions'))
      return options.sessionMatches === false ? [] : [{ id: id(9) }];
    if (sql.includes('from allrice_image_operations'))
      return [{ session_id: id(9), result: options.operationReceipt }];
    if (sql.includes('from allrice_employee_assignments'))
      return [{ id: id(10) }];
    throw Error('unexpected read in authority test');
  });
  return { tx: query as unknown as Tx, query };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.stored.mockResolvedValue({
    object: {
      id: file.objectId,
      checksum,
      ownerId: scope.ownerId,
      workspaceId: scope.workspaceId,
      mediaType: 'image/png',
      immutable: true,
    },
    category: 'uploads',
  });
  mocks.principal.mockResolvedValue({ writable: true });
  mocks.instance.mockResolvedValue({ assignmentId: id(10) });
  mocks.session.mockResolvedValue(undefined);
  mocks.artifact.mockResolvedValue({
    object: { id: file.objectId, checksum, immutable: true },
    provenance: { kind: 'model_proposal' },
  });
});
describe('private instance source admission', () => {
  it('requires a real browser login only for the default user entry', async () => {
    const { tx } = transaction();
    const internal = { ...context, sessionId: undefined };
    await expect(
      requireBrandContentScope(tx, internal, scope, true),
    ).rejects.toThrow('authority_denied');
    expect(mocks.principal).not.toHaveBeenCalled();
    await expect(
      requireBrandContentScope(tx, internal, scope, true, 'scheduler'),
    ).resolves.toMatchObject(scope);
    expect(mocks.principal).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: undefined }),
      tx,
      true,
    );
  });
  it('rejects a foreign owner before any file reader returns metadata', async () => {
    const { tx } = transaction({ object: false });
    await expect(
      assertBrandContentFile(tx, context, scope, file),
    ).rejects.toThrow('source_unavailable');
    expect(mocks.stored).not.toHaveBeenCalled();
  });
  it('does not trust a cached checksum', async () => {
    const { tx } = transaction();
    mocks.stored.mockResolvedValueOnce({
      object: {
        id: file.objectId,
        checksum: 'sha256:' + 'b'.repeat(64),
        ownerId: scope.ownerId,
        workspaceId: scope.workspaceId,
      },
      category: 'uploads',
    });
    await expect(
      assertBrandContentFile(tx, context, scope, file),
    ).rejects.toThrow('source_changed');
  });
  it('rejects same-owner artifacts from another employee instance', async () => {
    const { tx } = transaction({ version: true, sessionMatches: false });
    await expect(
      assertBrandContentFile(tx, context, scope, { ...file, versionId: id(8) }),
    ).rejects.toThrow('source_unavailable');
    expect(mocks.artifact).not.toHaveBeenCalled();
  });
  it('requires a real version and permits an owner upload without pretending it is generated', async () => {
    const { tx } = transaction();
    await expect(
      assertBrandContentFile(tx, context, scope, { ...file, versionId: id(8) }),
    ).rejects.toThrow('source_unavailable');
    await expect(
      assertBrandContentImages(tx, context, scope, [
        { slotKey: 'cover', file, sourceKind: 'uploaded', caption: '' },
      ]),
    ).resolves.toBeUndefined();
  });
  it('binds generated image provenance to actual successful operation output', async () => {
    const { tx } = transaction({
      operationReceipt: {
        modelContent: JSON.stringify({ objectId: id(30), checksum }),
      },
    });
    await expect(
      assertBrandContentImages(tx, context, scope, [
        {
          slotKey: 'cover',
          file,
          sourceKind: 'generated',
          operationId: id(11),
          caption: '',
        },
      ]),
    ).rejects.toThrow('source_changed');
    const good = transaction({
      operationReceipt: {
        modelContent: JSON.stringify({ objectId: file.objectId, checksum }),
      },
    });
    await expect(
      assertBrandContentImages(good.tx, context, scope, [
        {
          slotKey: 'cover',
          file,
          sourceKind: 'generated',
          operationId: id(11),
          caption: '',
        },
      ]),
    ).resolves.toBeUndefined();
  });
  it('keeps browser auth for users and rechecks live authority for admitted jobs', async () => {
    const { tx } = transaction();
    for (const authority of ['user', 'workflow', 'scheduler'] as const) {
      await requireBrandContentScope(tx, context, scope, true, authority);
      const passed = mocks.principal.mock.calls.at(-1)![0];
      expect(passed.sessionId).toBe(
        authority === 'user' ? context.sessionId : undefined,
      );
      expect(passed.actor.id).toBe(scope.ownerId);
    }
    expect(mocks.principal).toHaveBeenCalledTimes(3);
    mocks.principal.mockResolvedValueOnce(null);
    await expect(
      requireBrandContentScope(tx, context, scope, true, 'workflow'),
    ).rejects.toThrow('authority_denied');
  });
  it('rejects another current workspace before querying it', async () => {
    const { tx, query } = transaction();
    await expect(
      requireBrandContentScope(
        tx,
        context,
        { ...scope, workspaceId: id(40) },
        true,
      ),
    ).rejects.toThrow('authority_denied');
    expect(query).not.toHaveBeenCalled();
  });
});
