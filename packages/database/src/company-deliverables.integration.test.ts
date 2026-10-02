import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import {
  assistantFixtureStorage,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from './identity.ts';
import { listCompanyDeliverables } from './company-deliverables.ts';
import {
  inspectCompanyDeliverable,
  readArtifactBytes,
} from './artifact-review.ts';
import { readOrganizationDashboard } from './organization-dashboard.ts';
import type { StorageObject, ExecutionContext } from '@allrice/contracts';
import {
  registerToolBrokerExport,
  createToolBrokerExportObject,
} from './execution/tool-broker.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'company delivery library uses immutable business versions (isolated PostgreSQL)',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      a: Awaited<ReturnType<typeof tenantValidationFixture>>,
      b: typeof a;
    let admin: NonNullable<Awaited<ReturnType<typeof authenticateSession>>>;
    let seriesId: string, oldObjectId: string, expiredVersion: string;
    let original: StorageObject, originalBytes: Uint8Array;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      const p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: 'allrice-platform',
          organizationName: 'Platform',
          workspaceSlug: 'default',
          workspaceName: 'Default',
          email: 'company-files-admin@example.test',
          displayName: 'Admin',
          role: 'member',
        },
        f.db,
      );
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
      admin = (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
      a = await tenantValidationFixture(f.db);
      b = await tenantValidationFixture(f.db);
      const [row] =
        await f.db`select series_id,object_id from allrice_deliverable_versions where id=${a.artifact.artifactId}`;
      seriesId = row!.series_id;
      oldObjectId = row!.object_id;
      original = (
        await inspectCompanyDeliverable(
          admin,
          a.target.organizationId,
          a.artifact.artifactId,
          f.db,
        )
      ).object;
      originalBytes = await readArtifactBytes(
        assistantFixtureStorage(f.db),
        original,
      );
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    });
    async function version({
      series = randomUUID(),
      objectId,
      number = 1,
      fileName = 'legacy-report.txt',
      summary = null,
      kind = null,
      deleted = false,
    }: {
      series?: string;
      objectId?: string;
      number?: number;
      fileName?: string;
      summary?: string | null;
      kind?: string | null;
      deleted?: boolean;
    } = {}) {
      if (!objectId) {
        objectId = randomUUID();
        const key = original.key.replace(original.id, objectId);
        if (!deleted)
          await assistantFixtureStorage(f.db).put(
            { ...original, id: objectId, key },
            new Blob([new Uint8Array(originalBytes)]).stream(),
          );
        await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable,deleted_at)
      select ${objectId},organization_id,workspace_id,owner_id,${key},category,media_type,size_bytes,checksum,${deleted ? 'deleted' : 'ready'},true,${deleted ? new Date() : null} from allrice_storage_objects where id=${oldObjectId}`;
      }
      if (fileName.startsWith('tool-result-read-'))
        fileName = `tool-result-read-${objectId}.txt`;
      const id = randomUUID();
      await f.db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,parent_version_id,session_id,file_name,format,change_summary)
      values(${id},${a.target.organizationId},${a.target.workspaceId},${a.target.subjectId},${objectId},${series},${number},${number > 1 ? a.artifact.artifactId : null},${a.task.chatSessionId},${fileName},'text',${summary})`;
      if (kind)
        await f.db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest)
      select ${id},organization_id,workspace_id,owner_id,run_id,${kind},provenance,${randomUUID()},request_digest from allrice_workbench_artifacts where version_id=${a.artifact.artifactId}`;
      return id;
    }
    it('persists the exporter quality receipt against the exact immutable version without storing formula contents', async () => {
      const c = await tenantValidationFixture(f.db),
        owner = c.target.subjectId;
      const context: ExecutionContext = {
        executionId: randomUUID(),
        runId: c.task.runId,
        jobId: c.worker.jobId,
        worker: { id: c.worker.workerId, type: 'worker' },
        delegatedBy: { id: owner, type: 'user' },
        organizationId: c.target.organizationId,
        workspaceId: c.target.workspaceId,
        startedAt: new Date().toISOString(),
        policySnapshot: {
          id: randomUUID(),
          organizationId: c.target.organizationId,
          subjectId: owner,
          version: 1,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          memberships: [],
          grants: [],
        },
      };
      const source = (
        await inspectCompanyDeliverable(
          admin,
          c.target.organizationId,
          c.artifact.artifactId,
          f.db,
        )
      ).object;
      const object = {
        ...createToolBrokerExportObject({
          context,
          checksum: source.checksum,
          sizeBytes: source.sizeBytes,
          mediaType: source.mediaType,
        }),
        immutable: true,
      };
      const bytes = await readArtifactBytes(
        assistantFixtureStorage(f.db),
        source,
      );
      await assistantFixtureStorage(f.db).put(
        object,
        new Blob([new Uint8Array(bytes)]).stream(),
      );
      const published = await registerToolBrokerExport(
        {
          context,
          sessionId: c.task.chatSessionId,
          fileName: 'checked.txt',
          format: 'text',
          object,
          officeReceipt: {
            quality: {
              status: 'unavailable',
              reason: 'Native formula checking was not available',
            },
            warnings: ['No formula recalculation was performed'],
          },
        },
        f.db,
      );
      const result = await inspectCompanyDeliverable(
        admin,
        c.target.organizationId,
        published.id,
        f.db,
      );
      expect(result.companyEvidence).toMatchObject({
        objectId: object.id,
        checksum: object.checksum,
        sourceFile: null,
        office: {
          quality: { status: 'unavailable' },
          warnings: ['No formula recalculation was performed'],
        },
      });
      const [record] =
        await f.db`select metadata from allrice_audit_events where resource_id=${published.id} and action='artifact.office-quality'`;
      expect(record!.metadata.objectId).toBe(object.id);
      expect(JSON.stringify(record!.metadata)).not.toContain('formulas');
      expect(
        (
          await inspectCompanyDeliverable(
            admin,
            c.target.organizationId,
            c.artifact.artifactId,
            f.db,
          )
        ).companyEvidence.office,
      ).toBeNull();
    });
    it('keeps latest available version fixed while showing expired newer revisions and preserves archived/former staff provenance', async () => {
      const objectId = randomUUID();
      expiredVersion = randomUUID();
      await f.db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable,created_at,retention_until)
      select ${objectId},organization_id,workspace_id,owner_id,${original.key.replace(original.id, objectId)},category,media_type,size_bytes,checksum,'ready',true,now()-interval '2 days',now()-interval '1 day' from allrice_storage_objects where id=${oldObjectId}`;
      expiredVersion = await version({
        series: seriesId,
        objectId,
        number: 2,
        fileName: 'revision2.txt',
        kind: 'document',
      });
      await f.db`update allrice_chat_sessions set archived_at=now() where id=${a.task.chatSessionId}`;
      await f.db`update allrice_users set status='disabled' where id=${a.target.subjectId}`;
      await f.db`update allrice_memberships set active=false where user_id=${a.target.subjectId}`;
      const files = await listCompanyDeliverables(
        admin,
        a.target.organizationId,
      );
      expect(files.deliverables).toHaveLength(1);
      expect(files.deliverables[0]).toMatchObject({
        id: a.artifact.artifactId,
        seriesId,
        version: 1,
        latestPublishedVersion: 2,
        state: 'ready',
        runId: a.task.runId,
      });
      const versions = await listCompanyDeliverables(
        admin,
        a.target.organizationId,
        { seriesId, includeUnavailable: true },
      );
      expect(versions.deliverables.map((v) => [v.version, v.state])).toEqual([
        [2, 'expired'],
        [1, 'ready'],
      ]);
      const file = await inspectCompanyDeliverable(
        admin,
        a.target.organizationId,
        a.artifact.artifactId,
        f.db,
      );
      const bytes = await readArtifactBytes(
        assistantFixtureStorage(f.db),
        file.object,
      );
      expect(Buffer.from(bytes).toString()).toContain(
        'Isolated fixture, not a real model answer.',
      );
      await expect(
        inspectCompanyDeliverable(
          admin,
          a.target.organizationId,
          expiredVersion,
          f.db,
        ),
      ).rejects.toThrow('artifact_not_found');
      const [audit] =
        await f.db`select actor_id,metadata->>'subjectId' as subject from allrice_audit_events where action='company.deliverable.inspected' order by occurred_at desc limit 1`;
      expect(audit).toMatchObject({
        actor_id: admin.actor.id,
        subject: a.target.subjectId,
      });
    });
    it('leaves legacy source Run unknown, excludes raw tools and counts distinct series consistently with the dashboard', async () => {
      const legacy = await version();
      await version({
        fileName: `tool-result-read-${oldObjectId}.txt`,
        summary: `Tool result read; Run ${a.task.runId}; call raw-call`,
      });
      await version({ fileName: 'shell-output.txt', kind: 'command_output' });
      const files = await listCompanyDeliverables(
        admin,
        a.target.organizationId,
      );
      expect(files.deliverables).toHaveLength(2);
      expect(files.deliverables.find((f) => f.id === legacy)).toMatchObject({
        runId: null,
        employeeId: null,
        employeeName: null,
      });
      expect(
        (
          await inspectCompanyDeliverable(
            admin,
            a.target.organizationId,
            legacy,
            f.db,
          )
        ).provenance.runId,
      ).toBeNull();
      expect(
        (await readOrganizationDashboard(admin, a.target.organizationId))
          .deliverables.availableSeries,
      ).toBe(2);
      const [employee] =
        await f.db`select employee_id from allrice_employee_versions where id=${a.versionId}`;
      expect(
        (
          await listCompanyDeliverables(admin, a.target.organizationId, {
            employeeId: employee!.employee_id,
          })
        ).deliverables,
      ).toHaveLength(1);
      expect(
        (
          await listCompanyDeliverables(admin, a.target.organizationId, {
            format: 'pdf',
          })
        ).deliverables,
      ).toHaveLength(0);
    });
    it('rejects foreign files/cursors, current ordinary viewers and revoked administrator sessions', async () => {
      await expect(
        inspectCompanyDeliverable(
          admin,
          a.target.organizationId,
          b.artifact.artifactId,
          f.db,
        ),
      ).rejects.toThrow('artifact_not_found');
      await expect(
        listCompanyDeliverables(admin, a.target.organizationId, {
          before: b.artifact.artifactId,
        }),
      ).rejects.toThrow('not_found');
      const member = (await authenticateSession(
        (await createSession(b.target.subjectId)).token,
      ))!;
      await expect(
        listCompanyDeliverables(member, a.target.organizationId),
      ).rejects.toThrow();
      await expect(
        inspectCompanyDeliverable(
          member,
          a.target.organizationId,
          a.artifact.artifactId,
          f.db,
        ),
      ).rejects.toThrow();
      const session = await createSession(admin.actor.id),
        stale = (await authenticateSession(session.token))!;
      await revokeSession(session.token);
      await expect(
        inspectCompanyDeliverable(
          stale,
          a.target.organizationId,
          a.artifact.artifactId,
          f.db,
        ),
      ).rejects.toThrow();
      const deleted = await version({ deleted: true });
      expect(
        (await listCompanyDeliverables(admin, a.target.organizationId))
          .deliverables,
      ).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: deleted })]),
      );
      expect(
        (
          await listCompanyDeliverables(admin, a.target.organizationId, {
            includeUnavailable: true,
          })
        ).deliverables,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: deleted, state: 'deleted' }),
        ]),
      );
      await expect(
        inspectCompanyDeliverable(
          admin,
          a.target.organizationId,
          deleted,
          f.db,
        ),
      ).rejects.toThrow('artifact_not_found');
    });
    it('does not offer files from an archived workspace as available', async () => {
      await f.db`update allrice_workspaces set archived_at=now() where id=${a.target.workspaceId}`;
      expect(
        (await listCompanyDeliverables(admin, a.target.organizationId))
          .deliverables,
      ).toHaveLength(0);
      expect(
        (
          await listCompanyDeliverables(admin, a.target.organizationId, {
            includeUnavailable: true,
            seriesId,
          })
        ).deliverables,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: a.artifact.artifactId,
            state: 'unavailable',
          }),
        ]),
      );
      expect(
        (await readOrganizationDashboard(admin, a.target.organizationId))
          .deliverables.availableSeries,
      ).toBe(0);
      await expect(
        inspectCompanyDeliverable(
          admin,
          a.target.organizationId,
          a.artifact.artifactId,
          f.db,
        ),
      ).rejects.toThrow();
    });
  },
);
