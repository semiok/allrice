import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext, WorkerOperations } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { recordWorkerOperations } from './operations-resources.ts';
import {
  readPlatformTechnicalDiagnostics,
  capturePlatformTechnicalIssue,
  listPlatformTechnicalIssues,
  getPlatformTechnicalIssue,
  updatePlatformTechnicalIssue,
} from './platform-technical.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'platform technical facts and durable evidence, isolated PostgreSQL / no model',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let admin: RequestContext;
    let customer: Awaited<ReturnType<typeof createExperienceFixture>>;
    const workerId = randomUUID();
    const worker: WorkerOperations = {
      workerId,
      hostname: 'synthetic-technical-worker',
      platform: 'synthetic',
      capacity: {
        mode: 'configured',
        concurrency: 2,
        cpus: 4,
        memoryBytes: 8 * 1024 ** 3,
      },
      availableMemoryBytes: 4 * 1024 ** 3,
      rssBytes: 64 * 1024 ** 2,
      sandbox: null,
      sandboxStatus: 'unavailable',
      pressure: null,
    };
    beforeAll(async () => {
      fixture = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
      customer = await createExperienceFixture(fixture.db);
      const actorId = randomUUID();
      await fixture.db`insert into allrice_users(id,email,display_name,password_hash) values(${actorId},${`${actorId}@example.test`},'Independent platform admin','not-login')`;
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', `${actorId}@example.test`);
      admin = {
        ...customer.owner,
        actor: { type: 'user', id: actorId },
        workspaceId: null,
        memberships: [],
      };
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (fixture) await fixture.close();
    });
    const read = () =>
      readPlatformTechnicalDiagnostics(admin, {
        database: fixture.db,
        diagnostics: fixture.db,
        environment: 'test',
      });

    it('reads actual normal and queued facts; absent or stale samples never become measured zero', async () => {
      const normal = await read();
      expect(normal.pressure).toMatchObject({
        evidence: { freshness: 'fresh' },
        value: { jobs: { queued: 0, active: 0 } },
      });
      expect(normal.inventory).toMatchObject({
        evidence: { freshness: 'unknown', unavailableReason: 'no_sample' },
        value: null,
      });
      const queuedRun = randomUUID();
      await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec)
      values(${queuedRun},${customer.org},${customer.workspace},${customer.user},'queued','{}')`;
      await fixture.db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload)
      values(${randomUUID()},${customer.org},${customer.workspace},${customer.user},${queuedRun},'queued',${randomUUID()},clock_timestamp()+interval '10 minutes','{}')`;
      await recordWorkerOperations(worker, fixture.db);
      const queued = await read();
      expect(queued.pressure.value!.jobs.queued).toBe(1);
      expect(queued.inventory.evidence.freshness).toBe('fresh');
      expect(queued.inventory.value!.workers[0]).toMatchObject({
        workerId,
        online: true,
        sandbox: null,
        sandboxStatus: 'unavailable',
      });
      await fixture.db`update allrice_runtime_metadata set updated_at=clock_timestamp()-interval '91 seconds' where key=${`worker-operations:${workerId}`}`;
      const offline = await read();
      expect(offline.inventory).toMatchObject({
        evidence: { freshness: 'stale' },
        value: { workers: [{ workerId, online: false }] },
      });
    });
    it('keeps failed collections unknown without exposing database errors or reading the business pool', async () => {
      const unavailable = new Proxy(fixture.db, {
        apply() {
          throw Error('private-database-url-and-password');
        },
      });
      const result = await readPlatformTechnicalDiagnostics(admin, {
        database: fixture.db,
        diagnostics: unavailable,
        environment: 'test',
      });
      for (const sample of [
        result.inventory,
        result.pressure,
        result.runs,
        result.operations,
        result.feedback,
      ])
        expect(sample).toMatchObject({
          evidence: {
            freshness: 'unknown',
            unavailableReason: 'collection_failed',
          },
          value: null,
        });
      expect(JSON.stringify(result)).not.toContain('private-database');
    });
    it('returns failed Run and feedback references while excluding business content and raw provider errors', async () => {
      await fixture.db`update allrice_runs set state='failed',error_code='synthetic_error',error_message='SECRET-provider-and-customer-text',updated_at=clock_timestamp() where id=${customer.run}`;
      await fixture.db`insert into allrice_run_feedback(organization_id,workspace_id,run_id,message_id,actor_id,helpful,category,reason)
      values(${customer.org},${customer.workspace},${customer.run},${customer.assistant},${customer.user},false,'service-stability','SECRET-feedback-body')`;
      const facts = await read();
      expect(facts.runs.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: customer.run,
            status: 'failed',
            errorCode: 'synthetic_error',
          }),
        ]),
      );
      expect(facts.feedback.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: customer.run,
            category: 'service-stability',
          }),
        ]),
      );
      expect(JSON.stringify(facts)).not.toMatch(
        /SECRET|SYNTHETIC-ONLY|Reconciliation rule/,
      );
    });
    it('persists one problem and one occurrence for concurrent or ambiguous duplicate captures; explicitly groups related evidence', async () => {
      const capture = () =>
        capturePlatformTechnicalIssue(
          admin,
          { kind: 'run', id: customer.run },
          fixture.db,
          'test',
        );
      const results = await Promise.all([capture(), capture(), capture()]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      const id = results[0]!.detail.issue.id;
      expect(new Set(results.map((r) => r.detail.issue.id))).toEqual(
        new Set([id]),
      );
      expect(
        (await getPlatformTechnicalIssue(admin, id, fixture.db)).issue
          .occurrenceCount,
      ).toBe(1);
      const [feedback] = await fixture.db<
        { id: string }[]
      >`select id from allrice_run_feedback where run_id=${customer.run}`;
      const linked = await capturePlatformTechnicalIssue(
        admin,
        { kind: 'feedback', id: feedback!.id, issueId: id },
        fixture.db,
        'test',
      );
      expect(linked.detail.issue).toMatchObject({
        id,
        occurrenceCount: 2,
        version: 2,
      });
      expect(linked.detail.records).toHaveLength(2);
      await capturePlatformTechnicalIssue(
        admin,
        { kind: 'feedback', id: feedback!.id, issueId: id },
        fixture.db,
        'test',
      );
      expect(await listPlatformTechnicalIssues(admin, fixture.db)).toHaveLength(
        1,
      );
      expect(
        (await getPlatformTechnicalIssue(admin, id, fixture.db)).issue
          .occurrenceCount,
      ).toBe(2);
      expect(
        await fixture.db`select id from allrice_memberships where user_id=${admin.actor.id}`,
      ).toHaveLength(0);
    });
    it('protects status updates with stored versions and records the winning change only', async () => {
      const [before] = await listPlatformTechnicalIssues(admin, fixture.db);
      const results = await Promise.all(
        ['resolved', 'investigating'].map((status) =>
          updatePlatformTechnicalIssue(
            admin,
            before!.id,
            {
              ifVersion: before!.version,
              status,
              category: 'configuration',
              severity: 'low',
            },
            fixture.db,
          ),
        ),
      );
      expect(results.filter((r) => r.updated)).toHaveLength(1);
      expect(
        (await getPlatformTechnicalIssue(admin, before!.id, fixture.db)).issue
          .version,
      ).toBe(before!.version + 1);
      expect(
        await fixture.db`select action from allrice_platform_technical_issue_events where issue_id=${before!.id} order by version`,
      ).toEqual([
        { action: 'created' },
        { action: 'evidence_linked' },
        { action: 'status_changed' },
      ]);
    });
    it('denies ordinary and tenant-admin identities, spoofed membership and revoked platform accounts', async () => {
      const [problem] = await listPlatformTechnicalIssues(admin, fixture.db);
      const tenantAdmin = await customer.member('admin');
      for (const context of [
        customer.owner,
        tenantAdmin,
        {
          ...customer.owner,
          memberships: [
            { ...customer.owner.memberships[0]!, role: 'admin' as const },
          ],
        },
      ]) {
        await expect(
          readPlatformTechnicalDiagnostics(context, {
            database: fixture.db,
            diagnostics: fixture.db,
          }),
        ).rejects.toThrow('authorization_denied');
        await expect(
          listPlatformTechnicalIssues(context, fixture.db),
        ).rejects.toThrow('authorization_denied');
        await expect(
          getPlatformTechnicalIssue(context, problem!.id, fixture.db),
        ).rejects.toThrow('authorization_denied');
        await expect(
          capturePlatformTechnicalIssue(
            context,
            { kind: 'run', id: customer.run },
            fixture.db,
            'test',
          ),
        ).rejects.toThrow('authorization_denied');
      }
      await fixture.db`update allrice_users set status='disabled' where id=${admin.actor.id}`;
      await expect(
        capturePlatformTechnicalIssue(
          admin,
          { kind: 'run', id: customer.run },
          fixture.db,
          'test',
        ),
      ).rejects.toThrow('authorization_denied');
      await expect(
        updatePlatformTechnicalIssue(
          admin,
          problem!.id,
          {
            ifVersion: problem!.version,
            status: 'open',
            category: 'defect',
            severity: 'high',
          },
          fixture.db,
        ),
      ).rejects.toThrow('authorization_denied');
    });
  },
);
