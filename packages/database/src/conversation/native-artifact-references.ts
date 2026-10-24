import { verifiedChatExecutorTransitions } from './native-executor-transition.ts';
import { posix } from 'node:path';
import { z } from 'zod';
import { getDatabase } from '../core/client.ts';
import {
  readDshRuntimeCloseCoverage,
  assertDshCloseArtifactCoverage,
} from '../providers/dsh-runtime-close-observations.ts';
import { configuredNativeOriginReaders } from './native-origin-reader.ts';
import { readVerifiedNativeTerminalTestRetirements } from './native-terminal-test-retirement.ts';
import { readVerifiedNativeChatRetirements } from './native-context-retirement.ts';

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
const controlReferenceSchema = z
  .object({
    artifactId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    profileId: z.enum([
      'allrice-once-control-v1',
      'allrice-recurring-control-v1',
    ]),
    storageId: z.string().min(1).max(512),
    stateRoot: z
      .string()
      .refine(
        (value) => posix.isAbsolute(value) && posix.resolve(value) === value,
      ),
  })
  .strict();
export type NativeOnceControlReference = {
  partitionId: string;
  reference: z.infer<typeof controlReferenceSchema>;
  controls: {
    controlSessionId: string;
    sessionState: 'reserved' | 'initializing' | 'ready';
  }[];
};

/** Deployment/startup check, not execution authority. Keep archived and terminal
 * references: neither implies the original journal may be moved or deleted.
 * One read-only snapshot includes pins AND all four first-business origins;
 * an unclaimed or never-bound task must protect its reader too. Only an exact,
 * verified terminal test-execution retirement ends that executable dependency. */
