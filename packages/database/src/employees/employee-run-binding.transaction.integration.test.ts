import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  EmployeeContentManifestSchema,
  EmployeeContentTextSchema,
} from '@allrice/contracts';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import * as client from '../core/client.ts';
import { createRuntimeFixtureDatabase } from '../runtime.fixture.ts';
import { readPlatformModelSettings } from '../providers/platform-model-settings.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import { skillBytesChecksum } from '../skill-bundles.ts';
import {
  employeeManifest,
  employeeManifestChecksum,
} from './employee-config.ts';
import { prepareEmployeeRunBinding } from './employeehub.ts';
import * as runtimeContent from './employee-runtime-content.ts';

type Sql = ReturnType<typeof client.getDatabase> | TransactionSql;
type Scope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  membershipId: string;
  employeeId: string;
  employeeVersionId: string;
  assignmentId: string;
  sessionId: string;
  skillId: string;
  assetId: string;
  contentSetId: string;
};

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const committedProfile = {
  schemaVersion: 1,
  displayName: 'COMMITTED_PROFILE',
  preferences: { fixture: 'committed' },
};
const committedSkill = '# Binding fixture\nCOMMITTED_SKILL_BODY';
const countsBeforeBinding = {
  instances: 0,
  instanceRevisions: 0,
  policies: 0,
  caches: 0,
  knowledge: 1,
  sourceRevisions: 1,
  contentRevisions: 1,
};

