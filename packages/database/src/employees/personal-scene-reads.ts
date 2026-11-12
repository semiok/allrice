import { canUsePersonalEmployeeScenes } from './employee-instance-policy.ts';
import {
  EmployeeSceneStateSchema,
  EmployeeContentManifestSchema,
  PersonalSceneUseSchema,
  UuidSchema,
  PersonalSceneContentRefSchema,
  PersonalSceneReadHistorySchema,
  PersonalSceneReadQuerySchema,
  type PersonalSceneReadHistory,
  type RequestContext,
} from '@allrice/contracts';
import { z } from 'zod';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import {
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
} from './employee-instances.ts';
import { EmployeeContentError } from './employee-content-model.ts';
import { EmployeeRuntimeContentError } from './employee-runtime-content.ts';
import { runtimePolicyDigest } from '../runtime-policy-digest.ts';
import {
  parsePersonalSceneContentRef,
  personalSceneSkillAuthorView,
  readPersonalSceneSkillInTransaction,
} from './personal-scene-skills.ts';

// Read only the existing normalized root-event envelope. Extra display slots
// (label/summary/etc.) are never copied into the API response.
export const personalSceneUseEnvelopeSchema = z.object({
  source: z.literal('dsh'),
  sourceEventType: z.literal('allrice/scene-use'),
  presentation: z.literal('context'),
  status: z.literal('completed'),
  conversationId: UuidSchema,
  messageId: UuidSchema,
  internalTask: z.null().optional(),
  threadId: z.string(),
  attempt: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  sourceEventId: z.string(),
  nativePayload: PersonalSceneUseSchema,
});

function human(context: RequestContext) {
  if (
    !context.sessionId ||
    context.actor.type !== 'user' ||
    !context.workspaceId
  )
    throw new DataAccessError('authorization_denied');
}

/** Exact human inspection uses the same current owner/instance and source
 * checks as runtime reads, without pretending the human is a leased Run. */
export async function inspectPersonalSceneSkill(
  context: RequestContext,
  instanceId: string,
  contentRefInput: string,
  db = getDatabase(),
) {
  human(context);
  const contentRef = PersonalSceneContentRefSchema.parse(contentRefInput);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    if (
      !(await canUsePersonalEmployeeScenes(
        await getEmployeeInstance(context, instanceId, tx),
        tx,
      ))
    )
      throw new DataAccessError('not_found');
    const result = await readPersonalSceneSkillInTransaction(
      context,
      instanceId,
      { contentRef },
      tx,
    );
    return personalSceneSkillAuthorView(result.skill);
  });
}

/** Audit metadata remains visible to its owner after a content source is
 * revoked; reopening any body/resource still goes through the exact reader. */
