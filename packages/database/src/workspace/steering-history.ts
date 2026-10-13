import { RuntimeNativeInputProofSchema } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';

/** Project only receipt/order facts. Never expose command bodies or native prompts. */
export async function readSessionSteering(
  organizationId: string,
  workspaceId: string,
  sessionId: string,
  db = getDatabase(),
) {
  const rows = await db<
    {
      user_message_id: string;
      assistant_message_id: string;
      state: string;
      error_code: string | null;
      native_proof: unknown;
      expected_turn_id: string;
      expected_generation: number;
      client_user_message_id: string;
      run_id: string | null;
    }[]
  >`
    select f.user_message_id,f.assistant_message_id,c.state,c.error_code,c.native_proof,
      c.expected_turn_id,c.expected_generation,c.client_user_message_id,parent.run_id
    from allrice_conversation_commands c
    join allrice_conversation_followups f on f.run_id=c.followup_run_id
      and f.organization_id=c.organization_id and f.workspace_id=c.workspace_id
    left join lateral (
      select er.run_id from allrice_employee_runs er
      join allrice_run_events e on e.run_id=er.run_id
        and e.organization_id=er.organization_id and e.workspace_id=er.workspace_id
      where er.organization_id=c.organization_id and er.workspace_id=c.workspace_id
        and er.session_id=c.session_id and er.owner_id=c.owner_id
        and e.event_type='turn.started' and e.payload->>'turnId'=c.expected_turn_id
        and e.payload->>'generation'=c.expected_generation::text
      order by e.occurred_at desc limit 1
    ) parent on true
    where c.organization_id=${organizationId} and c.workspace_id=${workspaceId}
      and c.session_id=${sessionId} and c.input_kind='steer_current'
    order by c.created_at,c.id
  `;
  return rows.map((row) => {
    const parsed = RuntimeNativeInputProofSchema.safeParse(row.native_proof);
    const proof = parsed.success ? parsed.data : null;
    const adopted =
      row.state === 'consumed' &&
      proof?.status === 'adopted' &&
      proof.inputId === row.client_user_message_id &&
      proof.turnId === row.expected_turn_id;
    return {
      messageId: row.user_message_id,
      receiptId: adopted ? row.assistant_message_id : null,
      steering: {
        runId: row.run_id,
        turnId: row.expected_turn_id,
        generation: row.expected_generation,
        status: adopted
          ? ('adopted' as const)
          : row.error_code === 'INPUT_OUTCOME_UNKNOWN' ||
              row.state === 'consumed'
            ? ('unknown' as const)
            : row.state === 'rejected'
              ? ('rejected' as const)
              : ('pending' as const),
        sequence: adopted ? proof.sequence : null,
      },
    };
  });
}
