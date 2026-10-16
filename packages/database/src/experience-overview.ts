import type postgres from 'postgres';
import {
  ExperienceCollectionPolicySchema,
  ExperienceOverviewSchema,
  ExperienceSummarySchema,
  experiencePolicySchedule,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { experienceReviewEnabled, ExperienceError } from './experience.ts';
import {
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
  EmployeeInstanceError,
} from './employees/employee-instances.ts';
import { DataAccessError } from './data.ts';

type Sql = postgres.TransactionSql;
type Target = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  instanceId: string;
  available: boolean;
};

/** Internal projection: callers must authorize the exact owner or shared admin
 * target first. No private content is selected, and GET never creates a rule. */
export async function readExperienceSummary(sql: Sql, target: Target) {
  const {
    organizationId: org,
    workspaceId: workspace,
    ownerId: owner,
    instanceId: instance,
  } = target;
  const settings = await sql<{ scope_type: string; value: unknown }[]>`
    select scope_type,value from allrice_settings where key='employee_experience_policy'
      and ((scope_type='system' and scope_id is null) or (scope_type='organization' and scope_id=${org}))`;
  const company = settings.find((r) => r.scope_type === 'organization');
  const policy = ExperienceCollectionPolicySchema.parse(
    company?.value ?? settings.find((r) => r.scope_type === 'system')?.value,
  );
  const [rule] = await sql`
    select status,last_run_at,next_run_at from allrice_automations
    where organization_id=${org} and workspace_id=${workspace} and owner_id=${owner}
      and experience_binding->>'instanceId'=${instance} and deleted_at is null
    order by created_at desc,id desc limit 1`;
  const [last] = await sql`
    select r.status,r.created_at,
      jsonb_array_length(r.experience_occurrence->'sources') source_count,
      coalesce(jsonb_array_length(r.experience_receipt->'output'->'drafts'),0) draft_count
    from allrice_automation_runs r join allrice_automations a on a.id=r.automation_id
    where r.organization_id=${org} and r.workspace_id=${workspace} and a.owner_id=${owner}
      and r.experience_occurrence->>'instanceId'=${instance}
    order by r.created_at desc,r.id desc limit 1`;
  // These are ledger-wide counts, independent of the bounded history lists.
  const [counts] = await sql`
    select
      (select count(*)::int from allrice_experience_reviews e
        join allrice_memories m on m.id=e.memory_id
        join allrice_chat_sessions s on s.id=e.session_id and s.owner_id=e.owner_id
        where e.organization_id=${org} and e.workspace_id=${workspace} and e.owner_id=${owner}
          and e.instance_id=${instance} and e.origin_kind='incremental' and e.status='pending'
          and e.consolidation_occurrence_id is null and m.archived_at is null
          and m.lifecycle_state='candidate' and s.archived_at is null) pending_sources,
      (select count(*)::int from allrice_automation_runs r
        join allrice_automations a on a.id=r.automation_id
        cross join lateral jsonb_array_elements(coalesce(r.experience_receipt->'output'->'drafts','[]'::jsonb)) with ordinality draft(value,n)
        where r.organization_id=${org} and r.workspace_id=${workspace} and a.owner_id=${owner}
          and r.experience_occurrence->>'instanceId'=${instance} and ${target.available}
          and not exists (
            select 1 from jsonb_array_elements_text(draft.value->'sourceIds') source(id)
            where not exists (
              select 1 from allrice_experience_reviews e
              join allrice_memories m on m.id=e.memory_id and m.owner_id=e.owner_id
              join allrice_chat_sessions s on s.id=e.session_id and s.owner_id=e.owner_id
              where e.memory_id::text=source.id and e.organization_id=${org} and e.workspace_id=${workspace}
                and e.owner_id=${owner} and e.instance_id=${instance} and e.origin_kind='incremental'
                and e.status='pending' and e.consolidation_occurrence_id=r.id
                and m.archived_at is null and m.lifecycle_state='candidate' and s.archived_at is null
                and not exists (
                  select 1 from jsonb_array_elements(e.evidence->'skills') skill
                  where not exists (
                    select 1 from allrice_personal_skill_bindings b
                    join allrice_personal_skill_installations i on i.id=b.installation_id
                    join allrice_personal_skill_versions v on v.id=i.current_version_id
                    where b.id::text=skill->'pin'->>'bindingId' and b.enabled
                      and b.organization_id=${org} and b.workspace_id=${workspace} and b.owner_id=${owner} and b.instance_id=${instance}
                      and b.epoch::text=skill->'pin'->>'bindingEpoch' and i.state='installed'
                      and i.id::text=skill->'pin'->>'installationId' and v.id::text=skill->'pin'->>'versionId'
                      and v.definition_checksum=skill->'pin'->>'definitionChecksum'
                      and v.package_checksum is not distinct from (skill->'pin'->>'packageChecksum')))))
          and not exists(select 1 from allrice_platform_employee_test_runs t
            where t.purpose='experience_validation' and t.experience_binding->>'occurrenceId'=r.id::text
              and (t.experience_binding->>'draftIndex')::int=draft.n-1
              and t.status in ('succeeded','failed','canceled'))
          and not exists(select 1 from allrice_experience_reviews e
            where e.organization_id=${org} and e.workspace_id=${workspace} and e.owner_id=${owner}
              and e.instance_id=${instance} and e.origin_kind='derived'
              and e.adoption_proof->>'occurrenceId'=r.id::text
              and (e.adoption_proof->>'draftIndex')::int=draft.n-1)) awaiting_validation,
      (select count(*)::int from allrice_experience_reviews e
        where e.organization_id=${org} and e.workspace_id=${workspace} and e.owner_id=${owner}
          and e.instance_id=${instance} and e.origin_kind='derived') adopted_total`;
  const enabled = experienceReviewEnabled();
  const state = !target.available
    ? 'unavailable'
    : !enabled || policy.frequency === 'off'
      ? 'off'
      : !rule
        ? 'not_scheduled'
        : rule.status === 'enabled'
          ? 'scheduled'
          : 'paused';
  return ExperienceSummarySchema.parse({
    enabled,
    policy: {
      ...experiencePolicySchedule(policy),
      source: company ? 'company' : 'platform',
      revision: policy.revision,
      validationMode:
        'validationMode' in policy ? policy.validationMode : 'off',
      adoptionMode: 'adoptionMode' in policy ? policy.adoptionMode : 'off',
    },
    schedule: {
      state,
      lastCheckedAt: rule?.last_run_at?.toISOString() ?? null,
      nextRunAt:
        state === 'scheduled'
          ? (rule?.next_run_at?.toISOString() ?? null)
          : null,
      lastOccurrence: last
        ? {
            createdAt: last.created_at.toISOString(),
            outcome:
              last.status === 'succeeded'
                ? last.source_count === 0
                  ? 'no_sources'
                  : last.draft_count > 0
                    ? 'drafted'
                    : 'no_draft'
                : last.status,
          }
        : null,
    },
    counts: {
      pendingSources: counts!.pending_sources,
      awaitingValidation: counts!.awaiting_validation,
      adoptedTotal: counts!.adopted_total,
    },
  });
}

export async function getExperienceOverview(
  context: RequestContext,
  instanceId: string,
) {
  if (!experienceReviewEnabled()) throw new ExperienceError('disabled');
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      const instance = await getEmployeeInstanceForHistory(
        context,
        instanceId,
        sql,
      );
      let available = true;
      try {
        await getEmployeeInstance(context, instance.id, sql);
      } catch (e) {
        if (!(
          e instanceof DataAccessError || e instanceof EmployeeInstanceError
        ))
          throw e;
        available = false;
      }
      return ExperienceOverviewSchema.parse({
        visibility: 'owner',
        workspaceId: instance.workspaceId,
        instanceId: instance.id,
        summary: await readExperienceSummary(sql, {
          organizationId: instance.organizationId,
          workspaceId: instance.workspaceId,
          ownerId: instance.ownerId,
          instanceId: instance.id,
          available,
        }),
      });
    },
  );
}
