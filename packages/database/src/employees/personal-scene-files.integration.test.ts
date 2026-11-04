import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  PersonalSceneFile,
  PersonalSceneFilePreview,
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
} from './personal-scene-files.ts';
import {
  getPersonalSceneSkill,
  getPersonalSceneSkillResource,
  parsePersonalSceneContentRef,
} from './personal-scene-skills.ts';
import { mutateEmployeeContent } from './employee-content.ts';
import { skillBundleChecksum, skillBytesChecksum } from '../skill-bundles.ts';

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
      operation: 'preview' | 'save' | 'history',
      body?: unknown,
      instanceId = s.instance.id,
      origin = 'https://example.test',
    ): Promise<Response> {
      const base = `https://example.test/api/v1/employee-instances/${instanceId}/scene-skills`;
      const params = { params: Promise.resolve({ id: instanceId }) };
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
