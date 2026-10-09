import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type postgres from 'postgres';
import { UuidSchema, type RequestContext } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { isPlatformAdmin } from './platform-authority.ts';
import {
  currentMaintenanceAdmin,
  MaintenanceConflict,
} from './platform-maintenance.ts';
import { MaintenancePolicySchema } from './platform-maintenance-contracts.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  MaintenanceReportPayloadSchema,
  MaintenanceReportReceiptSchema,
  MaintenanceReportViewSchema,
  MaintenanceReportPageSchema,
  MaintenanceConnectionStateSchema,
  MaintenanceAssessmentSchema,
  type MaintenanceReportPayload,
} from './platform-maintenance-report-contracts.ts';

type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;
export type MaintenanceInstallationIdentity = {
  deploymentId: string;
  installationKey: string;
};
async function installation<T>(
  input: MaintenanceInstallationIdentity,
  work: (tx: Tx, deployment: Row) => Promise<T>,
) {
  const id = UuidSchema.safeParse(input.deploymentId);
  if (!id.success || !/^[-_A-Za-z0-9]{43}$/.test(input.installationKey))
    throw new DataAccessError('authentication_required');
  return getDatabase().begin(async (tx) => {
    const [d] =
      await tx`select * from allrice_platform_maintenance_deployments where id=${id.data} for share`;
    const digest = createHash('sha256').update(input.installationKey).digest();
    const expected = Buffer.from(d?.credential_digest ?? '0'.repeat(64), 'hex');
    if (
      expected.length !== 32 ||
      !timingSafeEqual(expected, digest) ||
      !d ||
      d.revoked_at ||
      !(await isPlatformAdmin({ actor: { type: 'user', id: d.owner_id } }, tx))
    )
      throw new DataAccessError('authentication_required');
    return work(tx, d);
  });
}
export async function getMaintenanceConnection(
  input: MaintenanceInstallationIdentity,
) {
  return installation(input, async (_tx, d) => {
    const policy = MaintenancePolicySchema.parse(d.policy);
    return MaintenanceConnectionStateSchema.parse({
      deploymentId: d.id,
      credentialRevision: d.credential_revision,
      policyRevision: d.revision,
      paused: policy.paused,
      checkIntervalMinutes: policy.checkIntervalMinutes,
      mode: policy.mode,
      automaticMerge: false,
      automaticDeployment: false,
    });
  });
}
function assessment(payload: MaintenanceReportPayload) {
  const synthetic = payload.facts.quality?.variant === 'defect';
  const probeFailed = !!payload.facts.probe?.failedAssertions.length;
  const qualityFailed =
    payload.facts.quality?.variant === 'correct' &&
    payload.facts.quality.verdict === 'assertion_failed';
  const failed =
    payload.facts.findings.length > 0 ||
    probeFailed ||
    !!(payload.facts.quality && payload.facts.quality.verdict !== 'passed');
  return MaintenanceAssessmentSchema.parse({
    version: 1,
    classification: synthetic
      ? 'synthetic_check'
      : probeFailed || qualityFailed
        ? 'suspected_code'
        : failed
          ? 'configuration_or_environment'
          : 'healthy',
    reason: synthetic
      ? 'synthetic_defect_is_not_source_bug'
      : probeFailed
        ? 'registered_probe_needs_central_reproduction'
        : qualityFailed
          ? 'quality_failure_needs_root_cause'
          : failed
            ? 'requires_diagnosis'
            : 'no_failure',
    repairEligible: false,
    sourceTrust: 'installation_assertion',
  });
}
function receipt(row: Row) {
  return MaintenanceReportReceiptSchema.parse({
    reportId: row.id,
    deploymentId: row.deployment_id,
    sourceReportId: row.source_report_id,
    payloadDigest: row.payload_digest,
    receivedAt: (row.received_at as Date).toISOString(),
  });
}
export async function receiveMaintenanceReport(
  identity: MaintenanceInstallationIdentity,
  raw: unknown,
  sentAt: string,
) {
  const payload = MaintenanceReportPayloadSchema.parse(raw),
    digest = technicalDigest(payload);
  return installation(identity, async (tx, d) => {
    // Serialize an immutable source id, including callers using different nonces.
    await tx`select pg_advisory_xact_lock(hashtext(${`maintenance-report:${d.id}:${payload.sourceReportId}`}))`;
    const [old] =
      await tx`select * from allrice_platform_maintenance_reports where deployment_id=${d.id as string} and source_report_id=${payload.sourceReportId}`;
    if (old) {
      if (old.payload_digest !== digest) throw new MaintenanceConflict();
      return receipt(old);
    }
    const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
    const now = clock?.now;
    if (
      !now ||
      !Number.isFinite(Date.parse(sentAt)) ||
      Math.abs(now.getTime() - Date.parse(sentAt)) > 300000 ||
      Date.parse(payload.sampledAt) > now.getTime() + 300000 ||
      Date.parse(payload.sampledAt) < now.getTime() - 90 * 86400000
    )
      throw new DataAccessError('grant_invalid');
    if (MaintenancePolicySchema.parse(d.policy).paused)
      throw new DataAccessError('grant_invalid');
    const [row] =
      await tx`insert into allrice_platform_maintenance_reports(id,deployment_id,source_report_id,owner_id,credential_revision,source_kind,payload_digest,payload,assessment)
      values(${randomUUID()},${d.id as string},${payload.sourceReportId},${d.owner_id as string},${d.credential_revision as number},${payload.sourceKind},${digest},${tx.json(payload)},${tx.json(assessment(payload))}) returning *`;
    return receipt(row!);
  });
}
export async function readMaintenanceInstallationReceipt(
  identity: MaintenanceInstallationIdentity,
  sourceReportId: string,
) {
  const id = UuidSchema.parse(sourceReportId);
  return installation(identity, async (tx, d) => {
    const [r] =
      await tx`select * from allrice_platform_maintenance_reports where deployment_id=${d.id as string} and source_report_id=${id}`;
    if (!r) throw new DataAccessError('not_found');
    return receipt(r);
  });
}
function view(row: Row) {
  return MaintenanceReportViewSchema.parse({
    ...receipt(row),
    companyName: row.company_name,
    companySlug: row.company_slug,
    deploymentName: row.deployment_name,
    payload: row.payload,
    assessment: row.assessment,
  });
}
export async function listMaintenanceReports(
  context: RequestContext,
  input: { deploymentId?: string; cursor?: string } = {},
) {
  const deploymentId = input.deploymentId
    ? UuidSchema.parse(input.deploymentId)
    : null;
  let cursor: { receivedAt: string; id: string } | null = null;
  if (input.cursor) {
    try {
      const data = JSON.parse(
        Buffer.from(input.cursor, 'base64url').toString('utf8'),
      );
      const id = UuidSchema.parse(data.id);
      if (
        typeof data.receivedAt !== 'string' ||
        !Number.isFinite(Date.parse(data.receivedAt))
      )
        throw Error();
      cursor = { id, receivedAt: new Date(data.receivedAt).toISOString() };
    } catch {
      throw new SyntaxError('invalid_report_cursor');
    }
  }
  return getDatabase().begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    if (
      deploymentId &&
      !(
        await tx`select id from allrice_platform_maintenance_deployments where id=${deploymentId} and owner_id=${owner}`
      ).length
    )
      throw new DataAccessError('not_found');
    const rows =
      await tx`select r.*,d.company_name,d.company_slug,d.deployment_name from allrice_platform_maintenance_reports r join allrice_platform_maintenance_deployments d on d.id=r.deployment_id
      where r.owner_id=${owner} and d.owner_id=${owner} ${deploymentId ? tx`and r.deployment_id=${deploymentId}` : tx``}
      ${cursor ? tx`and (r.received_at,r.id)<(${cursor.receivedAt}::timestamptz,${cursor.id}::uuid)` : tx``}
      order by r.received_at desc,r.id desc limit 51`;
    const page = rows.slice(0, 50),
      last = page.at(-1);
    await currentMaintenanceAdmin(context, tx);
    return MaintenanceReportPageSchema.parse({
      reports: page.map(view),
      nextCursor:
        rows.length > 50 && last
          ? Buffer.from(
              JSON.stringify({
                receivedAt: last.received_at.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    });
  });
}
export async function getMaintenanceReport(
  context: RequestContext,
  id: string,
) {
  UuidSchema.parse(id);
  return getDatabase().begin(async (tx) => {
    const owner = await currentMaintenanceAdmin(context, tx);
    const [row] =
      await tx`select r.*,d.company_name,d.company_slug,d.deployment_name from allrice_platform_maintenance_reports r join allrice_platform_maintenance_deployments d on d.id=r.deployment_id where r.id=${id} and r.owner_id=${owner} and d.owner_id=${owner}`;
    if (!row) throw new DataAccessError('not_found');
    return view(row);
  });
}
