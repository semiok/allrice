import {
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
  const [last] = await sql<{ payload: unknown }[]>`
    select jsonb_build_object('source',payload->'source','sourceEventType',payload->'sourceEventType',
      'sourceEventId',payload->'sourceEventId','nativePayload',jsonb_build_object('modelFailure',payload#>'{nativePayload,modelFailure}')) payload
    from allrice_run_events
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and run_id=${scope.runId} and payload->>'source'='dsh'
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
      'sourceEventId',payload->'sourceEventId','nativePayload',jsonb_build_object('modelFailure',payload#>'{nativePayload,modelFailure}')) payload
    from allrice_run_events
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and run_id=${scope.runId} and payload->>'source'='dsh'
      and payload->>'sourceEventType'='assistant/attempt'
      and payload#>'{nativePayload,modelFailure}' is not null
    order by sequence desc limit 9`;
  const failures = rows
    .map((row) => rootModelFailure(row.payload))
    .filter((value): value is ModelFailure => value !== null);
  return { failures: failures.slice(0, 8), truncated: failures.length > 8 };
}
