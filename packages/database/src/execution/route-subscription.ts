import {
  AssistantSubscriptionSnapshotSchema,
  SessionModelSnapshotSchema,
  resolveAssistantSubscriptionSnapshot,
  type AssistantSubscriptionSnapshot,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { runtimeLedgerInputDigest } from '../runtime-ledger/ledger.ts';

/** Trusted Worker pre-dispatch port, not reconciliation. An old completed NULL
 * ledger can never acquire a subscription exemption through this function. */
export async function freezeRouteSubscriptionSnapshot(
  input: {
    organizationId: string;
    workspaceId: string;
    decisionId: string;
    snapshot: AssistantSubscriptionSnapshot;
  },
  sql = getDatabase(),
) {
  const snapshot = AssistantSubscriptionSnapshotSchema.parse(input.snapshot);
  const snapshotDigest = runtimeLedgerInputDigest(snapshot);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`tenant:${input.organizationId.toLowerCase()}`}))`;
    const [row] = await tx`
      select d.*,e.session_id,e.execution_snapshot->'modelSnapshot' as model_snapshot,
        p.provider_key,p.auth_mode,s.snapshot_digest as old_digest,s.snapshot as old_snapshot
      from allrice_route_decisions d
      join allrice_employee_runs e on e.run_id=d.run_id
        and e.organization_id=d.organization_id and e.workspace_id=d.workspace_id
        and e.owner_id=d.actor_id
      join allrice_model_connections c on c.id=d.model_connection_id
        and (c.scope='platform' or c.organization_id=d.organization_id)
      join allrice_model_providers p on p.id=c.provider_id
      join allrice_model_catalog_entries m on m.id=d.model_catalog_entry_id
        and m.provider_id=p.id and m.model=d.model
      left join allrice_route_subscription_snapshots s on s.route_decision_id=d.id
      where d.id=${input.decisionId} and d.organization_id=${input.organizationId}
        and d.workspace_id=${input.workspaceId} for update of d`;
    if (
      !row ||
      !['codex', 'openai-codex'].includes(row.provider_key) ||
      row.auth_mode !== 'chatgpt_subscription'
    )
      throw Error('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
    const frozen = SessionModelSnapshotSchema.parse(row.model_snapshot);
    const target = [frozen, ...frozen.resolvedFallbacks].find(
      (t) =>
        t.connectionId === snapshot.connectionId &&
        t.modelCatalogEntryId === snapshot.modelCatalogEntryId,
    );
    if (!target) throw Error('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
    const expected = resolveAssistantSubscriptionSnapshot({
      sessionId: row.session_id,
      modelSnapshot: frozen,
      decision: {
        employeeId: row.employee_id,
        modelConnectionId: row.model_connection_id,
        modelCatalogEntryId: row.model_catalog_entry_id,
        modelPolicyRevision: row.model_policy_revision,
        harness: row.harness,
        provider: row.provider,
        model: row.model,
      },
      providerSnapshot: {
        provider: 'dsh',
        route: 'openai-codex',
        authMode: 'platform_subscription',
        model: snapshot.model,
        credentialReference: snapshot.credentialReference,
        baseUrl: null,
        reasoningEffort: target.reasoningEffort,
      },
    });
    if (!expected || runtimeLedgerInputDigest(expected) !== snapshotDigest)
      throw Error('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
    if (row.old_digest) {
      if (
        row.old_digest !== snapshotDigest ||
        runtimeLedgerInputDigest(
          AssistantSubscriptionSnapshotSchema.parse(row.old_snapshot),
        ) !== snapshotDigest
      )
        throw Error('ASSISTANT_SUBSCRIPTION_SNAPSHOT_CONFLICT');
      return { frozen: false, snapshotDigest };
    }
    const [ledger] =
      await tx`select 1 from allrice_model_usage_ledger where route_decision_id=${input.decisionId}`;
    if (row.status !== 'pending' || ledger)
      throw Error('ASSISTANT_SUBSCRIPTION_FREEZE_TOO_LATE');
    await tx`insert into allrice_route_subscription_snapshots(route_decision_id,snapshot,snapshot_digest)
      values(${input.decisionId},${tx.json(snapshot)},${snapshotDigest})`;
    await tx`update allrice_route_decisions set cost_cents=null where id=${input.decisionId}`;
    return { frozen: true, snapshotDigest };
  });
}

/** Durable pre-dispatch proof reader for controller binding; rejects fabricated,
 * cross-Run and corrupt snapshots without touching a price or credential. */
export async function verifyRouteSubscriptionSnapshot(
  input: {
    organizationId: string;
    workspaceId: string;
    runId: string;
    snapshot: AssistantSubscriptionSnapshot;
  },
  sql = getDatabase(),
) {
  const snapshot = AssistantSubscriptionSnapshotSchema.parse(input.snapshot);
  const snapshotDigest = runtimeLedgerInputDigest(snapshot);
  const rows = await sql`
    select s.snapshot,s.snapshot_digest from allrice_route_subscription_snapshots s
    join allrice_route_decisions d on d.id=s.route_decision_id
    where d.run_id=${input.runId} and d.organization_id=${input.organizationId}
      and d.workspace_id=${input.workspaceId} and d.status='pending'
      and s.snapshot_digest=${snapshotDigest}`;
  if (
    rows.length !== 1 ||
    runtimeLedgerInputDigest(
      AssistantSubscriptionSnapshotSchema.parse(rows[0]!.snapshot),
    ) !== snapshotDigest
  )
    throw Error('ASSISTANT_SUBSCRIPTION_SNAPSHOT_UNVERIFIED');
  return { snapshotDigest };
}
