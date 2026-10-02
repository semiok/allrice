import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CompanyAsset,
  CompanyAssetContent,
  RequestContext,
  StorageObject,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  authenticateSession,
  createSession,
} from './identity.ts';
import { getStoredFile } from './data.ts';
import { readArtifactBytes } from './artifact-review.ts';
import {
  getCompanyAssetFile,
  listCompanyAssets,
  listCompanyAssetRevisions,
  listCompanyRuleSources,
  mutateCompanyAsset,
} from './company-assets.ts';
import {
  createTraceableMemory,
  correctWorkspaceMemory,
} from './workspace/service.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'explicit company publications (isolated PostgreSQL and real storage)',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      a: Awaited<ReturnType<typeof tenantValidationFixture>>,
      foreign: typeof a;
    let owner: RequestContext, member: RequestContext, admin: RequestContext;
    const id = randomUUID();
    let saved: CompanyAsset;
    const content = (
      kind: 'rule' | 'template',
      extra: Partial<CompanyAssetContent> = {},
    ): CompanyAssetContent => ({
      kind,
      title: 'Published company reference',
      body: 'Use only current business data; list missing inputs.',
      category: '运营',
      appliesToEmployeeIds: [],
      taskKeywords: [],
      slots: [],
      ...extra,
    });
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'allrice-platform',
          organizationName: 'Platform',
          workspaceSlug: 'default',
          workspaceName: 'Default',
          email: 'company-assets-admin@example.test',
          displayName: 'Admin',
          role: 'member',
        },
        f.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      admin = (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
      a = await tenantValidationFixture(f.db);
      foreign = await tenantValidationFixture(f.db);
      owner = {
        ...(await authenticateSession(
          (await createSession(a.context.actor.id)).token,
        ))!,
        workspaceId: a.context.workspaceId,
      };
      const [org] = await f.db<
        { slug: string; name: string }[]
      >`select slug,name from allrice_organizations where id=${a.context.organizationId}`;
      const second = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: org!.slug,
          organizationName: org!.name,
          workspaceSlug: 'second-member',
          workspaceName: 'Second member',
          email: 'company-assets-reader@example.test',
          displayName: 'Second member',
          role: 'member',
        },
        f.db,
      );
      member = {
        ...(await authenticateSession(
          (await createSession(second.user.id)).token,
        ))!,
        workspaceId: second.workspaceId,
      };
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    });
    const mutate = (
      ctx: RequestContext,
      value: unknown,
      administration = false,
    ) =>
      mutateCompanyAsset(
        ctx,
        a.context.organizationId,
        value,
        assistantFixtureStorage(f.db),
        administration,
        f.db,
      );
    it('copies only the explicitly chosen private version and publishes once for another ordinary workspace', async () => {
      const draft = {
        operation: 'save',
        assetId: id,
        expectedRevision: 0,
        content: content('template', {
          sourceVersionId: a.artifact.artifactId,
          slots: [
            {
              key: 'period',
              label: '本期业务数据',
              required: true,
              multiline: true,
            },
          ],
        }),
      };
      saved = await mutate(owner, draft);
      expect(saved.state).toBe('draft');
      const [originalObject] = await f.db<
        { object_id: string }[]
      >`select object_id from allrice_deliverable_versions where id=${a.artifact.artifactId}`;
      expect(saved.latest.file!.objectId).not.toBe(originalObject!.object_id);
      const repeated = await mutate(owner, draft);
      expect(repeated.latest.id).toBe(saved.latest.id);
      expect(
        (await listCompanyAssets(member, a.context.organizationId, {}, f.db))
          .assets,
      ).toEqual([]);
      await expect(
        getCompanyAssetFile(
          owner,
          a.context.organizationId,
          id,
          saved.latest.id,
          false,
          f.db,
        ),
      ).rejects.toThrow('asset_unavailable');
      await expect(
        getStoredFile(owner, saved.latest.file!.objectId, f.db),
      ).rejects.toThrow('not_found');
      saved = await mutate(owner, {
        operation: 'publish',
        assetId: id,
        expectedRevision: saved.revision,
      });
      expect(
        (
          await mutate(owner, {
            operation: 'publish',
            assetId: id,
            expectedRevision: saved.revision - 1,
          })
        ).revision,
      ).toBe(saved.revision);
      const shared = await getCompanyAssetFile(
        member,
        a.context.organizationId,
        id,
        saved.latest.id,
        false,
        f.db,
      );
      expect(shared.object.ownerId).toBe(owner.actor.id);
      const original = await getStoredFile(
        owner,
        (
          await f.db<
            { object_id: string }[]
          >`select object_id from allrice_deliverable_versions where id=${a.artifact.artifactId}`
        )[0]!.object_id,
        f.db,
      );
      expect(
        await readArtifactBytes(assistantFixtureStorage(f.db), shared.object),
      ).toEqual(
        await readArtifactBytes(assistantFixtureStorage(f.db), original.object),
      );
      expect(shared.object.retentionUntil).toBeNull();
      expect(shared.object.immutable).toBe(true);
      await expect(
        getCompanyAssetFile(
          foreign.context,
          a.context.organizationId,
          id,
          saved.latest.id,
          false,
          f.db,
        ),
      ).rejects.toThrow('not_found');
      const publicJson = JSON.stringify(
        await listCompanyAssets(member, a.context.organizationId, {}, f.db),
      );
      expect(publicJson).not.toContain('PRIVATE_TEST_SECRET');
      expect(publicJson).not.toContain(a.task.chatSessionId!);
    });
    it('keeps the published revision while editing, protects CAS and preserves every immutable revision', async () => {
      const first = saved.latest;
      const edit = {
        operation: 'save',
        assetId: id,
        expectedRevision: saved.revision,
        content: {
          ...first.content,
          body: 'Use updated, independently verified current data.',
        },
      };
      saved = await mutate(owner, edit);
      const [counts] = await f.db<
        { revisions: number; audits: number }[]
      >`select (select count(*)::int from allrice_company_asset_revisions where asset_id=${id}) revisions,(select count(*)::int from allrice_audit_events where resource_id=${id} and action='company.asset.saved') audits`;
      expect((await mutate(owner, edit)).latest.id).toBe(saved.latest.id);
      expect(
        (
          await f.db`select (select count(*)::int from allrice_company_asset_revisions where asset_id=${id}) revisions,(select count(*)::int from allrice_audit_events where resource_id=${id} and action='company.asset.saved') audits`
        )[0],
      ).toEqual(counts);
      await expect(
        mutate(owner, {
          ...edit,
          content: { ...edit.content, body: 'A genuinely different edit' },
        }),
      ).rejects.toThrow('version_conflict');
      await expect(mutate(admin, edit, true)).rejects.toThrow(
        'version_conflict',
      );
      const visible = (
        await listCompanyAssets(member, a.context.organizationId, {}, f.db)
      ).assets[0]!;
      expect(visible.latest.id).toBe(first.id);
      expect(visible.latest.content.body).toBe(first.content.body);
      expect(saved.latest.file!.objectId).toBe(first.file!.objectId);
      await expect(
        mutate(owner, { operation: 'pause', assetId: id, expectedRevision: 1 }),
      ).rejects.toThrow('version_conflict');
      await expect(
        f.db`update allrice_company_asset_revisions set content='{}' where id=${first.id}`,
      ).rejects.toThrow('immutable');
      saved = await mutate(owner, {
        operation: 'publish',
        assetId: id,
        expectedRevision: saved.revision,
      });
      expect(
        (
          await getCompanyAssetFile(
            member,
            a.context.organizationId,
            id,
            first.id,
            false,
            f.db,
          )
        ).digest,
      ).toBe(first.digest);
      const history = await listCompanyAssetRevisions(
        owner,
        a.context.organizationId,
        id,
        false,
        f.db,
      );
      expect(history.revisions).toHaveLength(2);
      expect(history.publishedRevisionIds).toHaveLength(2);
    });
    it('pins an explicitly selected Memory revision while preserving the separately authored rule body', async () => {
      const memory = await createTraceableMemory(owner, {
        workspaceId: owner.workspaceId,
        content: 'Selected original memory excerpt',
        sourceType: 'user',
      });
      const chosen = (
        await listCompanyRuleSources(admin, a.context.organizationId, f.db)
      ).sources.find((s) => s.id === memory.id)!;
      expect(chosen.revision).toBe(1);
      await correctWorkspaceMemory(owner, owner.workspaceId!, memory.id, {
        content: 'Current memory changed after selection',
        confidence: 1,
        reason: 'Correction for revision provenance',
        expiresAt: null,
      });
      const current = (
        await listCompanyRuleSources(admin, a.context.organizationId, f.db)
      ).sources.find((s) => s.id === memory.id)!;
      expect(current.revision).toBe(2);
      expect(current.revisionId).not.toBe(chosen.revisionId);
      const authored = content('rule', {
        body: 'Edited final company rule; not claimed to be the original memory bytes.',
        sourceMemoryId: memory.id,
        sourceMemoryRevisionId: chosen.revisionId,
      });
      let rule = await mutate(
        admin,
        {
          operation: 'save',
          assetId: randomUUID(),
          expectedRevision: 0,
          content: authored,
        },
        true,
      );
      rule = await mutate(
        admin,
        {
          operation: 'publish',
          assetId: rule.id,
          expectedRevision: rule.revision,
        },
        true,
      );
      expect(rule.latest.content).toEqual(authored);
      const [provenance] = await f.db<
        { source_memory_revision_id: string; content: string }[]
      >`select c.source_memory_revision_id,m.content from allrice_company_asset_revisions c join allrice_memory_revisions m on m.id=c.source_memory_revision_id where c.id=${rule.latest.id}`;
      expect(provenance).toEqual({
        source_memory_revision_id: chosen.revisionId,
        content: chosen.content,
      });
      const otherMemory = await createTraceableMemory(member, {
        workspaceId: member.workspaceId,
        content: 'Unrelated private memory',
        sourceType: 'user',
      });
      const other = (
        await listCompanyRuleSources(admin, a.context.organizationId, f.db)
      ).sources.find((s) => s.id === otherMemory.id)!;
      await expect(
        mutate(
          admin,
          {
            operation: 'save',
            assetId: randomUUID(),
            expectedRevision: 0,
            content: { ...authored, sourceMemoryRevisionId: other.revisionId },
          },
          true,
        ),
      ).rejects.toThrow('source_changed');
      await expect(
        mutate(
          admin,
          {
            operation: 'save',
            assetId: randomUUID(),
            expectedRevision: 0,
            content: { ...authored, sourceMemoryId: randomUUID() },
          },
          true,
        ),
      ).rejects.toThrow('source_changed');
      await mutate(
        admin,
        {
          operation: 'pause',
          assetId: rule.id,
          expectedRevision: rule.revision,
        },
        true,
      );
    });
    it('withdrawal, live membership and company status gate new bytes including the author', async () => {
      saved = await mutate(owner, {
        operation: 'pause',
        assetId: id,
        expectedRevision: saved.revision,
      });
      for (const reader of [owner, member, admin])
        await expect(
          getCompanyAssetFile(
            reader,
            a.context.organizationId,
            id,
            saved.latest.id,
            reader === admin,
            f.db,
          ),
        ).rejects.toThrow('asset_unavailable');
      saved = await mutate(owner, {
        operation: 'resume',
        assetId: id,
        expectedRevision: saved.revision,
      });
      await f.db`update allrice_memberships set active=false where user_id=${member.actor.id}`;
      await expect(
        getCompanyAssetFile(
          member,
          a.context.organizationId,
          id,
          saved.latest.id,
          false,
          f.db,
        ),
      ).rejects.toThrow('authorization_denied');
      await f.db`update allrice_memberships set active=true where user_id=${member.actor.id}`;
      await f.db`update allrice_users set status='disabled' where id=${owner.actor.id}`;
      await f.db`update allrice_workspaces set archived_at=clock_timestamp() where id=${owner.workspaceId!}`;
      const retained = await getCompanyAssetFile(
        member,
        a.context.organizationId,
        id,
        saved.latest.id,
        false,
        f.db,
      );
      expect(
        (
          await readArtifactBytes(
            assistantFixtureStorage(f.db),
            retained.object,
          )
        ).length,
      ).toBeGreaterThan(0);
      saved = await mutate(
        admin,
        {
          operation: 'withdraw',
          assetId: id,
          expectedRevision: saved.revision,
        },
        true,
      );
      await expect(
        getCompanyAssetFile(
          member,
          a.context.organizationId,
          id,
          saved.latest.id,
          false,
          f.db,
        ),
      ).rejects.toThrow('asset_unavailable');
      await f.db`update allrice_users set status='active' where id=${owner.actor.id}`;
      await f.db`update allrice_workspaces set archived_at=null where id=${owner.workspaceId!}`;
      await expect(
        getStoredFile(owner, saved.latest.file!.objectId, f.db),
      ).rejects.toThrow('not_found');
    });
    it('allows only administrators to publish rules and rejects budget overflow without replacing the valid revision', async () => {
      await expect(
        mutate(owner, {
          operation: 'save',
          assetId: randomUUID(),
          expectedRevision: 0,
          content: content('rule'),
        }),
      ).rejects.toThrow('authorization_denied');
      let final: CompanyAsset | undefined;
      for (let index = 0; index < 5; index++) {
        const draft = await mutate(
          admin,
          {
            operation: 'save',
            assetId: randomUUID(),
            expectedRevision: 0,
            content: content('rule', { body: 'r'.repeat(4000) }),
          },
          true,
        );
        const publishing = mutate(
          admin,
          {
            operation: 'publish',
            assetId: draft.id,
            expectedRevision: draft.revision,
          },
          true,
        );
        if (index < 4) final = await publishing;
        else await expect(publishing).rejects.toThrow('rule_budget_exceeded');
      }
      expect(
        (await listCompanyAssets(member, a.context.organizationId, {}, f.db))
          .ruleBudget.publishedBytes,
      ).toBe(16000);
      expect(final?.state).toBe('published');
      await expect(
        mutate(member, {
          operation: 'pause',
          assetId: final!.id,
          expectedRevision: final!.revision,
        }),
      ).rejects.toThrow('authorization_denied');
    });
    it('rolls back failed snapshot copies and removes only the uncommitted object', async () => {
      let allocated: StorageObject | undefined;
      const storage = assistantFixtureStorage(f.db),
        assetId = randomUUID();
      const failing = {
        ...storage,
        put: async (
          object: StorageObject,
          stream: ReadableStream<Uint8Array>,
        ) => {
          allocated = object;
          await storage.put(object, stream);
          throw Error('simulated copy failure');
        },
        get: storage.get.bind(storage),
        delete: storage.delete.bind(storage),
        exists: storage.exists.bind(storage),
      };
      await expect(
        mutateCompanyAsset(
          owner,
          a.context.organizationId,
          {
            operation: 'save',
            assetId,
            expectedRevision: 0,
            content: content('template', {
              sourceVersionId: a.artifact.artifactId,
            }),
          },
          failing,
          false,
          f.db,
        ),
      ).rejects.toThrow('simulated copy failure');
      expect(
        await f.db`select id from allrice_company_assets where id=${assetId}`,
      ).toHaveLength(0);
      expect(
        await f.db`select id from allrice_storage_objects where id=${allocated!.id}`,
      ).toHaveLength(0);
      expect(await storage.exists(allocated!)).toBe(false);
    });
  },
);
