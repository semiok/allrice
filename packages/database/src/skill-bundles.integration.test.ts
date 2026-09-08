import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS,
  PLATFORM_EMPLOYEE_DSH_DISTRIBUTION,
  PlatformEmployeeRuntimeProfileSchema,
  type PlatformEmployeeDefinition,
  type SkillBundle,
} from '@allrice/contracts';
import type * as DatabaseClient from './core/client.ts';
import {
  assignPublishedPlatformEmployeeToWorkspace,
  rollbackPlatformEmployee,
} from './employees/platform-employees.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';
import {
  planPlatformSkillSync,
  readExistingPlatformSkills,
  synchronizePlatformContent,
} from './platform-content/sync.ts';
import type { PlatformContentCatalog } from './platform-content/catalog.ts';
import {
  buildEmployeeRuntimePackage,
  runtimePackageSystemPrompt,
} from './platform-employees/runtime-package.ts';
import {
  skillBundleChecksum,
  skillBytesChecksum,
  readFrozenSkillResource,
} from './skill-bundles.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
let admin: ReturnType<typeof postgres>;
let db: ReturnType<typeof postgres>;
const schema = `p18_bundle_${randomUUID().replaceAll('-', '')}`;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof DatabaseClient>()),
  getDatabase: () => db,
}));

/** Deliberately seeds already-published immutable revision fixtures. These tests
 * exercise actual tenant materialization, rollback and persisted Run reads;
 * they do not claim to exercise model preview or the publish approval UI. */
