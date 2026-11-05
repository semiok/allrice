import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  PersonalSceneFile,
  PersonalSceneFilePreview,
  PersonalSceneRestorePreview,
  RequestContext,
} from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from '../identity.ts';
import {
  createManagedOrganization,
  importOrganizationPeople,
} from '../organization-administration.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '../tenant-employees.ts';
import { getEmployeeWorkspace } from '../workspace/service.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import { sceneSkillFixture } from './employee-scene-skills.fixture.ts';
import {
  previewPersonalSceneFile,
  listPersonalSceneFileHistory,
  previewPersonalSceneRestore,
  restorePersonalSceneFile,
} from './personal-scene-files.ts';
import {
  getPersonalSceneSkill,
  getPersonalSceneSkillResource,
  parsePersonalSceneContentRef,
  personalSceneContentRef,
  savePersonalSceneSkillInTransaction,
  listPersonalSceneSkills,
} from './personal-scene-skills.ts';
import { mutateEmployeeContent } from './employee-content.ts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import { nativeBindingWaiter } from '../native-session-binding.fixture.ts';
import {
  readPathSignal,
  settleReadPathRace,
} from '../read-path-races.fixture.ts';

const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'human file import and update through the personal instance HTTP entry',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let admin: RequestContext;
    let publication: Awaited<
      ReturnType<typeof createEmployeeAdministrationFixture>
    >;
    beforeAll(async () => {
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Platform',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: 'file-platform@example.test',
        displayName: 'Platform',
        role: 'member',
      });
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', principal.user.email);
      admin = (await authenticateSession(
        (await createSession(principal.user.id)).token,
      ))!;
      publication = await createEmployeeAdministrationFixture(f.db);
      await publication.preview();
      expect((await publication.publish()).valid).toBe(true);
    }, 120000);
    afterAll(async () => {
      browser.context = null;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    }, 30000);

    async function setup() {
      const organization = await createManagedOrganization(admin, {
        name: `Files-${randomUUID()}`,
      });
      const workspaceId = organization.defaultWorkspaceId!;
      const people = (
        await importOrganizationPeople(admin, organization.organizationId, {
          people: [
            {
              username: `owner-${randomUUID()}`,
              displayName: 'Owner',
              contentMaintenanceLevel: 'personal',
            },
            {
              username: `peer-${randomUUID()}`,
              displayName: 'Peer',
              contentMaintenanceLevel: 'personal',
            },
          ],
        })
      ).created;
      const contexts = [];
      for (const person of people)
        contexts.push(
          (await authenticateSession(
            (await createSession(person.userId)).token,
            { organizationId: organization.organizationId, workspaceId },
          ))!,
        );
      const owner = contexts[0]!,
        peer = contexts[1]!;
      const employee = (
        await listAdminTenantEmployees(
          admin,
          organization.organizationId,
          workspaceId,
        )
      ).employees.find((entry) => entry.employeeId === publication.employeeId)!;
      await changeAdminTenantEmployee(admin, organization.organizationId, {
        workspaceId,
        employeeId: publication.employeeId,
        action: 'assign',
        revisionId: employee.revisionId,
        expectedVersion: employee.deployment?.version ?? null,
      });
      const assigned = (
        await getEmployeeWorkspace(owner, workspaceId)
      ).employees.find(
        (entry) => entry.employeeKey === publication.definition.key,
      )!;
      const instance = await createEmployeeInstance(owner, {
        workspaceId,
        assignmentId: assigned.id,
        requestId: randomUUID(),
        profile: { name: '我的周报助理' },
      });
      return { owner, peer, workspaceId, instance, assigned };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;
    function file(
      version = '1.0.0',
      sceneId: string = randomUUID(),
    ): PersonalSceneFile {
      const payload = sceneSkillFixture(version);
      const bytes = Buffer.from(`题目,版本\n周报,${version}\n`);
      const resource = payload.skillPackage.bundle.resources[0]!;
      Object.assign(resource, {
        byteLength: bytes.length,
        contentBase64: bytes.toString('base64'),
        checksum: skillBytesChecksum(bytes),
      });
      const bundle = payload.skillPackage.bundle;
      bundle.checksum = skillBundleChecksum({
        schemaVersion: bundle.schemaVersion,
        version: bundle.version,
        contentChecksum: bundle.contentChecksum,
        sourceRef: bundle.sourceRef,
        license: bundle.license,
        reviewedBy: bundle.reviewedBy,
        dependencies: bundle.dependencies,
        resources: bundle.resources,
      });
      return {
        schemaVersion: 1,
        scene: {
          id: sceneId,
          name: '我的周报',
          appliesWhen: '按资料整理周报草稿',
          nativeName: `allrice-scene-${sceneId}`,
        },
        procedure: { kind: 'procedure', title: '周报方法', ...payload },
        references: [],
        // Deliberately untrusted: the actual file bytes, not this claim, are checked.
        report: { published: true, bundleChecksum: 'untrusted' },
      };
    }
    function saveBody(s: Setup, preview: PersonalSceneFilePreview) {
      return {
        workspaceId: s.workspaceId,
        requestId: randomUUID(),
        expectedRevision: preview.expectedRevision,
        expectedContentRef: preview.expectedContentRef,
        scene: {
          id: preview.file.scene.id,
          name: preview.file.scene.name,
          appliesWhen: preview.file.scene.appliesWhen,
        },
        procedure: preview.file.procedure,
        references: preview.file.references,
        changeSummary: '根据实际周报结果修改文件',
      };
    }
    async function http(
      s: Setup,
      operation: 'preview' | 'save' | 'history' | 'restore-preview' | 'restore',
      body?: unknown,
      instanceId = s.instance.id,
      origin = 'https://example.test',
    ): Promise<Response> {
      const base = `https://example.test/api/v1/employee-instances/${instanceId}/scene-skills`;
      const params = { params: Promise.resolve({ id: instanceId }) };
      if (operation === 'restore-preview' || operation === 'restore') {
        const routePath =
          '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/restore/route.ts';
        const { POST, PUT } = await import(routePath);
        return (operation === 'restore' ? PUT : POST)(
          new Request(`${base}/restore`, {
            method: operation === 'restore' ? 'PUT' : 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
          params,
        );
      }
      if (operation === 'save') {
        const routePath =
          '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/route.ts';
        const { POST } = await import(routePath);
        return POST(
          new Request(base, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
          params,
        );
      }
      const routePath =
        '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/files/route.ts';
      const { GET, POST } = await import(routePath);
      return operation === 'history'
        ? GET(new Request(`${base}/files?workspaceId=${s.workspaceId}`), params)
        : POST(
            new Request(`${base}/files`, {
              method: 'POST',
              headers: { origin, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
            params,
          );
    }
    async function install(s: Setup, artifact: PersonalSceneFile) {
      browser.context = s.owner;
      const response = await http(s, 'preview', {
        workspaceId: s.workspaceId,
        file: artifact,
      });
      expect(response.status).toBe(200);
      const preview = (await response.json()) as PersonalSceneFilePreview;
      const input = saveBody(s, preview);
      const saved = await http(s, 'save', input);
      expect(saved.status).toBe(200);
      return { preview, input, receipt: (await saved.json()).receipt };
    }
    function restoreBody(s: Setup, preview: PersonalSceneRestorePreview) {
      if (!('skillPackage' in preview.file.procedure))
        throw Error('fixture package required');
      return {
        workspaceId: s.workspaceId,
        requestId: randomUUID(),
        expectedRevision: preview.expectedRevision,
        expectedContentRef: preview.expectedContentRef,
        restoreContentRef: preview.restoreContentRef,
        sceneId: preview.file.scene.id,
        contentChecksum:
          preview.file.procedure.skillPackage.bundle.contentChecksum,
        bundleChecksum: preview.file.procedure.skillPackage.bundle.checksum,
        changeSummary: '恢复已核对的原始周报方法',
      };
    }
    async function restorePreview(s: Setup, contentRef: string) {
      browser.context = s.owner;
      const response = await http(s, 'restore-preview', {
        workspaceId: s.workspaceId,
        restoreContentRef: contentRef,
      });
      expect(response.status).toBe(200);
      return (await response.json()) as PersonalSceneRestorePreview;
    }
    async function snapshot(s: Setup) {
      const [row] = await f.db`select
        (select count(*)::int from allrice_employee_content_sets where created_by=${s.owner.actor.id}) as sets,
        (select count(*)::int from allrice_employee_content_revisions where created_by=${s.owner.actor.id}) as revisions,
        (select count(*)::int from allrice_employee_content_requests where actor_id=${s.owner.actor.id}) as requests,
        (select count(*)::int from allrice_company_asset_revisions where created_by=${s.owner.actor.id}) as sources`;
      return row;
    }
    async function knowledge(s: Setup) {
      const sourceId = randomUUID(),
        revisionId = randomUUID(),
        bindingId = randomUUID();
      const definition = {
        schemaVersion: 1,
        sourceKind: 'managed',
        connectorBindingId: null,
        resourceRef: `synthetic:${sourceId}`,
        indexing: 'none',
        updatePolicy: 'manual',
        citationRequired: true,
        allowedScopes: ['workspace'],
      };
      const digest = runtimePolicyDigest(definition);
      await f.db`insert into allrice_knowledge_sources(id,organization_id,workspace_id,slug,name,description,created_by)
        values(${sourceId},${s.owner.organizationId},${s.workspaceId},${`source-${sourceId}`},'来源','合成来源',${s.owner.actor.id})`;
      await f.db`insert into allrice_knowledge_revisions(id,organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by)
        values(${revisionId},${s.owner.organizationId},${s.workspaceId},${sourceId},1,'来源','合成来源','draft',${f.db.json(definition)},${digest},${s.owner.actor.id})`;
      await f.db`insert into allrice_knowledge_acl_entries(organization_id,workspace_id,knowledge_revision_id,principal_type,principal_id,permission)
        values(${s.owner.organizationId},${s.workspaceId},${revisionId},'workspace',${s.workspaceId},'read')`;
      await f.db`update allrice_knowledge_revisions set status='published',published_at=now() where id=${revisionId}`;
      await f.db`insert into allrice_employee_knowledge_bindings(id,organization_id,workspace_id,employee_id,knowledge_revision_id,bound_by)
        values(${bindingId},${s.owner.organizationId},${s.workspaceId},${s.assigned.employeeId},${revisionId},${s.owner.actor.id})`;
      return {
        ref: {
          sourceKind: 'knowledge' as const,
          contentId: sourceId,
          revisionId,
          digest,
        },
        bindingId,
      };
    }

    it('keeps author framework metadata through human preview, save and exact read without exposing execution details as display sections', async () => {
      const s = await setup();
      const artifact = file();
      if (!('skillPackage' in artifact.procedure)) throw Error('fixture');
      artifact.procedure.body =
        '## 工作步骤\n1. 核实来源\n## 交付内容\n- 周报草稿\n## 执行细节\nmodel-only instructions';
      const frontmatter = {
        name: 'weekly-brief',
        description: '整理周报',
        whenToUse: '每周五',
        invocation: { modelInvocable: true, userInvocable: true },
        metadata: {
          displayName: '写周报',
          version: 'v2-preview',
          extra: { ownerNote: 'content, not authority' },
        },
      };
      artifact.procedure.skillPackage.frontmatter = frontmatter;
      const bundle = artifact.procedure.skillPackage.bundle;
      bundle.contentChecksum = skillBytesChecksum(artifact.procedure.body);
      const { checksum: _checksum, ...bundlePayload } = bundle;
      bundle.checksum = skillBundleChecksum(bundlePayload);
      const saved = await install(s, artifact);
      expect(saved.preview.file.procedure.skillPackage.frontmatter).toEqual(
        frontmatter,
      );
      const current = await getPersonalSceneSkill(
        s.owner,
        s.instance.id,
        artifact.scene.id,
        f.db,
      );
      expect(current).toMatchObject({
        frontmatter,
        name: '写周报',
        description: '整理周报',
        version: 'v2-preview',
        whenToUse: '每周五',
        stepsMarkdown: '1. 核实来源',
        deliverablesMarkdown: '- 周报草稿',
        contentRef: saved.receipt.contentRef,
        nativeName: `allrice-scene-${artifact.scene.id}`,
      });
      expect(current.content).toBe(artifact.procedure.body);
      expect(
        JSON.stringify([current.stepsMarkdown, current.deliverablesMarkdown]),
      ).not.toContain('model-only');
      const catalog = await listPersonalSceneSkills(
        s.owner,
        s.instance.id,
        f.db,
      );
      expect(catalog.skills[0]).toMatchObject({
        name: '写周报',
        version: 'v2-preview',
        contentRef: current.contentRef,
        revision: current.revision,
      });
      const pin = parsePersonalSceneContentRef(current.contentRef);
      const [source] = await f.db<
        { content: typeof artifact.procedure }[]
      >`select content from allrice_company_asset_revisions where id=${pin.sourceRevisionId}`;
      expect(source!.content).toEqual(artifact.procedure);
      await expect(
        getPersonalSceneSkill(s.peer, s.instance.id, artifact.scene.id, f.db),
      ).rejects.toThrow();

      const invalid = structuredClone(artifact);
      invalid.procedure.body =
        '```md\n## 工作步骤\n## 交付内容\n## 执行细节\n```';
      if (!('skillPackage' in invalid.procedure)) throw Error('fixture');
      invalid.procedure.skillPackage.bundle.contentChecksum =
        skillBytesChecksum(invalid.procedure.body);
      const { checksum: _invalidChecksum, ...invalidPayload } =
        invalid.procedure.skillPackage.bundle;
      invalid.procedure.skillPackage.bundle.checksum =
        skillBundleChecksum(invalidPayload);
      expect(
        (
          await http(s, 'preview', {
            workspaceId: s.workspaceId,
            file: invalid,
          })
        ).status,
      ).toBe(422);
      expect(
        await getPersonalSceneSkill(
          s.owner,
          s.instance.id,
          artifact.scene.id,
          f.db,
        ),
      ).toEqual(current);
    });

    it('restores v1 as a new current revision with exact old sources, immutable history and untouched other scenes', async () => {
      const s = await setup(),
        original = file(),
        dependency = await knowledge(s);
      original.references.push(dependency.ref);
      if (!('skillPackage' in original.procedure))
        throw Error('fixture package required');
      original.procedure.skillPackage.resourceSources = [
        { path: 'assets/template.csv', references: [dependency.ref] },
      ];
      const a = await install(s, original);
      await install(s, file('2.0.0', original.scene.id));
      const other = file('3.0.0');
      await install(s, other);
      const beforeHistory = await listPersonalSceneFileHistory(
        s.owner,
        s.instance.id,
      );
      const oldPin = parsePersonalSceneContentRef(a.receipt.contentRef);
      const [oldRevision] =
        await f.db`select manifest,digest,change_summary,created_at from allrice_employee_content_revisions where id=${oldPin.revisionId}`;
      const [currentRevision] =
        await f.db`select manifest from allrice_employee_content_revisions where set_id=${oldPin.setId} and number=${beforeHistory.revision}`;
      const before = await snapshot(s);
      const preview = await restorePreview(s, a.receipt.contentRef);
      expect(preview).toMatchObject({
        expectedRevision: 3,
        restoreRevision: 1,
        restoreContentRef: a.receipt.contentRef,
      });
      expect(preview.file.procedure.body).toBe(original.procedure.body);
      expect(preview.file.references).toEqual(
        oldRevision!.manifest.scenes[0].references,
      );
      expect(preview.current!.bundleVersion).toBe('2.0.0');
      expect(await snapshot(s)).toEqual(before);
      const input = restoreBody(s, preview);
      const response = await http(s, 'restore', input);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const result = await response.json();
      expect(result.receipt).toMatchObject({
        revision: 4,
        sceneId: original.scene.id,
        contentChecksum: a.receipt.contentChecksum,
        bundleChecksum: a.receipt.bundleChecksum,
      });
      expect(result.receipt.contentRef).not.toBe(a.receipt.contentRef);
      const newPin = parsePersonalSceneContentRef(result.receipt.contentRef);
      expect(newPin.sourceRevisionId).toBe(oldPin.sourceRevisionId);
      const [restored] =
        await f.db`select manifest from allrice_employee_content_revisions where id=${newPin.revisionId}`;
      expect(
        restored!.manifest.scenes.find(
          (scene: { id: string }) => scene.id === other.scene.id,
        ),
      ).toEqual(
        currentRevision!.manifest.scenes.find(
          (scene: { id: string }) => scene.id === other.scene.id,
        ),
      );
      expect(
        restored!.manifest.scenes.find(
          (scene: { id: string }) => scene.id === original.scene.id,
        ),
      ).toEqual(oldRevision!.manifest.scenes[0]);
      expect(
        (await getPersonalSceneSkill(s.owner, s.instance.id, original.scene.id))
          .content,
      ).toBe(original.procedure.body);
      const resource = await getPersonalSceneSkillResource(
        s.owner,
        s.instance.id,
        result.receipt.contentRef,
        'assets/template.csv',
      );
      expect(
        Buffer.from(resource.contentBase64, 'base64').toString(),
      ).toContain('1.0.0');
      const [oldAfter] =
        await f.db`select manifest,digest,change_summary,created_at from allrice_employee_content_revisions where id=${oldPin.revisionId}`;
      expect(oldAfter).toEqual(oldRevision);
      const afterHistory = await listPersonalSceneFileHistory(
        s.owner,
        s.instance.id,
      );
      expect(
        afterHistory.entries.filter((entry) => entry.revision <= 3),
      ).toEqual(beforeHistory.entries);
      expect(afterHistory.entries[0]).toMatchObject({
        revision: 4,
        changeSummary: input.changeSummary,
      });
      const after = await snapshot(s);
      expect(after).toEqual({
        sets: before!.sets,
        revisions: before!.revisions + 1,
        requests: before!.requests + 1,
        sources: before!.sources,
      });
      expect(await (await http(s, 'restore', input)).json()).toEqual(result);
      expect(await snapshot(s)).toEqual(after);
      expect(
        (
          await http(s, 'restore', {
            ...input,
            changeSummary: 'same id, different input',
          })
        ).status,
      ).toBe(409);
      await f.db`update allrice_employee_knowledge_bindings set enabled=false where id=${dependency.bindingId}`;
      await expect(
        getPersonalSceneSkillResource(
          s.owner,
          s.instance.id,
          result.receipt.contentRef,
          'assets/template.csv',
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      // A prior confirmed mutation can replay its exact receipt, without granting a body read.
      expect(await (await http(s, 'restore', input)).json()).toEqual(result);
      expect(await snapshot(s)).toEqual(after);
    });

    it('rejects an unreadable mixed legacy scene rather than silently restoring hidden plain procedures', async () => {
      const s = await setup(),
        original = file();
      const a = await install(s, original),
        pin = parsePersonalSceneContentRef(a.receipt.contentRef);
      const [stored] =
        await f.db`select manifest from allrice_employee_content_revisions where id=${pin.revisionId}`;
      const manifest = structuredClone(stored!.manifest);
      const plain = {
        contentId: randomUUID(),
        revisionId: randomUUID(),
        expectedRevision: 0,
        kind: 'procedure' as const,
        title: '旧场景附加方法',
        body: 'PLAIN_SOURCE_TO_RESTORE',
      };
      manifest.scenes[0].references.push({
        sourceKind: 'draft_text',
        contentId: plain.contentId,
      });
      const target = {
        workspaceId: s.workspaceId,
        setId: pin.setId,
        ownership: {
          scope: 'personal' as const,
          organizationId: s.owner.organizationId,
          ownerId: s.owner.actor.id,
        },
        target: { kind: 'instance' as const, instanceId: s.instance.id },
        changeSummary: '增加附加方法',
      };
      let revision = await mutateEmployeeContent(s.owner, {
        ...target,
        requestId: randomUUID(),
        expectedRevision: 1,
        operation: 'save_draft',
        manifest,
        textEdits: [plain],
      });
      revision = await mutateEmployeeContent(s.owner, {
        ...target,
        requestId: randomUUID(),
        expectedRevision: revision.revision,
        operation: 'validate',
        candidateRevisionId: revision.candidate.id,
        candidateDigest: revision.candidate.digest,
      });
      expect(revision.validation?.valid).toBe(true);
      const active = await mutateEmployeeContent(s.owner, {
        ...target,
        requestId: randomUUID(),
        expectedRevision: revision.revision,
        operation: 'activate',
        candidateRevisionId: revision.candidate.id,
        candidateDigest: revision.candidate.digest,
      });
      const mixedRef = personalSceneContentRef({
        ...pin,
        revisionId: active.active!.id,
      });
      const [mixed] =
        await f.db`select manifest from allrice_employee_content_revisions where id=${active.active!.id}`;
      const b = await install(s, file('2.0.0', original.scene.id));
      const before = await snapshot(s);
      expect(
        (
          await http(s, 'restore-preview', {
            workspaceId: s.workspaceId,
            restoreContentRef: mixedRef,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await http(s, 'restore', {
            workspaceId: s.workspaceId,
            requestId: randomUUID(),
            expectedRevision: b.receipt.revision,
            expectedContentRef: b.receipt.contentRef,
            restoreContentRef: mixedRef,
            sceneId: original.scene.id,
            contentChecksum: a.receipt.contentChecksum,
            bundleChecksum: a.receipt.bundleChecksum,
            changeSummary: '拒绝隐藏附加引用',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await http(s, 'preview', {
            workspaceId: s.workspaceId,
            file: {
              ...original,
              references: mixed!.manifest.scenes[0].references,
            },
          })
        ).status,
      ).toBe(400);
      expect(await snapshot(s)).toEqual(before);
      expect(
        (await getPersonalSceneSkill(s.owner, s.instance.id, original.scene.id))
          .contentRef,
      ).toBe(b.receipt.contentRef);
    });

    it('rechecks old package and resource source qualification after preview, without partial writes', async () => {
      for (const revoked of ['package', 'source', 'publication'] as const) {
        const s = await setup(),
          original = file(),
          dependency = await knowledge(s);
        original.references.push(dependency.ref);
        if (!('skillPackage' in original.procedure))
          throw Error('fixture package required');
        original.procedure.skillPackage.resourceSources = [
          { path: 'assets/template.csv', references: [dependency.ref] },
        ];
        const a = await install(s, original);
        const b = await install(s, file('2.0.0', original.scene.id));
        const preview = await restorePreview(s, a.receipt.contentRef),
          before = await snapshot(s);
        const pin = parsePersonalSceneContentRef(a.receipt.contentRef);
        if (revoked === 'package') {
          const [source] =
            await f.db`select asset_id from allrice_company_asset_revisions where id=${pin.sourceRevisionId}`;
          await f.db`update allrice_company_assets set state='withdrawn' where id=${source!.asset_id}`;
        } else if (revoked === 'source') {
          await f.db`update allrice_employee_knowledge_bindings set enabled=false where id=${dependency.bindingId}`;
        } else {
          await f.db`update allrice_employee_content_publications set invalidated_at=now() where revision_id=${pin.revisionId}`;
        }
        expect(
          (
            await http(s, 'restore-preview', {
              workspaceId: s.workspaceId,
              restoreContentRef: a.receipt.contentRef,
            })
          ).status,
          revoked,
        ).toBe(404);
        expect(
          (await http(s, 'restore', restoreBody(s, preview))).status,
          revoked,
        ).toBe(404);
        expect(await snapshot(s), revoked).toEqual(before);
        expect(
          (
            await getPersonalSceneSkill(
              s.owner,
              s.instance.id,
              original.scene.id,
            )
          ).contentRef,
        ).toBe(b.receipt.contentRef);
      }
    });

    it('keeps restore exact and scoped to the current human owner, tenant and instance', async () => {
      const s = await setup(),
        foreign = await setup(),
        original = file();
      const a = await install(s, original);
      await install(s, file('2.0.0', original.scene.id));
      const preview = await restorePreview(s, a.receipt.contentRef),
        input = restoreBody(s, preview),
        before = await snapshot(s);
      const selection = {
        workspaceId: s.workspaceId,
        restoreContentRef: a.receipt.contentRef,
      };
      for (const { context, expected } of [
        { context: s.peer, expected: 404 },
        { context: foreign.owner, expected: 403 },
        { context: null, expected: 401 },
      ]) {
        browser.context = context;
        expect((await http(s, 'restore-preview', selection)).status).toBe(
          expected,
        );
        expect((await http(s, 'restore', input)).status).toBe(expected);
      }
      const other = await createEmployeeInstance(s.owner, {
        workspaceId: s.workspaceId,
        assignmentId: s.assigned.id,
        requestId: randomUUID(),
        profile: { name: '另一本人员工' },
      });
      browser.context = s.owner;
      expect(
        (await http(s, 'restore-preview', selection, other.id)).status,
      ).toBe(404);
      expect(
        (
          await http(
            s,
            'restore',
            { ...input, expectedRevision: 0, expectedContentRef: null },
            other.id,
          )
        ).status,
      ).toBe(404);
      expect(
        (await http(s, 'restore', { ...input, sceneId: randomUUID() })).status,
      ).toBe(404);
      expect(
        (
          await http(s, 'restore', {
            ...input,
            bundleChecksum: `sha256:${'0'.repeat(64)}`,
          })
        ).status,
      ).toBe(409);
      expect(
        (await http(s, 'restore', { ...input, expectedContentRef: null }))
          .status,
      ).toBe(409);
      expect(
        (
          await http(
            s,
            'restore-preview',
            selection,
            s.instance.id,
            'https://other.test',
          )
        ).status,
      ).toBe(403);
      expect(
        (await http(s, 'restore', input, s.instance.id, 'https://other.test'))
          .status,
      ).toBe(403);
      expect(
        (await http(s, 'restore', { ...input, procedure: original.procedure }))
          .status,
      ).toBe(400);
      expect(
        (
          await http(s, 'restore-preview', {
            ...selection,
            ownerId: s.owner.actor.id,
          })
        ).status,
      ).toBe(400);
      await expect(
        previewPersonalSceneRestore(
          { ...s.owner, sessionId: '' },
          s.instance.id,
          selection,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await expect(
        restorePersonalSceneFile(
          { ...s.owner, sessionId: '' },
          s.instance.id,
          input,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      expect(await snapshot(s)).toEqual(before);
      await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
      expect((await http(s, 'restore-preview', selection)).status).toBe(403);
      expect((await http(s, 'restore', input)).status).toBe(403);
    });

    it('serializes restore with concurrent saves and replays only one immutable new revision', async () => {
      const s = await setup(),
        original = file();
      const a = await install(s, original);
      await install(s, file('2.0.0', original.scene.id));
      const preview = await restorePreview(s, a.receipt.contentRef),
        input = restoreBody(s, preview);
      const savePreview = await previewPersonalSceneFile(
        s.owner,
        s.instance.id,
        { workspaceId: s.workspaceId, file: file('3.0.0', original.scene.id) },
      );
      const before = await snapshot(s);
      const replies = await Promise.all([
        http(s, 'restore', input),
        http(s, 'save', saveBody(s, savePreview)),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect((await snapshot(s))!.revisions).toBe(before!.revisions + 1);
      expect(
        (await http(s, 'restore', { ...input, requestId: randomUUID() }))
          .status,
      ).toBe(409);
      const nextPreview = await restorePreview(s, a.receipt.contentRef),
        next = restoreBody(s, nextPreview);
      const count = await snapshot(s);
      const replays = await Promise.all([
        http(s, 'restore', next),
        http(s, 'restore', next),
      ]);
      expect(replays.map((reply) => reply.status)).toEqual([200, 200]);
      expect(await replays[0]!.json()).toEqual(await replays[1]!.json());
      expect((await snapshot(s))!.revisions).toBe(count!.revisions + 1);
      expect((await snapshot(s))!.requests).toBe(count!.requests + 1);
    });

    it.each(['package', 'resource source'] as const)(
      'rejects restore after waiting for a %s revocation that commits first, without partial writes',
      async (kind) => {
        const s = await setup(),
          original = file(),
          dependency = await knowledge(s);
        original.references.push(dependency.ref);
        if (!('skillPackage' in original.procedure))
          throw Error('fixture package required');
        original.procedure.skillPackage.resourceSources = [
          { path: 'assets/template.csv', references: [dependency.ref] },
        ];
        const a = await install(s, original);
        const b = await install(s, file('2.0.0', original.scene.id));
        const input = restoreBody(
          s,
          await restorePreview(s, a.receipt.contentRef),
        );
        const before = await snapshot(s),
          pin = parsePersonalSceneContentRef(a.receipt.contentRef);
        const [source] =
          await f.db`select asset_id from allrice_company_asset_revisions where id=${pin.sourceRevisionId}`;
        const ready = readPathSignal<number>(),
          release = readPathSignal();
        const revoking = f.db.begin(async (tx) => {
          const [backend] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          if (kind === 'package')
            await tx`update allrice_company_assets set state='withdrawn' where id=${source!.asset_id}`;
          else
            await tx`update allrice_employee_knowledge_bindings set enabled=false where id=${dependency.bindingId}`;
          ready.resolve(backend!.pid);
          await release.promise;
        });
        void revoking.catch((error) => ready.reject(error));
        const blockerPid = await ready.promise;
        const restoring = http(s, 'restore', input);
        void restoring.catch(() => undefined);
        try {
          // The existing observer returns only after PostgreSQL reports this
          // exact revoker as the restore query's blocker. No sleep orders it.
          const waiterPid = await nativeBindingWaiter(f.db, blockerPid);
          const [waiter] = await f.db<
            { wait_event_type: string; query: string }[]
          >`
            select wait_event_type,query from pg_stat_activity
            where pid=${waiterPid} and ${blockerPid}=any(pg_blocking_pids(pid))`;
          expect(waiter?.wait_event_type).toBe('Lock');
          expect(waiter!.query).toContain('for share');
          expect(waiter!.query).toContain(
            kind === 'package'
              ? 'allrice_company_assets'
              : 'allrice_employee_knowledge_bindings',
          );
        } finally {
          release.resolve();
          await settleReadPathRace([revoking, restoring]);
        }
        // The lock releases only on revocation commit. The woken restore must
        // observe current qualification instead of publishing its preview.
        const response = await restoring;
        expect(response.status).toBe(404);
        const result = await response.json();
        expect(result).not.toHaveProperty('receipt');
        expect(JSON.stringify(result)).not.toContain(original.procedure.body);
        expect(await snapshot(s)).toEqual(before);
        expect(
          (
            await getPersonalSceneSkill(
              s.owner,
              s.instance.id,
              original.scene.id,
            )
          ).contentRef,
        ).toBe(b.receipt.contentRef);
        await expect(
          getPersonalSceneSkillResource(
            s.owner,
            s.instance.id,
            a.receipt.contentRef,
            'assets/template.csv',
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
        expect((await http(s, 'restore', input)).status).toBe(404);
        expect(await snapshot(s)).toEqual(before);
      },
    );

    it('holds exact old source locks until restore commits and preserves withdrawal enforcement afterwards', async () => {
      const s = await setup(),
        original = file();
      const a = await install(s, original);
      await install(s, file('2.0.0', original.scene.id));
      const input = restoreBody(
        s,
        await restorePreview(s, a.receipt.contentRef),
      );
      const pin = parsePersonalSceneContentRef(a.receipt.contentRef);
      const [source] =
        await f.db`select asset_id from allrice_company_asset_revisions where id=${pin.sourceRevisionId}`;
      let ready!: () => void, release!: () => void;
      const prepared = new Promise<void>((done) => {
        ready = done;
      });
      const commit = new Promise<void>((done) => {
        release = done;
      });
      const restoring = f.db.begin(async (tx) => {
        const receipt = await savePersonalSceneSkillInTransaction(
          s.owner,
          s.instance.id,
          input,
          tx,
        );
        ready();
        await commit;
        return receipt;
      });
      try {
        await Promise.race([
          prepared,
          restoring.then(() => {
            throw Error('restore committed before release');
          }),
        ]);
        await expect(
          f.db.begin(async (tx) => {
            await tx`set local lock_timeout='100ms'`;
            await tx`update allrice_company_assets set state='withdrawn' where id=${source!.asset_id}`;
          }),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        release();
      }
      const receipt = await restoring;
      await f.db`update allrice_company_assets set state='withdrawn' where id=${source!.asset_id}`;
      expect(await (await http(s, 'restore', input)).json()).toEqual({
        receipt,
      });
      await expect(
        getPersonalSceneSkillResource(
          s.owner,
          s.instance.id,
          receipt.contentRef,
          'assets/template.csv',
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    it('previews the named personal target without writing, then saves current bytes and an exact replay receipt', async () => {
      const s = await setup(),
        artifact = file();
      browser.context = s.owner;
      const previewResponse = await http(s, 'preview', {
        workspaceId: s.workspaceId,
        file: artifact,
      });
      expect(previewResponse.status).toBe(200);
      expect(previewResponse.headers.get('cache-control')).toBe(
        'private, no-store',
      );
      const preview =
        (await previewResponse.json()) as PersonalSceneFilePreview;
      expect(preview).toMatchObject({
        instanceId: s.instance.id,
        instanceName: '我的周报助理',
        expectedRevision: 0,
        expectedContentRef: null,
        current: null,
        currentScene: null,
      });
      expect(preview.file.report).toBeUndefined();
      const [before] =
        await f.db`select count(*)::int as n from allrice_employee_content_requests where actor_id=${s.owner.actor.id}`;
      expect(before!.n).toBe(0);
      const input = saveBody(s, preview);
      const first = await http(s, 'save', input);
      expect(first.status).toBe(200);
      const result = await first.json();
      expect(await (await http(s, 'save', input)).json()).toEqual(result);
      expect(
        (await getPersonalSceneSkill(s.owner, s.instance.id, artifact.scene.id))
          .content,
      ).toBe(artifact.procedure.body);
      expect(
        (await http(s, 'save', { ...input, changeSummary: 'different' }))
          .status,
      ).toBe(409);
      expect(
        (await listPersonalSceneFileHistory(s.owner, s.instance.id)).entries,
      ).toMatchObject([
        { contentRef: result.receipt.contentRef, available: true },
      ]);
      const [after] =
        await f.db`select count(*)::int as n from allrice_employee_content_requests where actor_id=${s.owner.actor.id}`;
      expect(after!.n).toBe(1);
    });

    it('updates only the selected scene, compares the current exact ref, and retains old resources and revisions', async () => {
      const s = await setup(),
        original = file();
      const a = await install(s, original);
      const other = file('1.0.0');
      other.scene.name = '另一场景';
      await install(s, other);
      const next = file('2.0.0', original.scene.id);
      const b = await install(s, next);
      expect(b.preview.expectedContentRef).toBe(b.preview.current!.contentRef);
      expect(b.preview.expectedRevision).toBeGreaterThan(a.receipt.revision);
      expect(
        (await getPersonalSceneSkill(s.owner, s.instance.id, other.scene.id))
          .content,
      ).toBe(other.procedure.body);
      const oldResource = await getPersonalSceneSkillResource(
        s.owner,
        s.instance.id,
        a.receipt.contentRef,
        'assets/template.csv',
      );
      expect(oldResource.bundleChecksum).toBe(a.receipt.bundleChecksum);
      expect(
        Buffer.from(oldResource.contentBase64, 'base64').toString(),
      ).toContain('1.0.0');
      const currentResource = await getPersonalSceneSkillResource(
        s.owner,
        s.instance.id,
        b.receipt.contentRef,
        'assets/template.csv',
      );
      expect(
        Buffer.from(currentResource.contentBase64, 'base64').toString(),
      ).toContain('2.0.0');
      const [old] =
        await f.db`select content from allrice_company_asset_revisions where id=${parsePersonalSceneContentRef(a.receipt.contentRef).sourceRevisionId}`;
      expect(old!.content.body).toBe(original.procedure.body);
      const history = await http(s, 'history');
      expect(history.status).toBe(200);
      const entries = (await history.json()).entries;
      expect(
        entries.some(
          (entry: { bundleChecksum: string }) =>
            entry.bundleChecksum === a.receipt.bundleChecksum,
        ),
      ).toBe(true);
      expect(
        entries.some(
          (entry: { bundleChecksum: string }) =>
            entry.bundleChecksum === b.receipt.bundleChecksum,
        ),
      ).toBe(true);
    });

    it('lets the owner accurately replace a revoked old package without previewing its bytes', async () => {
      const s = await setup(),
        original = file();
      const first = await install(s, original);
      const pin = parsePersonalSceneContentRef(first.receipt.contentRef);
      const [source] =
        await f.db`select asset_id from allrice_company_asset_revisions where id=${pin.sourceRevisionId}`;
      await f.db`update allrice_company_assets set state='withdrawn' where id=${source!.asset_id}`;
      const revokedHistory = await listPersonalSceneFileHistory(
        s.owner,
        s.instance.id,
      );
      expect(revokedHistory.entries).toMatchObject([
        { contentRef: first.receipt.contentRef, available: false },
      ]);
      expect(Object.hasOwn(revokedHistory.entries[0]!, 'contentChecksum')).toBe(
        false,
      );
      const preview = await previewPersonalSceneFile(s.owner, s.instance.id, {
        workspaceId: s.workspaceId,
        file: file('2.0.0', original.scene.id),
      });
      expect(preview.current).toBeNull();
      expect(preview.expectedContentRef).toBe(first.receipt.contentRef);
      expect(preview.currentMetadata).toBeNull();
      const saved = await http(s, 'save', saveBody(s, preview));
      expect(saved.status).toBe(200);
      await expect(
        getPersonalSceneSkillResource(
          s.owner,
          s.instance.id,
          first.receipt.contentRef,
          'assets/template.csv',
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (await getPersonalSceneSkill(s.owner, s.instance.id, original.scene.id))
          .bundleVersion,
      ).toBe('2.0.0');
    });

    it('attributes scene changes to their own save and compares across the history page boundary', async () => {
      const s = await setup(),
        original = file();
      const first = await install(s, original);
      const initial = (
        await listPersonalSceneFileHistory(s.owner, s.instance.id)
      ).entries[0]!;
      const pin = parsePersonalSceneContentRef(first.receipt.contentRef);
      const [row] =
        await f.db`select manifest from allrice_employee_content_revisions where id=${pin.revisionId}`;
      let currentRevision = first.receipt.revision;
      // Normal unpublished edits fill the existing 100-revision history page.
      // They do not alter any publication or immutable historical revision.
      for (let index = 0; index < 100; index++) {
        const draft = await mutateEmployeeContent(s.owner, {
          workspaceId: s.workspaceId,
          setId: pin.setId,
          ownership: {
            scope: 'personal',
            organizationId: s.owner.organizationId,
            ownerId: s.owner.actor.id,
          },
          target: { kind: 'instance', instanceId: s.instance.id },
          requestId: randomUUID(),
          expectedRevision: currentRevision,
          changeSummary: `Unpublished edit ${index}`,
          operation: 'save_draft',
          manifest: row!.manifest,
          textEdits: [],
        });
        currentRevision = draft.revision;
      }
      const other = file('2.0.0');
      other.scene.name = '另一场景';
      await install(s, other);
      const page = await listPersonalSceneFileHistory(s.owner, s.instance.id);
      expect(page.nextBeforeRevision).not.toBeNull();
      expect(page.entries.map((entry) => entry.sceneId)).toEqual([
        other.scene.id,
      ]);
      const older = await listPersonalSceneFileHistory(
        s.owner,
        s.instance.id,
        page.nextBeforeRevision!,
      );
      expect(older.entries).toEqual([initial]);
      expect(older.entries[0]).toMatchObject({
        revision: first.receipt.revision,
        changeSummary: first.input.changeSummary,
        createdAt: initial.createdAt,
        contentRef: first.receipt.contentRef,
      });
    }, 60000);

    it('stops concurrent saves on CAS and rejects a stale or wrong old reference', async () => {
      const s = await setup(),
        original = file();
      await install(s, original);
      const preview = await previewPersonalSceneFile(s.owner, s.instance.id, {
        workspaceId: s.workspaceId,
        file: file('2.0.0', original.scene.id),
      });
      browser.context = s.owner;
      expect(
        (
          await http(s, 'save', {
            ...saveBody(s, preview),
            expectedContentRef: null,
          })
        ).status,
      ).toBe(409);
      const replies = await Promise.all([
        http(s, 'save', saveBody(s, preview)),
        http(s, 'save', saveBody(s, preview)),
      ]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect((await http(s, 'save', saveBody(s, preview))).status).toBe(409);
    });

    it('keeps other owners, instances, tenants, machine callers and cross-origin input outside the entry', async () => {
      const s = await setup(),
        other = await setup(),
        artifact = file();
      const saved = await install(s, artifact);
      for (const { label, context, expected } of [
        { label: 'same-workspace peer', context: s.peer, expected: 404 },
        {
          label: 'foreign organization/workspace',
          context: other.owner,
          expected: 403,
        },
        { label: 'unauthenticated', context: null, expected: 401 },
      ]) {
        browser.context = context;
        expect(
          (
            await http(s, 'preview', {
              workspaceId: s.workspaceId,
              file: artifact,
            })
          ).status,
          label,
        ).toBe(expected);
        expect((await http(s, 'history')).status, label).toBe(expected);
      }
      const peerInstance = await createEmployeeInstance(s.owner, {
        workspaceId: s.workspaceId,
        assignmentId: s.assigned.id,
        requestId: randomUUID(),
        profile: { name: '本人另一员工' },
      });
      browser.context = s.owner;
      expect(
        (await (await http(s, 'history', undefined, peerInstance.id)).json())
          .entries,
      ).toEqual([]);
      expect(
        (
          await http(
            s,
            'save',
            {
              ...saved.input,
              requestId: randomUUID(),
              expectedRevision: 0,
              expectedContentRef: saved.receipt.contentRef,
            },
            peerInstance.id,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await http(
            s,
            'preview',
            { workspaceId: s.workspaceId, file: artifact },
            s.instance.id,
            'https://other.test',
          )
        ).status,
      ).toBe(403);
      for (const extra of [
        { ownerId: s.owner.actor.id },
        { sharedTarget: 'company' },
        { legacy: true },
      ])
        expect(
          (
            await http(s, 'preview', {
              workspaceId: s.workspaceId,
              file: artifact,
              ...extra,
            })
          ).status,
        ).toBe(400);
      await expect(
        previewPersonalSceneFile({ ...s.owner, sessionId: '' }, s.instance.id, {
          workspaceId: s.workspaceId,
          file: artifact,
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
      expect(
        (
          await http(s, 'preview', {
            workspaceId: s.workspaceId,
            file: artifact,
          })
        ).status,
      ).toBe(403);
      expect((await http(s, 'save', saved.input)).status).toBe(403);
    });

    it('rejects invalid bytes and ambiguous immutable package identities without guessing an empty target', async () => {
      const s = await setup(),
        original = file();
      const a = await install(s, original),
        b = await install(s, file('2.0.0'));
      browser.context = s.owner;
      const corrupt = file('3.0.0', original.scene.id);
      corrupt.procedure.body += 'tampered';
      expect(
        (
          await http(s, 'preview', {
            workspaceId: s.workspaceId,
            file: corrupt,
          })
        ).status,
      ).toBe(409);
      const pin = parsePersonalSceneContentRef(b.receipt.contentRef);
      const [stored] =
        await f.db`select manifest from allrice_employee_content_revisions where id=${pin.revisionId}`;
      // The legacy generic builder can represent an ambiguous personal scene.
      // Build a new revision normally; published history remains immutable.
      const manifest = structuredClone(stored!.manifest);
      const first = manifest.scenes.find(
        (scene: { id: string }) => scene.id === original.scene.id,
      );
      const second = manifest.scenes.find(
        (scene: { id: string }) => scene.id !== original.scene.id,
      );
      first.references.push(second.references[0]);
      const target = {
        workspaceId: s.workspaceId,
        setId: pin.setId,
        ownership: {
          scope: 'personal' as const,
          organizationId: s.owner.organizationId,
          ownerId: s.owner.actor.id,
        },
        target: { kind: 'instance' as const, instanceId: s.instance.id },
        changeSummary: 'Legacy scene with two complete procedures',
      };
      let revision = await mutateEmployeeContent(s.owner, {
        ...target,
        requestId: randomUUID(),
        expectedRevision: b.receipt.revision,
        operation: 'save_draft',
        manifest,
        textEdits: [],
      });
      revision = await mutateEmployeeContent(s.owner, {
        ...target,
        requestId: randomUUID(),
        expectedRevision: revision.revision,
        operation: 'validate',
        candidateRevisionId: revision.candidate.id,
        candidateDigest: revision.candidate.digest,
      });
      expect(revision.validation?.valid).toBe(true);
      await mutateEmployeeContent(s.owner, {
        ...target,
        requestId: randomUUID(),
        expectedRevision: revision.revision,
        operation: 'activate',
        candidateRevisionId: revision.candidate.id,
        candidateDigest: revision.candidate.digest,
      });
      expect(
        (
          await http(s, 'preview', {
            workspaceId: s.workspaceId,
            file: file('3.0.0', original.scene.id),
          })
        ).status,
      ).toBe(409);
      const [old] =
        await f.db`select content from allrice_company_asset_revisions where id=${parsePersonalSceneContentRef(a.receipt.contentRef).sourceRevisionId}`;
      expect(old!.content.body).toBe(original.procedure.body);
    });
  },
);
