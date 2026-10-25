import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { BrowserObservationSchema } from '@allrice/contracts';
import type * as Client from './core/client.ts';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import { createCloudExecutionFixture } from './cloud-execution.fixture.ts';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import { createLocalPreviewFixture } from './local-preview.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { createReadPathProbe } from './read-path-probe.fixture.ts';
import {
  expectReadPathRowLocked,
  readWriteOverlap,
  readPathSignal,
} from './read-path-races.fixture.ts';
import {
  acknowledgeBrowserControl,
  createBrowserOperation,
  createBrowserWorkspace,
  installBrowserControlGrant,
  listBrowserWorkspaces,
  requestBrowserControl,
} from './browser-control.ts';
import { listBrowserControlManagement } from './browser-control-management.ts';
import { listLocalBrowserGrants } from './local-browser-grants.ts';
import {
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
  revokeRuntimeActionApproval,
  runtimePolicyDigest,
} from './runtime-policy.ts';
import { getWorkAutomation, updateWorkAutomation } from './work-automation.ts';
import {
  getInteractionStatus,
  getSessionRunTimings,
} from './conversation/interaction-status.ts';
import {
  getWorkbenchArtifact,
  listArtifactFeedback,
  listWorkbenchArtifacts,
  publishWorkbenchArtifact,
  saveArtifactFeedback,
} from './artifact-review.ts';
import {
  listMessageFeedback,
  mutateMessageFeedback,
} from './message-feedback.ts';
import { listChangesetRuns } from './changeset-service.ts';
import { resolveTaskRuntimePolicy } from './task-runtime-policy.ts';