async function fixture() {
  const ids = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    platformEmployeeId: randomUUID(),
    skillId: randomUUID(),
    revision1: randomUUID(),
    revision2: randomUUID(),
  };
  const employeeKey = `p18-${ids.platformEmployeeId}`,
    skillName = `p18-${ids.skillId}`;
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${ids.ownerId},${`${ids.ownerId}@example.test`},'P18 fixture','not-a-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${ids.organizationId},${employeeKey},'P18 fixture')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${ids.workspaceId},${ids.organizationId},'default','P18 fixture')`;
  await db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${ids.organizationId},${ids.workspaceId},${ids.ownerId},'admin')`;
  const definition: PlatformEmployeeDefinition = {
    schemaVersion: 1,
    key: employeeKey,
    name: 'P18 synthetic employee',
    description: 'Test package release authority',
    appearance: { avatarType: 'initials', avatarValue: 'P' },
    identity: {
      role: 'Synthetic reviewer',
      mission: 'Test only',
      workStyle: 'Controlled',
      behaviorRules: ['Use authorized inputs'],
      safetyBoundaries: ['No implicit authority'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
    systemPrompt: 'Platform policy for synthetic test.',
    modelPolicy: {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      timeoutMs: 300000,
      fallbackModels: [],
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
    },
    capabilities: {
      nativeSkillIds: [ids.skillId],
      workflowRevisionIds: [],
      knowledgeRevisionIds: [],
      toolNames: ['web.search'],
      connectorRefs: [],
    },
    securityPolicy: {
      dataScopes: ['workspace'],
      approvalPolicy: 'confirm_side_effects',
      bridgeAccess: 'read_only',
      connectorIdentityModes: [],
      deniedCapabilities: ['secret:use'],
    },
  };
  function version(revision: number) {
    const content = `# Synthetic Skill\nVersion ${revision} instructions.\n`;
    const asset = Buffer.from(`fixture amount=${revision * 100}\n`);
    const sourceRef = `https://example.test/skills/${skillName}/v${revision}`;
    const payload: Omit<SkillBundle, 'checksum'> = {
      schemaVersion: 1,
      version: `${revision}.0.0`,
      contentChecksum: skillBytesChecksum(content),
      sourceRef,
      license: 'Apache-2.0',
      reviewedBy: 'P18 synthetic reviewer',
      resources: [
        {
          path: 'references/rules.txt',
          mediaType: 'text/plain',
          byteLength: asset.length,
          checksum: skillBytesChecksum(asset),
          contentBase64: asset.toString('base64'),
        },
      ],
      dependencies: [{ kind: 'tool', name: 'web.search' }],
    };
    const bundle = { ...payload, checksum: skillBundleChecksum(payload) };
    const skill = {
      id: ids.skillId,
      name: skillName,
      description: 'Synthetic instructions with immutable resources',
      content,
      checksum: skillBytesChecksum(content),
      model_invocable: true,
      user_invocable: true,
      required_tool_refs: ['web.search'],
      source: 'allrice' as const,
      source_ref: sourceRef,
      version: bundle.version,
      license: bundle.license,
      review_status: 'reviewed' as const,
      reviewed_by_label: bundle.reviewedBy,
      reviewed_at: new Date('2026-09-08T00:00:00Z'),
      bundle,
    };
    const runtimePackage = buildEmployeeRuntimePackage({
      revision,
      definition,
      skills: [skill],
    });
    const profile = PlatformEmployeeRuntimeProfileSchema.parse({
      schemaVersion: 1,
      harness: 'dsh',
      distributionGeneration: PLATFORM_EMPLOYEE_DSH_DISTRIBUTION,
      approvedPluginIds: [...PLATFORM_EMPLOYEE_DSH_APPROVED_PLUGINS],
      employeeKey,
      provider: definition.modelPolicy.provider,
      model: definition.modelPolicy.model,
      reasoningEffort: definition.modelPolicy.reasoningEffort,
      timeoutMs: 300000,
      credentialReference: definition.modelPolicy.credentialReference,
      baseUrl: null,
      systemPrompt: runtimePackageSystemPrompt({
        platformPolicy: definition.systemPrompt,
        runtimePackage,
      }),
      nativeSkillIds: [ids.skillId],
      nativeSkillChecksums: [skill.checksum],
      toolNames: ['web.search'],
      connectorRefs: [],
      securityPolicy: definition.securityPolicy,
      runtimePackage,
    });
    return { skill, bundle, runtimePackage, profile, asset };
  }
  const v1 = version(1),
    v2 = version(2);
  // The mutable current catalog intentionally contains v2 before v1 is assigned.
  await db`insert into allrice_platform_dsh_skills(id,name,description,content,checksum,required_tool_refs,source,source_ref,version,license,review_status,reviewed_by_label,reviewed_at,bundle) values(${ids.skillId},${skillName},${v2.skill.description},${v2.skill.content},${v2.skill.checksum},${db.json(['web.search'])},'allrice',${v2.skill.source_ref},${v2.skill.version},${v2.skill.license},'reviewed',${v2.skill.reviewed_by_label},${v2.skill.reviewed_at},${db.json(v2.bundle)})`;
  for (const v of [v1, v2])
    await db`insert into allrice_platform_skill_bundle_versions(skill_id,version,checksum,bundle) values(${ids.skillId},${v.bundle.version},${v.bundle.checksum},${db.json(v.bundle)})`;
  await db`insert into allrice_platform_employees(id,employee_key,name,description,status) values(${ids.platformEmployeeId},${employeeKey},'P18 employee','Test fixture','published')`;
  for (const [index, v] of [v1, v2].entries())
    await db`insert into allrice_platform_employee_revisions(id,employee_id,revision,status,definition,runtime_profile,checksum,published_at,published_by_label) values(${index === 0 ? ids.revision1 : ids.revision2},${ids.platformEmployeeId},${index + 1},'published',${db.json(definition)},${db.json(v.profile)},${v.runtimePackage.checksum},now(),'P18 synthetic reviewer')`;
  await db`update allrice_platform_employees set current_published_revision_id=${ids.revision1},current_draft_revision_id=${ids.revision1} where id=${ids.platformEmployeeId}`;
  async function tenantSkill() {
    const [row] =
      await db`select content,checksum,bundle from allrice_dsh_skills where organization_id=${ids.organizationId} and workspace_id=${ids.workspaceId} and name=${skillName}`;
    return row;
  }
  return { ids, employeeKey, skillName, v1, v2, tenantSkill };
}

