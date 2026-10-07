import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  BrowserVerificationPlanSchema,
  staticBrowserDocumentUrl,
  ArtifactBrowserVerificationSchema,
  BrowserObservationSchema,
} from '@allrice/contracts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { createLocalBrowserFixture } from './local-browser.fixture.ts';
import {
  installBrowserControlGrant,
  browserStopConfirmed,
  createBrowserOperation,
} from './browser-control.ts';
import {
  claimLocalBrowserWorkspace,
  heartbeatLocalBrowserWorkspace,
} from './local-browser-workspaces.ts';
import type postgres from 'postgres';
import { captureLocalBrowserFile } from './local-browser-files.ts';
import {
  publishLocalBrowserObservation,
  acknowledgeLocalBrowserControl,
} from './local-browser-operations.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  publishWorkbenchArtifact,
  getWorkbenchArtifact,
  readArtifactBytes,
} from './artifact-review.ts';
import { selectBrowserExecution } from './browser-execution-choice.ts';
import {
  resolveStaticBrowserDocument,
  admitStaticBrowserVerification,
  startStaticBrowserVerification,
  staticBrowserLease,
  requestStaticBrowserStop,
  publishStaticBrowserVerification,
  readArtifactBrowserVerification,
} from './static-browser.ts';
import * as client from './core/client.ts';
import { runBrowserWorkspace } from '../../../apps/worker/src/tool-broker/handlers/browser-workspace.ts';
import { nativeBrokerRoundtrip } from '../../../apps/worker/src/harness/dsh-native-broker.fixture.ts';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.ts';
import { getWorkAutomation, updateWorkAutomation } from './work-automation.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const physical =
  process.env.ALLRICE_STATIC_BROWSER_PHYSICAL === '1' ? it : it.skip;
