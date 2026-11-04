import {
  EmployeeSceneStateSchema,
  PersonalSceneContentRefSchema,
  PersonalSceneReadHistorySchema,
  PersonalSceneReadQuerySchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import {
  getEmployeeInstance,
  getEmployeeInstanceForHistory,
} from './employee-instances.ts';
import { EmployeeContentError } from './employee-content-model.ts';
import { EmployeeRuntimeContentError } from './employee-runtime-content.ts';
import {
  parsePersonalSceneContentRef,
  readPersonalSceneSkillInTransaction,
} from './personal-scene-skills.ts';

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
    if ((await getEmployeeInstance(context, instanceId, tx)).kind !== 'custom')
      throw new DataAccessError('not_found');
    return (
      await readPersonalSceneSkillInTransaction(
        context,
        instanceId,
        { contentRef },
        tx,
      )
    ).skill;
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
      (await getEmployeeInstanceForHistory(scope, instanceId, tx)).kind !==
      'custom'
    )
      throw new DataAccessError('not_found');
    const rows = await tx<
      {
        run_id: string;
        session_id: string;
        user_message_id: string;
        created_at: Date;
        cursor_created_at: string;
        status: string;
        error_code: string | null;
        content_scene_state: unknown;
      }[]
    >`select er.run_id,er.session_id,er.user_message_id,er.created_at,
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
    const runs = rows.slice(0, 20).map((row) => {
      const parsed = EmployeeSceneStateSchema.safeParse(
        row.content_scene_state ?? { reads: [] },
      );
      if (!parsed.success) throw new EmployeeContentError('source_changed');
      const reads = parsed.data.reads.flatMap((receipt) => {
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
          },
        ];
      });
      return {
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
      };
    });
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
