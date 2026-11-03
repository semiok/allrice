import {
  UuidSchema,
  isModelFailureCode,
  modelFailure,
  readModelFailure,
  type ModelFailure,
} from '@allrice/contracts';
import type postgres from 'postgres';
import type { getDatabase } from '../core/client.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export interface ModelFailureScope {
  organizationId: string;
  workspaceId: string;
  runId: string;
  attempt?: number;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Only the existing root event projection can attest a new provider code. */
export function rootModelFailure(payload: unknown): ModelFailure | null {
  const row = object(payload);
  if (
    row?.source !== 'dsh' ||
    row.internalTask != null ||
    !UuidSchema.safeParse(row.conversationId).success ||
    !UuidSchema.safeParse(row.messageId).success ||
    row.sourceEventType !== 'assistant/attempt' ||
    typeof row.sourceEventId !== 'string' ||
    !/^dsh:[0-9]+$/.test(row.sourceEventId)
  )
    return null;
  return readModelFailure(object(row.nativePayload)?.modelFailure);
}

/** A later message or recovery invalidates an earlier failure as the terminal
 * cause. This is a read of display evidence, never execution permission. */
export async function readTerminalModelFailure(
  sql: Sql,
  scope: ModelFailureScope,
  code: string | null | undefined,
  message: unknown,
): Promise<ModelFailure | null> {
  if (!code?.startsWith('DSH_')) return null;
  const [chat] = await sql<{ present: boolean }[]>`
    select exists(select 1 from allrice_employee_runs er
      where er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId}
        and er.run_id=${scope.runId} and er.session_id is not null and er.assistant_message_id is not null) present`;
  if (!chat?.present) return null;
  const [last] = await sql<{ payload: unknown }[]>`
    select jsonb_build_object('source',payload->'source','sourceEventType',payload->'sourceEventType',
      'sourceEventId',payload->'sourceEventId','conversationId',payload->'conversationId',
      'messageId',payload->'messageId','internalTask',payload->'internalTask','nativePayload',jsonb_build_object('modelFailure',payload#>'{nativePayload,modelFailure}')) payload
    from allrice_run_events
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and run_id=${scope.runId} and payload->>'source'='dsh'
      and coalesce(payload->'internalTask','null'::jsonb)='null'::jsonb
      and exists(select 1 from allrice_employee_runs er where er.run_id=${scope.runId}
        and er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId}
        and er.session_id::text=payload->>'conversationId' and er.assistant_message_id::text=payload->>'messageId')
      and (${scope.attempt ?? null}::int is null or payload->>'attempt'=${String(scope.attempt)})
      and payload->>'sourceEventType' in ('assistant/attempt','assistant/message','llm/retry','llm/retry-started')
    order by sequence desc limit 1`;
  const receipt = rootModelFailure(last?.payload);
  if (receipt?.code && `DSH_${receipt.code}` === code) return receipt;
  return isModelFailureCode(code)
    ? modelFailure(message, undefined, code.slice(4))
    : null;
}

export async function readRootModelFailures(
  sql: Sql,
  scope: ModelFailureScope,
) {
  const rows = await sql<{ payload: unknown }[]>`
    select jsonb_build_object('source',payload->'source','sourceEventType',payload->'sourceEventType',
      'sourceEventId',payload->'sourceEventId','conversationId',payload->'conversationId',
      'messageId',payload->'messageId','internalTask',payload->'internalTask','nativePayload',jsonb_build_object('modelFailure',payload#>'{nativePayload,modelFailure}')) payload
    from allrice_run_events
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and run_id=${scope.runId} and payload->>'source'='dsh'
      and coalesce(payload->'internalTask','null'::jsonb)='null'::jsonb
      and exists(select 1 from allrice_employee_runs er where er.run_id=${scope.runId}
        and er.organization_id=${scope.organizationId} and er.workspace_id=${scope.workspaceId}
        and er.session_id::text=payload->>'conversationId' and er.assistant_message_id::text=payload->>'messageId')
      and payload->>'sourceEventType'='assistant/attempt'
      and payload#>'{nativePayload,modelFailure}' is not null
    order by sequence desc limit 9`;
  const failures = rows
    .map((row) => rootModelFailure(row.payload))
    .filter((value): value is ModelFailure => value !== null);
  return { failures: failures.slice(0, 8), truncated: failures.length > 8 };
}

/** Scalar display fragment for an already scoped allrice_runs alias `r`.
 * The terminal receipt is written by failJob from proven root evidence;
 * public task/history queries select its category, never the private message. */
export function terminalModelFailureCategorySql(sql: Sql) {
  return sql`(select e.payload#>>'{modelFailure,category}' from allrice_run_events e
    where e.run_id=r.id and e.organization_id=r.organization_id and e.workspace_id=r.workspace_id
      and e.event_type='run.failed' and e.payload->>'code'=r.error_code
      and exists(select 1 from allrice_employee_runs er where er.run_id=r.id
        and er.organization_id=r.organization_id and er.workspace_id=r.workspace_id)
    order by e.sequence desc limit 1)`;
}
