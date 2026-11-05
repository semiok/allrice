import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  EmployeeSkillCatalogSchema,
  PersonalSkillPreviewResponseSchema,
  PersonalSkillConfirmResponseSchema,
  type RequestContext,
  type StoragePort,
} from '@allrice/contracts';
import { createFileArchive, readFileArchive } from '@allrice/file-archives';
import { SkillPreviewTokens, parsePersonalSkill } from '@allrice/skill-import';
import * as client from '../core/client.ts';
import * as data from '../data.ts';
import * as browserWriter from './personal-skill-browser.ts';
import { loadPlatformContentCatalog } from '../platform-content/catalog.ts';
import { synchronizePlatformContent } from '../platform-content/sync.ts';
import { previewPersonalSkillUpdateTarget } from './personal-skill-versions.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from '../identity.ts';
import {
  listAdminTenantEmployees,
  changeAdminTenantEmployee,
} from '../tenant-employees.ts';
import { getEmployeeWorkspace } from '../workspace/service.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import {
  savePlatformEmployeeDraft,
  assignPublishedPlatformEmployeeToWorkspace,
} from './platform-employees.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  freezePersonalSkills,
  managePersonalSkill,
  listPersonalSkills,
} from './personal-skills.ts';

const browser = vi.hoisted(() => ({
  context: null as RequestContext | null,
  storage: null as StoragePort | null,
}));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
}));
vi.mock('../../../../apps/web/lib/storage/runtime', () => ({
  getStorageAdapter: () => browser.storage,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const key = 'synthetic-skill-preview-key-000000000000';
const sourceText =
  '---\nname: weekly\ndescription: Prepare a weekly summary.\nwhenToUse: When summarizing a week.\nmetadata:\n  displayName: Weekly summary\n  version: 1.2.0\n---\nRead references/rules.md.\n';
const root = 'https://github.com/acme/skills';
// Web owns the route's Bundler typecheck; the DB suite loads its runtime entry
// like the existing personal-scene and personal-skill HTTP regressions.
const routePath =
  '../../../../apps/web/app/api/v1/employee-instances/[id]/skills/preview/route.ts';

suite('browser Skill source preview and confirmation', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let admin: RequestContext;
  let source: Awaited<ReturnType<typeof createEmployeeAdministrationFixture>>;
  let riceId: string;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    browser.storage = runtimeFixtureStorage(f.db);
    const p = await principal();
    admin = p.context;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    vi.stubEnv('ALLRICE_STORAGE_SIGNING_SECRET', key);
    source = await createEmployeeAdministrationFixture(f.db);
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    const [rice] =
      await f.db`select id from allrice_platform_employees where employee_key='rice'`;
    riceId = rice!.id;
    await savePlatformEmployeeDraft(riceId, {
      definition: {
        ...source.definition,
        key: 'rice',
        name: 'Platform assistant',
      },
    });
    await source.preview(riceId);
    expect((await source.publish(riceId)).valid).toBe(true);
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

  async function principal(slug = `preview-${randomUUID()}`) {
    const p = await ensureBootstrapPortalPrincipal(
      {
        organizationSlug: slug,
        organizationName: 'Preview fixture',
        workspaceSlug: 'default',
        workspaceName: 'Preview',
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
  async function setup(rice = false) {
    const owner = await principal();
    const peer = await principal(owner.slug);
    const employeeId = rice ? riceId : source.employeeId;
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
        (rice ? 'default-assistant' : source.definition.key),
    )!;
    return { owner, peer, assigned };
  }
  async function zip(path = 'SKILL.md') {
    return createFileArchive([
      { path, bytes: Buffer.from(sourceText) },
      {
        path: 'references/rules.md',
        bytes: Buffer.from('Always count records.'),
      },
      {
        path: 'scripts/never-run.js',
        bytes: Buffer.from('throw new Error("must not execute");'),
      },
    ]);
  }
  async function send(
    context: RequestContext | null,
    id: string,
    workspaceId: string,
    bytes: Uint8Array,
    origin = 'http://localhost:3000',
    target: unknown = { operation: 'install' },
    fileName = 'weekly.zip',
  ) {
    browser.context = context;
    const form = new FormData();
    form.set('input', JSON.stringify({ workspaceId, target }));
    form.set('file', new Blob([Buffer.from(bytes)]), fileName);
    const { POST } = await import(routePath);
    return POST(
      new Request(
        'http://localhost:3000/api/v1/employee-instances/' +
          id +
          '/skills/preview',
        { method: 'POST', headers: { origin }, body: form },
      ),
      { params: Promise.resolve({ id }) },
    );
  }
  async function counts() {
    return (
      await f.db`select (select count(*)::int from allrice_storage_objects) files,(select count(*)::int from allrice_personal_skill_installations) installs,(select count(*)::int from allrice_personal_skill_bindings) bindings,(select count(*)::int from allrice_employee_runs) runs`
    )[0];
  }

  async function confirm(
    context: RequestContext | null,
    id: string,
    workspaceId: string,
    preview: { previewId: string; digest: string },
    requestId = randomUUID(),
    origin = 'http://localhost:3000',
  ) {
    browser.context = context;
    const path =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/skills/confirm/route.ts';
    const { POST } = await import(path);
    return POST(
      new Request('http://localhost:3000/confirm', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          requestId,
          previewId: preview.previewId,
          digest: preview.digest,
        }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }
  async function installWeb(
    s: Awaited<ReturnType<typeof setup>>,
    id = s.assigned.id,
    bytes?: Uint8Array,
  ) {
    const response = await send(
      s.owner.context,
      id,
      s.owner.workspaceId,
      bytes ?? (await zip()),
    );
    expect(response.status).toBe(200);
    const preview = PersonalSkillPreviewResponseSchema.parse(
      await response.json(),
    );
    const requestId = randomUUID();
    const applied = await confirm(
      s.owner.context,
      id,
      s.owner.workspaceId,
      preview,
      requestId,
    );
    expect(applied.status).toBe(200);
    return {
      preview,
      requestId,
      result: PersonalSkillConfirmResponseSchema.parse(await applied.json()),
    };
  }
  async function catalogGet(
    context: RequestContext | null,
    id: string,
    workspaceId: string,
  ) {
    browser.context = context;
    const path =
      '../../../../apps/web/app/api/v1/employee-instances/[id]/skills/route.ts';
    const { GET } = await import(path);
    return GET(
      new Request('http://localhost:3000/skills?workspaceId=' + workspaceId),
      { params: Promise.resolve({ id }) },
    );
  }
  it.each(['rice', 'custom', 'professional'] as const)(
    'catalog: projects actual base and enabled personal Skills for %s without writes',
    async (kind) => {
      const platform = await loadPlatformContentCatalog();
      await synchronizePlatformContent(platform);
      const s = await setup(kind === 'rice');
      const second = await createEmployeeInstance(s.owner.context, {
        workspaceId: s.owner.workspaceId,
        assignmentId: s.assigned.id,
        requestId: randomUUID(),
        profile: { name: 'Other' },
      });
      const id = kind === 'custom' ? second.id : s.assigned.id;
      const installed = await installWeb(s, id);
      const unused = await createFileArchive([
        {
          path: 'SKILL.md',
          bytes: Buffer.from(sourceText.replace('name: weekly', 'name: other')),
        },
        {
          path: 'references/rules.md',
          bytes: Buffer.from('Private to other employee'),
        },
      ]);
      await installWeb(s, id === second.id ? s.assigned.id : second.id, unused);
      const before = await counts();
      const response = await catalogGet(
        s.owner.context,
        id,
        s.owner.workspaceId,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const body = EmployeeSkillCatalogSchema.parse(await response.json());
      expect(
        EmployeeSkillCatalogSchema.safeParse({ ...body, content: 'private' })
          .success,
      ).toBe(false);
      expect(body.instanceId).toBe(id);
      expect(body.canInstall).toBe(true);
      const hidden = [
        'governed-memory',
        'workflow-automation',
        'employee-customization',
        'experience-consolidation',
      ];
      const names = body.platformSkills.map(
        (item: { name: string }) => item.name,
      );
      for (const entry of platform.skills.filter(
        (item) => item.enabled && !hidden.includes(item.name),
      ))
        expect(names).toContain(entry.name);
      for (const name of hidden) expect(names).not.toContain(name);
      expect(names).not.toContain('document-analysis');
      expect(
        body.platformSkills.find(
          (item: { name: string }) => item.name === 'office',
        ),
      ).toMatchObject({
        displayName: 'Office 文档',
        kind: 'platform',
        canUninstall: false,
      });
      expect(body.personalSkills).toHaveLength(1);
      expect(body.personalSkills[0]).toMatchObject({
        kind: 'personal',
        name: 'weekly',
        displayName: 'Weekly summary',
        version: '1.2.0',
        installationVersion: 1,
        installationId: installed.result.skill.id,
        versionId: installed.result.skill.versionId,
        revision: installed.result.skill.revision,
        binding: { instanceId: id, enabled: true, epoch: 1 },
        canUninstall: true,
      });
      expect(body.personalSkills[0]).not.toHaveProperty('bindings');
      expect(JSON.stringify(body)).not.toContain('Always count records.');
      expect(await counts()).toEqual(before);
      await managePersonalSkill(s.owner.context, {
        workspaceId: s.owner.workspaceId,
        instanceId: id,
        installationId: installed.result.skill.id,
        expectedRevision: installed.result.skill.revision,
        requestId: randomUUID(),
        operation: 'disable',
      });
      expect(
        (
          await (
            await catalogGet(s.owner.context, id, s.owner.workspaceId)
          ).json()
        ).personalSkills,
      ).toEqual([]);
    },
  );
  it('catalog: follows current catalog versions and disabled entries without taking an old Run directory', async () => {
    const platform = await loadPlatformContentCatalog();
    await synchronizePlatformContent(platform);
    const s = await setup();
    const before = await counts();
    const web = platform.skills.find((skill) => skill.name === 'web-research')!;
    await synchronizePlatformContent({
      ...platform,
      catalogChecksum: 'sha256:' + '7'.repeat(64),
      skills: platform.skills.map((skill) =>
        skill.id === web.id
          ? {
              ...skill,
              version: '92.0.0',
              description: 'Current reviewed description',
            }
          : skill,
      ),
    });
    try {
      const current = await (
        await catalogGet(s.owner.context, s.assigned.id, s.owner.workspaceId)
      ).json();
      expect(
        current.platformSkills.find(
          (item: { name: string }) => item.name === 'web-research',
        ),
      ).toMatchObject({
        version: '92.0.0',
        description: 'Current reviewed description',
        displayName: '网页调研',
      });
      await f.db`update allrice_platform_dsh_skills set enabled=false where id=${web.id}`;
      const disabled = await (
        await catalogGet(s.owner.context, s.assigned.id, s.owner.workspaceId)
      ).json();
      expect(
        disabled.platformSkills.some(
          (item: { name: string }) => item.name === 'web-research',
        ),
      ).toBe(false);
      expect(await counts()).toEqual(before);
    } finally {
      // Restore only this disposable fixture; no production downgrade.
      await f.db`update allrice_platform_dsh_skills set version=${web.version},description=${web.description},enabled=true where id=${web.id}`;
      await synchronizePlatformContent(platform);
    }
  });
  it('catalog: excludes uninstalled entries and enforces current read and write authority', async () => {
    const s = await setup(true),
      foreign = await setup();
    const installed = await installWeb(s);
    await f.db`update allrice_memberships set role='viewer' where user_id=${s.owner.user.id}`;
    const readonly = await (
      await catalogGet(s.owner.context, s.assigned.id, s.owner.workspaceId)
    ).json();
    expect(readonly.canInstall).toBe(false);
    expect(readonly.personalSkills[0].canUninstall).toBe(false);
    const before = await counts();
    for (const context of [s.peer.context, foreign.owner.context]) {
      const response = await catalogGet(
        context,
        s.assigned.id,
        s.owner.workspaceId,
      );
      expect([403, 404]).toContain(response.status);
      expect(JSON.stringify(await response.json())).not.toContain('weekly');
    }
    expect(
      (await catalogGet(null, s.assigned.id, s.owner.workspaceId)).status,
    ).toBe(401);
    expect(await counts()).toEqual(before);
    await f.db`update allrice_memberships set role='member' where user_id=${s.owner.user.id}`;
    await managePersonalSkill(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      installationId: installed.result.skill.id,
      expectedRevision: installed.result.skill.revision,
      requestId: randomUUID(),
      operation: 'uninstall',
    });
    expect(
      (
        await (
          await catalogGet(s.owner.context, s.assigned.id, s.owner.workspaceId)
        ).json()
      ).personalSkills,
    ).toEqual([]);
    await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
    expect(
      (await catalogGet(s.owner.context, s.assigned.id, s.owner.workspaceId))
        .status,
    ).toBe(403);
    await f.db`update allrice_memberships set active=false where user_id=${s.owner.user.id}`;
    expect(
      (await catalogGet(s.owner.context, s.assigned.id, s.owner.workspaceId))
        .status,
    ).toBe(403);
  });
  it.each(['rice', 'custom', 'professional'] as const)(
    'confirms the exact ZIP for an owned %s, stores resources and replays without new writes',
    async (kind) => {
      const s = await setup(kind === 'rice');
      const id =
        kind === 'custom'
          ? (
              await createEmployeeInstance(s.owner.context, {
                workspaceId: s.owner.workspaceId,
                assignmentId: s.assigned.id,
                requestId: randomUUID(),
                profile: { name: 'Private author' },
              })
            ).id
          : s.assigned.id;
      const bytes = await zip();
      // User presses the approved “确认安装” button after viewing these files.
      const { preview, requestId, result } = await installWeb(s, id, bytes);
      expect(result.receipt).toMatchObject({
        operation: 'install',
        requestId,
        instanceId: id,
        installationId: result.skill.id,
        revision: 1,
        versionId: result.skill.versionId,
        source: {
          kind: 'attachment',
          fileName: 'weekly.zip',
          originalChecksum: preview.digest,
        },
        effectiveFrom: 'next_task',
      });
      const [row] =
        await f.db`select v.original_text,v.resource_manifest,o.* from allrice_personal_skill_versions v
      join allrice_storage_objects o on o.id=(v.resource_manifest->>'archiveObjectId')::uuid where v.id=${result.skill.versionId}`;
      expect(row!.state).toBe('ready');
      expect(row!.immutable).toBe(true);
      expect(row!.original_text).toBe(sourceText);
      const stream = await browser.storage!.get({
        id: row!.id,
        organizationId: row!.organization_id,
        workspaceId: row!.workspace_id,
        ownerId: row!.owner_id,
        key: row!.object_key,
        checksum: row!.checksum,
        mediaType: row!.media_type,
        sizeBytes: Number(row!.size_bytes),
        immutable: true,
        retentionUntil: null,
        deletedAt: null,
      });
      expect(
        Buffer.from(await new Response(stream).arrayBuffer()).equals(bytes),
      ).toBe(true);
      expect(
        row!.resource_manifest.resources.map((r: { path: string }) => r.path),
      ).toEqual(['references/rules.md', 'scripts/never-run.js']);
      const frozen = await freezePersonalSkills(
        s.owner.context,
        { id },
        { nativeSkills: [] },
      );
      expect(frozen.nativeSkills[0]).toMatchObject({
        name: 'weekly',
        content: (await parsePersonalSkill(Buffer.from(sourceText))).definition
          .content,
        personal: { versionId: result.skill.versionId },
      });
      const before = await counts();
      expect(
        await (
          await confirm(
            s.owner.context,
            id,
            s.owner.workspaceId,
            preview,
            requestId,
          )
        ).json(),
      ).toEqual(result);
      expect(await counts()).toEqual(before);
      const duplicate = await send(
        s.owner.context,
        id,
        s.owner.workspaceId,
        bytes,
      );
      expect(
        (
          await confirm(
            s.owner.context,
            id,
            s.owner.workspaceId,
            await duplicate.json(),
            requestId,
          )
        ).status,
      ).toBe(409);
    },
  );
  it('updates the existing owner library only after confirming the complete unchanged binding set', async () => {
    const s = await setup(true);
    const second = await createEmployeeInstance(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      assignmentId: s.assigned.id,
      requestId: randomUUID(),
      profile: { name: 'Second' },
    });
    await installWeb(s);
    const installed = await installWeb(s, second.id);
    const old = installed.result.skill;
    const bytes = await createFileArchive([
      {
        path: 'SKILL.md',
        bytes: Buffer.from(
          sourceText
            .replace('1.2.0', '2.0.0')
            .replace(
              'Read references/rules.md.',
              'Read references/rules.md twice.',
            ),
        ),
      },
      { path: 'references/rules.md', bytes: Buffer.from('New rules.') },
    ]);
    const target = {
      operation: 'update',
      installationId: old.id,
      expectedRevision: old.revision,
      expectedVersionId: old.versionId,
    };
    const preview = await (
      await send(
        s.owner.context,
        s.assigned.id,
        s.owner.workspaceId,
        bytes,
        undefined,
        target,
      )
    ).json();
    expect(preview.affectedBindings).toHaveLength(2);
    const requestId = randomUUID();
    const applied = await confirm(
      s.owner.context,
      s.assigned.id,
      s.owner.workspaceId,
      preview,
      requestId,
    );
    expect(applied.status).toBe(200);
    const result = await applied.json();
    expect(result.receipt).toMatchObject({
      operation: 'update',
      revision: old.revision + 1,
      affectedBindings: preview.affectedBindings,
    });
    expect(result.skill.versionId).not.toBe(old.versionId);
    for (const id of [s.assigned.id, second.id])
      expect(
        (
          await freezePersonalSkills(
            s.owner.context,
            { id },
            { nativeSkills: [] },
          )
        ).personalSkills!.skills[0]!.versionId,
      ).toBe(result.skill.versionId);
    const [previous] =
      await f.db`select original_text from allrice_personal_skill_versions where id=${old.versionId}`;
    expect(previous!.original_text).toBe(sourceText);
    expect(
      await (
        await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          preview,
          requestId,
        )
      ).json(),
    ).toEqual(result);
    expect(
      (
        await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          preview,
        )
      ).status,
    ).toBe(409);
  });
  it('records a provenance-only ZIP rename at full quota while sharing immutable archive bytes', async () => {
    const s = await setup();
    const bytes = await zip();
    const { result: old } = await installWeb(s, s.assigned.id, bytes);
    const before = await counts();
    await f.db`insert into allrice_storage_quotas(organization_id,workspace_id,limit_bytes) values(${s.owner.organizationId},${s.owner.workspaceId},${bytes.byteLength})`;
    const preview = await (
      await send(
        s.owner.context,
        s.assigned.id,
        s.owner.workspaceId,
        bytes,
        undefined,
        {
          operation: 'update',
          installationId: old.skill.id,
          expectedRevision: old.skill.revision,
          expectedVersionId: old.skill.versionId,
        },
        'renamed.zip',
      )
    ).json();
    const response = await confirm(
      s.owner.context,
      s.assigned.id,
      s.owner.workspaceId,
      preview,
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.receipt.unchanged).toBe(false);
    expect(result.skill.versionId).not.toBe(old.skill.versionId);
    expect(result.skill.source).toMatchObject({
      kind: 'attachment',
      fileName: 'renamed.zip',
    });
    const [previous] =
      await f.db`select source from allrice_personal_skill_versions where id=${old.skill.versionId}`;
    expect(previous!.source.fileName).toBe('weekly.zip');
    if (old.skill.source.kind !== 'attachment')
      throw new Error('ZIP fixture must retain its attachment source');
    expect(result.skill.source.objectId).toBe(old.skill.source.objectId);
    expect(await counts()).toEqual(before);
  });
  it('binds an existing archive and confirms an unchanged update without additional quota or storage writes', async () => {
    const s = await setup(true),
      bytes = await zip();
    const first = await installWeb(s, s.assigned.id, bytes);
    const second = await createEmployeeInstance(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      assignmentId: s.assigned.id,
      requestId: randomUUID(),
      profile: { name: 'Second' },
    });
    const [usage] =
      await f.db`select sum(size_bytes)::bigint bytes from allrice_storage_objects where workspace_id=${s.owner.workspaceId} and state<>'deleted'`;
    await f.db`insert into allrice_storage_quotas(organization_id,workspace_id,limit_bytes) values(${s.owner.organizationId},${s.owner.workspaceId},${usage!.bytes})`;
    const before = await counts();
    const binding = first.result.skill.bindings[0];
    const secondResult = await installWeb(s, second.id, bytes);
    expect(secondResult.result.skill.versionId).toBe(
      first.result.skill.versionId,
    );
    expect(
      secondResult.result.skill.bindings.find(
        (b: { instanceId: string }) => b.instanceId === s.assigned.id,
      ),
    ).toEqual(binding);
    const old = secondResult.result.skill;
    const preview = await (
      await send(
        s.owner.context,
        second.id,
        s.owner.workspaceId,
        bytes,
        undefined,
        {
          operation: 'update',
          installationId: old.id,
          expectedRevision: old.revision,
          expectedVersionId: old.versionId,
        },
      )
    ).json();
    const response = await confirm(
      s.owner.context,
      second.id,
      s.owner.workspaceId,
      preview,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).receipt).toMatchObject({
      unchanged: true,
      versionId: old.versionId,
      revision: old.revision,
    });
    expect(await counts()).toEqual({
      ...before,
      bindings: before!.bindings + 1,
    });
    const [versions] =
      await f.db`select count(*)::int n from allrice_personal_skill_versions where installation_id=${old.id}`;
    expect(versions!.n).toBe(1);
  });
  it.each([
    'metadata_response',
    'storage_put',
    'receipt_insert',
    'commit_response',
  ] as const)(
    'cleans only pending archives after %s failure and preserves committed immutable bytes',
    async (failure) => {
      const s = await setup(),
        bytes = await zip();
      const preview = await (
        await send(s.owner.context, s.assigned.id, s.owner.workspaceId, bytes)
      ).json();
      const requestId = randomUUID();
      const createMetadata = data.createStorageMetadata;
      const write = browserWriter.confirmPersonalSkillBrowser;
      const metadataSpy = vi.spyOn(data, 'createStorageMetadata');
      const putSpy = vi.spyOn(browser.storage!, 'put');
      const writerSpy = vi.spyOn(browserWriter, 'confirmPersonalSkillBrowser');
      if (failure === 'metadata_response')
        metadataSpy.mockImplementationOnce(async (...args) => {
          await createMetadata(...args);
          throw Error('synthetic metadata response failure');
        });
      if (failure === 'storage_put')
        putSpy.mockRejectedValueOnce(Error('synthetic storage failure'));
      if (failure === 'commit_response')
        writerSpy.mockImplementationOnce(async (...args) => {
          await write(...args);
          throw Error('synthetic uncertain commit response');
        });
      if (failure === 'receipt_insert') {
        await f.db`create function reject_browser_receipt() returns trigger language plpgsql as $$begin raise exception 'synthetic receipt failure'; end$$`;
        await f.db`create trigger reject_browser_receipt before insert on allrice_personal_skill_receipts for each row execute function reject_browser_receipt()`;
      }
      try {
        const response = await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          preview,
          requestId,
        );
        expect(response.status).toBe(500);
        expect(metadataSpy).toHaveBeenCalledTimes(1);
        const rows =
          await f.db`select state,immutable,object_key from allrice_storage_objects where owner_id=${s.owner.user.id}`;
        expect(rows).toHaveLength(1);
        const [row] = rows;
        if (failure === 'commit_response') {
          expect(row).toMatchObject({ state: 'ready', immutable: true });
          await expect(
            access(join(f.storageRoot, row!.object_key)),
          ).resolves.toBeUndefined();
          const recovered = await confirm(
            s.owner.context,
            s.assigned.id,
            s.owner.workspaceId,
            preview,
            requestId,
          );
          expect(recovered.status).toBe(200);
          expect(metadataSpy).toHaveBeenCalledTimes(1);
          expect(putSpy).toHaveBeenCalledTimes(1);
          expect(await listPersonalSkills(s.owner.context)).toHaveLength(1);
        } else {
          expect(row).toMatchObject({ state: 'deleted', immutable: false });
          await expect(
            access(join(f.storageRoot, row!.object_key)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await listPersonalSkills(s.owner.context)).toHaveLength(0);
          if (failure === 'metadata_response')
            expect(putSpy).not.toHaveBeenCalled();
        }
      } finally {
        metadataSpy.mockRestore();
        putSpy.mockRestore();
        writerSpy.mockRestore();
        if (failure === 'receipt_insert') {
          await f.db`drop trigger reject_browser_receipt on allrice_personal_skill_receipts`;
          await f.db`drop function reject_browser_receipt()`;
        }
      }
    },
  );
  it('rejects a changed impact set and an install preview predating revocation', async () => {
    const s = await setup();
    const { result } = await installWeb(s);
    const second = await createEmployeeInstance(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      assignmentId: s.assigned.id,
      requestId: randomUUID(),
      profile: { name: 'Other' },
    });
    const bytes = await zip();
    const target = {
      operation: 'update',
      installationId: result.skill.id,
      expectedRevision: result.skill.revision,
      expectedVersionId: result.skill.versionId,
    };
    const updatePreview = await (
      await send(
        s.owner.context,
        s.assigned.id,
        s.owner.workspaceId,
        bytes,
        undefined,
        target,
      )
    ).json();
    // An additional binding without changing installation revision still changes the confirmed set.
    await f.db`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
      values(${s.owner.organizationId},${s.owner.workspaceId},${s.owner.user.id},${second.id},${result.skill.id},false)`;
    expect(
      (
        await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          updatePreview,
        )
      ).status,
    ).toBe(409);
    const preview = await (
      await send(s.owner.context, s.assigned.id, s.owner.workspaceId, bytes)
    ).json();
    await managePersonalSkill(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      instanceId: s.assigned.id,
      installationId: result.skill.id,
      expectedRevision: result.skill.revision,
      requestId: randomUUID(),
      operation: 'disable',
    });
    expect(
      (
        await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          preview,
        )
      ).status,
    ).toBe(409);
    expect(
      (await listPersonalSkills(s.owner.context))[0]!.bindings.every(
        (b) => !b.enabled,
      ),
    ).toBe(true);
  });
  it('coalesces concurrent confirmation and refuses platform-name shadowing or revoked receipt replay', async () => {
    const s = await setup();
    const preview = await (
      await send(
        s.owner.context,
        s.assigned.id,
        s.owner.workspaceId,
        await zip(),
      )
    ).json();
    const requestId = randomUUID();
    const replies = await Promise.all(
      [1, 2].map(() =>
        confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          preview,
          requestId,
        ),
      ),
    );
    expect(replies.map((r) => r.status)).toEqual([200, 200]);
    const bodies = await Promise.all(replies.map((r) => r.json()));
    expect(bodies[0]).toEqual(bodies[1]);
    const [count] =
      await f.db`select count(*)::int n from allrice_personal_skill_versions where installation_id=${bodies[0].skill.id}`;
    expect(count!.n).toBe(1);
    const shadow = await createFileArchive([
      {
        path: 'SKILL.md',
        bytes: Buffer.from(
          sourceText.replace('name: weekly', `name: p18-${source.skillId}`),
        ),
      },
      { path: 'references/rules.md', bytes: Buffer.from('Rules') },
    ]);
    const shadowPreview = await (
      await send(s.owner.context, s.assigned.id, s.owner.workspaceId, shadow)
    ).json();
    expect(
      (
        await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          shadowPreview,
        )
      ).status,
    ).toBe(409);
    await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
    expect(
      (
        await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          preview,
          requestId,
        )
      ).status,
    ).toBe(403);
  });
  it('rejects expired, modified, cross-owner, cross-instance, cross-tenant and CSRF confirmation before installation', async () => {
    const s = await setup(),
      bytes = await zip();
    const preview = await (
      await send(s.owner.context, s.assigned.id, s.owner.workspaceId, bytes)
    ).json();
    const second = await createEmployeeInstance(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      assignmentId: s.assigned.id,
      requestId: randomUUID(),
      profile: { name: 'Other' },
    });
    const foreign = await setup();
    const before = await counts();
    for (const [context, id, workspaceId] of [
      [s.peer.context, s.assigned.id, s.owner.workspaceId],
      [foreign.owner.context, foreign.assigned.id, foreign.owner.workspaceId],
      [s.owner.context, second.id, s.owner.workspaceId],
    ] as const)
      expect([403, 404, 422]).toContain(
        (await confirm(context, id, workspaceId, preview)).status,
      );
    expect(
      (await confirm(null, s.assigned.id, s.owner.workspaceId, preview)).status,
    ).toBe(401);
    expect(
      (
        await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          preview,
          randomUUID(),
          'https://evil.test',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await confirm(s.owner.context, s.assigned.id, s.owner.workspaceId, {
          ...preview,
          digest: 'sha256:' + '0'.repeat(64),
        })
      ).status,
    ).toBe(422);
    const verified = new SkillPreviewTokens(key).verify(preview.previewId, {
      organizationId: s.owner.organizationId,
      workspaceId: s.owner.workspaceId,
      ownerId: s.owner.user.id,
      instanceId: s.assigned.id,
      digest: preview.digest,
    });
    const expired = new SkillPreviewTokens(key).issue(
      {
        ...verified.preview,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      },
      verified.bytes,
    );
    expect(
      (
        await confirm(s.owner.context, s.assigned.id, s.owner.workspaceId, {
          ...preview,
          previewId: expired,
        })
      ).status,
    ).toBe(422);
    expect(await counts()).toEqual(before);
  });

  it.each([true, false])(
    'previews an owned general instance (Rice=%s), preserving exact ZIP without writes',
    async (rice) => {
      const s = await setup(rice),
        bytes = await zip(),
        before = await counts();
      const response = await send(
        s.owner.context,
        s.assigned.id,
        s.owner.workspaceId,
        bytes,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        instanceId: s.assigned.id,
        installed: false,
        scriptsExecuted: false,
        item: {
          name: 'weekly',
          displayName: 'Weekly summary',
          version: '1.2.0',
        },
        source: { kind: 'zip', fileName: 'weekly.zip' },
      });
      const verified = new SkillPreviewTokens(key).verify(body.previewId, {
        organizationId: s.owner.organizationId,
        workspaceId: s.owner.workspaceId,
        ownerId: s.owner.user.id,
        instanceId: s.assigned.id,
        digest: body.digest,
      });
      expect(verified.bytes.equals(bytes)).toBe(true);
      expect(verified.preview.target).toEqual({
        operation: 'install',
        expectedInstallation: null,
      });
      expect(body.files.map((file: { path: string }) => file.path)).toEqual([
        'SKILL.md',
        'references/rules.md',
        'scripts/never-run.js',
      ]);
      expect(await counts()).toEqual(before);
    },
  );
  it('uses the same entry for an owned custom instance and rejects peer, tenant and CSRF substitution', async () => {
    const s = await setup(),
      bytes = await zip();
    const instance = await createEmployeeInstance(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      assignmentId: s.assigned.id,
      requestId: randomUUID(),
      profile: { name: 'Private helper' },
    });
    expect(
      (await send(s.owner.context, instance.id, s.owner.workspaceId, bytes))
        .status,
    ).toBe(200);
    const outsider = await principal();
    for (const [context, workspaceId] of [
      [s.peer.context, s.owner.workspaceId],
      [outsider.context, outsider.workspaceId],
    ] as const)
      expect(
        (await send(context, instance.id, workspaceId, bytes)).status,
      ).toBe(404);
    expect(
      (
        await send(
          s.owner.context,
          instance.id,
          s.owner.workspaceId,
          bytes,
          'https://evil.example',
        )
      ).status,
    ).toBe(403);
    expect(
      (await send(null, instance.id, s.owner.workspaceId, bytes)).status,
    ).toBe(401);
  });
  it('rejects missing root SKILL.md and invalid archives without writes', async () => {
    const s = await setup(),
      before = await counts();
    for (const bytes of [
      await zip('nested/SKILL.md'),
      Buffer.from('not a zip'),
    ])
      expect(
        (await send(s.owner.context, s.assigned.id, s.owner.workspaceId, bytes))
          .status,
      ).toBe(422);
    expect(await counts()).toEqual(before);
  });
  it('returns non-retryable validation errors for malformed multipart and UTF-8 bodies', async () => {
    const s = await setup(),
      before = await counts();
    browser.context = s.owner.context;
    const { POST } = await import(routePath);
    for (const [contentType, body] of [
      ['multipart/form-data', Buffer.from('missing boundary')],
      [
        'multipart/form-data; boundary=preview',
        Buffer.from(
          '--preview\r\nContent-Disposition: form-data; name="input"\r\n\r\n{',
        ),
      ],
      ['application/json', Buffer.from([0xff])],
    ] as const) {
      const response = await POST(
        new Request('http://localhost:3000/preview', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            'content-type': contentType,
          },
          body,
        }),
        { params: Promise.resolve({ id: s.assigned.id }) },
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: 'VALIDATION_FAILED', retryable: false },
      });
    }
    expect(await counts()).toEqual(before);
  });
  it.each([false, true])(
    'freezes a public commit and rechecks revocation (revoked=%s)',
    async (revoked) => {
      const s = await setup(),
        commit = 'a'.repeat(40),
        tree = 'b'.repeat(40);
      const bytes = Buffer.from(
        '---\nname: weekly\ndescription: Weekly summary\n---\nSummarize.',
      );
      const sha = createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (address: string) => {
          if (address.includes('raw.githubusercontent.com')) {
            if (revoked)
              await f.db`update allrice_employee_assignments set active=false where id=${s.assigned.id}`;
            return new Response(bytes);
          }
          if (address.includes('/git/trees/'))
            return Response.json({
              sha: tree,
              truncated: false,
              tree: [
                {
                  path: 'SKILL.md',
                  mode: '100644',
                  type: 'blob',
                  sha,
                  size: bytes.length,
                },
              ],
            });
          if (address.includes('/commits/'))
            return Response.json({
              sha: commit,
              commit: { tree: { sha: tree } },
            });
          return Response.json({
            private: false,
            full_name: 'acme/skills',
            default_branch: 'main',
          });
        }),
      );
      browser.context = s.owner.context;
      const before = await counts();
      const { POST } = await import(routePath);
      const response = await POST(
        new Request('http://localhost:3000/preview', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workspaceId: s.owner.workspaceId,
            target: { operation: 'install' },
            source: { kind: 'github', url: root },
          }),
        }),
        { params: Promise.resolve({ id: s.assigned.id }) },
      );
      // An existing owner's withdrawn assignment keeps the established 403
      // contract; a foreign instance remains a non-enumerating 404 above.
      expect(response.status).toBe(revoked ? 403 : 200);
      expect(await counts()).toEqual(before);
      const body = await response.json();
      if (revoked) {
        expect(body).toMatchObject({
          error: { code: 'AUTHORIZATION_DENIED', retryable: false },
        });
        expect(JSON.stringify(body)).not.toContain('previewId');
        expect(JSON.stringify(body)).not.toContain('Summarize.');
      } else {
        const verified = new SkillPreviewTokens(key).verify(body.previewId, {
          organizationId: s.owner.organizationId,
          workspaceId: s.owner.workspaceId,
          ownerId: s.owner.user.id,
          instanceId: s.assigned.id,
          digest: body.digest,
        });
        expect(verified.preview.source).toMatchObject({
          kind: 'github',
          commitSha: commit,
        });
        expect(await readFileArchive(verified.bytes)).toEqual([
          { path: 'SKILL.md', bytes },
        ]);
        const noFetch = vi.fn(() => {
          throw Error('confirmation must not refetch a moving branch');
        });
        vi.stubGlobal('fetch', noFetch);
        const confirmed = await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          body,
        );
        expect(confirmed.status).toBe(200);
        const installed = await confirmed.json();
        expect(installed.receipt.source).toMatchObject({
          kind: 'github',
          commitSha: commit,
          treeSha: tree,
        });
        const target = {
          operation: 'update' as const,
          installationId: installed.skill.id,
          expectedRevision: installed.skill.revision,
          expectedVersionId: installed.skill.versionId,
        };
        const impact = await previewPersonalSkillUpdateTarget(
          s.owner.context,
          s.assigned.id,
          target,
        );
        if (verified.preview.source.kind !== 'github')
          throw Error('expected public source');
        // A URL/ref alias resolving to the same commit has the same established
        // source identity. Only provenance-bearing changes create versions.
        const alias = new SkillPreviewTokens(key).issue(
          {
            ...verified.preview,
            target: { ...target, bindingsDigest: impact.bindingsDigest },
            source: {
              ...verified.preview.source,
              requestedUrl: root + '/tree/main',
              resolvedRef: 'main',
            },
          },
          verified.bytes,
        );
        const unchanged = await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          { previewId: alias, digest: body.digest },
        );
        expect(unchanged.status).toBe(200);
        expect((await unchanged.json()).receipt).toMatchObject({
          unchanged: true,
          versionId: installed.skill.versionId,
        });
        const zipPreview = await (
          await send(
            s.owner.context,
            s.assigned.id,
            s.owner.workspaceId,
            verified.bytes,
            undefined,
            target,
          )
        ).json();
        const changed = await confirm(
          s.owner.context,
          s.assigned.id,
          s.owner.workspaceId,
          zipPreview,
        );
        expect(changed.status).toBe(200);
        const changedResult = await changed.json();
        expect(changedResult.receipt.unchanged).toBe(false);
        expect(changedResult.skill.versionId).not.toBe(
          installed.skill.versionId,
        );
        expect(changedResult.skill.source.kind).toBe('attachment');
        const manifests =
          await f.db`select resource_manifest from allrice_personal_skill_versions where installation_id=${installed.skill.id}`;
        expect(manifests).toHaveLength(2);
        expect(
          new Set(manifests.map((v) => v.resource_manifest.archiveObjectId))
            .size,
        ).toBe(1);
        expect(changedResult.skill.source.objectId).toBe(
          manifests[0]!.resource_manifest.archiveObjectId,
        );
        expect(noFetch).not.toHaveBeenCalled();
      }
    },
  );

  it('previews updates only for the current owned binding, same name and exact version', async () => {
    const s = await setup(),
      bytes = await zip();
    // Bootstrap grants organization-wide membership. Scope this fixture to
    // the first workspace so removing the second grant really revokes access.
    const memberships =
      await f.db`update allrice_memberships set workspace_id=${s.owner.workspaceId}
      where organization_id=${s.owner.organizationId} and user_id=${s.owner.user.id} and workspace_id is null returning id`;
    expect(memberships).toHaveLength(1);
    const { definition, originalText } = await parsePersonalSkill(
      Buffer.from(sourceText),
    );
    const id = randomUUID(),
      version = randomUUID();
    const attachmentSource = {
      kind: 'attachment',
      objectId: randomUUID(),
      fileName: 'SKILL.md',
      originalChecksum:
        'sha256:' + createHash('sha256').update(originalText).digest('hex'),
      byteLength: Buffer.byteLength(originalText),
    };
    // Synthetic prior source metadata only; no model or tool invocation.
    await f.db.begin(async (tx) => {
      await tx`insert into allrice_personal_skill_installations(id,organization_id,owner_id,name,state,current_version_id) values(${id},${s.owner.organizationId},${s.owner.user.id},${definition.name},'installed',${version})`;
      await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum) values(${version},${s.owner.organizationId},${s.owner.user.id},${id},1,${tx.json(attachmentSource)},${originalText},${tx.json(definition)},${runtimePolicyDigest(definition)})`;
      await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled) values(${s.owner.organizationId},${s.owner.workspaceId},${s.owner.user.id},${s.assigned.id},${id},true)`;
    });
    const second = await createEmployeeInstance(s.owner.context, {
      workspaceId: s.owner.workspaceId,
      assignmentId: s.assigned.id,
      requestId: randomUUID(),
      profile: { name: 'Second private employee' },
    });
    const otherWorkspace = randomUUID();
    await f.db`insert into allrice_workspaces(id,organization_id,slug,name) values(${otherWorkspace},${s.owner.organizationId},'second','Other workspace')`;
    await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${s.owner.organizationId},${otherWorkspace},${s.owner.user.id},'member')`;
    await assignPublishedPlatformEmployeeToWorkspace(
      source.definition.key,
      otherWorkspace,
    );
    const otherContext = (await authenticateSession(
      (await createSession(s.owner.user.id)).token,
      {
        organizationId: s.owner.organizationId,
        workspaceId: otherWorkspace,
      },
    ))!;
    const otherInstance = (
      await getEmployeeWorkspace(otherContext, otherWorkspace)
    ).employees.find((item) => item.employeeKey === source.definition.key)!;
    await f.db`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled)
      values(${s.owner.organizationId},${s.owner.workspaceId},${s.owner.user.id},${second.id},${id},true),
      (${s.owner.organizationId},${otherWorkspace},${s.owner.user.id},${otherInstance.id},${id},false)`;
    const target = {
      operation: 'update',
      installationId: id,
      expectedRevision: 1,
      expectedVersionId: version,
    };
    const request = (archive: Uint8Array, selected = target) =>
      send(
        s.owner.context,
        s.assigned.id,
        s.owner.workspaceId,
        archive,
        undefined,
        selected,
      );
    const before = await counts();
    const response = await request(bytes);
    expect(response.status).toBe(200);
    const preview = await response.json();
    expect(preview).toMatchObject({
      operation: 'update',
      target,
    });
    expect(preview.affectedBindings).toHaveLength(3);
    expect(preview.affectedBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instanceId: s.assigned.id, enabled: true }),
        expect.objectContaining({
          instanceId: second.id,
          enabled: true,
          label: 'Second private employee',
        }),
        expect.objectContaining({
          instanceId: otherInstance.id,
          workspaceId: otherWorkspace,
          workspaceLabel: 'Other workspace',
          enabled: false,
        }),
      ]),
    );
    expect(preview.target.bindingsDigest).toBe(
      runtimePolicyDigest(preview.affectedBindings),
    );
    const recovered = new SkillPreviewTokens(key).verify(preview.previewId, {
      organizationId: s.owner.organizationId,
      workspaceId: s.owner.workspaceId,
      ownerId: s.owner.user.id,
      instanceId: s.assigned.id,
      digest: preview.digest,
    });
    expect(recovered.preview.target).toEqual({
      ...target,
      bindingsDigest: runtimePolicyDigest(preview.affectedBindings),
    });
    // A binding change is independently attested even if a caller bypasses the
    // normal mutation's installation revision increment in this fixture.
    await f.db`update allrice_personal_skill_bindings set enabled=false,epoch=epoch+1 where instance_id=${second.id} and installation_id=${id}`;
    const changed = await (await request(bytes)).json();
    expect(changed.target.expectedRevision).toBe(1);
    expect(changed.target.bindingsDigest).not.toBe(
      preview.target.bindingsDigest,
    );
    await f.db`delete from allrice_memberships where organization_id=${s.owner.organizationId} and workspace_id=${otherWorkspace} and user_id=${s.owner.user.id}`;
    const remainingAccess = await f.db`select id from allrice_memberships
      where organization_id=${s.owner.organizationId} and user_id=${s.owner.user.id}
      and (workspace_id is null or workspace_id=${otherWorkspace})`;
    expect(remainingAccess).toHaveLength(0);
    const inaccessible = await request(bytes);
    expect(inaccessible.status).toBe(403);
    const denied = await inaccessible.json();
    expect(denied).toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED', retryable: false },
    });
    expect(denied).not.toHaveProperty('affectedBindings');
    expect(denied).not.toHaveProperty('previewId');
    const deniedConfirm = await confirm(
      s.owner.context,
      s.assigned.id,
      s.owner.workspaceId,
      changed,
    );
    expect(deniedConfirm.status).toBe(403);
    expect(await deniedConfirm.json()).toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED' },
    });
    await f.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${s.owner.organizationId},${otherWorkspace},${s.owner.user.id},'member')`;
    expect(
      (await request(bytes, { ...target, expectedRevision: 2 })).status,
    ).toBe(409);
    const different = await createFileArchive([
      {
        path: 'SKILL.md',
        bytes: Buffer.from(
          '---\nname: other\ndescription: Another skill\n---\nDo another task.',
        ),
      },
    ]);
    expect((await request(different)).status).toBe(409);
    await f.db`update allrice_personal_skill_bindings set enabled=false where installation_id=${id}`;
    expect((await request(bytes)).status).toBe(404);
    expect(await counts()).toEqual(before);
  });
});