// Real PostgreSQL only: the pool spy either returns this fixture's real pool or
// throws. Authorization functions, SQL tags, content readers and freeze results
// are never replaced with synthetic allow decisions or transaction objects.
integration(
  'complete employee binding: caller transaction and real authority',
  () => {
    let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let schema: string;

    beforeAll(async () => {
      fixture = await createRuntimeFixtureDatabase();
      const [scope] = await fixture.db<{ schema: string }[]>`
      select current_schema() as schema`;
      if (!scope || !/^p25_[a-f0-9]{32}$/.test(scope.schema)) {
        throw Error('owned_fixture_schema_required');
      }
      schema = scope.schema;
      const owned = await fixture.db<{ schema: string }[]>`
      select n.nspname as schema from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where c.oid in (
        to_regclass('allrice_organizations'),
        to_regclass('allrice_organization_people'),
        to_regclass('allrice_employee_user_profiles'),
        to_regclass('allrice_employee_instances'),
        to_regclass('allrice_employee_instance_revisions'),
        to_regclass('allrice_employee_model_policies'),
        to_regclass('allrice_session_model_snapshots'),
        to_regclass('allrice_platform_model_settings'),
        to_regclass('allrice_codex_subscriptions'),
        to_regclass('allrice_dsh_skills'),
        to_regclass('allrice_company_asset_revisions'),
        to_regclass('allrice_employee_content_revisions'),
        to_regclass('allrice_employee_knowledge_bindings'),
        to_regclass('allrice_runtime_metadata'))`;
      expect(owned).toHaveLength(14);
      expect(owned.every((row) => row.schema === schema)).toBe(true);
      for (const flag of [
        'ALLRICE_CLOUD_MCP_ENABLED',
        'ALLRICE_LOCAL_MCP_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
      ]) {
        vi.stubEnv(flag, '1');
      }
      await fixture.db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        await tx`update allrice_codex_subscriptions set enabled=false`;
        await tx`update allrice_codex_subscriptions set enabled=true where slot=1`;
      });
    }, 120_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (!fixture) return;
      const cleanup = await fixture.close();
      expect(cleanup).toMatchObject({
        schema,
        schemaRemoved: true,
        storageRemoved: true,
        databaseClosed: true,
        adminClosed: true,
      });
      console.info('employee_binding_tx_cleanup', JSON.stringify(cleanup));
    }, 30_000);

    async function publishRequirement(
      sql: Sql,
      scope: Scope,
      number: number,
      body: string,
    ) {
      const revisionId = randomUUID();
      const contentRevisionId = randomUUID();
      const text = EmployeeContentTextSchema.parse({
        kind: 'requirement',
        title: 'Binding requirement fixture',
        body,
      });
      const reference = {
        sourceKind: 'requirement' as const,
        contentId: scope.assetId,
        revisionId,
        digest: runtimePolicyDigest(text),
      };
      const manifest = EmployeeContentManifestSchema.parse({
        schemaVersion: 1,
        common: [reference],
        scenes: [],
        declaredConflicts: [],
      });
      await sql`insert into allrice_company_asset_revisions(
      id,organization_id,asset_id,number,content,digest,base_asset_revision,created_by)
      values(${revisionId},${scope.organizationId},${scope.assetId},${number},
        ${sql.json(text)},${reference.digest},${number - 1},${scope.ownerId})`;
      await sql`insert into allrice_company_asset_publications(asset_id,revision_id,published_by)
      values(${scope.assetId},${revisionId},${scope.ownerId})`;
      await sql`update allrice_company_assets
      set latest_revision_id=${revisionId},published_revision_id=${revisionId},
        revision=${number},state='published' where id=${scope.assetId}`;
      await sql`insert into allrice_employee_content_revisions(
      id,set_id,number,manifest,digest,change_summary,created_by)
      values(${contentRevisionId},${scope.contentSetId},${number},${sql.json(manifest)},
        ${runtimePolicyDigest(manifest)},'Synthetic fixture publication',${scope.ownerId})`;
      await sql`insert into allrice_employee_content_publications(set_id,revision_id)
      values(${scope.contentSetId},${contentRevisionId})`;
      await sql`update allrice_employee_content_sets
      set revision=${number},candidate_revision_id=${contentRevisionId},
        active_revision_id=${contentRevisionId} where id=${scope.contentSetId}`;
      return { reference, contentRevisionId };
    }

    async function knowledge(sql: Sql, scope: Scope, description: string) {
      const sourceId = randomUUID();
      const revisionId = randomUUID();
      const definition = {
        schemaVersion: 1,
        sourceKind: 'managed',
        connectorBindingId: null,
        resourceRef: `synthetic:binding-${sourceId}`,
        indexing: 'none',
        updatePolicy: 'manual',
        citationRequired: true,
        allowedScopes: ['workspace'],
      };
      await sql`insert into allrice_knowledge_sources(
      id,organization_id,workspace_id,slug,name,description,created_by)
      values(${sourceId},${scope.organizationId},${scope.workspaceId},${`binding-${sourceId}`},
        'Binding knowledge fixture',${description},${scope.ownerId})`;
      await sql`insert into allrice_knowledge_revisions(
      id,organization_id,workspace_id,knowledge_source_id,revision,name,description,
      status,definition,checksum,created_by)
      values(${revisionId},${scope.organizationId},${scope.workspaceId},${sourceId},1,
        'Binding knowledge fixture',${description},'draft',${sql.json(definition)},
        ${runtimePolicyDigest(definition)},${scope.ownerId})`;
      await sql`insert into allrice_knowledge_acl_entries(
      organization_id,workspace_id,knowledge_revision_id,principal_type,principal_id,permission)
      values(${scope.organizationId},${scope.workspaceId},${revisionId},'workspace',${scope.workspaceId},'read')`;
      await sql`update allrice_knowledge_revisions set status='published',published_at=now()
      where id=${revisionId}`;
      await sql`insert into allrice_employee_knowledge_bindings(
      id,organization_id,workspace_id,employee_id,knowledge_revision_id,bound_by)
      values(${randomUUID()},${scope.organizationId},${scope.workspaceId},${scope.employeeId},
        ${revisionId},${scope.ownerId})`;
      return revisionId;
    }

    async function seedScope(): Promise<Scope> {
      const scope: Scope = {
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        ownerId: randomUUID(),
        membershipId: randomUUID(),
        employeeId: randomUUID(),
        employeeVersionId: randomUUID(),
        assignmentId: randomUUID(),
        sessionId: randomUUID(),
        skillId: randomUUID(),
        assetId: randomUUID(),
        contentSetId: randomUUID(),
      };
      const manifest = employeeManifest({
        key: 'binding-tx-fixture',
        name: 'Binding transaction fixture',
        description: 'Synthetic PostgreSQL fixture only',
        toolNames: ['workspace.skill.read', 'cloud.mcp.call', 'local.mcp.call'],
      });
      await fixture.db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        await tx`insert into allrice_users(id,email,display_name,password_hash)
        values(${scope.ownerId},${`${scope.ownerId}@example.test`},'Binding fixture','not-login')`;
        await tx`insert into allrice_organizations(id,slug,name,business_context)
        values(${scope.organizationId},${`binding-${scope.organizationId}`},
          'COMMITTED_COMPANY','COMMITTED_COMPANY_CONTEXT')`;
        await tx`insert into allrice_workspaces(id,organization_id,slug,name)
        values(${scope.workspaceId},${scope.organizationId},'binding','Binding fixture')`;
        await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role)
        values(${scope.membershipId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},'member')`;
        await tx`insert into allrice_organization_people(
        organization_id,user_id,display_name,job_title,responsibilities,content_maintenance_level)
        values(${scope.organizationId},${scope.ownerId},'COMMITTED_PERSON',
          'COMMITTED_ROLE','COMMITTED_DUTIES','company')`;
        await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name)
        values(${scope.employeeId},${scope.organizationId},${scope.workspaceId},
          'binding-tx-fixture','Binding fixture')`;
        await tx`insert into allrice_employee_versions(
        id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,
        capabilities,config_checksum,manifest,provider_snapshot)
        values(${scope.employeeVersionId},${scope.organizationId},${scope.workspaceId},
          ${scope.employeeId},1,'Binding fixture',${manifest.provider.model},${manifest.systemPrompt},
          ${tx.json(manifest.capabilities)},${employeeManifestChecksum(manifest)},
          ${tx.json(manifest)},${tx.json(manifest.provider)})`;
        await tx`insert into allrice_employee_assignments(
        id,organization_id,workspace_id,employee_id,employee_version_id,user_id)
        values(${scope.assignmentId},${scope.organizationId},${scope.workspaceId},
          ${scope.employeeId},${scope.employeeVersionId},${scope.ownerId})`;
        await tx`insert into allrice_chat_sessions(
        id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
        values(${scope.sessionId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},
          'Binding fixture',${scope.assignmentId},${scope.employeeVersionId})`;
        await tx`insert into allrice_employee_user_profiles(
        organization_id,workspace_id,employee_id,user_id,profile)
        values(${scope.organizationId},${scope.workspaceId},${scope.employeeId},
          ${scope.ownerId},${tx.json(committedProfile)})`;
        await tx`insert into allrice_dsh_skills(
        id,organization_id,workspace_id,name,description,content,checksum,required_tool_refs,created_by)
        values(${scope.skillId},${scope.organizationId},${scope.workspaceId},
          'binding-fixture-native','Synthetic binding skill',${committedSkill},
          ${skillBytesChecksum(committedSkill)},'["workspace.skill.read"]',${scope.ownerId})`;
        await tx`insert into allrice_employee_dsh_skill_bindings(
        organization_id,workspace_id,employee_id,skill_id,bound_by)
        values(${scope.organizationId},${scope.workspaceId},${scope.employeeId},${scope.skillId},${scope.ownerId})`;
        await tx`insert into allrice_company_assets(
        id,organization_id,owner_id,kind,content_scope,content_workspace_id)
        values(${scope.assetId},${scope.organizationId},${scope.ownerId},
          'execution_requirement','company',${scope.workspaceId})`;
        await tx`insert into allrice_employee_content_sets(
        id,organization_id,workspace_id,employee_id,scope,created_by)
        values(${scope.contentSetId},${scope.organizationId},${scope.workspaceId},
          ${scope.employeeId},'company',${scope.ownerId})`;
        await publishRequirement(tx, scope, 1, 'COMMITTED_REQUIREMENT_BODY');
        await knowledge(tx, scope, 'COMMITTED_KNOWLEDGE_DIRECTORY');
      });
      return scope;
    }

    function input(scope: Scope) {
      return {
        context: {
          actor: { type: 'user' as const, id: scope.ownerId },
          organizationId: scope.organizationId,
        },
        workspaceId: scope.workspaceId,
        assignmentId: scope.assignmentId,
        employeeVersionId: scope.employeeVersionId,
        sessionId: scope.sessionId,
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        promptSnapshot: {
          systemPrompt: '',
          conversation: [],
          memories: [],
          userRequest: 'Freeze fixture binding; do not execute a model.',
        },
      };
    }

    async function counts(scope: Scope, sql: Sql) {
      const [row] = await sql<
        {
          instances: number;
          instanceRevisions: number;
          policies: number;
          caches: number;
          knowledge: number;
          sourceRevisions: number;
          contentRevisions: number;
        }[]
      >`select
      (select count(*)::int from allrice_employee_instances where id=${scope.assignmentId}) as instances,
      (select count(*)::int from allrice_employee_instance_revisions where instance_id=${scope.assignmentId}) as "instanceRevisions",
      (select count(*)::int from allrice_employee_model_policies where employee_id=${scope.employeeId}) as policies,
      (select count(*)::int from allrice_session_model_snapshots where session_id=${scope.sessionId}) as caches,
      (select count(*)::int from allrice_employee_knowledge_bindings where employee_id=${scope.employeeId}) as knowledge,
      (select count(*)::int from allrice_company_asset_revisions where asset_id=${scope.assetId}) as "sourceRevisions",
      (select count(*)::int from allrice_employee_content_revisions where set_id=${scope.contentSetId}) as "contentRevisions"`;
      if (!row) throw Error('fixture_counts_missing');
      return row;
    }

    async function currentRows(scope: Scope, sql: Sql) {
      const [row] = await sql`select o.name,o.business_context,p.display_name,
      p.job_title,p.responsibilities,u.profile,s.content,s.checksum,
      a.published_revision_id,c.active_revision_id
      from allrice_organizations o
      join allrice_organization_people p on p.organization_id=o.id and p.user_id=${scope.ownerId}
      join allrice_employee_user_profiles u on u.organization_id=o.id and u.workspace_id=${scope.workspaceId}
        and u.employee_id=${scope.employeeId} and u.user_id=${scope.ownerId}
      join allrice_dsh_skills s on s.id=${scope.skillId}
      join allrice_company_assets a on a.id=${scope.assetId}
      join allrice_employee_content_sets c on c.id=${scope.contentSetId}
      where o.id=${scope.organizationId}`;
      if (!row) throw Error('fixture_current_rows_missing');
      return row;
    }

    function forbidPool() {
      return vi.spyOn(client, 'getDatabase').mockImplementation(() => {
        throw Error('unexpected_global_database_in_binding');
      });
    }

    it('freezes uncommitted company/profile/model/source data and rolls back every implicit write', async () => {
      const scope = await seedScope();
      const before = await currentRows(scope, fixture.db);
      const settings = await readPlatformModelSettings(fixture.db);
      const configuration = {
        ...settings.configuration,
        timeoutMs:
          settings.configuration.timeoutMs === 600_000 ? 300_000 : 600_000,
      };
      const profile = {
        schemaVersion: 1,
        displayName: 'TX_PROFILE',
        preferences: { fixture: 'uncommitted' },
      };
      const skill = '# Binding fixture\nTX_NATIVE_SKILL_BODY';
      expect(await counts(scope, fixture.db)).toEqual(countsBeforeBinding);
      const pool = forbidPool();
      const rollback = Error('intentional_complete_binding_rollback');
      await expect(
        fixture.db.begin(async (tx) => {
          await tx`select set_config('search_path', ${schema}, true)`;
          const [inside] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          await tx`update allrice_organizations
          set name='TX_COMPANY',business_context='TX_COMPANY_CONTEXT' where id=${scope.organizationId}`;
          await tx`update allrice_organization_people set display_name='TX_PERSON',
          job_title='TX_ROLE',responsibilities='TX_DUTIES'
          where organization_id=${scope.organizationId} and user_id=${scope.ownerId}`;
          await tx`update allrice_employee_user_profiles set profile=${tx.json(profile)}
          where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
            and employee_id=${scope.employeeId} and user_id=${scope.ownerId}`;
          await tx`update allrice_dsh_skills set content=${skill},checksum=${skillBytesChecksum(skill)}
          where id=${scope.skillId}`;
          await tx`update allrice_platform_model_settings
          set configuration=${tx.json(configuration)},revision=revision+1 where singleton`;
          const published = await publishRequirement(
            tx,
            scope,
            2,
            'TX_REQUIREMENT_BODY',
          );
          const knowledgeRevision = await knowledge(
            tx,
            scope,
            'TX_KNOWLEDGE_DIRECTORY',
          );

          const binding = await prepareEmployeeRunBinding(input(scope), tx);
          expect(binding.promptSnapshot.organizationContext).toMatchObject({
            companyName: 'TX_COMPANY',
            businessContext: 'TX_COMPANY_CONTEXT',
            displayName: 'TX_PERSON',
            jobTitle: 'TX_ROLE',
            responsibilities: 'TX_DUTIES',
          });
          expect(binding.executionSnapshot.userProfile).toEqual(profile);
          expect(binding.executionSnapshot.instance?.id).toBe(
            scope.assignmentId,
          );
          expect(binding.executionSnapshot.modelSnapshot).toMatchObject({
            policyRevision: settings.revision + 1,
            platformSettings: { configuration },
            runLimits: { timeoutMs: configuration.timeoutMs },
          });
          expect(
            binding.nativeSkills.find((value) => value.id === scope.skillId)
              ?.content,
          ).toBe(skill);
          expect(
            binding.executionSnapshot.capabilitySnapshot.knowledge.some(
              (value) =>
                value.revision.id === knowledgeRevision &&
                value.revision.description === 'TX_KNOWLEDGE_DIRECTORY',
            ),
          ).toBe(true);
          expect(binding.executionSnapshot.content?.layers[0]).toMatchObject({
            revisionId: published.contentRevisionId,
            common: [published.reference],
          });
          const resolved = await runtimeContent.readEmployeeRuntimeContent(
            { ...input(scope).context, workspaceId: scope.workspaceId },
            binding.executionSnapshot.content,
            tx,
          );
          expect(resolved.sources.map((value) => value.body)).toEqual([
            'TX_REQUIREMENT_BODY',
          ]);
          expect(
            JSON.stringify(binding.executionSnapshot.content),
          ).not.toContain('TX_REQUIREMENT_BODY');
          expect(binding.executionSnapshot).toHaveProperty('mcpTools');
          expect(await counts(scope, tx)).toEqual({
            instances: 1,
            instanceRevisions: 1,
            policies: 1,
            caches: 1,
            knowledge: 2,
            sourceRevisions: 2,
            contentRevisions: 2,
          });
          const [observer] = await fixture.db<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          if (!inside || !observer) throw Error('backend_pid_missing');
          expect(observer.pid).not.toBe(inside.pid);
          expect(await counts(scope, fixture.db)).toEqual(countsBeforeBinding);
          expect(await currentRows(scope, fixture.db)).toEqual(before);
          expect(await readPlatformModelSettings(fixture.db)).toEqual(settings);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(pool).not.toHaveBeenCalled();
      expect(await counts(scope, fixture.db)).toEqual(countsBeforeBinding);
      expect(await currentRows(scope, fixture.db)).toEqual(before);
      expect(await readPlatformModelSettings(fixture.db)).toEqual(settings);
    }, 30_000);

    it.each(['membership', 'assignment'] as const)(
      'sees transaction-local %s revocation before downstream content reads',
      async (kind) => {
        const scope = await seedScope();
        const content = vi.spyOn(
          runtimeContent,
          'prepareEmployeeRuntimeContent',
        );
        const pool = forbidPool();
        await expect(
          fixture.db.begin(async (tx) => {
            await tx`select set_config('search_path', ${schema}, true)`;
            if (kind === 'membership') {
              await tx`update allrice_memberships set active=false where id=${scope.membershipId}`;
            } else {
              await tx`update allrice_employee_assignments set active=false where id=${scope.assignmentId}`;
            }
            await prepareEmployeeRunBinding(input(scope), tx);
          }),
        ).rejects.toMatchObject({ code: 'not_found' });
        expect(content).not.toHaveBeenCalled();
        expect(pool).not.toHaveBeenCalled();
        expect(await counts(scope, fixture.db)).toEqual(countsBeforeBinding);
        const [restored] =
          await fixture.db`select m.active as member_active,a.active as assignment_active
        from allrice_memberships m join allrice_employee_assignments a on a.id=${scope.assignmentId}
        where m.id=${scope.membershipId}`;
        expect(restored).toEqual({
          member_active: true,
          assignment_active: true,
        });
      },
      30_000,
    );

    it('keeps the omitted-transaction path usable with committed implicit state and stable identities', async () => {
      const scope = await seedScope();
      const pool = vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      const binding = await prepareEmployeeRunBinding(input(scope));
      expect(pool).toHaveBeenCalled();
      expect(binding.promptSnapshot.organizationContext?.companyName).toBe(
        'COMMITTED_COMPANY',
      );
      expect(binding.executionSnapshot.userProfile).toEqual(committedProfile);
      expect(
        binding.nativeSkills.find((value) => value.id === scope.skillId)
          ?.content,
      ).toBe(committedSkill);
      expect(
        binding.executionSnapshot.capabilitySnapshot.knowledge,
      ).toHaveLength(1);
      expect(await counts(scope, fixture.db)).toEqual({
        ...countsBeforeBinding,
        instances: 1,
        instanceRevisions: 1,
        policies: 1,
        caches: 1,
      });
      const repeated = await prepareEmployeeRunBinding(input(scope));
      expect(repeated.executionSnapshot.instance?.id).toBe(
        binding.executionSnapshot.instance?.id,
      );
      expect(repeated.employeeAssignmentId).toBe(binding.employeeAssignmentId);
      expect(repeated.employeeVersionId).toBe(binding.employeeVersionId);
      expect(await counts(scope, fixture.db)).toEqual({
        ...countsBeforeBinding,
        instances: 1,
        instanceRevisions: 1,
        policies: 1,
        caches: 1,
      });
    }, 30_000);
  },
);