const html = `<!doctype html><meta charset="utf-8"><title>Known bug verified</title><button onclick="document.querySelector('output').textContent=20+22">Compute</button><output>0</output>`;
const plan = BrowserVerificationPlanSchema.parse({
  version: 1,
  timeoutMs: 30000,
  steps: [
    { type: 'click', selector: { tag: 'button', label: 'Compute' } },
    { type: 'text_contains', expected: '42' },
  ],
});
const assertionPlan = BrowserVerificationPlanSchema.parse({
  version: 1,
  timeoutMs: 30000,
  steps: [{ type: 'title_equals', expected: 'Known bug verified' }],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
suite(
  'saved HTML verification: exact authority, native wire, real runsc and workbench parsing',
  () => {
    let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
      storageRoot: string;
    beforeAll(async () => {
      for (const key of [
        'ALLRICE_RUNTIME_POLICY_ENABLED',
        'ALLRICE_BROWSER_CONTROL_ENABLED',
        'ALLRICE_LOCAL_BROWSER_ENABLED',
        'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
        'ALLRICE_WORKBENCH_ENABLED',
        'ALLRICE_CLOUD_RUNNER_ENABLED',
      ])
        vi.stubEnv(key, '1');
      database = await createAssistantFixtureDatabase();
      storageRoot = await mkdtemp(join(tmpdir(), 'allrice-static-browser-qa-'));
      vi.spyOn(client, 'getDatabase').mockReturnValue(database.db);
    }, 60000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await database?.close();
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    });
    async function fixture(local = false, policyLifetimeMs = 3_600_000) {
      const f = await createLocalBrowserFixture(database.db, storageRoot, {
        open: false,
        workbench: true,
        memberRole: 'member',
        policyLifetimeMs,
      });
      if (!local)
        await database.db`update allrice_execution_targets set state='offline' where target_key=${'bridge.' + f.device.id}`;
      const otherGrant = await installBrowserControlGrant(
        f.context,
        {
          targetId: f.target,
          ownerId: f.user,
          profile: { version: 1, origins: ['https://example.com'] },
          enabled: true,
        },
        database.db,
      );
      const cloudGrant = await installBrowserControlGrant(
        f.context,
        {
          targetId: f.target,
          ownerId: f.user,
          profile: { version: 1, network: 'public_https', origins: [] },
          enabled: true,
        },
        database.db,
      );
      const artifact = await publishWorkbenchArtifact(
        {
          context: f.execution,
          sessionId: f.session,
          callId: randomUUID(),
          kind: 'document',
          fileName: 'index.html',
          format: 'html',
          mediaType: 'text/html',
          bytes: Buffer.from(html),
        },
        f.storage,
        database.db,
      );
      const document = await resolveStaticBrowserDocument(
        f.execution,
        {
          versionId: artifact.id,
          checksum: 'sha256:' + createHash('sha256').update(html).digest('hex'),
        },
        f.storage,
        database.db,
      );
      const [job] = await database.db<
        { attempt: number; lease_token: string }[]
      >`select attempt,lease_token from allrice_jobs where id=${f.execution.jobId}`;
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', ''); // All execution/read assertions are ordinary members.
      const automation = await getWorkAutomation(
        f.context,
        f.workspace,
        database.db,
      );
      await updateWorkAutomation(
        f.context,
        f.workspace,
        {
          expectedRevision: automation.revision,
          capability: local ? 'computer' : 'cloud',
          enabled: true,
        },
        database.db,
      );
      return { ...f, document, artifact, job: job!, cloudGrant, otherGrant };
    }
    async function admit(
      f: Awaited<ReturnType<typeof fixture>>,
      callId = randomUUID(),
      verificationPlan = plan,
    ) {
      const selected = await selectBrowserExecution(
        {
          context: f.execution,
          callId,
          url: staticBrowserDocumentUrl(f.document.target),
          jobAttempt: f.job.attempt,
          jobLeaseToken: f.job.lease_token,
          staticArtifact: f.document.target,
        },
        database.db,
      );
      expect(selected.choice.status).toBe('execute');
      return admitStaticBrowserVerification(
        {
          context: f.execution,
          sessionId: f.session,
          callId,
          target: f.document.target,
          plan: verificationPlan,
          jobAttempt: f.job.attempt,
          jobLeaseToken: f.job.lease_token,
          location: selected.choice.location as 'cloud' | 'local',
          reason: selected.selectionReason,
          grantId: selected.grantId,
          grantVersion: selected.grantVersion,
          targetId: selected.targetId,
          deviceId:
            selected.choice.location === 'local' ? selected.deviceId : null,
          deadlineAt: selected.deadlineAt,
        },
        database.db,
      );
    }
    it('selects and freezes only the concrete qualifying grant; revocation cannot substitute an older grant', async () => {
      const f = await fixture(),
        row = await admit(f);
      expect(row.parent_grant_id).toBe(f.cloudGrant.id);
      expect(row.parent_grant_id).not.toBe(f.otherGrant.id);
      await database.db`update allrice_browser_control_grants set enabled=false,revoked_at=clock_timestamp() where id=${f.cloudGrant.id}`;
      await expect(staticBrowserLease(row, database.db)).rejects.toMatchObject({
        code: 'static_browser_authority_lost',
      });
      await expect(
        publishStaticBrowserVerification(
          row,
          Buffer.from('not-used'),
          f.storage,
          database.db,
        ),
      ).rejects.toMatchObject({ code: 'static_browser_authority_lost' });
    });
    it('rechecks grant version and origin between selection and admission', async () => {
      const f = await fixture(),
        callId = randomUUID();
      const s = await selectBrowserExecution(
        {
          context: f.execution,
          callId,
          url: staticBrowserDocumentUrl(f.document.target),
          jobAttempt: f.job.attempt,
          jobLeaseToken: f.job.lease_token,
          staticArtifact: f.document.target,
        },
        database.db,
      );
      await database.db`update allrice_browser_control_grants set version=version+1,profile=${database.db.json({ version: 1, origins: ['https://example.com'] })} where id=${s.grantId!}`;
      await expect(
        admitStaticBrowserVerification(
          {
            context: f.execution,
            sessionId: f.session,
            callId,
            target: f.document.target,
            plan,
            jobAttempt: f.job.attempt,
            jobLeaseToken: f.job.lease_token,
            location: 'cloud',
            reason: s.selectionReason,
            grantId: s.grantId,
            grantVersion: s.grantVersion,
            targetId: s.targetId,
            deviceId: null,
            deadlineAt: s.deadlineAt,
          },
          database.db,
        ),
      ).rejects.toMatchObject({ code: 'static_browser_grant_denied' });
    });
    it.each(['policy', 'employee', 'flag', 'lease'] as const)(
      'live %s loss denies renewal and publication, including ordinary accounts',
      async (kind) => {
        const f = await fixture(false, kind === 'policy' ? 3000 : 3_600_000),
          row = await admit(f);
        await startStaticBrowserVerification(row, database.db);
        if (kind === 'policy') await delay(3100);
        if (kind === 'employee')
          await database.db`update allrice_employees set status='archived' where organization_id=${f.org} and workspace_id=${f.workspace}`;
        if (kind === 'lease')
          await database.db`update allrice_jobs set lease_token=${randomUUID()} where id=${f.execution.jobId}`;
        if (kind === 'flag') vi.stubEnv('ALLRICE_BROWSER_CONTROL_ENABLED', '0');
        await expect(staticBrowserLease(row, database.db)).rejects.toThrow();
        await expect(
          publishStaticBrowserVerification(
            row,
            Buffer.from('not-used'),
            f.storage,
            database.db,
          ),
        ).rejects.toThrow();
        vi.stubEnv('ALLRICE_BROWSER_CONTROL_ENABLED', '1');
      },
    );
    it('freezes saved version/plan inputs, prevents replay, and refuses foreign or changed source references', async () => {
      const f = await fixture(),
        row = await admit(f);
      expect(await startStaticBrowserVerification(row, database.db)).toBe(true);
      expect(await startStaticBrowserVerification(row, database.db)).toBe(
        false,
      );
      await expect(
        database.db`update allrice_static_browser_verifications set target=target||'{"checksum":"changed"}'::jsonb where id=${row.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        resolveStaticBrowserDocument(
          f.execution,
          { versionId: f.artifact.id, checksum: 'sha256:' + '0'.repeat(64) },
          f.storage,
          database.db,
        ),
      ).rejects.toMatchObject({ code: 'static_browser_source_changed' });
      const stranger = await fixture();
      await expect(
        resolveStaticBrowserDocument(
          stranger.execution,
          { versionId: f.artifact.id, checksum: f.document.target.checksum },
          stranger.storage,
          database.db,
        ),
      ).rejects.toMatchObject({ code: 'static_browser_source_denied' });
    });
    it.each(
      (['deny', 'plan_only', 'confirmation'] as const).flatMap((kind) =>
        [plan, assertionPlan].map((verificationPlan) => ({
          kind,
          verificationPlan,
        })),
      ),
    )(
      'live $kind controls cannot be bypassed by a cloud static verifier ($verificationPlan.steps)',
      async ({ kind, verificationPlan }) => {
        const f = await fixture(),
          row = await admit(f, randomUUID(), verificationPlan);
        if (kind === 'confirmation') {
          const automation = await getWorkAutomation(
            f.context,
            f.workspace,
            database.db,
          );
          await updateWorkAutomation(
            f.context,
            f.workspace,
            {
              expectedRevision: automation.revision,
              capability: 'cloud',
              enabled: false,
            },
            database.db,
          );
        } else {
          const [p] = await database.db<
            {
              version: number;
              controls: {
                version: number;
                mode: string;
                rules: { action: string; effect: string }[];
              };
            }[]
          >`
        select version,controls from allrice_runtime_policy_controls where organization_id=${f.org} and workspace_id=${f.workspace}`;
          const controls = {
            ...p!.controls,
            version: p!.version + 1,
            ...(kind === 'plan_only'
              ? { mode: 'plan_only' }
              : {
                  rules: p!.controls.rules.map((r) =>
                    r.action === 'cloud.browser.act'
                      ? { ...r, effect: 'deny' }
                      : r,
                  ),
                }),
          };
          await database.db`update allrice_runtime_policy_controls set version=${controls.version},controls=${database.db.json(controls)}
        where organization_id=${f.org} and workspace_id=${f.workspace}`;
        }
        await expect(
          staticBrowserLease(row, database.db),
        ).rejects.toMatchObject({ code: 'static_browser_policy_denied' });
        await expect(
          startStaticBrowserVerification(row, database.db),
        ).rejects.toMatchObject({ code: 'static_browser_policy_denied' });
        await expect(
          publishStaticBrowserVerification(
            row,
            Buffer.from('not-used'),
            f.storage,
            database.db,
          ),
        ).rejects.toThrow();
      },
    );
    function scheduleQueries(
      hook: (sql: string, execute: () => Promise<unknown>) => Promise<unknown>,
    ) {
      return new Proxy(database.db, {
        get(target, key) {
          if (key !== 'begin') return Reflect.get(target, key, target);
          return (work: (tx: postgres.TransactionSql) => Promise<unknown>) =>
            target.begin((tx) =>
              work(
                new Proxy(tx, {
                  apply(query, thisArg, args: unknown[]) {
                    const fragments = args[0];
                    if (!Array.isArray(fragments) || !('raw' in fragments))
                      return Reflect.apply(query, thisArg, args);
                    const sql = fragments
                      .join('?')
                      .replaceAll(/\s+/g, ' ')
                      .toLowerCase();
                    return hook(
                      sql,
                      async () => await Reflect.apply(query, thisArg, args),
                    );
                  },
                }),
              ),
            );
        },
      });
    }
    async function claimedStatic() {
      const f = await fixture(true);
      await database.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment}',
        '{"version":1,"clientVersion":"synthetic-static","staticBrowserVersion":1,"browser":"ready","sandbox":"unavailable","preview":"unavailable","paused":false}'::jsonb)
        where target_key=${'bridge.' + f.device.id}`;
      const row = await admit(f);
      const claimed = await claimLocalBrowserWorkspace(
        f.device,
        randomUUID(),
        true,
        database.db,
      );
      const workspace = claimed.workspace!;
      const identity = {
        workspaceId: workspace.id,
        controllerLeaseToken: claimed.lease!.token,
      };
      const observationId = randomUUID();
      const capture = await captureLocalBrowserFile(
        f.device,
        {
          ...identity,
          kind: 'screenshot',
          fence: workspace.fence,
          observationId,
        },
        Buffer.from('89504e470d0a1a0a', 'hex'),
        f.storage,
        database.db,
      );
      const capturedAt = new Date();
      const observation = BrowserObservationSchema.parse({
        version: 1,
        id: observationId,
        profileId: workspace.profileId,
        fence: workspace.fence,
        revision: 1,
        capturedAt: capturedAt.toISOString(),
        expiresAt: new Date(capturedAt.getTime() + 60000).toISOString(),
        url: staticBrowserDocumentUrl(f.document.target),
        title: 'Known bug verified',
        text: '0',
        pageDigest: runtimePolicyDigest('synthetic-static'),
        screenshotObjectId: capture.objectId,
        elements: [],
      });
      await publishLocalBrowserObservation(
        f.device,
        { ...identity, observation },
        database.db,
      );
      await acknowledgeLocalBrowserControl(
        f.device,
        { ...identity, fence: workspace.fence, state: 'agent', observationId },
        database.db,
      );
      const command = {
        version: 1,
        workspaceId: workspace.id,
        profileId: workspace.profileId,
        actor: 'agent',
        fence: workspace.fence,
        observationId,
        action: { type: 'observe' },
      };
      await createBrowserOperation(
        f.context,
        command,
        randomUUID(),
        database.db,
      );
      return { f, row, identity, command };
    }
    it('static heartbeat enters root before workspace while ledger holds controls, without deadlock', async () => {
      const { f, identity, command } = await claimedStatic();
      const controlsLocked = deferred<void>(),
        release = deferred<void>(),
        firstLock = deferred<string>();
      let paused = false;
      const ledgerDb = scheduleQueries(async (sql, execute) => {
        const result = await execute();
        if (
          !paused &&
          sql.startsWith(
            ' select version, controls from allrice_runtime_policy_controls',
          )
        ) {
          paused = true;
          controlsLocked.resolve();
          await release.promise;
        }
        return result;
      });
      const heartbeatDb = scheduleQueries(async (sql, execute) => {
        if (sql.includes('for update'))
          firstLock.resolve(
            sql.includes('from allrice_runtime_roots') ? 'root' : sql,
          );
        return execute();
      });
      const operation = createBrowserOperation(
        f.context,
        command,
        randomUUID(),
        ledgerDb,
      );
      void operation.catch(() => undefined);
      await controlsLocked.promise;
      const heartbeat = heartbeatLocalBrowserWorkspace(
        f.device,
        identity,
        heartbeatDb,
      );
      void heartbeat.catch(() => undefined);
      try {
        expect(await firstLock.promise).toBe('root');
      } finally {
        release.resolve();
      }
      await expect(operation).resolves.toBeDefined();
      await expect(heartbeat).resolves.toMatchObject({
        workspace: { desiredControl: 'agent' },
      });
    }, 15000);
    it('a heartbeat blocked by live policy observes committed Deny, and stop survives invalid controls', async () => {
      const { f, row, identity } = await claimedStatic();
      const locked = deferred<void>(),
        release = deferred<void>();
      const deny = database.db.begin(async (tx) => {
        const [p] = await tx<
          {
            version: number;
            controls: {
              version: number;
              rules: { action: string; effect: string }[];
            };
          }[]
        >`
          select version,controls from allrice_runtime_policy_controls where organization_id=${f.org} and workspace_id=${f.workspace} for update`;
        locked.resolve();
        await release.promise;
        const controls = {
          ...p!.controls,
          version: p!.version + 1,
          rules: p!.controls.rules.map((rule) =>
            rule.action === 'local.browser.act'
              ? { ...rule, effect: 'deny' }
              : rule,
          ),
        };
        await tx`update allrice_runtime_policy_controls set version=${controls.version},controls=${tx.json(controls)}
          where organization_id=${f.org} and workspace_id=${f.workspace}`;
      });
      await locked.promise;
      const atControls = deferred<void>();
      const heartbeatDb = scheduleQueries(async (sql, execute) => {
        if (
          sql.includes('from allrice_runtime_policy_controls') &&
          sql.includes('for update')
        )
          atControls.resolve();
        return execute();
      });
      const heartbeat = heartbeatLocalBrowserWorkspace(
        f.device,
        identity,
        heartbeatDb,
      );
      void heartbeat.catch(() => undefined);
      try {
        await atControls.promise;
      } finally {
        release.resolve();
      }
      await deny;
      await expect(heartbeat).resolves.toMatchObject({
        workspace: { desiredControl: 'closed' },
      });
      await database.db`update allrice_runtime_policy_controls set controls='{}'::jsonb
        where organization_id=${f.org} and workspace_id=${f.workspace}`;
      await expect(
        requestStaticBrowserStop(row, database.db),
      ).resolves.toBeUndefined();
      await expect(
        heartbeatLocalBrowserWorkspace(f.device, identity, database.db),
      ).resolves.toMatchObject({ workspace: { desiredControl: 'closed' } });
    }, 15000);
    it('closes an unclaimed unknown verification and skips expired static intents during later claims', async () => {
      const f = await fixture(true);
      await database.db`update allrice_execution_targets set metadata=jsonb_set(metadata,'{environment}',
      '{"version":1,"clientVersion":"synthetic-static","staticBrowserVersion":1,"browser":"ready","sandbox":"unavailable","preview":"unavailable","paused":false}'::jsonb) where target_key=${'bridge.' + f.device.id}`;
      const row = await admit(f);
      expect(row.location).toBe('local');
      await database.db`update allrice_static_browser_verifications set state='unknown' where id=${row.id}`;
      expect(
        (
          await claimLocalBrowserWorkspace(
            f.device,
            randomUUID(),
            true,
            database.db,
          )
        ).workspace,
      ).toBeNull();
      await requestStaticBrowserStop(row, database.db);
      expect(
        await browserStopConfirmed(
          f.execution,
          row.browser_workspace_id!,
          row.job_attempt,
          row.job_lease_token,
          database.db,
        ),
      ).toBe(true);
      await requestStaticBrowserStop(row, database.db); // Terminal stop is idempotent.
      const next = await admit(f);
      expect(
        (
          await claimLocalBrowserWorkspace(
            f.device,
            randomUUID(),
            true,
            database.db,
          )
        ).workspace?.id,
      ).toBe(next.browser_workspace_id);
    });
    physical(
      'native DSH -> production Broker -> real runsc -> DB -> private details contract/download bytes, with no project execution',
      async () => {
        const f = await fixture();
        const execute = CloudRunnerBackend.prototype.executeStaticBrowser;
        const probe = vi
          .spyOn(CloudRunnerBackend.prototype, 'executeStaticBrowser')
          .mockImplementation(async function (
            this: CloudRunnerBackend,
            ...args
          ) {
            const result = await execute.apply(this, args);
            if (result.reason !== 'completed')
              console.error('STATIC_PHYSICAL_FAILURE', JSON.stringify(result));
            return result;
          });
        const args = {
          command: 'verify',
          artifact: {
            versionId: f.artifact.id,
            checksum: f.document.target.checksum,
          },
          plan,
          location: 'auto',
        };
        const before =
          await database.db`select id from allrice_runtime_operations where run_id=${f.run}`;
        let delivery:
          { verification: unknown; artifacts: { id: string }[] } | undefined;
        await nativeBrokerRoundtrip({
          canonicalName: 'browser.workspace',
          wireName: 'browser_workspace',
          args,
          invalidArgs: { ...args, url: 'http://127.0.0.1:9999/' },
          timeoutMs: 120000,
          onToolCall: async (call) => {
            const result = await runBrowserWorkspace({
              input: {
                context: f.execution,
                capabilities: [
                  'storage:read',
                  'storage:write',
                  'network:outbound',
                ],
                storageRoot,
                sessionId: f.session,
                call,
                managedBrowserJobAttempt: f.job.attempt,
                managedBrowserJobLeaseToken: f.job.lease_token,
              },
              arguments: call.arguments,
            }).catch((error) => {
              console.error('STATIC_CHAIN_FAILURE', error);
              throw error;
            });
            delivery = JSON.parse(result.modelContent);
            return result;
          },
        });
        expect(delivery).toBeDefined();
        expect(delivery!.verification).toMatchObject({
          location: 'cloud',
          physicalStopConfirmed: true,
          report: { verdict: 'passed', target: f.document.target },
        });
        const artifacts = [];
        for (const ref of delivery!.artifacts) {
          const parsed = ArtifactBrowserVerificationSchema.parse(
            await readArtifactBrowserVerification(
              f.context,
              f.session,
              ref.id,
              database.db,
            ),
          );
          expect(parsed.outcome.report.verdict).toBe('passed');
          const artifact = await getWorkbenchArtifact(
            f.context,
            f.session,
            ref.id,
            database.db,
          );
          const bytes = await readArtifactBytes(
            f.storage,
            artifact.object,
            5000000,
          );
          expect(
            'sha256:' + createHash('sha256').update(bytes).digest('hex'),
          ).toBe(artifact.object.checksum);
          artifacts.push({
            id: ref.id,
            format: artifact.version.format,
            checksum: artifact.object.checksum,
            sizeBytes: bytes.length,
          });
        }
        const stranger = await fixture();
        await expect(
          readArtifactBrowserVerification(
            stranger.context,
            f.session,
            delivery!.artifacts[0]!.id,
            database.db,
          ),
        ).rejects.toThrow();
        expect(
          await readArtifactBrowserVerification(
            f.context,
            f.session,
            f.artifact.id,
            database.db,
          ),
        ).toBeNull();
        expect(
          await database.db`select id from allrice_runtime_operations where run_id=${f.run}`,
        ).toEqual(before);
        const evidence = process.env.ALLRICE_STATIC_BROWSER_EVIDENCE;
        if (evidence)
          await writeFile(
            join(evidence, 'pr4b-native-cloud-chain.json'),
            JSON.stringify(
              {
                kind: 'deterministic-real-native-transport',
                newModelTasks: 0,
                verification: delivery!.verification,
                artifacts,
                privateDetailsContract: true,
                detailHttpAndFrontendVerified: false,
                crossAccountDenied: true,
                oldRecord: true,
                projectExecutionAdded: 0,
              },
              null,
              2,
            ),
          );
        probe.mockRestore();
      },
      180000,
    );
  },
);
