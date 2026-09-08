/** Shared, read-only acceptance query. Run it before spending model budget. */
import assert from 'node:assert/strict';
import type Postgres from '../../../packages/database/node_modules/postgres/types/index.d.ts';

export type ReconciliationAuditScope = {
  organizationId: string;
  workspaceId: string;
  actorId: string;
  runId: string;
  executionId: string;
};

type Audit = ReconciliationAuditScope & {
  id: string;
  action: string;
  resourceType: string;
  decision: string;
  toolName: string;
};

export async function readReconciliationAudits(
  db: ReturnType<typeof Postgres>,
  scope: ReconciliationAuditScope,
) {
  // Never project whole metadata: only verified identity and tool names. The
  // real recordToolBrokerAudit stores Run/Execution in metadata, not resource_id.
  return db<Audit[]>`
    select id,organization_id as "organizationId",workspace_id as "workspaceId",
      actor_id as "actorId",action,resource_type as "resourceType",decision,
      metadata->>'runId' as "runId",metadata->>'executionId' as "executionId",
      metadata->>'toolName' as "toolName"
    from allrice_audit_events
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and actor_id=${scope.actorId} and metadata->>'runId'=${scope.runId}
      and metadata->>'executionId'=${scope.executionId}
      and action='tool.execute' and resource_type='tool_broker'
    order by occurred_at,id limit 17
  `;
}

export function assertReconciliationAudits(
  audits: readonly Audit[],
  scope: ReconciliationAuditScope,
  expectedToolNames: readonly string[],
) {
  assert.ok(expectedToolNames.length > 0 && expectedToolNames.length <= 12);
  for (const audit of audits) {
    for (const key of Object.keys(scope) as (keyof ReconciliationAuditScope)[])
      assert.equal(
        audit[key],
        scope[key],
        `Audit ${key} matches this execution`,
      );
    assert.equal(audit.action, 'tool.execute');
    assert.equal(audit.resourceType, 'tool_broker');
    assert.equal(
      audit.decision,
      'allowed',
      'Every successful tool has an allowed audit',
    );
  }
  assert.deepEqual(
    audits.map((audit) => audit.toolName).sort(),
    [...expectedToolNames].sort(),
    'Actual audit tool names and counts match every successful Broker call',
  );
}

export async function saveReconciliationAssistantMessage(
  db: ReturnType<typeof Postgres>,
  scope: ReconciliationAuditScope & { sessionId: string; messageId: string },
  answer: string,
) {
  const rows = await db`update allrice_messages
    set content=${db.json({ text: answer, citations: [] })}
    where id=${scope.messageId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and session_id=${scope.sessionId}
      and owner_id=${scope.actorId} and role='assistant'
      and id=(select assistant_message_id from allrice_employee_runs
        where run_id=${scope.runId} and organization_id=${scope.organizationId}
          and workspace_id=${scope.workspaceId} and owner_id=${scope.actorId}
          and session_id=${scope.sessionId}) returning id`;
  assert.equal(
    rows.length,
    1,
    'Only this synthetic session assistant message was saved',
  );
}