export async function listPersonalSceneReads(
  context: RequestContext,
  instanceId: string,
  raw: unknown = {},
  db = getDatabase(),
) {
  const input = PersonalSceneReadQuerySchema.parse(raw);
  const scope = {
    ...context,
    workspaceId: input.workspaceId ?? context.workspaceId,
  };
  human(scope);
  return db.begin('isolation level repeatable read read only', async (tx) => {
    if (
      !(await canUsePersonalEmployeeScenes(
        await getEmployeeInstanceForHistory(scope, instanceId, tx),
        tx,
      ))
    )
      throw new DataAccessError('not_found');
    const rows = await tx<
      {
        run_id: string;
        session_id: string;
        user_message_id: string;
        assistant_message_id: string | null;
        created_at: Date;
        cursor_created_at: string;
        status: string;
        error_code: string | null;
        content_scene_state: unknown;
      }[]
    >`select er.run_id,er.session_id,er.user_message_id,er.assistant_message_id,er.created_at,
      to_char(er.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_created_at,r.state as status,
      r.error_code,er.content_scene_state
      from allrice_employee_runs er
      join allrice_runs r on r.id=er.run_id and r.organization_id=er.organization_id
        and r.workspace_id=er.workspace_id and r.owner_id=er.owner_id
      join allrice_chat_sessions c on c.id=er.session_id and c.organization_id=er.organization_id
        and c.workspace_id=er.workspace_id and c.owner_id=er.owner_id
      where er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId}
        and er.owner_id=${scope.actor.id}
        and c.employee_instance_id=${instanceId}
        and er.execution_snapshot->'instance'->>'id'=${instanceId}
        ${input.runId ? tx`and er.run_id=${input.runId}` : tx``}
        ${input.beforeRunId ? tx`and (er.created_at,er.run_id)<(${input.beforeCreatedAt!}::timestamptz,${input.beforeRunId}::uuid)` : tx``}
      order by er.created_at desc,er.run_id desc limit 21`;
    if (input.runId && !rows.length) throw new DataAccessError('not_found');
    const page = rows.slice(0, 20);
    const events = page.length
      ? await tx<
          {
            id: string;
            run_id: string;
            sequence: number;
            occurred_at: Date;
            payload: unknown;
            bound_session_id: string | null;
          }[]
        >`select e.id,e.run_id,e.sequence,e.occurred_at,e.payload,b.native_session_id as bound_session_id
      from allrice_run_events e
      left join allrice_native_session_bindings b
        on b.native_session_id=e.payload#>>'{nativePayload,nativeSessionId}'
        and b.organization_id=${scope.organizationId} and b.workspace_id=${scope.workspaceId}
        and b.owner_id=${scope.actor.id} and b.context_kind='chat'
        and b.context_id::text=e.payload->>'conversationId'
      where e.organization_id=${scope.organizationId} and e.workspace_id=${scope.workspaceId}
        and e.run_id in ${tx(page.map((row) => row.run_id))}
        and e.event_type='harness.native' and e.payload->>'sourceEventType'='allrice/scene-use'
      order by e.sequence,e.id`
      : [];
    const claims = new Map<string, string>();
    const runs = [];
    for (const row of page) {
      const parsed = EmployeeSceneStateSchema.safeParse(
        row.content_scene_state ?? { reads: [] },
      );
      if (!parsed.success) throw new EmployeeContentError('source_changed');
      const reads = parsed.data.reads.flatMap<
        PersonalSceneReadHistory['runs'][number]['reads'][number]
      >((receipt) => {
        const read = receipt.personal;
        if (!read) return [];
        if (
          read.instanceId !== instanceId ||
          read.runId !== row.run_id ||
          receipt.sceneDigest !== read.bundleChecksum ||
          parsePersonalSceneContentRef(read.contentRef).sceneId !==
            receipt.sceneId
        )
          throw new EmployeeContentError('source_changed');
        return [
          {
            receiptId: receipt.receiptId,
            sceneId: receipt.sceneId,
            contentRef: read.contentRef,
            contentChecksum: read.contentChecksum,
            bundleChecksum: read.bundleChecksum,
            contentRead: read.contentRead === true,
            resources: read.resources,
            generationId: read.generationId,
            readAt: read.readAt,
            uses: [],
          },
        ];
      });
      for (const event of events.filter((item) => item.run_id === row.run_id)) {
        const parsedEvent = personalSceneUseEnvelopeSchema.safeParse(
          event.payload,
        );
        if (!parsedEvent.success)
          throw new EmployeeContentError('source_changed');
        const envelope = parsedEvent.data,
          use = envelope.nativePayload;
        const read = reads.find((item) => item.contentRef === use.contentRef);
        if (
          !read ||
          !read.contentRead ||
          read.sceneId !== use.sceneId ||
          read.contentChecksum !== use.contentChecksum ||
          read.bundleChecksum !== use.bundleChecksum ||
          envelope.threadId !== use.nativeSessionId ||
          event.bound_session_id !== use.nativeSessionId ||
          envelope.conversationId !== row.session_id ||
          envelope.messageId !== row.assistant_message_id ||
          envelope.sourceEventId !==
            `scene-use:${use.nativeSessionId}:${use.nativeSequence}`
        )
          throw new EmployeeContentError('source_changed');
        // Immutable identity only, independent of current publication/source
        // authorization. Revocation must not erase a proven historical use.
        const pin = parsePersonalSceneContentRef(read.contentRef);
        const [identity] = await tx<
          {
            number: number;
            manifest: unknown;
            digest: string;
            source_digest: string;
            source_content_id: string;
            content_checksum: string | null;
            bundle_checksum: string | null;
            author_name: string | null;
          }[]
        >`select r.number,r.manifest,r.digest,a.digest as source_digest,a.asset_id as source_content_id,
          a.content#>>'{skillPackage,bundle,contentChecksum}' as content_checksum,
          a.content#>>'{skillPackage,bundle,checksum}' as bundle_checksum,
          a.content#>>'{skillPackage,frontmatter,name}' as author_name
          from allrice_employee_content_sets s
          join allrice_employee_content_revisions r on r.set_id=s.id and r.id=${pin.revisionId}
          join allrice_company_asset_revisions a on a.id=${pin.sourceRevisionId} and a.organization_id=s.organization_id
          where s.id=${pin.setId} and s.organization_id=${scope.organizationId} and s.workspace_id=${scope.workspaceId}
            and s.scope='personal' and s.owner_id=${scope.actor.id} and s.instance_id=${instanceId}`;
        const manifest = EmployeeContentManifestSchema.safeParse(
          identity?.manifest,
        );
        const procedures = manifest.success
          ? (manifest.data.scenes
              .find((scene) => scene.id === read.sceneId)
              ?.references.filter((ref) => ref.sourceKind === 'procedure') ??
            [])
          : [];
        if (
          !identity ||
          !manifest.success ||
          identity.number !== use.revision ||
          runtimePolicyDigest(manifest.data) !== identity.digest ||
          procedures.length !== 1 ||
          procedures[0]!.revisionId !== pin.sourceRevisionId ||
          procedures[0]!.contentId !== identity.source_content_id ||
          procedures[0]!.digest !== identity.source_digest ||
          identity.content_checksum !== use.contentChecksum ||
          identity.bundle_checksum !== use.bundleChecksum ||
          (use.nativeName !== `allrice-scene-${read.sceneId}` &&
            use.nativeName !== identity.author_name)
        )
          throw new EmployeeContentError('source_changed');
        const claim = runtimePolicyDigest({
          runId: row.run_id,
          attempt: envelope.attempt,
          generation: envelope.generation,
          use,
        });
        const previous = claims.get(envelope.sourceEventId);
        if (previous && previous !== claim)
          throw new EmployeeContentError('source_changed');
        if (!previous)
          read.uses.push({
            ...use,
            eventId: event.id,
            eventSequence: event.sequence,
            recordedAt: event.occurred_at.toISOString(),
          });
        claims.set(envelope.sourceEventId, claim);
      }
      runs.push({
        runId: row.run_id,
        sessionId: row.session_id,
        messageId: row.user_message_id,
        createdAt: row.cursor_created_at,
        status: row.status,
        // The private error message/code can contain upstream or configuration
        // details. Reuse the fixed content failure; other failures link back to
        // the existing Run receipt without copying its private slots.
        error:
          row.error_code === 'EMPLOYEE_CONTENT_UNAVAILABLE'
            ? {
                code: 'EMPLOYEE_CONTENT_UNAVAILABLE' as const,
                message: new EmployeeRuntimeContentError().message,
              }
            : row.error_code
              ? {
                  code: null,
                  message: '本次执行未完成，请回到原工作记录查看错误回执。',
                }
              : null,
        reads,
      });
    }
    const last = rows[19];
    return PersonalSceneReadHistorySchema.parse({
      instanceId,
      runs,
      nextCursor:
        rows.length > 20 && last
          ? { createdAt: last.cursor_created_at, runId: last.run_id }
          : null,
    });
  });
}
