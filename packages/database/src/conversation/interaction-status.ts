import { getDatabase } from '../core/client.ts';
import {
  assertWorkbenchSession,
  type WorkbenchPrincipal,
} from '../artifact-review.ts';
import { RuntimeNativeInputProofSchema } from '@allrice/contracts';

/** Read-only bounded projections of durable authority; never resumes a Run. */
export async function getInteractionStatus(
  context: WorkbenchPrincipal,
  sessionId: string,
  db = getDatabase(),
) {
  return db.begin(async (tx) => {
    await assertWorkbenchSession(tx, context, sessionId);
    const [runtime] = await tx<
      {
        state: string;
        active_run_id: string | null;
        active_turn_id: string | null;
        thread_generation: number;
        config_checksum: string;
        current_version_id: string | null;
        next_version_id: string | null;
      }[]
    >`
      select cr.state,cr.active_run_id,cr.active_turn_id,cr.thread_generation,cr.config_checksum,
        er.employee_version_id as current_version_id,a.employee_version_id as next_version_id
      from allrice_conversation_runtimes cr
      join allrice_chat_sessions s on s.id=cr.session_id
      join allrice_employee_assignments a on a.id=s.employee_assignment_id
      left join allrice_employee_runs er on er.run_id=cr.active_run_id
      where cr.session_id=${sessionId}`;
    const inputs = await tx<
      {
        id: string;
        kind: string;
        user_message_id: string;
        created_at: Date;
        command_state: string | null;
        native_proof: unknown;
        error_code: string | null;
        run_id: string | null;
        run_state: string | null;
        followup_state: string | null;
        assistant_status: string;
        expected_turn_id: string | null;
        expected_generation: number | null;
        artifact_id: string | null;
      }[]
    >`
      select i.client_message_id as id,i.kind,i.user_message_id,i.created_at,c.state as command_state,c.native_proof,c.error_code,
      er.run_id,r.state as run_state,f.state as followup_state,m.status as assistant_status,c.expected_turn_id,c.expected_generation,
      rc.artifact_id from allrice_chat_input_requests i
      join allrice_messages m on m.reply_to_id=i.user_message_id and m.role='assistant'
      left join allrice_employee_runs er on er.assistant_message_id=m.id
      left join allrice_runs r on r.id=er.run_id
      left join allrice_conversation_followups f on f.run_id=er.run_id
      left join allrice_conversation_commands c on c.followup_run_id=f.run_id
      left join allrice_review_continuations rc on rc.run_id=er.run_id
      where i.organization_id=${context.organizationId} and i.workspace_id=${context.workspaceId!}
        and i.session_id=${sessionId} and i.owner_id=${context.actor.id}
      order by i.created_at desc,i.client_message_id desc limit 30`;
    const actions = await tx<
      {
        id: string;
        resource_id: string;
        run_id: string;
        runtime_expires_at: Date;
      }[]
    >`
      select a.id,a.resource_id,a.run_id,a.runtime_expires_at from allrice_approval_requests a
      join allrice_employee_runs er on er.run_id=a.run_id
      join allrice_runtime_operations op on op.id=a.resource_id and op.organization_id=a.organization_id and op.workspace_id=a.workspace_id
      where a.organization_id=${context.organizationId} and a.workspace_id=${context.workspaceId!}
      and er.session_id=${sessionId} and er.owner_id=${context.actor.id}
      and a.runtime_request->>'respondentId'=${context.actor.id}
      and a.status='pending' and a.runtime_response is null and a.runtime_revoked_at is null and a.runtime_expires_at>now()
      and op.snapshot->>'status'='waiting_user' order by a.requested_at limit 30`;
    return {
      pendingActions: actions.map((a) => ({
        approvalId: a.id,
        operationId: a.resource_id,
        runId: a.run_id,
        expiresAt: a.runtime_expires_at.toISOString(),
      })),
      runtime: runtime
        ? {
            state: runtime.state,
            runId: runtime.active_run_id,
            turnId: runtime.active_turn_id,
            generation: runtime.thread_generation,
            configChecksum: runtime.config_checksum,
            currentVersionId: runtime.current_version_id,
            nextVersionId: runtime.next_version_id,
          }
        : null,
      inputs: inputs.map((i) => {
        const parsed = RuntimeNativeInputProofSchema.safeParse(i.native_proof);
        const proof = parsed.success ? parsed.data : null;
        const status = i.command_state
          ? i.command_state === 'consumed' && proof?.status === 'adopted'
            ? 'adopted'
            : i.command_state === 'rejected'
              ? i.error_code === 'INPUT_OUTCOME_UNKNOWN'
                ? 'unknown'
                : 'rejected'
              : 'pending'
          : !i.run_id
            ? i.assistant_status === 'failed'
              ? 'rejected'
              : 'received'
            : i.run_state === 'queued'
              ? 'queued'
              : i.run_state === 'running'
                ? 'running'
                : i.run_state === 'succeeded'
                  ? 'completed'
                  : i.run_state === 'canceled'
                    ? 'canceled'
                    : 'failed';
        return {
          inputId: i.id,
          kind: i.kind,
          status,
          runId: i.run_id,
          messageId: i.user_message_id,
          artifactId: i.artifact_id,
          createdAt: i.created_at.toISOString(),
          turnId: i.expected_turn_id,
          generation: i.expected_generation,
          evidence:
            proof?.status === 'adopted'
              ? { sequence: proof.sequence, checkpoint: proof.checkpoint }
              : null,
        };
      }),
    };
  });
}
