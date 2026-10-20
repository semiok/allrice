import { posix } from 'node:path';
import { z } from 'zod';
import { getDatabase } from '../core/client.ts';

const approval = z
  .object({
    artifactId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    generation: z.enum(['dsh-0.1.5-rc.3-a4c74a9', 'dsh-0.2.1-rc.2-687f282']),
    storageRoot: z
      .string()
      .refine(
        (value) => posix.isAbsolute(value) && posix.resolve(value) === value,
        'An exact absolute storage root is required',
      ),
    // Existing employee previews use their stable test directory rather than
    // the shared chat root. This is the configured executions root plus the
    // fixed preview subdirectory, never an arbitrary path supplied by a model.
    previewStorageRoot: z
      .string()
      .refine(
        (value) => posix.isAbsolute(value) && posix.resolve(value) === value,
      )
      .optional(),
  })
  .strict();
export type NativeArtifactReferenceApproval = z.infer<typeof approval>;

/** Deployment/startup check, not execution authority. Keep archived and terminal
 * references: neither implies the original journal may be moved or deleted.
 * One read-only snapshot includes pins AND all four first-business origins;
 * an unclaimed or never-bound task must protect its reader too. */
export async function verifyNativeArtifactReferenceCoverage(
  input: readonly NativeArtifactReferenceApproval[],
) {
  const approved = z.array(approval).min(1).max(8).parse(input);
  if (new Set(approved.map((a) => a.artifactId)).size !== approved.length)
    throw Error('DSH_NATIVE_ARTIFACT_REFERENCES_DUPLICATE_APPROVAL');
  const db = getDatabase();
  const references = await db.begin('read only', async (tx) => {
    await tx`set local statement_timeout='5000'`;
    return tx<
      {
        source: string;
        artifactId: string | null;
        generation: string | null;
        profileId: string | null;
        records: number;
        covered: boolean;
      }[]
    >`with approved as (
      select * from jsonb_to_recordset(${tx.json(approved)})
        as a("artifactId" text,generation text,"storageRoot" text,"previewStorageRoot" text)
    ), origins as (
      select 'origin:chat' source,native_root_origin origin from allrice_chat_sessions
      union all select 'origin:platform_technical',native_root_origin from allrice_platform_technical_tasks
      union all select 'origin:experience_consolidation',native_root_origin from allrice_automation_runs
      union all select 'origin:platform_employee_test',native_root_origin from allrice_platform_employee_test_runs
    ), refs as (
      select 'binding' source,artifact_id,distribution_generation generation,profile_id,
        storage_namespace,organization_id,workspace_id,owner_id,storage_context_key,context_kind,context_id
      from allrice_native_session_bindings
      union all
      select source,origin->>'artifactId',origin->>'distributionGeneration',origin->>'profileId',
        null,null,null,null,null,null,null from origins where origin is not null
    ) select r.source,r.artifact_id as "artifactId",r.generation,r.profile_id as "profileId",
      count(*)::int records,
      bool_and(coalesce(a.generation=r.generation and r.profile_id in ('restricted','technical')
        and (r.storage_namespace is null or r.storage_namespace =
          a."storageRoot"||'/'||r.organization_id||'/'||r.workspace_id||'/'||r.owner_id||'/'||r.storage_context_key||'/sessions'
          or (r.context_kind='platform_employee_test' and r.context_id::text=r.storage_context_key
            and r.storage_namespace=a."previewStorageRoot"||'/'||r.context_id||'/'||r.organization_id||'/'||r.workspace_id||'/'||r.owner_id||'/'||r.storage_context_key||'/sessions')),false)) covered
    from refs r left join approved a on a."artifactId"=r.artifact_id
    group by r.source,r.artifact_id,r.generation,r.profile_id
    order by r.source,r.artifact_id,r.generation,r.profile_id`;
  });
  const missing = references.filter((r) => !r.covered);
  if (missing.length)
    throw Error(
      'DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED ' + JSON.stringify(missing),
    );
  return { verified: true as const, references };
}
