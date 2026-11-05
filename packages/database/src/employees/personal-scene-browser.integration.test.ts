import { createHash, randomUUID } from 'node:crypto';
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import {
  PersonalScenePreviewResponseSchema,
  PersonalSceneConfirmResponseSchema,
  PersonalSceneRemoveResponseSchema,
  type PersonalScenePreviewResponse,
  type RequestContext,
} from '@allrice/contracts';
import { createFileArchive } from '@allrice/file-archives';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  authenticateSession,
  createSession,
} from '../identity.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '../tenant-employees.ts';
import { getEmployeeWorkspace } from '../workspace/service.ts';
import { savePlatformEmployeeDraft } from './platform-employees.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import {
  getPersonalSceneSkill,
  getPersonalSceneSkillResource,
  listPersonalSceneSkills,
} from './personal-scene-skills.ts';

import { removePersonalSceneSkill } from './personal-scene-remove.ts';
import { inspectPersonalSceneSkill } from './personal-scene-reads.ts';
import {
  previewPersonalSceneRestore,
  listPersonalSceneFileHistory,
} from './personal-scene-files.ts';
import { parsePersonalSceneContentRef } from './personal-scene-skills.ts';
import { mutateEmployeeContent } from './employee-content.ts';

const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const origin = 'http://localhost:3000';
const body = (version: string) =>
  `## 工作步骤\nRead assets/result.txt for ${version}.\n## 交付内容\nA report.\n## 执行细节\nUse supplied data only.`;
const raw = (version = 'v1', name = 'weekly-review') =>
  `---\nname: ${name}\ndescription: Review the week\nwhenToUse: A weekly review\nmetadata: { displayName: Weekly review, version: ${version} }\n---\n${body(version)}`;
