import { createHash, randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import { createFileArchive, readFileArchive } from '@allrice/file-archives';
import { SkillPreviewTokens, parsePersonalSkill } from '@allrice/skill-import';
import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
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
import { savePlatformEmployeeDraft } from './platform-employees.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';

const browser = vi.hoisted(() => ({ context: null as RequestContext | null }));
vi.mock('../../../../apps/web/lib/identity/session', () => ({
  getRequestContext: async () => browser.context,
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

suite('authenticated browser Skill source preview without installation', () => {
  let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
  let admin: RequestContext;
  let source: Awaited<ReturnType<typeof createEmployeeAdministrationFixture>>;
  let riceId: string;
  beforeAll(async () => {
    f = await createRuntimeFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
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
  ) {
    browser.context = context;
    const form = new FormData();
    form.set('input', JSON.stringify({ workspaceId, target }));
    form.set('file', new Blob([Buffer.from(bytes)]), 'weekly.zip');
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
      expect(verified.preview.target).toEqual({ operation: 'install' });
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
      expect(response.status).toBe(revoked ? 404 : 200);
      expect(await counts()).toEqual(before);
      const body = await response.json();
      if (revoked) expect(JSON.stringify(body)).not.toContain('previewId');
      else {
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
      }
    },
  );

  it('previews updates only for the current owned binding, same name and exact version', async () => {
    const s = await setup(),
      bytes = await zip();
    const { definition, originalText } = await parsePersonalSkill(
      Buffer.from(sourceText),
    );
    const id = randomUUID(),
      version = randomUUID();
    const source = {
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
      await tx`insert into allrice_personal_skill_versions(id,organization_id,owner_id,installation_id,version,source,original_text,definition,definition_checksum) values(${version},${s.owner.organizationId},${s.owner.user.id},${id},1,${tx.json(source)},${originalText},${tx.json(definition)},${runtimePolicyDigest(definition)})`;
      await tx`insert into allrice_personal_skill_bindings(organization_id,workspace_id,owner_id,instance_id,installation_id,enabled) values(${s.owner.organizationId},${s.owner.workspaceId},${s.owner.user.id},${s.assigned.id},${id},true)`;
    });
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
    expect(await response.json()).toMatchObject({
      operation: 'update',
      target,
    });
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