let current: postgres.Sql;
vi.mock('./core/client.ts', async (original) => ({
  ...(await original<typeof Client>()),
  getDatabase: () => current,
}));
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'MET-210 populated GET paths and retained write locks — isolated PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    let db: postgres.Sql;
    beforeAll(async () => {
      for (const key of [
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
        'ALLRICE_BROWSER_CONTROL_ENABLED',
        'ALLRICE_LOCAL_BROWSER_ENABLED',
        'ALLRICE_LOCAL_PREVIEW_ENABLED',
        'ALLRICE_LOCAL_PROCESS_ENABLED',
        'ALLRICE_LOCAL_COMMAND_ENABLED',
        'ALLRICE_LOCAL_SERVICE_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
        'ALLRICE_ASSISTANTS_ENABLED',
      ])
        vi.stubEnv(key, '1');
      fixture = await createAssistantFixtureDatabase();
      db = fixture.db;
      current = db;
    }, 120_000);
    afterAll(async () => {
      try {
        await fixture?.close();
      } catch (error) {
        if (error && typeof error === 'object' && 'cleanup' in error)
          console.error('MET210_OWNED_CLEANUP', error.cleanup);
        throw error;
      } finally {
        vi.unstubAllEnvs();
      }
    });
    async function read<T>(
      work: (sql: postgres.Sql) => Promise<T>,
      options: Parameters<typeof createReadPathProbe>[1] = {},
    ) {
      const probe = createReadPathProbe(db, options);
      current = probe.db;
      try {
        const value = await work(probe.db);
        probe.expectNoRowLocks();
        return value;
      } finally {
        current = db;
      }
    }
    async function browser() {
      const f = await createCloudExecutionFixture(db, fixture.storageRoot, {
        browserControl: true,
      });
      await installBrowserControlGrant(
        f.context,
        {
          targetId: f.target,
          ownerId: f.user,
          profile: { version: 1, origins: ['https://example.com'] },
          enabled: true,
        },
        db,
      );
      const [job] = await db<
        { attempt: number; lease_token: string }[]
      >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
      const w = await createBrowserWorkspace(
        {
          context: f.execution,
          callId: randomUUID(),
          url: 'https://example.com/',
          jobAttempt: job!.attempt,
          jobLeaseToken: job!.lease_token,
        },
        db,
      );
      const at = Date.now() - 1000;
      const observation = BrowserObservationSchema.parse({
        version: 1,
        id: randomUUID(),
        profileId: w.profile_id,
        fence: 1,
        revision: 1,
        capturedAt: new Date(at).toISOString(),
        expiresAt: new Date(at + 60_000).toISOString(),
        url: 'https://example.com/',
        title: 'Synthetic',
        text: 'Fixture',
        pageDigest: runtimePolicyDigest('fixture'),
        elements: [
          {
            id: 'e1',
            tag: 'button',
            label: 'Save',
            inputType: '',
            sensitive: false,
          },
        ],
        screenshotObjectId: null,
      });
      await acknowledgeBrowserControl(f.context, w.id, 1, observation, db);
      await createBrowserOperation(
        f.context,
        {
          version: 1,
          workspaceId: w.id,
          profileId: w.profile_id,
          actor: 'agent',
          fence: 1,
          observationId: observation.id,
          action: { type: 'click', elementId: 'e1' },
        },
        randomUUID(),
        db,
      );
      return { ...f, w, observation };
    }
    async function approval() {
      const f = await createCloudExecutionFixture(db, fixture.storageRoot);
      const created = await f.create();
      const [row] = await db<
        { id: string }[]
      >`select id from allrice_approval_requests where resource_type='runtime_operation' and resource_id=${created.snapshot.binding.attempt.operationId}`;
      const view = await getRuntimeActionApproval(f.context, row!.id, db);
      const response = {
        contractVersion: 1,
        direction: 'response',
        kind: 'action_approval',
        requestId: view.request.requestId,
        version: view.request.version,
        requestDigest: view.request.requestDigest,
        task: view.request.task,
        responseId: randomUUID(),
        respondedBy: f.user,
        respondedAt: new Date().toISOString(),
        approvalId: row!.id,
        decision: 'approved',
      };
      return { ...f, id: row!.id, response };
    }

    it('calibrates the probe against a real row lock and a real write', async () => {
      const f = await createCloudExecutionFixture(db, fixture.storageRoot);
      for (const kind of ['lock', 'write'] as const) {
        const probe = createReadPathProbe(db);
        await probe.db.begin(async (tx) => {
          if (kind === 'lock')
            await tx`select id from allrice_users where id=${f.user} for share`;
          else
            await tx`update allrice_users set display_name=display_name where id=${f.user}`;
        });
        expect(probe.transactions[0]!.xid).toBeTypeOf('string');
        expect(() => probe.expectNoRowLocks()).toThrow(
          'read path locked or wrote rows',
        );
      }
    });
    it('browser list traverses a live cloud workspace and populated operation without assigning any xid', async () => {
      const f = await browser();
      const rows = await read((sql) =>
        listBrowserWorkspaces(f.context, f.run, sql),
      );
      expect(rows).toMatchObject([
        { id: f.w.id, available: true, operations: [{ available: true }] },
      ]);
      expect(rows[0]!.operations).toHaveLength(1);
      const management = await read((sql) =>
        listBrowserControlManagement(f.context, sql),
      );
      expect(management.grants).toHaveLength(1);
      expect(management.members.some((m) => m.id === f.user)).toBe(true);
    }, 30_000);
    it('local browser workspace and grant reads traverse populated device/profile joins without locks', async () => {
      const f = await createLocalBrowserFixture(db, fixture.storageRoot);
      expect(
        await read((sql) => listBrowserWorkspaces(f.context, f.run, sql)),
      ).toMatchObject([
        { id: f.browser!.w.id, transport: 'local', available: true },
      ]);
      expect(
        await read((sql) => listLocalBrowserGrants(f.context, sql)),
      ).toMatchObject([{ grantId: f.localGrant.grantId, enabled: true }]);
    }, 30_000);
    it('local preview workspace follows its endpoint and current service authority without locks', async () => {
      const f = await createLocalPreviewFixture(db, fixture.storageRoot);
      const w = await f.open();
      expect(
        await read((sql) => listBrowserWorkspaces(f.context, f.run, sql)),
      ).toMatchObject([
        { id: w.id, available: true, preview: { processId: f.processId } },
      ]);
    }, 30_000);
    it('approval GET remains lock-free before decision, after decision and after revocation', async () => {
      const f = await approval();
      expect(
        (await read((sql) => getRuntimeActionApproval(f.context, f.id, sql)))
          .response,
      ).toBeNull();
      await decideRuntimeActionApproval(f.context, f.id, f.response, db);
      expect(
        (await read((sql) => getRuntimeActionApproval(f.context, f.id, sql)))
          .response,
      ).toMatchObject({ decision: 'approved' });
      await revokeRuntimeActionApproval(f.context, f.id, db);
      expect(
        (await read((sql) => getRuntimeActionApproval(f.context, f.id, sql)))
          .revokedAt,
      ).toBeTypeOf('string');
    }, 30_000);
    it('work automation reads defaults and a persisted setting without an xid', async () => {
      const f = await createCloudExecutionFixture(db, fixture.storageRoot);
      await db`delete from allrice_member_work_automation where organization_id=${f.org} and workspace_id=${f.workspace} and user_id=${f.user}`;
      const before = await read((sql) =>
        getWorkAutomation(f.context, f.workspace, sql),
      );
      expect(before.revision).toBe(0);
      await updateWorkAutomation(
        f.context,
        f.workspace,
        {
          expectedRevision: before.revision,
          capability: 'computer',
          enabled: true,
        },
        db,
      );
      expect(
        await read((sql) => getWorkAutomation(f.context, f.workspace, sql)),
      ).toMatchObject({
        revision: before.revision + 1,
        settings: { computer: true },
      });
    });
    it('session projections traverse actual artifacts and feedback without an xid', async () => {
      const f = await createCloudExecutionFixture(db, fixture.storageRoot, {
        workbench: true,
      });
      const artifact = await publishWorkbenchArtifact(
        {
          context: f.execution,
          sessionId: f.session,
          callId: randomUUID(),
          kind: 'document',
          fileName: 'evidence.txt',
          format: 'text',
          mediaType: 'text/plain',
          bytes: Buffer.from('synthetic evidence'),
        },
        f.storage,
        db,
      );
      expect(
        (
          await read((sql) =>
            listWorkbenchArtifacts(f.context, f.session, undefined, sql),
          )
        ).artifacts,
      ).toMatchObject([{ id: artifact.id }]);
      expect(
        await read((sql) =>
          getWorkbenchArtifact(f.context, f.session, artifact.id, sql),
        ),
      ).toMatchObject({ id: artifact.id });
      const feedback = await saveArtifactFeedback(
        f.context,
        f.session,
        {
          feedbackId: randomUUID(),
          artifactId: artifact.id,
          checksum: artifact.object.checksum,
          expectedRevision: 0,
          comments: [
            {
              id: randomUUID(),
              anchor: { kind: 'whole' },
              text: 'Synthetic feedback',
            },
          ],
        },
        false,
        f.storage,
        db,
      );
      expect(
        await read((sql) =>
          listArtifactFeedback(f.context, f.session, artifact.id, sql),
        ),
      ).toMatchObject([{ id: feedback.id, state: 'draft' }]);
      expect(
        await read((sql) =>
          listChangesetRuns(f.context, f.session, artifact.id, sql),
        ),
      ).toEqual([]);
      expect(
        await read((sql) => getInteractionStatus(f.context, f.session, sql)),
      ).toBeDefined();
      await db`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy) values(${f.run},${f.org},${f.workspace},${db.json({ ...resolveTaskRuntimePolicy([]) })})`;
      expect(
        (await read((sql) => getSessionRunTimings(f.context, f.session, sql)))
          .runTimings,
      ).toHaveLength(1);
      const history = await createExperienceFixture(db);
      await mutateMessageFeedback(history.owner, history.session.id, 'put', {
        messageId: history.assistant,
        rating: 'positive',
        ifVersion: null,
      });
      expect(
        (
          await read(() =>
            listMessageFeedback(history.owner, history.session.id),
          )
        ).items,
      ).toMatchObject([{ rating: 'positive' }]);
    }, 30_000);
    it('assistant tree reads actual child and budget records without an xid', async () => {
      const f = await assistantFixture(db);
      const child = (await f.delegate()).instance;
      const tree = await read((sql) =>
        createAssistantRuntime({ database: sql }).getTree(f.context, {
          runId: f.task.runId,
        }),
      );
      expect(tree.instances.some((r) => r.runId === child.runId)).toBe(true);
    });

    for (const order of ['reader first', 'writer first'] as const) {
      it(`browser polling and control mutation complete with ${order}`, async () => {
        const f = await browser();
        await readWriteOverlap(
          db,
          order,
          (sql) => listBrowserWorkspaces(f.context, f.run, sql),
          (sql) =>
            requestBrowserControl(
              f.context,
              f.w.id,
              {
                requestId: randomUUID(),
                expectedFence: 1,
                control: 'human',
                observationId: null,
              },
              sql,
            ),
        );
      }, 30_000);
      it(`approval polling and decide complete with ${order}`, async () => {
        const f = await approval();
        await readWriteOverlap(
          db,
          order,
          (sql) => getRuntimeActionApproval(f.context, f.id, sql),
          (sql) =>
            decideRuntimeActionApproval(f.context, f.id, f.response, sql),
        );
      }, 30_000);
    }
    it.each(['decide', 'revoke'] as const)(
      'approval %s still locks both identity and approval rows',
      async (action) => {
        const f = await approval();
        let checked = false;
        const probe = createReadPathProbe(db, {
          beforeCommit: async () => {
            await expectReadPathRowLocked(db, 'allrice_users', f.user);
            await expectReadPathRowLocked(
              db,
              'allrice_approval_requests',
              f.id,
            );
            checked = true;
          },
        });
        if (action === 'decide')
          await decideRuntimeActionApproval(
            f.context,
            f.id,
            f.response,
            probe.db,
          );
        else await revokeRuntimeActionApproval(f.context, f.id, probe.db);
        expect(checked).toBe(true);
        await db`update allrice_memberships set active=false where user_id=${f.user}`;
        await expect(
          revokeRuntimeActionApproval(f.context, f.id, db),
        ).rejects.toThrow();
        await expect(
          decideRuntimeActionApproval(f.context, f.id, f.response, db),
        ).rejects.toThrow();
      },
    );
    it('a concurrent membership revocation blocks decide, then denies it after commit', async () => {
      const f = await approval();
      const revokerOpen = readPathSignal<number>(),
        release = readPathSignal();
      const writerOpen = readPathSignal<number>();
      const revoker = db.begin(async (tx) => {
        await tx`update allrice_memberships set active=false where user_id=${f.user}`;
        const [r] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        revokerOpen.resolve(r!.pid);
        await release.promise;
      });
      void revoker.catch((error: unknown) => revokerOpen.reject(error));
      const revokerPid = await revokerOpen.promise;
      const writer = createReadPathProbe(db, {
        lockTimeout: '3s',
        afterStart: async (tx) => {
          const [r] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          writerOpen.resolve(r!.pid);
        },
      });
      const writing = decideRuntimeActionApproval(
        f.context,
        f.id,
        f.response,
        writer.db,
      );
      void writing.catch((error: unknown) => writerOpen.reject(error));
      let raceError: unknown;
      try {
        const pid = await writerOpen.promise;
        await vi.waitFor(
          async () => {
            const [r] = await db<
              { blockers: number[] }[]
            >`select pg_blocking_pids(${pid}) as blockers`;
            expect(r!.blockers).toContain(revokerPid);
          },
          { timeout: 1500, interval: 10 },
        );
      } catch (error) {
        raceError = error;
      } finally {
        release.resolve();
      }
      const outcome = await Promise.allSettled([revoker, writing]);
      if (raceError) throw raceError;
      expect(outcome[0]!.status).toBe('fulfilled');
      expect(outcome[1]).toMatchObject({
        status: 'rejected',
        reason: { code: 'membership_denied' },
      });
    });
    it('browser operation admission still holds identity and workspace locks', async () => {
      const f = await browser();
      let checked = false;
      const probe = createReadPathProbe(db, {
        beforeCommit: async (tx) => {
          const [row] = await tx<
            { xid: string | null }[]
          >`select pg_current_xact_id_if_assigned()::text as xid`;
          if (!row!.xid) return;
          const [operations] = await tx<
            { n: number }[]
          >`select count(*)::int as n
            from allrice_runtime_operations o join allrice_browser_operation_inputs i on i.operation_id=o.id
            where i.browser_workspace_id=${f.w.id}`;
          // Root preparation is a separate transaction before admission.
          if (operations!.n < 2) return;
          await expectReadPathRowLocked(db, 'allrice_users', f.user);
          await expectReadPathRowLocked(
            db,
            'allrice_browser_workspaces',
            f.w.id,
          );
          checked = true;
        },
      });
      await createBrowserOperation(
        f.context,
        {
          version: 1,
          workspaceId: f.w.id,
          profileId: f.w.profile_id,
          actor: 'agent',
          fence: 1,
          observationId: f.observation.id,
          action: { type: 'click', elementId: 'e1' },
        },
        randomUUID(),
        probe.db,
      );
      expect(checked).toBe(true);
    });
    it('message feedback write still holds identity and session locks and rejects a revoked owner', async () => {
      const f = await createExperienceFixture(db);
      let checked = false;
      const probe = createReadPathProbe(db, {
        beforeCommit: async () => {
          await expectReadPathRowLocked(db, 'allrice_users', f.user);
          await expectReadPathRowLocked(
            db,
            'allrice_chat_sessions',
            f.session.id,
          );
          checked = true;
        },
      });
      current = probe.db;
      try {
        expect(
          await mutateMessageFeedback(f.owner, f.session.id, 'put', {
            messageId: f.assistant,
            rating: 'positive',
            ifVersion: null,
          }),
        ).toMatchObject({ ok: true });
      } finally {
        current = db;
      }
      expect(checked).toBe(true);
      await db`update allrice_memberships set active=false where user_id=${f.user}`;
      await expect(
        mutateMessageFeedback(f.owner, f.session.id, 'put', {
          messageId: f.assistant,
          rating: 'negative',
          ifVersion: null,
        }),
      ).rejects.toThrow('identity_denied');
    });
  },
);