const contentFiles = (version = 'v1', name = 'weekly-review') => [
  { path: 'SKILL.md', bytes: Buffer.from(raw(version, name)) },
  { path: 'assets/result.txt', bytes: Buffer.from(`resource-${version}`) },
  {
    path: 'scripts/never-run.js',
    bytes: Buffer.from('throw new Error("must not execute");'),
  },
];
suite('browser exact Workflow source confirmation', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let admin: RequestContext;
  let publication: Awaited<
    ReturnType<typeof createEmployeeAdministrationFixture>
  >;
  let riceId: string;
  async function principal(slug = `scene-web-${randomUUID()}`) {
    const p = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: slug,
        organizationName: 'Synthetic',
        workspaceSlug: 'default',
        workspaceName: 'Default',
        email: `${randomUUID()}@example.test`,
        displayName: 'Owner',
        role: 'member',
      },
      f.db,
    );
    const context = (await authenticateSession(
      (await createSession(p.user.id)).token,
      { organizationId: p.organizationId, workspaceId: p.workspaceId },
    ))!;
    return { ...p, context, slug };
  }
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    const p = await principal();
    admin = p.context;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    vi.stubEnv(
      'ALLRICE_STORAGE_SIGNING_SECRET',
      'synthetic-scene-web-signing-key-0000000',
    );
    publication = await createEmployeeAdministrationFixture(f.db);
    await publication.preview();
    expect((await publication.publish()).valid).toBe(true);
    const [rice] =
      await f.db`select id from allrice_platform_employees where employee_key='rice'`;
    riceId = rice!.id;
    await savePlatformEmployeeDraft(riceId, {
      definition: {
        ...publication.definition,
        key: 'rice',
        name: 'Base assistant',
      },
    });
    await publication.preview(riceId);
    expect((await publication.publish(riceId)).valid).toBe(true);
  }, 120000);
  afterEach(() => {
    vi.unstubAllGlobals();
    browser.context = null;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f?.close();
  }, 30000);
  async function setup(kind: 'rice' | 'custom' | 'professional' = 'custom') {
    const owner = await principal(),
      peer = await principal(owner.slug);
    const employeeId = kind === 'rice' ? riceId : publication.employeeId;
    const e = (
      await listAdminTenantEmployees(
        admin,
        owner.organizationId,
        owner.workspaceId,
      )
    ).employees.find((item) => item.employeeId === employeeId)!;
    await changeAdminTenantEmployee(admin, owner.organizationId, {
      workspaceId: owner.workspaceId,
      employeeId,
      action: 'assign',
      revisionId: e.revisionId,
      expectedVersion: e.deployment?.version ?? null,
    });
    const assigned = (
      await getEmployeeWorkspace(owner.context, owner.workspaceId)
    ).employees.find(
      (item) =>
        item.employeeKey ===
        (kind === 'rice' ? 'default-assistant' : publication.definition.key),
    )!;
    const instance =
      kind === 'custom'
        ? await createEmployeeInstance(owner.context, {
            workspaceId: owner.workspaceId,
            assignmentId: assigned.id,
            requestId: randomUUID(),
            profile: { name: 'My employee' },
          })
        : assigned;
    return { owner, peer, assigned, instance };
  }
  async function counts() {
    return (
      await f.db`select (select count(*)::int from allrice_employee_content_sets) sets,(select count(*)::int from allrice_employee_content_revisions) revisions,(select count(*)::int from allrice_company_asset_revisions) sources,(select count(*)::int from allrice_storage_objects) objects,(select count(*)::int from allrice_employee_runs) runs`
    )[0];
  }
  async function preview(
    context: RequestContext | null,
    id: string,
    workspaceId: string,
    bytes?: Uint8Array,
    target: unknown = { operation: 'install' },
    url?: string,
    requestOrigin = origin,
  ) {
    browser.context = context;
    const form = new FormData();
    form.set('input', JSON.stringify({ workspaceId, target }));
    if (bytes) form.set('file', new Blob([Buffer.from(bytes)]), 'review.zip');
    const path =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/preview/route.ts';
    const { POST } = await import(path);
    return POST(
      new Request(origin + '/preview', {
        method: 'POST',
        headers: {
          origin: requestOrigin,
          ...(url ? { 'content-type': 'application/json' } : {}),
        },
        body: url
          ? JSON.stringify({
              workspaceId,
              target,
              source: { kind: 'github', url },
            })
          : form,
      }),
      { params: Promise.resolve({ id }) },
    );
  }
  async function confirm(
    context: RequestContext | null,
    id: string,
    workspaceId: string,
    p: Pick<PersonalScenePreviewResponse, 'previewId' | 'digest'>,
    requestId = randomUUID(),
    requestOrigin = origin,
  ) {
    browser.context = context;
    const path =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/confirm/route.ts';
    const { POST } = await import(path);
    return POST(
      new Request(origin + '/confirm', {
        method: 'POST',
        headers: { origin: requestOrigin, 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          requestId,
          previewId: p.previewId,
          digest: p.digest,
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }
  async function readPreview(
    s: Awaited<ReturnType<typeof setup>>,
    bytes?: Uint8Array,
    target?: unknown,
  ) {
    const result = await preview(
      s.owner.context,
      s.instance.id,
      s.owner.workspaceId,
      bytes ?? (await createFileArchive(contentFiles())),
      target,
    );
    expect(result.status).toBe(200);
    return PersonalScenePreviewResponseSchema.parse(await result.json());
  }
  async function removeScene(
    s: Awaited<ReturnType<typeof setup>>,
    sceneId: string,
    input: unknown,
    requestOrigin = origin,
  ) {
    const path =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/scene-skills/[sceneId]/route.ts';
    const { DELETE } = await import(path);
    return DELETE(
      new Request(origin + '/remove', {
        method: 'DELETE',
        headers: { origin: requestOrigin, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ id: s.instance.id, sceneId }) },
    );
  }
  async function installSource(
    s: Awaited<ReturnType<typeof setup>>,
    version: string,
    name: string,
    prior?: { sceneId: string; revision: number; contentRef: string },
  ) {
    const p = await readPreview(
      s,
      await createFileArchive(contentFiles(version, name)),
      prior
        ? {
            operation: 'update',
            sceneId: prior.sceneId,
            expectedRevision: prior.revision,
            expectedContentRef: prior.contentRef,
          }
        : undefined,
    );
    const response = await confirm(
      s.owner.context,
      s.instance.id,
      s.owner.workspaceId,
      p,
    );
    expect(response.status).toBe(200);
    return PersonalSceneConfirmResponseSchema.parse(await response.json())
      .receipt;
  }
  it.each(['rice', 'custom'] as const)(
    'scene removal: %s revokes all package versions, preserves other scenes and exact audit, and never revives on replay',
    async (kind) => {
      const s = await setup(kind);
      const other = await installSource(s, 'other', 'other-method');
      const first = await installSource(s, 'v1', 'weekly-review');
      const second = await installSource(s, 'v2', 'weekly-review', first);
      const before = await counts();
      const oldRevisions =
        await f.db`select id,manifest,digest from allrice_employee_content_revisions where created_by=${s.owner.context.actor.id} order by id`;
      const assetRevisions =
        await f.db`select id,content,digest from allrice_company_asset_revisions where created_by=${s.owner.context.actor.id} order by id`;
      const input = {
        workspaceId: s.owner.workspaceId,
        requestId: randomUUID(),
        expectedRevision: second.revision,
        expectedContentRef: second.contentRef,
      };
      browser.context = s.owner.context;
      const response = await removeScene(s, second.sceneId, input);
      expect(response.status).toBe(200);
      const result = PersonalSceneRemoveResponseSchema.parse(
        await response.json(),
      );
      expect(result.receipt).toMatchObject({
        operation: 'remove',
        scope: 'scene_all_history',
        sceneId: second.sceneId,
        instanceId: s.instance.id,
        requestId: input.requestId,
        revision: second.revision + 1,
        removed: true,
      });
      expect(
        (
          await listPersonalSceneSkills(s.owner.context, s.instance.id)
        ).skills.map((item) => item.sceneId),
      ).toEqual([other.sceneId]);
      for (const old of [first, second]) {
        await expect(
          inspectPersonalSceneSkill(
            s.owner.context,
            s.instance.id,
            old.contentRef,
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          getPersonalSceneSkillResource(
            s.owner.context,
            s.instance.id,
            old.contentRef,
            'assets/result.txt',
          ),
        ).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          previewPersonalSceneRestore(s.owner.context, s.instance.id, {
            workspaceId: s.owner.workspaceId,
            restoreContentRef: old.contentRef,
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
      }
      expect(
        (
          await inspectPersonalSceneSkill(
            s.owner.context,
            s.instance.id,
            other.contentRef,
          )
        ).content,
      ).toBe(body('other'));
      expect(
        await f.db`select id,content,digest from allrice_company_asset_revisions where created_by=${s.owner.context.actor.id} order by id`,
      ).toEqual(assetRevisions);
      expect(
        await f.db`select id,manifest,digest from allrice_employee_content_revisions where id in ${f.db(oldRevisions.map((item) => item.id))} order by id`,
      ).toEqual(oldRevisions);
      const history = await listPersonalSceneFileHistory(
        s.owner.context,
        s.instance.id,
      );
      expect(
        history.entries.filter((item) => item.sceneId === first.sceneId).length,
      ).toBeGreaterThan(0);
      expect(
        history.entries
          .filter((item) => item.sceneId === first.sceneId)
          .every((item) => !item.available),
      ).toBe(true);
      expect((await counts())!.runs).toBe(before!.runs);
      expect((await counts())!.objects).toBe(before!.objects);
      expect(
        await (await removeScene(s, second.sceneId, input)).json(),
      ).toEqual(result);
      const replacement = await installSource(s, 'new', 'weekly-review');
      const afterNew = await counts();
      browser.context = s.owner.context;
      expect(
        await (await removeScene(s, second.sceneId, input)).json(),
      ).toEqual(result);
      expect(await counts()).toEqual(afterNew);
      expect(
        (
          await getPersonalSceneSkill(
            s.owner.context,
            s.instance.id,
            replacement.sceneId,
          )
        ).content,
      ).toBe(body('new'));
    },
  );
  it('scene removal: rejects foreign principals, CSRF, CAS, changed requests and professional scope without collateral writes', async () => {
    const s = await setup(),
      first = await installSource(s, 'v1', 'weekly-review');
    const input = {
      workspaceId: s.owner.workspaceId,
      requestId: randomUUID(),
      expectedRevision: first.revision,
      expectedContentRef: first.contentRef,
    };
    const before = await counts();
    for (const context of [null, s.peer.context, (await principal()).context]) {
      browser.context = context;
      expect([401, 403, 404]).toContain(
        (await removeScene(s, first.sceneId, input)).status,
      );
      expect(await counts()).toEqual(before);
    }
    browser.context = s.owner.context;
    expect(
      (await removeScene(s, first.sceneId, input, 'https://other.test')).status,
    ).toBe(403);
    expect(
      (await removeScene(s, first.sceneId, { ...input, expectedRevision: 99 }))
        .status,
    ).toBe(409);
    expect(
      (
        await removeScene(s, first.sceneId, {
          ...input,
          operation: 'shared_remove',
        })
      ).status,
    ).toBe(400);
    expect(await counts()).toEqual(before);
    const professional = await setup('professional');
    browser.context = professional.owner.context;
    expect(
      (
        await removeScene(professional, first.sceneId, {
          ...input,
          workspaceId: professional.owner.workspaceId,
        })
      ).status,
    ).toBe(404);
    browser.context = s.owner.context;
    const success = await removeScene(s, first.sceneId, input);
    expect(success.status).toBe(200);
    const removed = await counts();
    expect(
      (await removeScene(s, first.sceneId, { ...input, expectedRevision: 99 }))
        .status,
    ).toBe(409);
    expect(await counts()).toEqual(removed);
    await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
    expect([403, 404, 409]).toContain(
      (await removeScene(s, first.sceneId, input)).status,
    );
    expect(await counts()).toEqual(removed);
  });
  it('scene removal: concurrent delete has one commit and old raw references cannot publish or edit archived bytes', async () => {
    const s = await setup(),
      installed = await installSource(s, 'v1', 'weekly-review');
    const pin = parsePersonalSceneContentRef(installed.contentRef);
    const [old] =
      await f.db`select manifest from allrice_employee_content_revisions where id=${pin.revisionId}`;
    const input = {
      workspaceId: s.owner.workspaceId,
      expectedRevision: installed.revision,
      expectedContentRef: installed.contentRef,
    };
    const results = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((requestId) =>
        removePersonalSceneSkill(
          s.owner.context,
          s.instance.id,
          installed.sceneId,
          { ...input, requestId },
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected').map((r) => r.reason.code),
    ).toEqual(['version_conflict']);
    const common = {
      changeSummary: 'Synthetic archived source admission',
      workspaceId: s.owner.workspaceId,
      setId: pin.setId,
      target: { kind: 'instance', instanceId: s.instance.id },
      ownership: {
        scope: 'personal',
        organizationId: s.owner.organizationId,
        ownerId: s.owner.context.actor.id,
      },
    };
    const draft = await mutateEmployeeContent(s.owner.context, {
      ...common,
      requestId: randomUUID(),
      expectedRevision: installed.revision + 1,
      operation: 'save_draft',
      manifest: old!.manifest,
      textEdits: [],
      changeSummary: 'Attempt old raw reference',
    });
    const checked = await mutateEmployeeContent(s.owner.context, {
      ...common,
      requestId: randomUUID(),
      expectedRevision: draft.revision,
      operation: 'validate',
      candidateRevisionId: draft.candidate.id,
      candidateDigest: draft.candidate.digest,
    });
    expect(checked.validation!.valid).toBe(false);
    await expect(
      mutateEmployeeContent(s.owner.context, {
        ...common,
        requestId: randomUUID(),
        expectedRevision: checked.revision,
        operation: 'activate',
        candidateRevisionId: checked.candidate.id,
        candidateDigest: checked.candidate.digest,
        invalidatePrevious: false,
      }),
    ).rejects.toMatchObject({ code: 'validation_required' });
    expect(
      (await listPersonalSceneSkills(s.owner.context, s.instance.id)).skills,
    ).toEqual([]);
    const [asset] =
      await f.db`select a.id,a.revision,r.content from allrice_company_assets a join allrice_company_asset_revisions r on r.asset_id=a.id where r.id=${pin.sourceRevisionId}`;
    const editManifest = structuredClone(old!.manifest);
    editManifest.scenes[0].references = [
      { sourceKind: 'draft_text', contentId: asset!.id },
    ];
    await expect(
      mutateEmployeeContent(s.owner.context, {
        ...common,
        requestId: randomUUID(),
        expectedRevision: checked.revision,
        operation: 'save_draft',
        manifest: editManifest,
        textEdits: [
          {
            ...asset!.content,
            contentId: asset!.id,
            revisionId: randomUUID(),
            expectedRevision: asset!.revision,
          },
        ],
        changeSummary: 'Attempt archived source edit',
      }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
  });
  it('scene removal: a legacy shared package reference blocks the transaction without revoking another scene', async () => {
    const s = await setup(),
      installed = await installSource(s, 'v1', 'weekly-review');
    const pin = parsePersonalSceneContentRef(installed.contentRef);
    const [row] =
      await f.db`select manifest from allrice_employee_content_revisions where id=${pin.revisionId}`;
    // A common reference is reachable through the existing raw custom writer.
    const manifest = structuredClone(row!.manifest);
    manifest.common.push(manifest.scenes[0].references[0]);
    const draft = await mutateEmployeeContent(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      requestId: randomUUID(),
      setId: pin.setId,
      target: { kind: 'instance', instanceId: s.instance.id },
      ownership: {
        scope: 'personal',
        organizationId: s.owner.organizationId,
        ownerId: s.owner.context.actor.id,
      },
      expectedRevision: installed.revision,
      operation: 'save_draft',
      manifest,
      textEdits: [],
      changeSummary: 'Synthetic legacy shared package',
    });
    const before = await counts();
    await expect(
      removePersonalSceneSkill(
        s.owner.context,
        s.instance.id,
        installed.sceneId,
        {
          workspaceId: s.owner.workspaceId,
          requestId: randomUUID(),
          expectedRevision: draft.revision,
          expectedContentRef: installed.contentRef,
        },
      ),
    ).rejects.toMatchObject({ code: 'source_changed' });
    expect(await counts()).toEqual(before);
    expect(
      (
        await inspectPersonalSceneSkill(
          s.owner.context,
          s.instance.id,
          installed.contentRef,
        )
      ).content,
    ).toBe(body('v1'));
  });

  it.each(['rice', 'custom'] as const)(
    'owner %s previews without writes and confirms exact bytes, provenance and idempotent receipt',
    async (kind) => {
      const s = await setup(kind),
        before = await counts();
      const p = await readPreview(s);
      expect(await counts()).toEqual(before);
      expect(p.installed).toBe(false);
      expect(p.scriptsExecuted).toBe(false);
      expect(p.item.frontmatter.name).toBe('weekly-review');
      const requestId = randomUUID();
      const response = await confirm(
        s.owner.context,
        s.instance.id,
        s.owner.workspaceId,
        p,
        requestId,
      );
      expect(response.status).toBe(200);
      const result = PersonalSceneConfirmResponseSchema.parse(
        await response.json(),
      );
      const skill = await getPersonalSceneSkill(
        s.owner.context,
        s.instance.id,
        result.receipt.sceneId,
      );
      expect(skill.content).toBe(body('v1'));
      expect(skill.nativeName).toBe('weekly-review');
      expect(skill.source).toEqual(p.source);
      expect(result.receipt.source).toEqual(p.source);
      expect(result.receipt.effectiveFrom).toBe('next_load');
      const exact = await getPersonalSceneSkillResource(
        s.owner.context,
        s.instance.id,
        result.receipt.contentRef,
        'assets/result.txt',
      );
      expect(Buffer.from(exact.contentBase64, 'base64').toString()).toBe(
        'resource-v1',
      );
      const saved = await counts();
      expect(
        await (
          await confirm(
            s.owner.context,
            s.instance.id,
            s.owner.workspaceId,
            p,
            requestId,
          )
        ).json(),
      ).toEqual(result);
      expect(await counts()).toEqual(saved);
      expect(saved!.runs).toBe(before!.runs);
      expect(saved!.objects).toBe(before!.objects);
      expect(
        (await confirm(s.owner.context, s.instance.id, s.owner.workspaceId, p))
          .status,
      ).toBe(409);
      expect(
        (await listPersonalSceneSkills(s.owner.context, s.instance.id)).skills,
      ).toHaveLength(1);
    },
  );
  it('updates only the attested scene revision, preserves old resources and rejects changed names or competing writes', async () => {
    const s = await setup();
    const p = await readPreview(s);
    const old = PersonalSceneConfirmResponseSchema.parse(
      await (
        await confirm(s.owner.context, s.instance.id, s.owner.workspaceId, p)
      ).json(),
    ).receipt;
    const target = {
      operation: 'update',
      sceneId: old.sceneId,
      expectedRevision: old.revision,
      expectedContentRef: old.contentRef,
    };
    expect(
      (
        await preview(
          s.owner.context,
          s.instance.id,
          s.owner.workspaceId,
          await createFileArchive(contentFiles('v2', 'renamed')),
          target,
        )
      ).status,
    ).toBe(409);
    const next = await readPreview(
      s,
      await createFileArchive(contentFiles('v2')),
      target,
    );
    expect(next.current!.source).toEqual(p.source);
    const result = await confirm(
      s.owner.context,
      s.instance.id,
      s.owner.workspaceId,
      next,
    );
    expect(result.status).toBe(200);
    const updated = PersonalSceneConfirmResponseSchema.parse(
      await result.json(),
    ).receipt;
    expect(updated.sceneId).toBe(old.sceneId);
    expect(updated.revision).toBe(old.revision + 1);
    expect(
      (await getPersonalSceneSkill(s.owner.context, s.instance.id, old.sceneId))
        .content,
    ).toBe(body('v2'));
    expect(
      Buffer.from(
        (
          await getPersonalSceneSkillResource(
            s.owner.context,
            s.instance.id,
            old.contentRef,
            'assets/result.txt',
          )
        ).contentBase64,
        'base64',
      ).toString(),
    ).toBe('resource-v1');
    const before = await counts();
    expect(
      (await confirm(s.owner.context, s.instance.id, s.owner.workspaceId, next))
        .status,
    ).toBe(409);
    expect(await counts()).toEqual(before);
    const collision = await readPreview(s);
    expect(
      (
        await confirm(
          s.owner.context,
          s.instance.id,
          s.owner.workspaceId,
          collision,
        )
      ).status,
    ).toBe(409);
    expect(await counts()).toEqual(before);
  });
  it('GitHub changes after preview cannot change the confirmed source; confirmation performs no fetch', async () => {
    const s = await setup();
    const commit = 'a'.repeat(40),
      treeSha = 'b'.repeat(40);
    const files = contentFiles();
    const hash = (bytes: Uint8Array) =>
      createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
    const fetcher = vi.fn(async (address: string | URL | Request) => {
      const url = String(address),
        json = (v: unknown) => Response.json(v);
      if (url === 'https://api.github.com/repos/acme/skills')
        return json({
          private: false,
          full_name: 'acme/skills',
          default_branch: 'main',
        });
      if (url.endsWith('/commits/main'))
        return json({ sha: commit, commit: { tree: { sha: treeSha } } });
      if (url.includes('/git/trees/'))
        return json({
          sha: treeSha,
          truncated: false,
          tree: files.map((file) => ({
            path: file.path,
            mode: '100644',
            type: 'blob',
            sha: hash(file.bytes),
            size: file.bytes.length,
          })),
        });
      const file = files.find(
        (item) =>
          url ===
          `https://raw.githubusercontent.com/acme/skills/${commit}/${item.path}`,
      );
      if (file) return new Response(file.bytes);
      throw new Error('unexpected synthetic request');
    });
    vi.stubGlobal('fetch', fetcher);
    const response = await preview(
      s.owner.context,
      s.instance.id,
      s.owner.workspaceId,
      undefined,
      undefined,
      'https://github.com/acme/skills',
    );
    expect(response.status).toBe(200);
    const p = PersonalScenePreviewResponseSchema.parse(await response.json());
    expect(p.source).toMatchObject({
      kind: 'github',
      commitSha: commit,
      originalChecksum: p.digest,
    });
    fetcher.mockImplementation(async () => {
      throw new Error('source has changed; confirmation must not fetch');
    });
    const calls = fetcher.mock.calls.length;
    const saved = await confirm(
      s.owner.context,
      s.instance.id,
      s.owner.workspaceId,
      p,
    );
    expect(saved.status).toBe(200);
    expect(fetcher.mock.calls).toHaveLength(calls);
    const receipt = PersonalSceneConfirmResponseSchema.parse(
      await saved.json(),
    ).receipt;
    expect(
      (
        await getPersonalSceneSkill(
          s.owner.context,
          s.instance.id,
          receipt.sceneId,
        )
      ).source,
    ).toEqual(p.source);
  });
  it('rejects foreign principals, professional instances, CSRF, tampering and revoked assignment without writes', async () => {
    const s = await setup(),
      other = await setup(),
      professional = await setup('professional');
    const p = await readPreview(s),
      bytes = await createFileArchive(contentFiles()),
      before = await counts();
    for (const context of [s.peer.context, other.owner.context, null]) {
      expect([401, 403, 404]).toContain(
        (await preview(context, s.instance.id, s.owner.workspaceId, bytes))
          .status,
      );
      expect([401, 403, 404]).toContain(
        (await confirm(context, s.instance.id, s.owner.workspaceId, p)).status,
      );
    }
    expect(
      (
        await preview(
          professional.owner.context,
          professional.instance.id,
          professional.owner.workspaceId,
          bytes,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await confirm(
          s.owner.context,
          s.instance.id,
          s.owner.workspaceId,
          p,
          randomUUID(),
          'https://evil.test',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await preview(
          s.owner.context,
          s.instance.id,
          s.owner.workspaceId,
          bytes,
          undefined,
          undefined,
          'https://evil.test',
        )
      ).status,
    ).toBe(403);
    const foreign = await confirm(
      s.owner.context,
      other.instance.id,
      other.owner.workspaceId,
      p,
    );
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED' },
    });
    expect(
      (
        await confirm(s.owner.context, s.instance.id, s.owner.workspaceId, {
          ...p,
          digest: 'sha256:' + '0'.repeat(64),
        })
      ).status,
    ).toBe(422);
    await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
    expect(
      (await confirm(s.owner.context, s.instance.id, s.owner.workspaceId, p))
        .status,
    ).toBe(403);
    expect(await counts()).toEqual(before);
  });
  it('returns the frozen framework error and makes no write for an ordinary Skill uploaded as Workflow', async () => {
    const s = await setup(),
      before = await counts();
    const bytes = await createFileArchive([
      {
        path: 'SKILL.md',
        bytes: Buffer.from(
          '---\nname: ordinary\ndescription: A valid ordinary Skill\n---\nDo a task.',
        ),
      },
    ]);
    const response = await preview(
      s.owner.context,
      s.instance.id,
      s.owner.workspaceId,
      bytes,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        message: '该技能不符合 workflow 规范。',
      },
    });
    expect(await counts()).toEqual(before);
  });
});
