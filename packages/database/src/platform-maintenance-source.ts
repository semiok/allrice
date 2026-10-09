import { randomUUID } from 'node:crypto';
import { getDatabase } from './core/client.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { executionPressureSnapshot } from './execution-diagnostics.ts';
import { QualityCheckReportSchema } from './platform-quality-contracts.ts';
import {
  MaintenanceReportPayloadSchema,
  MaintenanceReportReceiptSchema,
  type MaintenanceReportPayload,
} from './platform-maintenance-report-contracts.ts';

type Probe = MaintenanceReportPayload['facts']['probe'];
/** Bounded, metadata-only collector. It never reads employee messages, files,
 * credentials or business records, and never creates a repair/model Run. */
export async function collectMaintenanceSourceReports(input: {
  connectionDigest: string;
  deploymentId: string;
  releaseSha: string;
  intervalMinutes: number;
  probe: Probe;
}) {
  if (!/^[a-f0-9]{40}$/.test(input.releaseSha))
    throw Error('maintenance_release_identity_missing');
  const db = getDatabase(),
    pressure = await executionPressureSnapshot(db);
  const findings: MaintenanceReportPayload['facts']['findings'] = [];
  if (pressure.jobs && pressure.jobs.longest_wait_ms > 300000)
    findings.push({
      id: 'resource_wait',
      occurrences: Math.min(1000000, Math.max(1, pressure.jobs.queued)),
      errorCode: null,
    });
  if (input.probe?.failedAssertions.length)
    findings.push({
      id: 'secret_output',
      occurrences: input.probe.failedAssertions.length,
      errorCode: 'QUOTED_SECRET_REDACTION',
    });
  const facts = { findings, quality: null, probe: input.probe },
    factsDigest = technicalDigest({ releaseSha: input.releaseSha, facts });
  return db.begin(async (tx) => {
    await tx`insert into allrice_platform_maintenance_source_state(connection_digest,deployment_id) values(${input.connectionDigest},${input.deploymentId}) on conflict do nothing`;
    const [state] =
      await tx`select * from allrice_platform_maintenance_source_state where connection_digest=${input.connectionDigest} for update`;
    const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
    const now = clock?.now;
    if (!state || !now) return 0;
    // Recompute from the latest policy, including a shortened interval.
    const dueAt = state.last_sampled_at
      ? new Date(state.last_sampled_at).getTime() +
        input.intervalMinutes * 60000
      : 0;
    if (dueAt > now.getTime()) return 0;
    let queued = 0;
    async function enqueue(localSourceId: string, raw: unknown) {
      const payload = MaintenanceReportPayloadSchema.parse(raw);
      const rows =
        await tx`insert into allrice_platform_maintenance_outbox(id,connection_digest,deployment_id,source_kind,local_source_id,payload,payload_digest)
        values(${randomUUID()},${input.connectionDigest},${input.deploymentId},${payload.sourceKind},${localSourceId},${tx.json(payload)},${technicalDigest(payload)}) on conflict(connection_digest,source_kind,local_source_id) do nothing returning id`;
      queued += rows.length;
    }
    if (state.last_facts_digest !== factsDigest)
      await enqueue('health:' + String(Number(state.sequence) + 1), {
        version: 1,
        sourceReportId: randomUUID(),
        sourceKind: 'deployment_health',
        sampledAt: now.toISOString(),
        observedReleaseSha: input.releaseSha,
        producerVersion: 'allrice-maintenance.v1',
        facts,
      });
    const qualityRows =
      await tx`select q.id,q.frozen,q.report from allrice_platform_quality_checks q join allrice_jobs j on j.id=q.job_id
      where q.created_at>=${state.created_at} and q.report is not null and j.status in ('succeeded','failed','canceled')
      and not exists(select 1 from allrice_platform_maintenance_outbox o where o.connection_digest=${input.connectionDigest} and o.source_kind='quality_check' and o.local_source_id='quality:'||q.id::text)
      order by q.created_at limit 50`;
    for (const q of qualityRows) {
      const parsed = QualityCheckReportSchema.safeParse(q.report),
        f = q.frozen as {
          caseId?: string;
          variant?: string;
          releaseSha?: string;
        };
      if (
        !parsed.success ||
        !f.releaseSha ||
        !/^[a-f0-9]{40}$/.test(f.releaseSha) ||
        !['project.static.v1', 'project.live.v1'].includes(f.caseId ?? '') ||
        !['correct', 'defect'].includes(f.variant ?? '')
      )
        continue;
      const r = parsed.data,
        digest = technicalDigest(r);
      await enqueue('quality:' + q.id, {
        version: 1,
        sourceReportId: randomUUID(),
        sourceKind: 'quality_check',
        sampledAt: r.completedAt,
        observedReleaseSha: f.releaseSha,
        producerVersion: 'allrice-maintenance.v1',
        facts: {
          findings:
            r.verdict === 'assertion_failed'
              ? [
                  {
                    id: 'quality_failure',
                    occurrences: 1,
                    errorCode: r.errorCode,
                  },
                ]
              : [],
          probe: null,
          quality: {
            caseId: f.caseId,
            variant: f.variant,
            verdict: r.verdict,
            reportDigest: digest,
            cleanup: r.cleanup,
          },
        },
      });
    }
    await tx`update allrice_platform_maintenance_source_state set last_sampled_at=clock_timestamp(),next_check_at=clock_timestamp()+${input.intervalMinutes}*interval '1 minute',last_facts_digest=${factsDigest},sequence=sequence+${state.last_facts_digest !== factsDigest ? 1 : 0},updated_at=clock_timestamp() where connection_digest=${input.connectionDigest}`;
    return queued;
  });
}
export async function claimMaintenanceSourceReport(connectionDigest: string) {
  return getDatabase().begin(async (tx) => {
    const [row] =
      await tx`select * from allrice_platform_maintenance_outbox where connection_digest=${connectionDigest} and delivered_at is null and next_attempt_at<=clock_timestamp() and (sending_until is null or sending_until<clock_timestamp()) order by created_at,id limit 1 for update skip locked`;
    if (!row) return null;
    const [claimed] =
      await tx`update allrice_platform_maintenance_outbox set attempts=attempts+1,sending_until=clock_timestamp()+interval '45 seconds' where id=${row.id} returning *`;
    const payload = MaintenanceReportPayloadSchema.parse(claimed!.payload);
    if (technicalDigest(payload) !== claimed!.payload_digest)
      throw Error('maintenance_outbox_digest_mismatch');
    return {
      id: String(claimed!.id),
      attempt: Number(claimed!.attempts),
      deploymentId: String(claimed!.deployment_id),
      payload,
      payloadDigest: String(claimed!.payload_digest),
    };
  });
}
export async function settleMaintenanceSourceReport(input: {
  id: string;
  attempt: number;
  receipt?: unknown;
  failed?: boolean;
}) {
  return getDatabase().begin(async (tx) => {
    const [old] =
      await tx`select * from allrice_platform_maintenance_outbox where id=${input.id} and attempts=${input.attempt} and delivered_at is null for update`;
    if (!old) return false;
    if (input.receipt) {
      const r = MaintenanceReportReceiptSchema.parse(input.receipt),
        payload = MaintenanceReportPayloadSchema.parse(old.payload);
      if (
        r.deploymentId !== old.deployment_id ||
        r.sourceReportId !== payload.sourceReportId ||
        r.payloadDigest !== old.payload_digest
      )
        throw Error('maintenance_receipt_mismatch');
      await tx`update allrice_platform_maintenance_outbox set receipt=${tx.json(r)},delivered_at=clock_timestamp(),sending_until=null,last_error=null where id=${input.id}`;
      await tx`update allrice_platform_maintenance_source_state set last_delivery_at=clock_timestamp(),last_error=null where connection_digest=${old.connection_digest}`;
    } else {
      const seconds = Math.min(
        900,
        30 * 2 ** Math.min(5, Number(old.attempts) - 1),
      );
      await tx`update allrice_platform_maintenance_outbox set sending_until=null,next_attempt_at=clock_timestamp()+${seconds}*interval '1 second',last_error='transport_unconfirmed' where id=${input.id}`;
      await tx`update allrice_platform_maintenance_source_state set last_error='transport_unconfirmed' where connection_digest=${old.connection_digest}`;
    }
    return true;
  });
}
