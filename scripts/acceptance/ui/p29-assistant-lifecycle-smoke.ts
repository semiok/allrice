/** Run explicitly after the Web build is frozen. Private fixture only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
if (process.env.ALLRICE_MET140_UI_ISOLATED !== '1') {
  const child = spawn(
    process.execPath,
    [
      '--import',
      createRequire(join(root, 'package.json')).resolve('tsx'),
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        ALLRICE_MET140_UI_ISOLATED: '1',
        ALLRICE_TEST_DATABASE_URL: 'postgres://a123@127.0.0.1:5432/allrice_b2',
        ALLRICE_ASSISTANTS_ENABLED: '1',
        ALLRICE_WORKBENCH_ENABLED: '1',
        ALLRICE_RUNTIME_POLICY_ENABLED: '1',
        __NEXT_PROCESSED_ENV: 'true',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => child.kill(signal));
  const [code] = await once(child, 'exit');
  process.exit(typeof code === 'number' ? code : 1);
}
const evidence = await mkdtemp(join(tmpdir(), 'allrice-met140-evidence-'));
const report: Record<string, unknown> = {
  passed: false,
  scope:
    'MET140 controlled-native UI acceptance only; no external model/provider calls, no production/real-tenant writes',
  externalModelCalls: 0,
  evidence,
  cleanup: {},
};
let phase = 'fixture_create';
const { createAssistantFixtureDatabase } =
  await import('../../../packages/database/src/assistant-runtime.fixture.ts');
const { createCodexLifecycleScenario } =
  await import('../runtime/p27-codex-lifecycle-fixture.ts');
const { verifyAssistantLifecycleInChrome, lifecycleFixtureCleanupAllowed } =
  await import('./p29-assistant-lifecycle-ui.ts');
const { productionAssistantController } =
  await import('../../../apps/worker/src/harness/dsh/assistant-controller.ts');
const { recordRouteDecision } =
  await import('../../../packages/database/src/execution/route-decision.ts');
const { freezeRouteSubscriptionSnapshot } =
  await import('../../../packages/database/src/execution/route-subscription.ts');
let database:
  Awaited<ReturnType<typeof createAssistantFixtureDatabase>> | undefined;
let partial:
  Awaited<ReturnType<typeof createCodexLifecycleScenario>> | undefined;
let cancellation:
  Awaited<ReturnType<typeof createCodexLifecycleScenario>> | undefined;
try {
  database = await createAssistantFixtureDatabase();
  const [scope] = await database.db`select current_schema() as schema`;
  const databaseUrl = new URL('postgres://a123@127.0.0.1:5432/allrice_b2');
  databaseUrl.searchParams.set(
    'options',
    `-csearch_path=${scope!.schema},public`,
  );
  partial = await createCodexLifecycleScenario(database.db, {
    mode: 'partial_failure',
  });
  phase = 'partial_native_execution';
  await partial.start();
  partial.releaseChild('A');
  partial.releaseChild('B');
  const outcome = await partial.finish();
  await partial.project(outcome);
  report.partialOutcome = outcome;
  cancellation = await createCodexLifecycleScenario(database.db);
  phase = 'cancellation_native_start';
  await cancellation.start();
  for (
    let attempt = 0;
    attempt < 100 && cancellation.native.requests.length < 3;
    attempt++
  )
    await delay(100);
  assert.equal(cancellation.native.requests.length, 3);
  const f = cancellation.f,
    otherSessionId = randomUUID();
  await database.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
    values(${otherSessionId},${f.org},${f.workspace},${f.user},'MET140 isolated other Session',${f.assignment},${f.version})`;
  const partialOtherSessionId = randomUUID();
  await database.db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
    values(${partialOtherSessionId},${partial.f.org},${partial.f.workspace},${partial.f.user},'MET140 same owner other Session',${partial.f.assignment},${partial.f.version})`;
  const storageRoot = join(partial.native.root, 'artifacts');
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  phase = 'chrome_ui';
  report.ui = await verifyAssistantLifecycleInChrome({
    db: database.db,
    databaseUrl: databaseUrl.toString(),
    storageRoot: await realpath(storageRoot),
    evidenceDirectory: evidence,
    partial: partial.f,
    cancellation: f,
    partialOtherSessionId,
    otherSessionId,
    drainCancellation: () => cancellation!.drain(),
    createSameSessionPeer: async () => {
      // New synthetic request identity, same actual frozen employee/Session.
      // This is controller admission only; no native host/prompt/model is begun.
      const source = cancellation!,
        db = database!.db;
      const runId = randomUUID(),
        jobId = randomUUID(),
        leaseToken = randomUUID(),
        workerId = randomUUID();
      const userMessageId = randomUUID(),
        assistantMessageId = randomUUID();
      const generation = source.f.worker.generation + 1;
      await db.begin(async (tx) => {
        await tx`insert into allrice_runs(id,organization_id,workspace_id,project_id,owner_id,state,policy_snapshot_id,execution_spec,input)
          select ${runId},organization_id,workspace_id,project_id,owner_id,'running',policy_snapshot_id,execution_spec,input from allrice_runs where id=${source.f.rootRunId}`;
        await tx`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
          select ${jobId},organization_id,workspace_id,owner_id,${runId},'running',${randomUUID()},clock_timestamp()+interval '5 minutes',payload,${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '5 minutes' from allrice_jobs where id=${source.f.worker.jobId}`;
        await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
          values(${userMessageId},${source.f.org},${source.f.workspace},${source.f.session},${source.f.user},'user','{"text":"MET140 subsequent root: admission only, no model call","citations":[]}'),
          (${assistantMessageId},${source.f.org},${source.f.workspace},${source.f.session},${source.f.user},'assistant','{"text":"MET140 synthetic waiting root; no model completion claimed","citations":[]}')`;
        await tx`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,user_message_id,assistant_message_id,provider_snapshot,prompt_snapshot,native_skills,execution_snapshot)
          select ${runId},organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,session_id,${userMessageId},${assistantMessageId},provider_snapshot,prompt_snapshot,native_skills,execution_snapshot from allrice_employee_runs where run_id=${source.f.rootRunId}`;
        await tx`update allrice_conversation_runtimes set active_run_id=${runId},worker_id=${workerId},thread_generation=${generation},state='running' where session_id=${source.f.session} and organization_id=${source.f.org} and workspace_id=${source.f.workspace} and owner_id=${source.f.user} and active_run_id=${source.f.rootRunId}`;
      });
      const decision = {
        ...source.decision,
        id: randomUUID(),
        runId,
        generation,
        createdAt: new Date().toISOString(),
      };
      await recordRouteDecision(decision, db);
      const proof = await freezeRouteSubscriptionSnapshot(
        {
          organizationId: source.f.org,
          workspaceId: source.f.workspace,
          decisionId: decision.id,
          snapshot: source.controllerInput.subscriptionSnapshot,
        },
        db,
      );
      const controller = productionAssistantController({
        ...source.controllerInput,
        worker: { jobId, workerId, leaseToken },
        context: {
          ...source.controllerInput.context,
          executionId: randomUUID(),
          runId,
          jobId,
          worker: { type: 'worker', id: workerId },
          startedAt: new Date().toISOString(),
        },
      });
      assert.ok(controller);
      const requestsBefore = source.native.requests.length;
      await controller.bind(randomUUID(), generation);
      assert.equal(source.native.requests.length, requestsBefore);
      const facts = async () => ({
        root: await db`select r.state,j.status,j.cancel_requested_at,c.active_run_id,a.configuration,l.cancel_request_id from allrice_runs r join allrice_jobs j on j.run_id=r.id join allrice_assistant_roots a on a.root_run_id=r.id join allrice_runtime_roots l on l.root_run_id=r.id join allrice_employee_runs e on e.run_id=r.id join allrice_conversation_runtimes c on c.session_id=e.session_id where r.id=${runId} and j.id=${jobId}`,
        budgets:
          await db`select metric,capacity,reserved,spent from allrice_runtime_budgets where root_run_id=${runId} order by metric`,
        subscription:
          await db`select snapshot_digest from allrice_route_subscription_snapshots where route_decision_id=${decision.id}`,
      });
      const before = JSON.stringify(await facts());
      return {
        rootRunId: runId,
        assertUnchanged: async () => {
          assert.equal(JSON.stringify(await facts()), before);
          assert.equal(source.native.requests.length, requestsBefore);
          return {
            oldRootRunId: source.f.rootRunId,
            newRootRunId: runId,
            newRootHasNoCancelRequest: true,
            newRootLedgerUnchanged: true,
            newRootRemainsActiveSessionOwner: true,
            nativeRequestsAddedBySuccessor: 0,
            subscriptionSnapshotDigest: proof.snapshotDigest,
          };
        },
      };
    },
  });
  assert.equal((report.ui as { passed: boolean }).passed, true);
  report.controlledNativeRequests = {
    partial: partial.native.requests.length,
    cancellation: cancellation.native.requests.length,
  };
  report.cancellationTree = await cancellation.bound.tree();
  report.passed = true;
} catch {
  report.failure = { code: 'MET140_SMOKE_FAILED', phase };
  process.exitCode = 1;
} finally {
  const cleanup: Record<string, unknown> = {};
  const uiCleanup = (
    report.ui as
      | {
          cleanup?: {
            chromeClosed: boolean;
            nextStopped: boolean;
            authRemoved: boolean;
          };
        }
      | undefined
  )?.cleanup;
  const mayRemoveFixture = lifecycleFixtureCleanupAllowed(
    phase === 'chrome_ui',
    uiCleanup,
  );
  if (!mayRemoveFixture) {
    report.passed = false;
    report.fixtureRetained = {
      reason: 'ui_owner_cleanup_unconfirmed',
      schemaStorageNativeRetained: true,
    };
    process.exitCode = 1;
  }
  try {
    if (partial && mayRemoveFixture) cleanup.partial = await partial.close();
  } catch {
    cleanup.partial = false;
  }
  try {
    if (cancellation && mayRemoveFixture)
      cleanup.cancellation = await cancellation.close();
  } catch {
    cleanup.cancellation = false;
  }
  try {
    if (database && mayRemoveFixture && !Object.values(cleanup).includes(false))
      cleanup.database = await database.close();
  } catch {
    cleanup.database = false;
  }
  report.cleanup = cleanup;
  if (Object.values(cleanup).some((value) => value === false)) {
    report.passed = false;
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  report.sourceDigests = Object.fromEntries(
    await Promise.all(
      [
        'scripts/acceptance/runtime/p27-codex-lifecycle-fixture.ts',
        'scripts/acceptance/ui/p29-assistant-lifecycle-ui.ts',
        'scripts/acceptance/ui/p29-assistant-lifecycle-smoke.ts',
      ].map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(join(root, path)))
          .digest('hex'),
      ]),
    ),
  );
  const path = join(evidence, 'summary.json');
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence: path,
      failure: report.failure ?? null,
      uiFailure:
        (report.ui as { failure?: unknown } | undefined)?.failure ?? null,
    }),
  );
}
