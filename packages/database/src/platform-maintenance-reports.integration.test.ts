import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import {
  registerMaintenanceDeployment,
  rotateMaintenanceCredential,
  MaintenanceConflict,
} from './platform-maintenance.ts';
import {
  getMaintenanceConnection,
  receiveMaintenanceReport,
  readMaintenanceInstallationReceipt,
  listMaintenanceReports,
  getMaintenanceReport,
  type MaintenanceInstallationIdentity,
} from './platform-maintenance-reports.ts';
import {
  collectMaintenanceSourceReports,
  claimMaintenanceSourceReport,
  settleMaintenanceSourceReport,
} from './platform-maintenance-source.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import { maintenanceProbeFixtures } from './platform-maintenance-probe.ts';
import type { MaintenanceReportPayload } from './platform-maintenance-report-contracts.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'authenticated immutable company reports and durable report-only delivery',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      admin: RequestContext,
      other: RequestContext,
      ordinary: RequestContext;
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      async function principal(email: string) {
        const p = await ensureBootstrapPortalPrincipal({
          organizationSlug: 'allrice-platform',
          organizationName: 'Internal',
          workspaceSlug: 'control-plane',
          workspaceName: 'Internal',
          email,
          displayName: 'Report fixture',
          role: 'member',
        });
        return (await authenticateSession(
          (await createSession(p.user.id)).token,
        ))!;
      }
      admin = await principal('report-admin@example.test');
      other = await principal('report-other@example.test');
      ordinary = await principal('report-ordinary@example.test');
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        'report-admin@example.test,report-other@example.test',
      );
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (fixture) await fixture.close();
    });
    const payload = (): MaintenanceReportPayload => ({
      version: 1,
      sourceReportId: randomUUID(),
      sourceKind: 'deployment_health',
      sampledAt: new Date().toISOString(),
      observedReleaseSha: 'a'.repeat(40),
      producerVersion: 'allrice-maintenance.v1',
      facts: { findings: [], quality: null, probe: null },
    });
    async function install(owner = admin) {
      const r = await registerMaintenanceDeployment(owner, {
        requestId: randomUUID(),
        companyName: 'Isolated source',
        companySlug: 'source-' + randomUUID().slice(0, 8),
        deploymentName: 'Primary',
      });
      return {
        identity: {
          deploymentId: r.deployment.id,
          installationKey: r.installationKey!,
        },
        deployment: r.deployment,
      };
    }
    const send = (
      identity: MaintenanceInstallationIdentity,
      value = payload(),
      sentAt = new Date().toISOString(),
    ) => receiveMaintenanceReport(identity, value, sentAt);
    it('authenticates only the installation key and immediately fences a rotated or revoked connection', async () => {
      const { identity, deployment } = await install();
      await expect(
        getMaintenanceConnection({
          ...identity,
          installationKey: 'x'.repeat(43),
        }),
      ).rejects.toMatchObject({ code: 'authentication_required' });
      await expect(
        getMaintenanceConnection({ ...identity, deploymentId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'authentication_required' });
      const r = await rotateMaintenanceCredential(admin, deployment.id, {
        expectedRevision: deployment.revision,
        action: 'rotate',
      });
      await expect(send(identity)).rejects.toMatchObject({
        code: 'authentication_required',
      });
      const fresh = { ...identity, installationKey: r.installationKey! };
      expect((await getMaintenanceConnection(fresh)).credentialRevision).toBe(
        2,
      );
      await rotateMaintenanceCredential(admin, deployment.id, {
        expectedRevision: r.deployment.revision,
        action: 'revoke',
      });
      await expect(send(fresh)).rejects.toMatchObject({
        code: 'authentication_required',
      });
    });
    it('persists one immutable report across concurrent retries and lost receipts, rejecting tampering and unseen stale packets', async () => {
      const { identity } = await install(),
        p = payload();
      const receipts = await Promise.all(
        Array.from({ length: 5 }, () => send(identity, p)),
      );
      expect(new Set(receipts.map((r) => r.reportId)).size).toBe(1);
      expect(await send(identity, p, '2000-01-01T00:00:00.000Z')).toEqual(
        receipts[0],
      );
      await expect(
        send(identity, { ...p, observedReleaseSha: 'b'.repeat(40) }),
      ).rejects.toBeInstanceOf(MaintenanceConflict);
      await expect(
        send(identity, payload(), '2000-01-01T00:00:00.000Z'),
      ).rejects.toMatchObject({ code: 'grant_invalid' });
      expect(
        await readMaintenanceInstallationReceipt(identity, p.sourceReportId),
      ).toEqual(receipts[0]);
      expect(
        (
          await fixture.db`select id from allrice_platform_maintenance_reports where deployment_id=${identity.deploymentId}`
        ).length,
      ).toBe(1);
    });
    it('keeps source claims, synthetic failures and environment errors ineligible until trustworthy central reproduction', async () => {
      const { identity } = await install(),
        synthetic = payload();
      synthetic.sourceKind = 'quality_check';
      synthetic.facts.quality = {
        caseId: 'project.static.v1',
        variant: 'defect',
        verdict: 'assertion_failed',
        reportDigest: 'sha256:' + 'a'.repeat(64),
        cleanup: 'confirmed',
      };
      const a = await send(identity, synthetic);
      expect(
        (await getMaintenanceReport(admin, a.reportId)).assessment,
      ).toMatchObject({
        classification: 'synthetic_check',
        repairEligible: false,
      });
      const claimed = payload();
      claimed.facts.probe = {
        specId: 'command-output.credentials.v2',
        fixtureDigest: technicalDigest(maintenanceProbeFixtures),
        failedAssertions: ['quoted_spaces'],
      };
      const b = await send(identity, claimed);
      expect(
        (await getMaintenanceReport(admin, b.reportId)).assessment,
      ).toMatchObject({
        classification: 'suspected_code',
        repairEligible: false,
        sourceTrust: 'installation_assertion',
      });
      const capacity = payload();
      capacity.facts.findings = [
        { id: 'resource_wait', occurrences: 1, errorCode: null },
      ];
      const c = await send(identity, capacity);
      expect(
        (await getMaintenanceReport(admin, c.reportId)).assessment
          .classification,
      ).toBe('configuration_or_environment');
      await expect(
        send(identity, {
          ...claimed,
          companyName: 'spoofed',
        } as MaintenanceReportPayload),
      ).rejects.toBeTruthy();
    });
    it('keeps canceled checks incomplete rather than healthy and paginates same-millisecond receipts without omissions', async () => {
      const { identity } = await install();
      const p = payload();
      p.sourceKind = 'quality_check';
      p.facts.quality = {
        caseId: 'project.static.v1',
        variant: 'correct',
        verdict: 'canceled',
        reportDigest: 'sha256:' + 'c'.repeat(64),
        cleanup: 'confirmed',
      };
      const r = await send(identity, p);
      expect(
        (await getMaintenanceReport(admin, r.reportId)).assessment,
      ).toMatchObject({
        classification: 'configuration_or_environment',
        reason: 'requires_diagnosis',
      });
      await Promise.all(Array.from({ length: 52 }, () => send(identity)));
      await fixture.db`update allrice_platform_maintenance_reports set received_at='2026-10-09T00:00:00.123456Z' where deployment_id=${identity.deploymentId}`;
      const first = await listMaintenanceReports(admin, {
        deploymentId: identity.deploymentId,
      });
      const second = await listMaintenanceReports(admin, {
        deploymentId: identity.deploymentId,
        cursor: first.nextCursor!,
      });
      expect(first.reports).toHaveLength(50);
      expect(second.reports).toHaveLength(3);
      expect(
        new Set([...first.reports, ...second.reports].map((x) => x.reportId))
          .size,
      ).toBe(53);
      expect(second.nextCursor).toBeNull();
    });
    it('applies a shorter interval immediately from the last sample, without replaying unchanged facts', async () => {
      const { identity } = await install();
      const connectionDigest =
        'sha256:' + randomUUID().replaceAll('-', '').padEnd(64, '0');
      const input = {
        connectionDigest,
        deploymentId: identity.deploymentId,
        releaseSha: 'a'.repeat(40),
        intervalMinutes: 10080,
        probe: null,
      };
      expect(await collectMaintenanceSourceReports(input)).toBe(1);
      await fixture.db`update allrice_platform_maintenance_source_state set last_sampled_at=clock_timestamp()-interval '20 minutes' where connection_digest=${connectionDigest}`;
      expect(
        await collectMaintenanceSourceReports({
          ...input,
          intervalMinutes: 15,
          releaseSha: 'b'.repeat(40),
        }),
      ).toBe(1);
      expect(
        await collectMaintenanceSourceReports({
          ...input,
          intervalMinutes: 15,
          releaseSha: 'b'.repeat(40),
        }),
      ).toBe(0);
    });
    it('scopes central reads to the administrator and machine receipts to their own deployment without leaking another source', async () => {
      const a = await install(),
        b = await install(other),
        receipt = await send(a.identity);
      await expect(
        getMaintenanceReport(other, receipt.reportId),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        listMaintenanceReports(other, {
          deploymentId: a.identity.deploymentId,
        }),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(listMaintenanceReports(ordinary)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        readMaintenanceInstallationReceipt(b.identity, receipt.sourceReportId),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect((await listMaintenanceReports(other)).reports).toEqual([]);
      expect(
        (
          await listMaintenanceReports(admin, {
            deploymentId: a.identity.deploymentId,
          })
        ).reports.map((r) => r.reportId),
      ).toEqual([receipt.reportId]);
    });
    it('reuses frozen outbox bytes after unknown transport, validates the receipt identity and leaves all model/repair Jobs absent', async () => {
      const { identity } = await install(),
        connectionDigest =
          'sha256:' + randomUUID().replaceAll('-', '').padEnd(64, '0');
      const before = (
        await fixture.db`select count(*)::int n from allrice_jobs`
      )[0]!.n;
      const input = {
        connectionDigest,
        deploymentId: identity.deploymentId,
        releaseSha: 'a'.repeat(40),
        intervalMinutes: 15,
        probe: {
          specId: 'command-output.credentials.v2' as const,
          fixtureDigest: technicalDigest(maintenanceProbeFixtures),
          failedAssertions: [],
        },
      };
      expect(await collectMaintenanceSourceReports(input)).toBe(1);
      expect(await collectMaintenanceSourceReports(input)).toBe(0);
      const first = await claimMaintenanceSourceReport(connectionDigest);
      expect(first).toBeTruthy();
      await settleMaintenanceSourceReport({
        id: first!.id,
        attempt: first!.attempt,
        failed: true,
      });
      await fixture.db`update allrice_platform_maintenance_outbox set next_attempt_at=clock_timestamp() where id=${first!.id}`;
      const retry = await claimMaintenanceSourceReport(connectionDigest);
      expect(retry!.payload).toEqual(first!.payload);
      const receipt = await send(identity, retry!.payload);
      await expect(
        settleMaintenanceSourceReport({
          id: retry!.id,
          attempt: retry!.attempt,
          receipt: { ...receipt, deploymentId: randomUUID() },
        }),
      ).rejects.toThrow('maintenance_receipt_mismatch');
      expect(
        await settleMaintenanceSourceReport({
          id: retry!.id,
          attempt: retry!.attempt,
          receipt,
        }),
      ).toBe(true);
      expect(await claimMaintenanceSourceReport(connectionDigest)).toBeNull();
      expect(
        (await fixture.db`select count(*)::int n from allrice_jobs`)[0]!.n,
      ).toBe(before);
      expect(
        (
          await fixture.db`select count(*)::int n from allrice_platform_repair_tasks`
        )[0]!.n,
      ).toBe(0);
    });
  },
);
