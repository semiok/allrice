/** Synthetic historical first INSERTs in a private schema; no model or Dev writes. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from './employee-administration.fixture.ts';
import * as client from './core/client.ts';
import { skillBytesChecksum } from './skill-bundles.ts';
import {
  buildEmployeeRuntimePackage,
  materializePlatformEmployeeRevision,
  rollbackPlatformEmployee,
  assignPublishedPlatformEmployeeToWorkspace,
} from './employees/platform-employees.ts';
import { freezeEmployeeBaseSkills } from './employees/employee-base-skills.ts';
import { loadPlatformContentCatalog } from './platform-content/catalog.ts';
import { synchronizePlatformContent } from './platform-content/sync.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const retired = [
  ['7486aa1e-2495-4dd1-9eea-2ba4d65c761e', 'document-analysis'],
  ['4f94e92d-e065-4217-af0b-9c25d0802290', 'structured-deliverable'],
  ['d78b3556-821a-5550-bf13-d9dd84b9bbe0', 'development-cooperation'],
] as const;
type Fixture = Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
type Revision = Parameters<
  typeof materializePlatformEmployeeRevision
>[1]['revision'];
let fixture: Fixture | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture?.close();
  fixture = undefined;
});
const migration = () =>
  readFile(
    new URL(
      '../migrations/0241_retire_legacy_tools_skills.sql',
      import.meta.url,
    ),
    'utf8',
  );
const snapshot = async (db: Fixture['db'], table: string) =>
  db`select to_jsonb(t) value from ${db(table)} t order by to_jsonb(t)::text`;

async function historical() {
  fixture = await createRuntimeFixtureDatabase({
    throughMigration: '0239_workbench_file_favorites.sql',
  });
  const db = fixture.db;
  vi.spyOn(client, 'getDatabase').mockReturnValue(db);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    Error('No provider/network in retirement migration fixture'),
  );
  const f = await createEmployeeAdministrationFixture(db);
  await f.preview();
  expect((await f.publish()).valid).toBe(true);
  const [current] =
    await db`select v.*,a.id assignment_id from allrice_employee_versions v
    join allrice_employee_assignments a on a.employee_version_id=v.id
    where v.organization_id=${f.organizationId} and a.user_id=${f.ownerId}`;
  expect(current).toBeDefined();
  const copies: string[] = [];
  for (const [id, name] of retired) {
    const content = `# Latest retired ${name}\n`,
      checksum = skillBytesChecksum(content);
    await db`insert into allrice_platform_dsh_skills(id,name,description,content,checksum,source,enabled,source_ref,version,license,review_status)
      values(${id},${name},'Synthetic retired source',${content},${checksum},'allrice',false,
        ${'https://example.test/retired/' + name},'1.0.0','Apache-2.0','draft')`;
    await db`insert into allrice_platform_skill_bundle_versions(skill_id,version,checksum,bundle)
      values(${id},'1.0.0',${checksum},'{}')`;
    const copy = randomUUID();
    copies.push(copy);
    await db`insert into allrice_dsh_skills(id,organization_id,workspace_id,name,description,content,checksum,created_by)
      values(${copy},${f.organizationId},${f.workspaceId},${name},'Proven platform copy',${content},${checksum},${f.ownerId})`;
    await db`insert into allrice_employee_dsh_skill_bindings(organization_id,workspace_id,employee_id,skill_id,bound_by)
      values(${f.organizationId},${f.workspaceId},${current!.employee_id},${copy},${f.ownerId})`;
  }
  // The old frozen body differs from today's disabled catalog. Its exact
  // platform ID + body/checksum prove a tenant copy's origin across versions.
  const [oldId, oldName] = retired[2],
    content = '# Original historical source\n';
  const skill = {
    id: oldId,
    name: oldName,
    description: 'Synthetic original source',
    content,
    checksum: skillBytesChecksum(content),
    model_invocable: true,
    user_invocable: true,
    required_tool_refs: [],
    source: 'allrice' as const,
    source_ref: 'https://example.test/original',
    version: '0.9.0',
    license: 'Apache-2.0',
    review_status: 'reviewed' as const,
    reviewed_by_label: 'Synthetic',
    reviewed_at: new Date('2026-01-01T00:00:00Z'),
  };
  const definition = {
    ...f.definition,
    capabilities: { ...f.definition.capabilities, nativeSkillIds: [oldId] },
  };
  const pkg = buildEmployeeRuntimePackage({
    revision: 99,
    definition,
    skills: [skill],
  });
  const currentRevision = await f.revision();
  const profile = {
    ...currentRevision.runtime_profile,
    runtimePackage: pkg,
    nativeSkillIds: [oldId],
    nativeSkillChecksums: [skill.checksum],
  };
  const revisionId = randomUUID(),
    versionId = randomUUID(),
    instanceId = randomUUID();
  await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,checksum,runtime_profile)
    values(${revisionId},${f.employeeId},99,'published',${db.json(definition)},${skillBytesChecksum(JSON.stringify(definition))},${db.json(profile)})`;
  // Birth of an immutable historical row, never an UPDATE of a sealed version.
  const manifest = { ...current!.manifest, runtimePackage: pkg };
  await db`insert into allrice_employee_versions
    select (jsonb_populate_record(null::allrice_employee_versions,
      to_jsonb(v)||${db.json({ id: versionId, version: 99, manifest, config_checksum: pkg.checksum })}::jsonb)).*
    from allrice_employee_versions v where id=${current!.id}`;
  await db`insert into allrice_employee_version_sources(employee_version_id,organization_id,workspace_id,employee_id,platform_employee_id,platform_revision_id)
    values(${versionId},${f.organizationId},${f.workspaceId},${current!.employee_id},${f.employeeId},${revisionId})`;
  await db`insert into allrice_employee_instances(id,organization_id,workspace_id,owner_id,assignment_id,kind,creation_version_id,creation_request_id,creation_input)
    values(${instanceId},${f.organizationId},${f.workspaceId},${f.ownerId},${current!.assignment_id},'custom',${versionId},${randomUUID()},'{}')`;
  await db`insert into allrice_memories(organization_id,workspace_id,employee_id,owner_id,instance_id,content,summary,details,visibility,source_type,trust_level,lifecycle_state)
    values(${f.organizationId},${f.workspaceId},${current!.employee_id},${f.ownerId},${instanceId},'Current confirmed memory','Current confirmed memory','Keep exact details','private','user','user_confirmed','durable')`;
  await db`update allrice_dsh_skills set content=${content},checksum=${skill.checksum} where id=${copies[2]!}`;
  const otherWorkspace = randomUUID(),
    unproven = randomUUID();
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${otherWorkspace},${f.organizationId},'unrelated','Unrelated')`;
  await db`insert into allrice_dsh_skills(id,organization_id,workspace_id,name,description,content,checksum,created_by)
    values(${unproven},${f.organizationId},${otherWorkspace},${oldName},'Same name, unrelated author',
      'Independent personal content',${skillBytesChecksum('Independent personal content')},${f.ownerId})`;
  const methodTestId = randomUUID();
  await db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose)
    values(${methodTestId},${f.employeeId},${f.revisionId},'Synthetic historical method','failed','{}','method_candidate')`;
  const [oldRevision] = await db<
    Revision[]
  >`select * from allrice_platform_employee_revisions where id=${revisionId}`;
  return {
    db,
    f,
    current,
    copies,
    unproven,
    instanceId,
    versionId,
    revisionId,
    methodTestId,
    pkg,
    definition,
    oldRevision: oldRevision!,
  };
}

suite('MET-223 precise tool/Skill retirement migration', () => {
  it('deletes only retired sources and methods, preserving live creation pointers, memory and current publications', async () => {
    const x = await historical(),
      { db } = x;
    const preservedTables = [
      'allrice_employee_versions',
      'allrice_employee_instances',
      'allrice_memories',
      'allrice_employee_memory_operations',
      'allrice_employee_assignments',
      'allrice_employee_version_sources',
      'allrice_runs',
    ];
    const before = await Promise.all(
      preservedTables.map((t) => snapshot(db, t)),
    );
    const [personal] =
      await db`select to_jsonb(s) value from allrice_dsh_skills s where id=${x.unproven}`;
    await db.begin(async (tx) => {
      await tx.unsafe(await migration());
    });
    expect(
      await Promise.all(preservedTables.map((t) => snapshot(db, t))),
    ).toEqual(before);
    expect(
      await db`select id from allrice_platform_dsh_skills where id in ${db(retired.map((r) => r[0]))}`,
    ).toEqual([]);
    expect(
      await db`select skill_id from allrice_platform_skill_bundle_versions where skill_id in ${db(retired.map((r) => r[0]))}`,
    ).toEqual([]);
    expect(
      await db`select id from allrice_dsh_skills where id in ${db(x.copies)}`,
    ).toEqual([]);
    expect(
      await db`select id from allrice_employee_dsh_skill_bindings where skill_id in ${db(x.copies)}`,
    ).toEqual([]);
    expect(
      (
        await db`select to_jsonb(s) value from allrice_dsh_skills s where id=${x.unproven}`
      )[0],
    ).toEqual(personal);
    expect(
      await db`select id from allrice_platform_employee_test_runs where id=${x.methodTestId}`,
    ).toEqual([]);
    for (const name of [
      'allrice_employee_method_tests',
      'allrice_employee_method_file_steps',
      'allrice_employee_method_activations',
    ])
      expect(
        (await db`select to_regclass(${name}) relation`)[0]!.relation,
      ).toBeNull();
    expect(
      (
        await db`select status from allrice_platform_employee_revisions where id=${x.revisionId}`
      )[0]!.status,
    ).toBe('disabled');
    expect(
      (
        await db`select status from allrice_platform_employee_revisions where id=${x.f.revisionId}`
      )[0]!.status,
    ).toBe('published');
    await expect(
      rollbackPlatformEmployee(x.f.employeeId, {
        revisionId: x.revisionId,
        reason: 'Synthetic retired source must not be restored',
      }),
    ).rejects.toThrow('platform_employee_rollback_revision_not_found');
    const [disabled] = await db<
      Revision[]
    >`select * from allrice_platform_employee_revisions where id=${x.revisionId}`;
    await expect(
      db.begin((tx) =>
        materializePlatformEmployeeRevision(tx, {
          employeeId: x.f.employeeId,
          revision: disabled!,
          definition: x.definition,
          workspaceIds: [x.f.workspaceId],
          actorLabel: 'Synthetic',
        }),
      ),
    ).rejects.toThrow('platform_employee_revision_disabled');
    // A stale caller cannot materialize the old package with a pre-migration status.
    await expect(
      db.begin((tx) =>
        materializePlatformEmployeeRevision(tx, {
          employeeId: x.f.employeeId,
          revision: x.oldRevision,
          definition: x.definition,
          workspaceIds: [x.f.workspaceId],
          actorLabel: 'Synthetic',
        }),
      ),
    ).rejects.toThrow('retired_platform_skill_source');
    await synchronizePlatformContent(await loadPlatformContentCatalog());
    expect(
      (await freezeEmployeeBaseSkills([])).nativeSkills.every(
        (s) => !retired.some((r) => r[0] === s.id),
      ),
    ).toBe(true);
    await expect(freezeEmployeeBaseSkills(x.pkg.skills)).rejects.toThrow(
      'retired_platform_skill_source',
    );
    expect(
      await assignPublishedPlatformEmployeeToWorkspace(
        x.f.definition.key,
        x.f.workspaceId,
      ),
    ).toBeDefined();
    expect(
      (
        await db`select status from allrice_platform_employee_revisions where id=${x.revisionId}`
      )[0]!.status,
    ).toBe('disabled');
    await expect(
      db`delete from allrice_platform_skill_bundle_versions where skill_id=${x.f.skillId}`,
    ).rejects.toThrow('skill_bundle_version_is_immutable');
    await expect(db`insert into allrice_platform_employee_test_runs(id,employee_id,revision_id,requested_by_label,status,input,purpose)
      values(${randomUUID()},${x.f.employeeId},${x.f.revisionId},'Retired writer','failed','{}','method_candidate')`).rejects.toMatchObject(
      { code: '23514' },
    );
  }, 120000);

  it('rolls back the entire migration instead of cascading into a shared consumer', async () => {
    const x = await historical(),
      { db } = x;
    // Deliberately minimal existing FK boundary: the migration must not disable
    // or cascade any incoming shared relation, including future consumers.
    await db`create table migration_shared_reference(test_id uuid references allrice_platform_employee_test_runs(id))`;
    await db`insert into migration_shared_reference values(${x.methodTestId})`;
    const before = await Promise.all(
      [
        'allrice_platform_dsh_skills',
        'allrice_platform_skill_bundle_versions',
        'allrice_dsh_skills',
        'allrice_platform_employee_revisions',
      ].map((t) => snapshot(db, t)),
    );
    await expect(
      db.begin(async (tx) => {
        await tx.unsafe(await migration());
      }),
    ).rejects.toMatchObject({ code: '23503' });
    expect(
      await Promise.all(
        [
          'allrice_platform_dsh_skills',
          'allrice_platform_skill_bundle_versions',
          'allrice_dsh_skills',
          'allrice_platform_employee_revisions',
        ].map((t) => snapshot(db, t)),
      ),
    ).toEqual(before);
    expect(
      (
        await db`select to_regclass('allrice_employee_method_tests') relation`
      )[0]!.relation,
    ).not.toBeNull();
    expect(
      (
        await db`select tgenabled from pg_trigger where tgname='allrice_skill_bundle_immutable' and tgrelid='allrice_platform_skill_bundle_versions'::regclass`
      )[0]!.tgenabled,
    ).toBe('O');
    await expect(
      db`delete from allrice_platform_skill_bundle_versions where skill_id=${x.f.skillId}`,
    ).rejects.toThrow('skill_bundle_version_is_immutable');
  }, 120000);
});