async function persistRun(
  f: Awaited<ReturnType<typeof fixture>>,
  version: 1 | 2,
) {
  const v = version === 1 ? f.v1 : f.v2;
  const runId = randomUUID(),
    sessionId = randomUUID(),
    userMessageId = randomUUID(),
    assistantMessageId = randomUUID();
  const [assignment] =
    await db`select id,employee_version_id from allrice_employee_assignments where organization_id=${f.ids.organizationId} and workspace_id=${f.ids.workspaceId} and user_id=${f.ids.ownerId}`;
  await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${sessionId},${f.ids.organizationId},${f.ids.workspaceId},${f.ids.ownerId},'P18 preserved session',${assignment!.id},${assignment!.employee_version_id})`;
  for (const [id, role] of [
    [userMessageId, 'user'],
    [assistantMessageId, 'assistant'],
  ])
    await db`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content) values(${id!},${f.ids.organizationId},${f.ids.workspaceId},${sessionId},${f.ids.ownerId},${role!},${db.json({ text: 'Synthetic package test' })})`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${runId},${f.ids.organizationId},${f.ids.workspaceId},${f.ids.ownerId},'running',${db.json({})},${db.json({})})`;
  const provider = {
    provider: 'dsh',
    authMode: 'platform_subscription',
    route: 'openai-codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'xhigh',
    credentialReference: 'deployment:codex-default',
    baseUrl: null,
  };
  await db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills) values(${runId},${f.ids.organizationId},${f.ids.workspaceId},${f.ids.ownerId},${assignment!.id},${assignment!.employee_version_id},${sessionId},${userMessageId},${assistantMessageId},${db.json(provider)},${db.json({ systemPrompt: 'Synthetic frozen policy', conversation: [], memories: [], userRequest: 'Read a packaged resource' })},${db.json(v.runtimePackage.skills)})`;
  const read = () =>
    resolveEmployeeExecution({
      organizationId: f.ids.organizationId,
      workspaceId: f.ids.workspaceId,
      ownerId: f.ids.ownerId,
      runId,
    });
  const snapshot = async () => {
    const [row] =
      await db`select native_skills,provider_snapshot,prompt_snapshot,execution_snapshot,employee_version_id from allrice_employee_runs where run_id=${runId}`;
    return row;
  };
  return { runId, sessionId, read, snapshot, before: await snapshot() };
}

suite(
  'P18 real PostgreSQL published bundle materialization and rollback',
  () => {
    beforeAll(async () => {
      const base = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!base) throw Error('Explicit test database required');
      const url = new URL(base);
      url.search = '';
      admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(20260907,1)`;
        await tx`create extension if not exists vector with schema public`;
        await tx`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema "${schema}"`);
      url.searchParams.set('options', `-csearch_path=${schema},public`);
      db = postgres(url.toString(), { max: 6, onnotice: () => {} });
      const directory = new URL('../migrations/', import.meta.url);
      for (const file of (await readdir(directory))
        .filter((file) => file.endsWith('.sql'))
        .sort())
        await db.unsafe(await readFile(new URL(file, directory), 'utf8'));
    }, 120000);
    afterAll(async () => {
      await db?.end({ timeout: 5 });
      if (admin && /^p18_bundle_[a-f0-9]{32}$/.test(schema))
        await admin.unsafe(`drop schema "${schema}" cascade`);
      await admin?.end({ timeout: 5 });
    });
    it('materializes an older published body and resource from that revision, not the current platform catalog', async () => {
      const f = await fixture();
      await assignPublishedPlatformEmployeeToWorkspace(
        f.employeeKey,
        f.ids.workspaceId,
        'P18 test',
      );
      const tenant = await f.tenantSkill();
      expect(tenant?.content).toBe(f.v1.skill.content);
      expect(tenant?.checksum).toBe(f.v1.skill.checksum);
      expect(tenant?.bundle).toEqual(f.v1.bundle);
      const [catalog] =
        await db`select content,bundle from allrice_platform_dsh_skills where id=${f.ids.skillId}`;
      expect(catalog?.content).toBe(f.v2.skill.content);
      expect(catalog?.bundle).toEqual(f.v2.bundle);
    });
    it('rolls back exact body+asset while both previously persisted Run snapshots remain unchanged', async () => {
      const f = await fixture();
      await assignPublishedPlatformEmployeeToWorkspace(
        f.employeeKey,
        f.ids.workspaceId,
        'P18 test',
      );
      const runA = await persistRun(f, 1);
      await db`update allrice_platform_employees set current_published_revision_id=${f.ids.revision2} where id=${f.ids.platformEmployeeId}`;
      await assignPublishedPlatformEmployeeToWorkspace(
        f.employeeKey,
        f.ids.workspaceId,
        'P18 test',
      );
      const runB = await persistRun(f, 2);
      expect((await f.tenantSkill())?.bundle).toEqual(f.v2.bundle);
      await rollbackPlatformEmployee(
        f.ids.platformEmployeeId,
        {
          revisionId: f.ids.revision1,
          reason: 'P18 deterministic rollback acceptance',
        },
        'P18 test',
      );
      expect((await f.tenantSkill())?.content).toBe(f.v1.skill.content);
      expect((await f.tenantSkill())?.bundle).toEqual(f.v1.bundle);
      expect(await runA.snapshot()).toEqual(runA.before);
      expect(await runB.snapshot()).toEqual(runB.before);
      for (const [run, version] of [
        [runA, f.v1],
        [runB, f.v2],
      ] as const) {
        const resolved = await run.read();
        const asset = readFrozenSkillResource(
          resolved.nativeSkills,
          f.skillName,
          'references/rules.txt',
        );
        expect(Buffer.from(asset.contentBase64, 'base64')).toEqual(
          version.asset,
        );
        expect(resolved.nativeSkills[0]?.content).toBe(version.skill.content);
      }
      await expect(
        db`update allrice_employee_runs set native_skills=${db.json(f.v2.runtimePackage.skills)} where run_id=${runA.runId}`,
      ).rejects.toThrow('immutable');
    });
    it('prevents mutation and deletion of immutable version rows', async () => {
      const f = await fixture();
      await expect(
        db`update allrice_platform_skill_bundle_versions set bundle=${db.json(f.v2.bundle)} where skill_id=${f.ids.skillId} and version='1.0.0'`,
      ).rejects.toThrow('skill_bundle_version_is_immutable');
      await expect(
        db`delete from allrice_platform_skill_bundle_versions where skill_id=${f.ids.skillId} and version='1.0.0'`,
      ).rejects.toThrow('skill_bundle_version_is_immutable');
      await expect(
        db`insert into allrice_platform_skill_bundle_versions(skill_id,version,checksum,bundle) values(${f.ids.skillId},'1.0.0',${f.v2.bundle.checksum},${db.json(f.v2.bundle)})`,
      ).rejects.toThrow();
    });
    it('synchronizes real bundle JSONB idempotently and requires a version bump for resource-only changes', async () => {
      const f = await fixture(),
        id = randomUUID(),
        name = `sync-${randomUUID()}`;
      const skill = f.v1.skill;
      const catalog: PlatformContentCatalog = {
        schemaVersion: 2,
        catalogChecksum: skillBytesChecksum(name),
        skills: [
          {
            id,
            name,
            description: skill.description,
            content: skill.content,
            contentFile: `skills/${name}/SKILL.md`,
            bundleFile: `skills/${name}/bundle.json`,
            version: skill.version,
            checksum: skill.checksum,
            source: skill.source,
            sourceRef: skill.source_ref,
            license: skill.license,
            reviewStatus: 'reviewed',
            reviewedByLabel: skill.reviewed_by_label,
            createdByLabel: 'P18 synthetic sync',
            modelInvocable: true,
            userInvocable: true,
            requiredToolRefs: skill.required_tool_refs,
            enabled: true,
            bundle: f.v1.bundle,
          },
        ],
      };
      expect(await synchronizePlatformContent(catalog)).toMatchObject({
        inserted: 1,
        updated: 0,
      });
      expect(await synchronizePlatformContent(catalog)).toMatchObject({
        inserted: 0,
        updated: 0,
        unchanged: 1,
      });
      // This is the exact read-only projection and planner used by db:verify.
      // A READ ONLY transaction also rejects accidental sync FOR UPDATE locks.
      const verifiedRows = await db.begin(async (transaction) => {
        await transaction`set transaction read only`;
        return readExistingPlatformSkills(transaction);
      });
      expect(verifiedRows.find((row) => row.id === id)?.bundle).toEqual(
        f.v1.bundle,
      );
      expect(planPlatformSkillSync(verifiedRows, catalog.skills)).toMatchObject(
        {
          inserts: [],
          updates: [],
          unchanged: catalog.skills,
        },
      );
      const bytes = Buffer.from('Resource-only update; body remains frozen.\n');
      const { checksum: priorChecksum, ...payload } = f.v1.bundle;
      const changedPayload = {
        ...payload,
        resources: [
          {
            ...payload.resources[0]!,
            byteLength: bytes.length,
            checksum: skillBytesChecksum(bytes),
            contentBase64: bytes.toString('base64'),
          },
        ],
      };
      const changed = structuredClone(catalog);
      changed.skills[0]!.bundle = {
        ...changedPayload,
        checksum: skillBundleChecksum(changedPayload),
      };
      expect(() => planPlatformSkillSync(verifiedRows, changed.skills)).toThrow(
        'platform_skill_version_bump_required',
      );
      await expect(synchronizePlatformContent(changed)).rejects.toThrow(
        'platform_skill_version_bump_required',
      );
      const nextPayload = { ...changedPayload, version: '1.0.1' };
      changed.skills[0]!.version = '1.0.1';
      changed.skills[0]!.bundle = {
        ...nextPayload,
        checksum: skillBundleChecksum(nextPayload),
      };
      expect(await synchronizePlatformContent(changed)).toMatchObject({
        updated: 1,
      });
      expect(await synchronizePlatformContent(changed)).toMatchObject({
        updated: 0,
        unchanged: 1,
      });
      expect(
        planPlatformSkillSync(
          await readExistingPlatformSkills(db),
          changed.skills,
        ),
      ).toMatchObject({ inserts: [], updates: [], unchanged: changed.skills });
      const versions =
        await db`select version,checksum,bundle from allrice_platform_skill_bundle_versions where skill_id=${id} order by version`;
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({
        version: '1.0.0',
        checksum: priorChecksum,
        bundle: f.v1.bundle,
      });
      expect(versions[1]).toMatchObject({
        version: '1.0.1',
        bundle: changed.skills[0]!.bundle,
      });
    });
    it('rejects a tampered published package before creating tenant assignments', async () => {
      const f = await fixture();
      const profile = structuredClone(f.v1.profile);
      profile.runtimePackage!.skills[0]!.bundle!.resources[0]!.contentBase64 =
        Buffer.from('tampered').toString('base64');
      await db`update allrice_platform_employee_revisions set runtime_profile=${db.json(profile)} where id=${f.ids.revision1}`;
      await expect(
        assignPublishedPlatformEmployeeToWorkspace(
          f.employeeKey,
          f.ids.workspaceId,
          'P18 test',
        ),
      ).rejects.toThrow('runtime_package_checksum_mismatch');
      const [count] =
        await db`select count(*)::integer as count from allrice_platform_employee_tenant_assignments where employee_id=${f.ids.platformEmployeeId}`;
      expect(count?.count).toBe(0);
    });
  },
);