export async function verifyNativeArtifactReferenceCoverage(
  input: readonly NativeArtifactReferenceApproval[],
) {
  const approved = z.array(approval).min(1).max(8).parse(input);
  if (new Set(approved.map((a) => a.artifactId)).size !== approved.length)
    throw Error('DSH_NATIVE_ARTIFACT_REFERENCES_DUPLICATE_APPROVAL');
  const readers = configuredNativeOriginReaders();
  if (
    readers.some(
      (reader) =>
        !approved.some(
          (a) =>
            a.artifactId === reader.targetArtifactId &&
            a.generation === reader.generation,
        ),
    )
  )
    throw Error('DSH_NATIVE_ORIGIN_READER_TARGET_UNVERIFIED');
  const db = getDatabase();
  const snapshot = await db.begin(
    'isolation level repeatable read read only',
    async (tx) => {
      await tx`set local statement_timeout='5000'`;
      const retiredChatContexts = await readVerifiedNativeChatRetirements(tx);
      const retiredContexts = [
        ...retiredChatContexts,
        ...(await readVerifiedNativeTerminalTestRetirements(tx)),
      ];
      const transitions = await verifiedChatExecutorTransitions(tx);
      for (const t of transitions)
        if (
          !approved.some(
            (a) =>
              a.artifactId === t.target.artifactId &&
              a.generation === t.target.generation,
          )
        )
          throw Error('DSH_NATIVE_TRANSITION_TARGET_UNVERIFIED');
      const references = await tx<
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
    ), compatible as (
      select * from jsonb_to_recordset(${tx.json(readers.map((reader) => ({ ...reader })))}) as c(
        "approvalDigest" text,"sourceArtifactId" text,"targetArtifactId" text,generation text,"profileId" text,
        "organizationId" uuid,"workspaceId" uuid,"ownerId" uuid,"contextId" uuid,
        "originDigest" text,"sourceOrigin" jsonb,"storageNamespace" text)
    ), transitions as (
      select * from jsonb_to_recordset(${tx.json(transitions.map((t) => ({ contextId: t.scope.contextId, organizationId: t.scope.organizationId, workspaceId: t.scope.workspaceId, ownerId: t.scope.ownerId, targetArtifactId: t.target.artifactId, generation: t.target.generation, originDigest: t.originDigest, storageNamespace: t.storageNamespace })))}) as t(
       "contextId" uuid,"organizationId" uuid,"workspaceId" uuid,"ownerId" uuid,"targetArtifactId" text,generation text,"originDigest" text,"storageNamespace" text)
    ), origins as (
      select 'origin:chat' source,id source_context_id,native_root_origin origin,organization_id,workspace_id,owner_id from allrice_chat_sessions
      union all select 'origin:platform_technical',id,native_root_origin,null,null,null from allrice_platform_technical_tasks
      union all select 'origin:experience_consolidation',id,native_root_origin,null,null,null from allrice_automation_runs
      union all select 'origin:platform_employee_test',id,native_root_origin,null,null,null from allrice_platform_employee_test_runs
    ), retired as (
      select * from jsonb_to_recordset(${tx.json(retiredContexts)}) as d(
        "contextKind" text,"contextId" uuid,"organizationId" uuid,"workspaceId" uuid,"ownerId" uuid)
    ), all_refs as (
      select 'binding' source,artifact_id,distribution_generation generation,profile_id,
        storage_namespace,organization_id,workspace_id,owner_id,storage_context_key,context_kind,context_id,
        null::jsonb origin,root_origin_digest,origin_reader_approval_digest
      from allrice_native_session_bindings
      union all
      select source,origin->>'artifactId',origin->>'distributionGeneration',origin->>'profileId',
        null,organization_id,workspace_id,owner_id,null,
         case when source='origin:chat' then origin->>'contextKind' else substr(source,8) end,
         case when source='origin:chat' then (origin->>'contextId')::uuid else source_context_id end,
        origin,null,null from origins where origin is not null
    ), refs as (
      select r.* from all_refs r where not exists(select 1 from retired d
        where d."contextKind"=r.context_kind and d."contextId"=r.context_id
          and ((r.source in ('origin:platform_employee_test','origin:experience_consolidation','origin:platform_technical')
            and r.origin->>'contextKind'=r.context_kind and r.origin->>'contextId'=r.context_id::text)
            or (d."organizationId"=r.organization_id and d."workspaceId"=r.workspace_id
              and d."ownerId"=r.owner_id)))
    ) select r.source,coalesce(t."targetArtifactId",r.artifact_id) as "artifactId",coalesce(t.generation,r.generation) generation,r.profile_id as "profileId",
      array_agg(distinct r.artifact_id) as "historicalArtifactIds",
      count(*)::int records,
      bool_and(coalesce(case
        when t."contextId" is not null then a."artifactId"=t."targetArtifactId" and a.generation=t.generation and r.profile_id='restricted'
          and (r.storage_namespace is null or r.storage_namespace=t."storageNamespace")
        when r.origin is not null and exists(select 1 from compatible s where s."sourceArtifactId"=r.artifact_id)
          then c."sourceArtifactId"=r.artifact_id and c."sourceOrigin"=r.origin and c.generation=r.generation and c."profileId"=r.profile_id
        when r.origin_reader_approval_digest is not null then c."approvalDigest"=r.origin_reader_approval_digest
          and c."targetArtifactId"=r.artifact_id and c."originDigest"=r.root_origin_digest
          and c."storageNamespace"=r.storage_namespace and r.storage_context_key=r.context_id::text
          and c.generation=r.generation and c."profileId"=r.profile_id
        else not exists(select 1 from compatible s where s."sourceArtifactId"=r.artifact_id)
          and a.generation=r.generation and r.profile_id in ('restricted','technical')
        and (r.storage_namespace is null or r.storage_namespace =
          a."storageRoot"||'/'||r.organization_id||'/'||r.workspace_id||'/'||r.owner_id||'/'||r.storage_context_key||'/sessions'
          or (r.context_kind='platform_employee_test' and r.context_id::text=r.storage_context_key
            and r.storage_namespace=a."previewStorageRoot"||'/'||r.context_id||'/'||r.organization_id||'/'||r.workspace_id||'/'||r.owner_id||'/'||r.storage_context_key||'/sessions')) end,false)) covered
    from refs r left join transitions t on r.context_kind='chat' and r.context_id=t."contextId"
      and r.organization_id=t."organizationId" and r.workspace_id=t."workspaceId" and r.owner_id=t."ownerId"
      left join approved a on a."artifactId"=coalesce(t."targetArtifactId",r.artifact_id)
      left join compatible c on r.context_kind='chat' and c."contextId"=r.context_id
        and c."organizationId"=r.organization_id and c."workspaceId"=r.workspace_id and c."ownerId"=r.owner_id
    group by r.source,coalesce(t."targetArtifactId",r.artifact_id),coalesce(t.generation,r.generation),r.profile_id
    order by r.source,coalesce(t."targetArtifactId",r.artifact_id),coalesce(t.generation,r.generation),r.profile_id`;
      // NULL origin + no pin is an implicit legacy executor dependency, even
      // when archived. An old reference count of zero is not retirement proof.
      const nullChats = await tx<
        {
          id: string;
          organization_id: string;
          workspace_id: string;
          owner_id: string;
        }[]
      >`select c.id,c.organization_id,c.workspace_id,c.owner_id
        from allrice_chat_sessions c where c.native_root_origin is null and not exists(
          select 1 from allrice_native_session_bindings b where b.context_kind='chat' and b.context_id=c.id)`;
      const remaining = nullChats.filter(
        (c) =>
          !retiredChatContexts.some(
            (r) =>
              r.contextId === c.id &&
              r.organizationId === c.organization_id &&
              r.workspaceId === c.workspace_id &&
              r.ownerId === c.owner_id,
          ),
      );
      if (remaining.length) {
        const id =
          process.env.ALLRICE_DSH_RETAINED_1_ARTIFACT_ID?.trim() ||
          process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID?.trim() ||
          null;
        references.push({
          source: 'implicit:legacy-chat',
          artifactId: id,
          generation: 'dsh-0.1.5-rc.3-a4c74a9',
          profileId: 'restricted',
          records: remaining.length,
          covered:
            !!id &&
            approved.some(
              (a) =>
                a.artifactId === id &&
                a.generation === 'dsh-0.1.5-rc.3-a4c74a9',
            ),
        });
      }
      // A closed Host still owns history and a future restart. There is no
      // implicit retirement from TTL, lack of business pins or terminal tasks.
      const [schema] =
        await tx`select to_regclass(format('%I.allrice_native_once_partitions',current_schema())) is not null available`;
      const nativeOnceControlReferences: NativeOnceControlReference[] = [];
      if (schema?.available) {
        const partitions = await tx<
          { partition_id: string; reference: unknown }[]
        >`select partition_id,reference from allrice_native_once_partitions order by partition_id`;
        for (const partition of partitions) {
          const reference = controlReferenceSchema.parse(partition.reference);
          const recurring =
            reference.profileId === 'allrice-recurring-control-v1';
          if (
            partition.partition_id !==
            (recurring ? 'allrice-recurring-v1' : 'allrice-once-v1')
          )
            throw Error('DSH_NATIVE_CONTROL_PARTITION_PROFILE_MISMATCH');
          const table = recurring
            ? 'allrice_native_recurring_controls'
            : 'allrice_native_once_controls';
          const controls = await tx<
            { control_session_id: string; session_state: unknown }[]
          >`select control_session_id,snapshot->'control'->>'sessionState' session_state
          from ${tx(table)} where partition_id=${partition.partition_id} order by control_session_id`;
          nativeOnceControlReferences.push({
            partitionId: partition.partition_id,
            reference,
            controls: controls.map((c) => ({
              controlSessionId: c.control_session_id,
              sessionState: z
                .enum(['reserved', 'initializing', 'ready'])
                .parse(c.session_state),
            })),
          });
          const descriptor = approved.find(
            (a) =>
              a.artifactId === reference.artifactId &&
              a.generation === 'dsh-0.2.1-rc.2-687f282',
          );
          references.push({
            source: recurring
              ? 'control:native_recurring'
              : 'control:native_once',
            artifactId: reference.artifactId,
            generation: 'dsh-0.2.1-rc.2-687f282',
            profileId: reference.profileId,
            records: 1,
            covered: !!descriptor,
          });
        }
      }
      // Same read-only snapshot as origin/binding/control references. Current
      // approved live runtimes do not block an ordinary rolling deployment.
      const closeObservations = await readDshRuntimeCloseCoverage(tx, {
        outsideApprovedArtifacts: approved.map((a) => a.artifactId),
      });
      const closeCoverage = assertDshCloseArtifactCoverage(
        closeObservations,
        approved.map((a) => a.artifactId),
        retiredChatContexts,
      );
      return {
        references,
        nativeOnceControlReferences,
        retiredContexts,
        closeCoverage,
      };
    },
  );
  const { references, nativeOnceControlReferences, retiredContexts } = snapshot;
  const missing = references.filter((r) => !r.covered);
  if (missing.length)
    throw Error(
      'DSH_NATIVE_ARTIFACT_REFERENCES_UNCOVERED ' + JSON.stringify(missing),
    );
  return {
    verified: true as const,
    closeCoverage: snapshot.closeCoverage,
    references,
    nativeOnceControlReferences,
    ...(retiredContexts.length ? { retiredContexts } : {}),
    ...(readers.length
      ? {
          compatibleOrigins: readers.map(
            ({
              contextId,
              sourceArtifactId,
              targetArtifactId,
              approvalDigest,
            }) => ({
              contextId,
              sourceArtifactId,
              targetArtifactId,
              approvalDigest,
            }),
          ),
        }
      : {}),
  };
}
