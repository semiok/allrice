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
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from './runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  authenticateSession,
  createSession,
} from './identity.ts';
import { getStoredFile } from './data.ts';
import { readArtifactBytes } from './artifact-review.ts';
import {
  listReferenceRevisions,
  getReferenceFile,
  changeReference,
  prepareReferenceUpload,
} from './reference-library.ts';
import { readReferenceSelection } from './reference-runtime.ts';
import { captureCompanyRunAssets } from './company-run-assets.ts';
import {
  finishReferenceProcessing,
  failReferenceProcessing,
} from './reference-processing.ts';
import {
  getCompanyAsset,
  getCompanyAssetFile,
  listCompanyAssets,
  listCompanyTemplateRecommendations,
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
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
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
      f = await createRuntimeFixtureDatabase();
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
      await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level) values(${a.context.organizationId},${a.context.actor.id},'Company publisher','company') on conflict(organization_id,user_id) do update set content_maintenance_level='company'`;
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
        runtimeFixtureStorage(f.db),
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
        await readArtifactBytes(runtimeFixtureStorage(f.db), shared.object),
      ).toEqual(
        await readArtifactBytes(runtimeFixtureStorage(f.db), original.object),
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
    it('recommends only applicable published revisions, ranks company pins and rechecks current bytes and authority', async () => {
      const employee = randomUUID(),
        other = randomUUID();
      await f.db`insert into allrice_platform_employees(id,employee_key,name,description,status)
        values(${employee},'company-reference-fixture','Company reference fixture','Isolated recommendation fixture','published'),
              (${other},'other-reference-fixture','Other reference fixture','Isolated recommendation fixture','published')`;
      const create = async (
        title: string,
        extra: Partial<CompanyAssetContent> = {},
      ) => {
        let item = await mutate(owner, {
          operation: 'save',
          assetId: randomUUID(),
          expectedRevision: 0,
          content: content('template', {
            title,
            sourceVersionId: a.artifact.artifactId,
            ...extra,
          }),
        });
        item = await mutate(owner, {
          operation: 'publish',
          assetId: item.id,
          expectedRevision: item.revision,
        });
        return item;
      };
      let pinned = await create('Pinned current reference');
      const fixed = pinned.latest;
      const matching = await create('Task-matching reference', {
        taskKeywords: ['quarter-report'],
      });
      const excluded = await create('Different AI reference', {
        appliesToEmployeeIds: [other],
      });
      const recommend = (ctx = owner) =>
        listCompanyTemplateRecommendations(
          ctx,
          owner.organizationId,
          employee,
          'quarter-report',
          f.db,
        );
      expect((await recommend()).assets[0]!.id).toBe(matching.id);
      const pin = {
        operation: 'pin',
        assetId: pinned.id,
        expectedRevision: pinned.revision,
      };
      pinned = await mutate(owner, pin);
      expect((await mutate(owner, pin)).revision).toBe(pinned.revision);
      await expect(
        mutate(member, { ...pin, expectedRevision: pinned.revision }),
      ).rejects.toThrow('authorization_denied');
      pinned = await mutate(owner, {
        operation: 'save',
        assetId: pinned.id,
        expectedRevision: pinned.revision,
        content: {
          ...pinned.latest.content,
          body: 'NEW PRIVATE DRAFT MUST NOT BE RECOMMENDED',
        },
      });
      const result = await recommend();
      expect(result.assets[0]).toMatchObject({
        id: pinned.id,
        pinned: true,
        latest: { id: fixed.id, digest: fixed.digest },
      });
      expect(JSON.stringify(result)).not.toContain('NEW PRIVATE DRAFT');
      expect(result.assets.some((x) => x.id === excluded.id)).toBe(false);
      expect((await recommend(member)).assets[0]!.latest.id).toBe(fixed.id);
      await expect(recommend(foreign.context)).rejects.toThrow('not_found');
      const [count] =
        await f.db`select count(*)::int as count from allrice_company_asset_revisions where asset_id=${pinned.id}`;
      expect(count!.count).toBe(2);
      pinned = await mutate(
        admin,
        {
          operation: 'unpin',
          assetId: pinned.id,
          expectedRevision: pinned.revision,
        },
        true,
      );
      expect((await recommend()).assets[0]!.id).toBe(matching.id);
      await f.db`update allrice_storage_objects set created_at=clock_timestamp()-interval '2 seconds',retention_until=clock_timestamp()-interval '1 second' where id=${fixed.file!.objectId}`;
      expect((await recommend()).assets.some((x) => x.id === pinned.id)).toBe(
        false,
      );
      pinned = await mutate(owner, {
        operation: 'withdraw',
        assetId: pinned.id,
        expectedRevision: pinned.revision,
      });
      await expect(
        mutate(owner, {
          operation: 'pin',
          assetId: pinned.id,
          expectedRevision: pinned.revision,
        }),
      ).rejects.toThrow('asset_unavailable');
      expect((await recommend()).assets.some((x) => x.id === pinned.id)).toBe(
        false,
      );
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
            runtimeFixtureStorage(f.db),
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
    it('company maintenance manages shared snapshots without reading or publishing another author draft, and downgrade closes direct mutations', async () => {
      const newId = randomUUID();
      let current = await mutate(owner, {
        operation: 'save',
        assetId: newId,
        expectedRevision: 0,
        content: content('template', {
          sourceVersionId: a.artifact.artifactId,
        }),
      });
      current = await mutate(owner, {
        operation: 'publish',
        assetId: newId,
        expectedRevision: current.revision,
      });
      const publishedId = current.latest.id;
      current = await mutate(owner, {
        operation: 'save',
        assetId: newId,
        expectedRevision: current.revision,
        content: content('template', {
          title: 'Private unpublished draft',
          sourceVersionId: a.artifact.artifactId,
        }),
      });
      const draftId = current.latest.id;
      await f.db`insert into allrice_organization_people(organization_id,user_id,display_name,content_maintenance_level)
        values(${a.context.organizationId},${member.actor.id},'Company maintainer','company')
        on conflict(organization_id,user_id) do update set content_maintenance_level='company'`;
      try {
        const history = await listCompanyAssetRevisions(
          member,
          a.context.organizationId,
          newId,
          false,
          f.db,
        );
        expect(history.asset).toMatchObject({
          canEdit: false,
          canPublish: false,
          canMaintainPublication: true,
          canArchive: false,
          latest: { id: publishedId },
        });
        expect(history.revisions.map((r) => r.id)).toEqual([publishedId]);
        expect(history.revisions.some((r) => r.id === draftId)).toBe(false);
        await expect(
          mutate(member, {
            operation: 'archive',
            assetId: newId,
            expectedRevision: current.revision,
          }),
        ).rejects.toThrow('private_draft_in_progress');
        await expect(
          mutate(member, {
            operation: 'publish',
            assetId: newId,
            expectedRevision: current.revision,
          }),
        ).rejects.toThrow('authorization_denied');
        await expect(
          mutate(member, {
            operation: 'save',
            assetId: newId,
            expectedRevision: current.revision,
            content: current.latest.content,
          }),
        ).rejects.toThrow('authorization_denied');
        await expect(
          listCompanyRuleSources(member, a.context.organizationId, f.db),
        ).rejects.toThrow('authorization_denied');
        const [original] =
          await f.db`select object_id from allrice_deliverable_versions where id=${a.artifact.artifactId}`;
        await expect(
          getStoredFile(member, String(original!.object_id), f.db),
        ).rejects.toThrow();
        const file = await getCompanyAssetFile(
          member,
          a.context.organizationId,
          newId,
          publishedId,
          false,
          f.db,
        );
        expect(
          (
            await readArtifactBytes(
              runtimeFixtureStorage(f.db),
              file.object,
              100000,
            )
          ).length,
        ).toBeGreaterThan(0);
        current = await mutate(member, {
          operation: 'pause',
          assetId: newId,
          expectedRevision: current.revision,
        });
        expect(
          (
            await listCompanyAssets(member, a.context.organizationId, {}, f.db)
          ).assets.find((v) => v.id === newId)?.state,
        ).toBe('paused');
        await expect(
          getCompanyAssetFile(
            member,
            a.context.organizationId,
            newId,
            publishedId,
            false,
            f.db,
          ),
        ).rejects.toThrow('asset_unavailable');
        current = await mutate(member, {
          operation: 'resume',
          assetId: newId,
          expectedRevision: current.revision,
        });
        expect(current.publishedRevisionId).toBe(publishedId);
        expect(current.latest.id).toBe(publishedId);
        const [stored] =
          await f.db`select latest_revision_id from allrice_company_assets where id=${newId}`;
        expect(stored!.latest_revision_id).toBe(draftId);
        expect(
          await getCompanyAsset(
            owner,
            a.context.organizationId,
            newId,
            false,
            f.db,
          ),
        ).toMatchObject({ canEdit: true, latest: { id: draftId } });
        await f.db`update allrice_organization_people set content_maintenance_level='personal' where organization_id=${a.context.organizationId} and user_id in (${owner.actor.id},${member.actor.id})`;
        for (const ctx of [owner, member]) {
          await expect(
            mutate(ctx, {
              operation: 'pause',
              assetId: newId,
              expectedRevision: current.revision,
            }),
          ).rejects.toThrow('authorization_denied');
        }
        await expect(
          mutate(owner, {
            operation: 'publish',
            assetId: newId,
            expectedRevision: current.revision,
          }),
        ).rejects.toThrow('authorization_denied');
        current = await mutate(owner, {
          operation: 'save',
          assetId: newId,
          expectedRevision: current.revision,
          content: {
            ...current.latest.content,
            title: 'Own personal draft remains editable',
          },
        });
        expect(current).toMatchObject({
          canEdit: true,
          canPublish: false,
          canMaintainPublication: false,
        });
        const published = (
          await listCompanyAssets(member, a.context.organizationId, {}, f.db)
        ).assets.find((v) => v.id === newId)!;
        expect(published).toMatchObject({
          canEdit: false,
          canPublish: false,
          canMaintainPublication: false,
          latest: { id: publishedId },
        });
      } finally {
        await f.db`update allrice_organization_people set content_maintenance_level='company' where organization_id=${a.context.organizationId} and user_id=${owner.actor.id}`;
        await f.db`update allrice_organization_people set content_maintenance_level='personal' where organization_id=${a.context.organizationId} and user_id=${member.actor.id}`;
      }
    });
    it('migrates published templates twice without sharing newer drafts, duplicating files or bypassing withdrawal', async () => {
      const assetId = randomUUID();
      let current = await mutate(owner, {
        operation: 'save',
        assetId,
        expectedRevision: 0,
        content: content('template', {
          sourceVersionId: a.artifact.artifactId,
          slots: [
            { key: 'period', label: '期间', required: true, multiline: false },
          ],
        }),
      });
      const v1 = current.latest;
      // Represents pre-migration data, not a new publication produced by the hook.
      await f.db`alter table allrice_company_asset_publications disable trigger company_reference_published`;
      try {
        current = await mutate(owner, {
          operation: 'publish',
          assetId,
          expectedRevision: current.revision,
        });
      } finally {
        await f.db`alter table allrice_company_asset_publications enable trigger company_reference_published`;
      }
      current = await mutate(owner, {
        operation: 'save',
        assetId,
        expectedRevision: current.revision,
        content: {
          ...v1.content,
          title: 'PRIVATE_NEW_DRAFT',
          body: 'Private procedure, not shared',
        },
      });
      const draftId = current.latest.id;
      const [before] =
        await f.db`select count(*)::int as objects,sum(size_bytes)::text as bytes from allrice_storage_objects`;
      for (let n = 0; n < 2; n++)
        await f.db`select allrice_sync_company_template_reference(${assetId})`;
      const [after] =
        await f.db`select count(*)::int as objects,sum(size_bytes)::text as bytes from allrice_storage_objects`;
      expect(after).toEqual(before);
      const [mapped] =
        await f.db`select r.* from allrice_knowledge_revisions r where legacy_company_asset_id=${assetId}`;
      expect(mapped).toMatchObject({
        legacy_company_revision_id: v1.id,
        file_object_id: v1.file!.objectId,
        workspace_id: owner.workspaceId,
        revision: 1,
      });
      const sourceId = mapped!.knowledge_source_id as string;
      for (const ctx of [owner, member]) {
        const refs = await listReferenceRevisions(
          ctx,
          ctx.workspaceId!,
          sourceId,
        );
        expect(refs).toHaveLength(1);
        expect(refs[0]).toMatchObject({
          revisionId: mapped!.id,
          canMaintain: false,
          companyTemplate: { assetId, revisionId: v1.id, digest: v1.digest },
        });
        expect(JSON.stringify(refs)).not.toContain('PRIVATE_NEW_DRAFT');
        const file = await getReferenceFile(
          ctx,
          ctx.workspaceId!,
          mapped!.id,
          f.db,
        );
        expect(file.object.id).toBe(v1.file!.objectId);
        expect(file.object.workspaceId).toBe(owner.workspaceId);
      }
      await expect(
        getReferenceFile(
          foreign.context,
          foreign.context.workspaceId!,
          mapped!.id,
          f.db,
        ),
      ).rejects.toThrow();
      expect(
        await f.db`select id from allrice_knowledge_revisions where legacy_company_revision_id=${draftId}`,
      ).toHaveLength(0);
      await expect(
        changeReference(owner, sourceId, {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          expectedRevision: 1,
          action: 'archive',
        }),
      ).rejects.toThrow('not_found');
      await expect(
        prepareReferenceUpload(owner, {
          workspaceId: owner.workspaceId,
          requestId: randomUUID(),
          sourceId,
          expectedRevision: 1,
          scope: 'company',
          fileName: 'bypass.txt',
          purpose: '',
          mediaType: 'text/plain',
          contentBase64: Buffer.from('bypass').toString('base64'),
        }),
      ).rejects.toThrow('not_found');
      // Existing message admission freezes the ORIGINAL template ID, digest and slots.
      const selection = {
        assetId,
        revisionId: v1.id,
        digest: v1.digest,
        parameters: { period: '2026-10' },
      };
      const snapshot = await f.db.begin((tx) =>
        captureCompanyRunAssets(tx, member, randomUUID(), '月度复盘', [
          selection,
        ]),
      );
      expect(snapshot.templates[0]).toMatchObject({
        assetId,
        revision: { id: v1.id, digest: v1.digest },
        parameters: selection.parameters,
      });
      const retained = await getReferenceFile(
        owner,
        owner.workspaceId!,
        mapped!.id,
        f.db,
      );
      const claim = {
        revisionId: mapped!.id as string,
        token: randomUUID(),
        object: retained.object,
        fileName: retained.fileName,
      };
      await f.db`update allrice_knowledge_processing set state='processing',lease_token=${claim.token},lease_until=clock_timestamp()+interval '5 minutes' where revision_id=${claim.revisionId}`;
      current = await mutate(owner, {
        operation: 'pause',
        assetId,
        expectedRevision: current.revision,
      });
      await expect(
        finishReferenceProcessing(claim, [
          { content: 'Synthetic reference', start: 0, end: 19 },
        ]),
      ).rejects.toThrow('not_found');
      await failReferenceProcessing(
        claim,
        '资料处理失败，请重试；原文件已保留。',
      );
      current = await mutate(owner, {
        operation: 'resume',
        assetId,
        expectedRevision: current.revision,
      });
      const retry = {
        workspaceId: owner.workspaceId,
        requestId: randomUUID(),
        expectedRevision: 1,
        action: 'retry',
      };
      await expect(
        changeReference(member, sourceId, {
          ...retry,
          workspaceId: member.workspaceId,
        }),
      ).rejects.toThrow('not_found');
      await changeReference(owner, sourceId, retry);
      await changeReference(owner, sourceId, retry);
      expect(
        (
          await f.db`select state from allrice_knowledge_processing where revision_id=${claim.revisionId}`
        )[0]!.state,
      ).toBe('saved');
      claim.token = randomUUID();
      await f.db`update allrice_knowledge_processing set state='processing',lease_token=${claim.token},lease_until=clock_timestamp()+interval '5 minutes' where revision_id=${claim.revisionId}`;
      await finishReferenceProcessing(claim, [
        { content: 'Synthetic reference', start: 0, end: 19 },
      ]);
      expect(
        (await readReferenceSelection(member, mapped!.id, f.db, false))
          .selection.revision,
      ).toBe(1);
      for (const operation of ['pause', 'withdraw'] as const) {
        current = await mutate(owner, {
          operation,
          assetId,
          expectedRevision: current.revision,
        });
        expect(
          await listReferenceRevisions(member, member.workspaceId!, sourceId),
        ).toEqual([]);
        await expect(
          getReferenceFile(owner, owner.workspaceId!, mapped!.id, f.db),
        ).rejects.toThrow('not_found');
        await expect(
          readReferenceSelection(member, mapped!.id, f.db, false),
        ).rejects.toThrow('所选资料');
        await expect(
          f.db.begin((tx) =>
            captureCompanyRunAssets(tx, member, randomUUID(), '月度复盘', [
              selection,
            ]),
          ),
        ).rejects.toThrow('asset_unavailable');
        current = await mutate(owner, {
          operation: 'resume',
          assetId,
          expectedRevision: current.revision,
        });
        expect(current.publishedRevisionId).toBe(v1.id);
        expect(
          (await listReferenceRevisions(member, member.workspaceId!)).find(
            (r) => r.sourceId === sourceId,
          )?.revision,
        ).toBe(1);
      }
      current = await mutate(owner, {
        operation: 'publish',
        assetId,
        expectedRevision: current.revision,
      });
      expect(
        (await listReferenceRevisions(member, member.workspaceId!)).find(
          (r) => r.sourceId === sourceId,
        )?.revision,
      ).toBe(2);
      expect(
        await listReferenceRevisions(member, member.workspaceId!, sourceId),
      ).toHaveLength(2);
      for (let n = 0; n < 50; n++)
        current = await mutate(owner, {
          operation: 'save',
          assetId,
          expectedRevision: current.revision,
          content: { ...current.latest.content, title: 'Private draft ' + n },
        });
      const pinnedHistory = await listCompanyAssetRevisions(
        owner,
        owner.organizationId,
        assetId,
        false,
        f.db,
        v1.id,
      );
      expect(pinnedHistory.revisions).toHaveLength(50);
      expect(pinnedHistory.revisions.some((r) => r.id === v1.id)).toBe(true);
      const unauthorizedPin = await listCompanyAssetRevisions(
        member,
        member.organizationId,
        assetId,
        false,
        f.db,
        current.latest.id,
      );
      expect(unauthorizedPin.revisions.map((r) => r.id).sort()).toEqual(
        [v1.id, draftId].sort(),
      );
      expect(
        (await getReferenceFile(member, member.workspaceId!, mapped!.id, f.db))
          .object.id,
      ).toBe(v1.file!.objectId);
      expect(
        (
          await f.db`select count(*)::int as objects,sum(size_bytes)::text as bytes from allrice_storage_objects`
        )[0],
      ).toEqual(before);
      // Private original Session lifecycle does not withdraw a separately published snapshot.
      await f.db`update allrice_chat_sessions set archived_at=clock_timestamp() where id=${a.task.chatSessionId!}`;
      try {
        expect(
          (
            await getReferenceFile(
              member,
              member.workspaceId!,
              mapped!.id,
              f.db,
            )
          ).object.id,
        ).toBe(v1.file!.objectId);
      } finally {
        await f.db`update allrice_chat_sessions set archived_at=null where id=${a.task.chatSessionId!}`;
      }
    });
    it('rolls back failed snapshot copies and removes only the uncommitted object', async () => {
      let allocated: StorageObject | undefined;
      const storage = runtimeFixtureStorage(f.db),
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
