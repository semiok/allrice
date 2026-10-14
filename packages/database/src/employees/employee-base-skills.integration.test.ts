import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { EmployeeExecutionSnapshotSchema } from '@allrice/contracts';
import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { createEmployeeAdministrationFixture } from '../employee-administration.fixture.ts';
import { authenticateSession, createSession } from '../identity.ts';
import {
  createChatSession,
  getEmployeeWorkspace,
  sendChatMessage,
} from '../workspace/service.ts';
import { loadPlatformContentCatalog } from '../platform-content/catalog.ts';
import { synchronizePlatformContent } from '../platform-content/sync.ts';
import { readFrozenSkillResource } from '../skill-bundles.ts';
import {
  resolveEmployeeExecution,
  resolveEmployeeCapabilities,
} from './employeehub.ts';
import { createEmployeeInstance } from './employee-instances.ts';
import {
  assertFrozenBaseSkillCatalog,
  freezeEmployeeBaseSkills,
} from './employee-base-skills.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('foundation Skills: catalog → ordinary Run → frozen execution', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let catalog: Awaited<ReturnType<typeof loadPlatformContentCatalog>>;
  beforeAll(async () => {
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    catalog = await loadPlatformContentCatalog();
  }, 120000);
  beforeEach(async () => {
    await synchronizePlatformContent(catalog);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await f?.close();
  });

  async function setup() {
    const source = await createEmployeeAdministrationFixture(f.db);
    await source.preview();
    expect((await source.publish()).valid).toBe(true);
    await f.db`update allrice_memberships set role='member' where user_id=${source.ownerId}`;
    const context = (await authenticateSession(
      (await createSession(source.ownerId)).token,
      {
        organizationId: source.organizationId,
        workspaceId: source.workspaceId,
      },
    ))!;
    const assignment = (
      await getEmployeeWorkspace(context, source.workspaceId)
    ).employees.find(
      (e) =>
        e.currentVersion.manifest.schemaVersion === 2 &&
        e.currentVersion.manifest.runtimePackage?.skills.some(
          (s) => s.id === source.skillId,
        ),
    )!;
    expect(assignment).toBeDefined();
    const custom = await createEmployeeInstance(context, {
      workspaceId: source.workspaceId,
      assignmentId: assignment.id,
      requestId: randomUUID(),
      profile: { name: 'Synthetic custom worker' },
    });
    const send = async (
      kind: 'general' | 'custom',
      clientMessageId = randomUUID(),
    ) => {
      const session = await createChatSession(context, {
        workspaceId: source.workspaceId,
        ...(kind === 'custom'
          ? { employeeInstanceId: custom.id }
          : { employeeAssignmentId: assignment.id }),
        title: 'Foundation fixture',
      });
      const message = { text: 'Read a reviewed method', clientMessageId };
      const sent = await sendChatMessage(
        context,
        source.workspaceId,
        session.id,
        message,
      );
      return { sent, session, message };
    };
    const resolve = (runId: string) =>
      resolveEmployeeExecution({
        organizationId: source.organizationId,
        workspaceId: source.workspaceId,
        ownerId: source.ownerId,
        runId,
      });
    return { source, context, assignment, custom, send, resolve };
  }

  it('includes reviewed foundation Skills for both instance kinds without editing publication or expanding grants', async () => {
    const x = await setup();
    const [versionBefore] =
      await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
    for (const kind of ['general', 'custom'] as const) {
      const { sent } = await x.send(kind),
        resolved = await x.resolve(sent.run.id);
      const snapshot = resolved.executionSnapshot!;
      expect(snapshot.schemaVersion).toBe(2);
      if (snapshot.schemaVersion !== 2) throw Error('wrong snapshot');
      expect(snapshot.instance?.kind).toBe(kind);
      expect(snapshot.baseSkillCatalog?.skills.map((s) => s.id).sort()).toEqual(
        catalog.skills
          .filter((s) => s.enabled)
          .map((s) => s.id)
          .sort(),
      );
      expect(resolved.nativeSkills).toHaveLength(
        catalog.skills.filter((s) => s.enabled).length + 1,
      );
      expect(snapshot.employee.definitionChecksum).toBe(
        versionBefore!.config_checksum,
      );
      const manifest = snapshot.employee.definition;
      if (manifest.schemaVersion !== 2) throw Error('wrong manifest');
      expect(manifest.runtimePackage).toEqual(
        versionBefore!.manifest.runtimePackage,
      );
      const expectedGrants = resolveEmployeeCapabilities(
        manifest.capabilities,
        manifest.runtimePackage!.skills,
        manifest.securityPolicy.deniedCapabilities,
        manifest.capabilityBindings.toolNames,
      );
      expect(resolved.grantedCapabilities).toEqual(expectedGrants);
      expect(snapshot.capabilitySnapshot.bindings.toolNames).toEqual([
        'workspace.skill.read',
        ...(kind === 'custom' ? ['workspace.employee.method.inspect'] : []),
      ]);
      expect(resolved.grantedCapabilities).not.toContain('storage:write');
      const office = resolved.nativeSkills.find((s) => s.name === 'office')!;
      expect(office.bundle).toBeDefined();
      const resource = office.bundle!.resources[0]!;
      expect(
        readFrozenSkillResource(
          resolved.nativeSkills,
          office.name,
          resource.path,
        ).checksum,
      ).toBe(resource.checksum);
      // The old immutable employee package has only its explicit synthetic method.
      expect(manifest.runtimePackage!.skills.map((s) => s.id)).toEqual([
        x.source.skillId,
      ]);
    }
    const [versionAfter] =
      await f.db`select manifest,config_checksum from allrice_employee_versions where id=${x.assignment.currentVersion.id}`;
    expect(versionAfter).toEqual(versionBefore);
  });

  it('retains exact versions and original request receipts after catalog updates; new Runs use the new reviewed version', async () => {
    const x = await setup(),
      original = await x.send('custom');
    const before = await x.resolve(original.sent.run.id);
    const old = catalog.skills.find((s) => s.name === 'web-research')!;
    const changed = {
      ...catalog,
      catalogChecksum: `sha256:${'9'.repeat(64)}`,
      skills: catalog.skills.map((s) =>
        s.id === old.id
          ? {
              ...s,
              version: '91.0.0',
              description: s.description + ' Updated.',
            }
          : s,
      ),
    };
    await synchronizePlatformContent(changed);
    expect((await x.resolve(original.sent.run.id)).nativeSkills).toEqual(
      before.nativeSkills,
    );
    expect(
      (
        await sendChatMessage(
          x.context,
          x.source.workspaceId,
          original.session.id,
          original.message,
        )
      ).run.id,
    ).toBe(original.sent.run.id);
    const next = await x.resolve((await x.send('general')).sent.run.id);
    expect(next.nativeSkills.find((s) => s.id === old.id)?.description).toBe(
      old.description + ' Updated.',
    );
    expect(
      next.executionSnapshot?.schemaVersion === 2 &&
        next.executionSnapshot.baseSkillCatalog?.skills.find(
          (s) => s.id === old.id,
        )?.version,
    ).toBe('91.0.0');
    expect(
      before.executionSnapshot?.schemaVersion === 2 &&
        before.executionSnapshot.baseSkillCatalog?.skills.find(
          (s) => s.id === old.id,
        )?.version,
    ).toBe(old.version);
    // Restore the isolated fixture without pretending a production downgrade is allowed.
    await f.db`update allrice_platform_dsh_skills set version=${old.version}, description=${old.description} where id=${old.id}`;
  });

  it('rejects stale metadata, unreviewed entries, forged same-name identities and damaged Run governance', async () => {
    const old = catalog.skills.find((s) => s.name === 'web-research')!;
    await f.db`update allrice_platform_dsh_skills set review_status='rejected' where id=${old.id}`;
    expect(
      (await freezeEmployeeBaseSkills([])).nativeSkills.some(
        (s) => s.id === old.id,
      ),
    ).toBe(false);
    await synchronizePlatformContent(catalog);
    const frozen = await freezeEmployeeBaseSkills([]);
    await expect(
      freezeEmployeeBaseSkills([
        { ...frozen.nativeSkills[0]!, id: randomUUID() },
      ]),
    ).rejects.toThrow('base_skill_catalog_identity_conflict');
    await f.db`update allrice_platform_dsh_skills set version='92.0.0' where id=${old.id}`;
    await expect(freezeEmployeeBaseSkills([])).rejects.toThrow(
      'base_skill_catalog_source_changed',
    );
    await f.db`update allrice_platform_dsh_skills set version=${old.version} where id=${old.id}`;
    expect(() =>
      assertFrozenBaseSkillCatalog(
        frozen.catalog!,
        [...frozen.nativeSkills].reverse(),
      ),
    ).toThrow('base_skill_snapshot_checksum_mismatch');
    const x = await setup(),
      { sent } = await x.send('general');
    await expect(
      f.db`update allrice_employee_runs set execution_snapshot=jsonb_set(execution_snapshot,'{baseSkillCatalog,snapshotChecksum}','"broken"'::jsonb) where run_id=${sent.run.id}`,
    ).rejects.toThrow('immutable');
    expect(() =>
      assertFrozenBaseSkillCatalog(
        { ...frozen.catalog!, snapshotChecksum: `sha256:${'0'.repeat(64)}` },
        frozen.nativeSkills,
      ),
    ).toThrow('base_skill_snapshot_checksum_mismatch');
    const extra = frozen.nativeSkills.find((s) => !s.bundle)!;
    await expect(
      freezeEmployeeBaseSkills(
        Array.from({ length: 65 }, (_, i) => ({
          ...extra,
          id: randomUUID(),
          name: `extra-${i}`,
        })),
      ),
    ).rejects.toThrow('base_skill_catalog_budget_exceeded');
  });

  it('reads pre-catalog snapshots without adding fields or defaults', async () => {
    const [record] = await f.db<
      { value: never }[]
    >`delete from allrice_runtime_metadata where key='platform-content-catalog' returning value`;
    const frozen = await freezeEmployeeBaseSkills([]);
    expect(frozen).toEqual({ nativeSkills: [], catalog: undefined });
    const x = await setup(),
      { sent } = await x.send('general');
    const [row] =
      await f.db`select execution_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
    expect(
      EmployeeExecutionSnapshotSchema.parse(row!.execution_snapshot),
    ).not.toHaveProperty('baseSkillCatalog');
    await x.resolve(sent.run.id);
    await f.db`insert into allrice_runtime_metadata(key,value) values('platform-content-catalog',${f.db.json(record!.value)})`;
  });

  it('honors replacement identities even after legacy entries leave the current catalog', async () => {
    const office = catalog.skills.find((s) => s.name === 'office')!;
    const replaced = new Set(office.replaces!);
    expect(replaced.size).toBe(2);
    const original = catalog.skills
      .filter((s) => replaced.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        content: s.content,
        checksum: s.checksum,
        invocation: {
          modelInvocable: s.modelInvocable,
          userInvocable: s.userInvocable,
        },
        requiredToolRefs: s.requiredToolRefs,
      }));
    const [row] =
      await f.db`select value from allrice_runtime_metadata where key='platform-content-catalog'`;
    const metadata = row!.value;
    // A catalog may retain replacement identities after removing legacy entries.
    metadata.skills = metadata.skills.filter(
      (s: { id: string }) => !replaced.has(s.id),
    );
    await f.db`update allrice_runtime_metadata set value=${f.db.json(metadata)} where key='platform-content-catalog'`;
    const result = await freezeEmployeeBaseSkills(original);
    expect(result.nativeSkills.filter((s) => replaced.has(s.id))).toEqual([]);
    expect(result.nativeSkills.some((s) => s.id === office.id)).toBe(true);
    expect(original.map((s) => s.id).sort()).toEqual([...replaced].sort());
  });
});
