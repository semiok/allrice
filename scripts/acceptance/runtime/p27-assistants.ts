/** One explicitly authorized P27 real-provider execution. No retries/fixture provider. */
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Postgres from '../../../packages/database/node_modules/postgres/types/index.d.ts';
import type { createAssistantFixtureDatabase as CreateDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import type { DshHarnessAdapter as Adapter } from '../../../apps/worker/src/harness/dsh-adapter.ts';
import { observeP27Clients } from './p27-owned-clients.ts';
import { collectP27InstalledRuntime } from './p27-installed-runtime.ts';
import {
  assertExecutionAuthorization,
  authorizedPlatformHome,
  FIXTURE_DATABASE_URL,
  isolatedEnvironment,
  parseArguments,
  PROVIDER,
  readCandidate,
  requireCheck,
  RUN_LIMITS,
} from './p27-assistant-preflight.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const check: typeof requireCheck = requireCheck;
const sourceFiles = [
  'pnpm-lock.yaml',
  'apps/worker/dsh/allrice-assistant-runtime.mjs',
  'apps/worker/dsh/allrice-restricted.cordis.yml',
  'apps/worker/src/harness/dsh/assistant-controller.ts',
  'packages/database/src/assistant-output.ts',
  'apps/worker/dsh/distribution.json',
  'apps/worker/dsh/upstream.json',
];
const prompt = `P27_ROOT_SYNTHETIC_ONLY. Use the actual assistant_delegate tool exactly twice, one independent child A and one B. Give each tools ["assistant.report"] only. Delegate BOTH before you synthesize. Each child must independently calculate its assigned synthetic inputs and call assistant_report once with status "completed", an accurate short summary, evidence [], incomplete [], and output {name:"report",content:<JSON string of its computed result>}. The platform, not you, attaches the immutable artifact evidence. Do not invent artifact IDs.
Child A: sale rows [{units:3,unitPriceCents:125},{units:2,unitPriceCents:250}]. Calculate totalCents and row count. Output JSON fields exactly case:"A",totalCents,rows.
Child B: invoice/payment rows [{invoiceCents:1000,paidCents:400},{invoiceCents:900,paidCents:900}]. Calculate invoiceCents,paidCents,outstandingCents. Output JSON fields exactly case:"B",invoiceCents,paidCents,outstandingCents.
Wait for BOTH actual child results. Do not call assistant_report as the parent. After consuming both results, return ONLY a JSON object with salesTotalCents from A, outstandingCents from B, reports:2. No markdown or extra text. If a child fails, say so; never manufacture success. No external research, file tools, local execution or additional delegation.`;

async function main() {
  const args = parseArguments(process.argv.slice(2));
  readCandidate(root, args.sha);
  const sources: Record<string, string> = {};
  for (const file of sourceFiles)
    sources[file] = hash(await readFile(join(root, file)));
  const installedRuntime = await collectP27InstalledRuntime(root);
  if (args.mode === '--preflight') {
    process.stdout.write(
      `${JSON.stringify({
        status: 'preflight_only',
        candidateSha: args.sha,
        sources,
        installedRuntime,
        providerNotCalled: true,
        databaseNotOpened: true,
        credentialMetadataNotRead: true,
      })}\n`,
    );
    return;
  }
  // No DB import/connection, credential metadata inspection, native host or
  // filesystem mutation occurs before explicit SHA-bound execution authority.
  assertExecutionAuthorization(process.env, args.sha);
  const platformHome = await authorizedPlatformHome(
    process.env.ALLRICE_DSH_PLATFORM_HOME,
  );
  const environment = isolatedEnvironment(process.env, platformHome);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  const evidenceId = randomUUID();
  const evidenceDirectory = join(
    root,
    '.local',
    `p27-assistants-${evidenceId}`,
  );
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p27-assistants-')),
  );
  const report: Record<string, unknown> = {
    version: 1,
    evidenceId,
    candidateSha: args.sha,
    sources,
    installedRuntime,
    provider: PROVIDER,
    limits: RUN_LIMITS,
    promptDigest: hash(prompt),
    startedAt: new Date().toISOString(),
    status: 'running',
    assertions: [],
    excluded: [
      'P27-four-task-lines',
      'Bridge-M-and-Intel',
      'signed-install-update',
      'old-Bridge-and-session',
      'cancel-disconnect-revocation-cross-tenant',
      'GA',
    ],
  };
  let sequence = 0;
  const save = () =>
    writeFile(
      join(evidenceDirectory, `${String(++sequence).padStart(2, '0')}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  const assertions: string[] = [];
  const verify = (ok: unknown, name: string) => {
    check(ok, name);
    assertions.push(name);
    report.assertions = [...assertions];
  };
  let database: Awaited<ReturnType<typeof CreateDatabase>> | undefined;
  let adapter: Adapter | undefined;
  let clients: ReturnType<typeof observeP27Clients> | undefined;
  let executionPromise: Promise<unknown> | undefined;
  let executionSettled = false;
  let executeCount = 0;
  let snapshotFailure: (() => Promise<void>) | undefined;
  try {
    report.phase = 'isolated_database_setup';
    await save();
    const require = createRequire(
      new URL('../../../packages/database/package.json', import.meta.url),
    );
    const postgres = require('postgres') as typeof Postgres;
    const admin = postgres(FIXTURE_DATABASE_URL, {
      max: 1,
      onnotice: () => {},
    });
    try {
      const extensions = await admin<
        { extname: string }[]
      >`select extname from pg_extension where extname in ('vector','pg_trgm')`;
      verify(extensions.length === 2, 'existing_fixture_extensions');
    } finally {
      await admin.end({ timeout: 5 });
    }
    const [
      { createAssistantFixtureDatabase },
      { createP27AssistantFixture },
      { DshHarnessAdapter },
      { DshProtocolClient },
      { productionAssistantController },
      { createAssistantRuntime },
      { assertAssistantAuthority },
      { riceToolDefinitions },
      { allRiceToolManifest, runtimeContractEqual },
      { LocalStorageAdapter },
      { getWorkbenchArtifact, readArtifactBytes },
    ] = await Promise.all([
      import('../../../packages/database/src/assistant-runtime.fixture.ts'),
      import('./p27-assistant-fixture.ts'),
      import('../../../apps/worker/src/harness/dsh-adapter.ts'),
      import('../../../apps/worker/src/harness/dsh-protocol-client.ts'),
      import('../../../apps/worker/src/harness/dsh/assistant-controller.ts'),
      import('../../../packages/database/src/assistant-runtime.ts'),
      import('../../../packages/database/src/assistant-authority.ts'),
      import('../../../apps/worker/src/tool-broker.ts'),
      import('../../../packages/contracts/src/index.ts'),
      import('../../../packages/storage/src/index.ts'),
      import('../../../packages/database/src/artifact-review.ts'),
    ]);
    database = await createAssistantFixtureDatabase();
    const { db } = database;
    const [schema] = await db<
      { name: string }[]
    >`select current_schema() as name`;
    verify(/^p25_[a-f0-9]{32}$/.test(schema!.name), 'random_isolated_schema');
    report.schema = schema!.name;
    const fixture = await createP27AssistantFixture(db);
    snapshotFailure = async () => {
      // Explicit scalar allowlist. Never select message/result payloads,
      // provider errors or lease tokens, including on failed execution.
      const [instances, budgets, usage] = await Promise.all([
        db`select run_id,parent_run_id,status,depth from allrice_assistant_instances where root_run_id=${fixture.rootRunId}`,
        db`select metric,unit,currency,capacity,reserved,spent from allrice_runtime_budgets where root_run_id=${fixture.rootRunId}`,
        db`select run_id,metric,count(*)::integer as reservations,
          count(*) filter(where settled_amount is null)::integer as unsettled,
          coalesce(sum(settled_amount),0)::text as settled_amount
          from allrice_assistant_usage where root_run_id=${fixture.rootRunId} group by run_id,metric`,
      ]);
      report.failureSnapshot = {
        instances: [...instances],
        budgets: [...budgets],
        usage: [...usage],
      };
    };
    report.identity = {
      organizationId: fixture.org,
      workspaceId: fixture.workspace,
      ownerId: fixture.user,
      rootRunId: fixture.rootRunId,
      jobId: fixture.worker.jobId,
      sessionId: fixture.session,
      employeeVersionId: fixture.version,
      definitionDigest: fixture.checksum,
    };
    const tools = riceToolDefinitions.filter((tool) =>
      ['assistant.delegate', 'assistant.report'].includes(tool.name),
    );
    const manifest = allRiceToolManifest.filter((tool) =>
      tools.some((selected) => selected.name === tool.canonicalName),
    );
    verify(
      tools.length === 2 &&
        manifest.length === 2 &&
        manifest.every((tool) => tool.transport === 'dsh_assistant_native'),
      'real_native_tool_registry',
    );
    report.toolRegistry = {
      canonicalNames: tools.map((tool) => tool.name),
      nativeWireNames: manifest.map((tool) =>
        'dshWireName' in tool ? tool.dshWireName : null,
      ),
      definitionsDigest: hash(JSON.stringify(tools)),
    };
    verify(
      runtimeContractEqual(fixture.manifest.provider, PROVIDER),
      'frozen_provider_matches_actual_route',
    );
    const storage = new LocalStorageAdapter(join(temporary, 'storage'));
    const workDirectory = join(temporary, 'work');
    await mkdir(workDirectory, { mode: 0o700 });
    // Observe the production close contract (it awaits its child exit). Do not
    // replace provider transport, tools, authorization or process termination.
    clients = observeP27Clients(DshProtocolClient);
    adapter = new DshHarnessAdapter({
      runtimeRoot: join(temporary, 'runtime'),
      runtimeCommand: process.execPath,
      runtimeArgs: [join(root, 'apps/worker/dsh/allrice-jsonrpc-runtime.mjs')],
      cordisConfig: join(root, 'apps/worker/dsh/allrice-restricted.cordis.yml'),
      requestTimeoutMs: RUN_LIMITS.timeoutMs,
    });
    const abort = new AbortController();
    const controller = productionAssistantController({
      configuration: fixture.config,
      context: fixture.executionContext,
      worker: fixture.worker,
      database: db,
      storage,
      signal: abort.signal,
      authorize: assertAssistantAuthority,
      runLimits: RUN_LIMITS,
      tools,
    });
    verify(!!controller, 'production_assistant_controller_enabled');
    report.phase = 'single_real_provider_execute';
    await save();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(Error('p27_execute_deadline'));
      }, RUN_LIMITS.timeoutMs);
    });
    let result;
    try {
      executeCount++;
      const execution = adapter.execute({
        kernel: {
          schemaVersion: 1,
          harness: 'dsh',
          employeeAssignmentId: fixture.assignment,
          employeeVersionId: fixture.version,
          sessionId: fixture.session,
          userMessageId: fixture.userMessageId,
          assistantMessageId: fixture.assistantMessageId,
          systemInstructions:
            'Use only the provided governed native assistant tools. Be concise. Never fabricate evidence.',
          userRequest: prompt,
          bootstrapConversation: '',
          authorizedMemoryContext: '',
          grantedCapabilities: ['model:invoke'],
          skillVersionIds: [],
          imageAttachments: [],
        },
        providerSnapshot: PROVIDER,
        storageObjects: [],
        workDirectory,
        executionEnvironment: {
          ALLRICE_ORGANIZATION_ID: fixture.org,
          ALLRICE_WORKSPACE_ID: fixture.workspace,
          ALLRICE_OWNER_ID: fixture.user,
        },
        signal: abort.signal,
        attempt: 1,
        generation: fixture.worker.generation,
        maxOutputTokens: controller!.maxOutputTokens,
        threadId: `dsh-${fixture.session}`,
        tools,
        onEvent: async () => {},
        assistants: controller,
      });
      // No raw harness events/answers/thinking/errors are written to evidence.
      executionPromise = execution.finally(() => {
        executionSettled = true;
      });
      executionPromise.catch(() => {});
      result = await Promise.race([execution, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      report.execute = {
        count: executeCount,
        elapsedMs: Math.round(performance.now() - started),
      };
    }
    const runtime = createAssistantRuntime({
      database: db,
      authorize: assertAssistantAuthority,
    });
    report.phase = 'durable_results_and_immutable_bytes';
    const tree = await runtime.getTree(fixture.context, {
      runId: fixture.rootRunId,
    });
    const children = tree.instances.filter(
      (child) => child.parentRunId === fixture.rootRunId,
    );
    verify(
      tree.instances.length === 3 &&
        children.length === 2 &&
        !tree.cancelRequested &&
        tree.instances.find((instance) => instance.runId === fixture.rootRunId)
          ?.status === 'completed',
      'exact_two_finite_children',
    );
    verify(
      children.every(
        (child) =>
          child.depth === 1 &&
          child.status === 'completed' &&
          !child.cancelRequestedAt &&
          child.allowedTools.length === 1 &&
          child.allowedTools[0] === 'assistant.report',
      ),
      'children_completed_with_only_report_authority',
    );
    verify(
      tree.results.length === 2 &&
        tree.results.every(
          (item) =>
            children.some((child) => child.runId === item.runId) &&
            item.status === 'completed' &&
            item.incomplete.length === 0 &&
            item.evidence.length === 1 &&
            item.parentMessageId !== null &&
            item.parentAdoptedSeq !== null,
        ),
      'parent_durably_adopted_both_results',
    );
    verify(
      tree.messages.length === 2 &&
        children.every(
          (child) =>
            tree.messages.filter(
              (message) =>
                message.childRunId === child.runId &&
                message.senderRunId === fixture.rootRunId,
            ).length === 1,
        ) &&
        tree.messages.every(
          (message) =>
            message.status === 'adopted' &&
            message.nativeMessageId !== null &&
            message.durableSeq !== null &&
            message.adoptedSeq !== null,
        ),
      'native_messages_durably_adopted',
    );
    report.children = children.map((child) => ({
      runId: child.runId,
      nativeSessionId: child.nativeSessionId,
      status: child.status,
      depth: child.depth,
      artifactNamespace: child.artifactNamespace,
    }));
    report.adoption = tree.results.map((item) => ({
      runId: item.runId,
      deliveryId: item.deliveryId,
      parentMessageId: item.parentMessageId,
      parentAdoptedSeq: item.parentAdoptedSeq,
      summaryDigest: hash(item.summary),
      evidence: item.evidence,
    }));
    const artifacts = [];
    const cases = new Set<string>();
    for (const item of tree.results) {
      const evidence = item.evidence[0]!;
      const artifact = await getWorkbenchArtifact(
        fixture.context,
        fixture.session,
        evidence.id,
        db,
      );
      const bytes = await readArtifactBytes(storage, artifact.object, 140000);
      const content = JSON.parse(Buffer.from(bytes).toString('utf8'));
      verify(
        artifact.object.immutable &&
          artifact.object.checksum === evidence.digest &&
          hash(bytes) === evidence.digest &&
          artifact.object.organizationId === fixture.org &&
          artifact.object.workspaceId === fixture.workspace &&
          artifact.object.ownerId === fixture.user &&
          artifact.version.sessionId === fixture.session &&
          artifact.provenance.runId === item.runId &&
          artifact.version.fileName === 'report.json',
        'immutable_report_bytes_and_owner',
      );
      verify(
        content.kind === 'assistant_generated' &&
          content.independentlyVerified === false &&
          content.rootRunId === fixture.rootRunId &&
          content.childRunId === item.runId &&
          content.deliveryId === item.deliveryId &&
          content.name === 'report',
        'report_platform_provenance',
      );
      const data = JSON.parse(content.content);
      verify(
        data.case === 'A'
          ? data.totalCents === 875 && data.rows === 2
          : data.case === 'B' &&
              data.invoiceCents === 1900 &&
              data.paidCents === 1300 &&
              data.outstandingCents === 600,
        'computed_child_report_correct',
      );
      cases.add(data.case);
      const links = await db<{ artifact_id: string; relative_path: string }[]>`
        select artifact_id,relative_path from allrice_assistant_artifacts where run_id=${item.runId} and artifact_id=${evidence.id} and digest=${evidence.digest}`;
      verify(
        links.length === 1 &&
          links[0]!.relative_path === `outputs/${item.deliveryId}/report.json`,
        'artifact_registered_to_its_child',
      );
      artifacts.push({
        childRunId: item.runId,
        artifactId: evidence.id,
        objectId: artifact.object.id,
        digest: evidence.digest,
        sizeBytes: bytes.length,
        objectKeyDigest: hash(artifact.object.key),
        namespaceDigest: hash(
          children.find((child) => child.runId === item.runId)!
            .artifactNamespace,
        ),
        reopenAndReadbackVerified: true,
      });
    }
    verify(
      cases.size === 2 &&
        new Set(artifacts.map((a) => a.objectId)).size === 2 &&
        new Set(artifacts.map((a) => a.namespaceDigest)).size === 2,
      'same_basename_independent_immutable_objects',
    );
    report.artifacts = artifacts;
    const final = JSON.parse(result.answer);
    verify(
      Object.keys(final).sort().join(',') ===
        'outstandingCents,reports,salesTotalCents' &&
        final.salesTotalCents === 875 &&
        final.outstandingCents === 600 &&
        final.reports === 2,
      'parent_synthesis_matches_real_reports',
    );
    report.answer = {
      digest: hash(result.answer),
      sizeBytes: Buffer.byteLength(result.answer),
    };
    const usage = await db<
      {
        run_id: string;
        metric: string;
        amount: string;
        settled_amount: string | null;
      }[]
    >`
      select run_id,metric,amount,settled_amount from allrice_assistant_usage where root_run_id=${fixture.rootRunId}`;
    verify(
      usage.length > 0 && usage.every((row) => row.settled_amount !== null),
      'all_usage_settled',
    );
    report.phase = 'actual_budget_ledger';
    verify(
      tree.budgets.length === 4 &&
        tree.budgets.every(
          (budget) =>
            budget.reserved === 0 &&
            budget.usageComplete &&
            budget.spent > 0 &&
            budget.spent <= budget.capacity &&
            budget.currency === null &&
            usage
              .filter((row) => row.metric === budget.metric)
              .reduce((sum, row) => sum + Number(row.settled_amount), 0) ===
              budget.spent,
        ),
      'actual_ledger_matches_settled_usage',
    );
    verify(
      tree.instances.every((instance) =>
        usage.some(
          (row) =>
            row.run_id === instance.runId &&
            row.metric === 'model_calls' &&
            Number(row.settled_amount) > 0,
        ),
      ),
      'real_model_usage_for_parent_and_each_child',
    );
    verify(
      tree.budgets.find((b) => b.metric === 'model_calls')?.capacity === 16 &&
        tree.budgets.find((b) => b.metric === 'tool_calls')?.capacity === 64,
      'production_root_call_caps',
    );
    report.ledger = {
      budgets: tree.budgets,
      perRun: tree.instances.map((instance) => ({
        runId: instance.runId,
        metrics: Object.fromEntries(
          tree.budgets.map((budget) => [
            budget.metric,
            usage
              .filter(
                (row) =>
                  row.run_id === instance.runId && row.metric === budget.metric,
              )
              .reduce((sum, row) => sum + Number(row.settled_amount), 0),
          ]),
        ),
      })),
      costStatus: 'not_measured_no_authoritative_price_binding',
      usageRows: usage.length,
    };
    // Catch concurrent edits during execution; a changed candidate is not evidence.
    readCandidate(root, args.sha);
    verify(
      JSON.stringify(await collectP27InstalledRuntime(root)) ===
        JSON.stringify(installedRuntime),
      'installed_runtime_unchanged',
    );
    report.phase = 'verified';
    report.status = 'passed_basic_assistants_only';
  } catch (error) {
    report.status = 'failed';
    // Error strings may contain provider payloads or DB arguments. Retain only
    // our fixed assertion code, never a generic error message/stack/actual value.
    report.failureCode =
      error instanceof Error && /^p27_[a-z_]+$/.test(error.message)
        ? error.message
        : 'p27_external_or_runtime_failure';
    process.exitCode = 1;
  } finally {
    let nativeStopped = !adapter;
    if (adapter) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await Promise.all([adapter!.close(), clients!.closeAll()]);
            await executionPromise?.catch(() => {});
            // An initialize that started while stopping is captured and denied.
            await clients!.closeAll();
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('p27_host_close_timeout')),
              10000,
            );
          }),
        ]);
        nativeStopped =
          (executeCount === 0 || executionSettled) &&
          !!clients?.snapshot().allStopped;
      } catch {
        nativeStopped = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (nativeStopped) clients?.restore();
    if (report.status === 'failed' && snapshotFailure) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          snapshotFailure(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('p27_failure_snapshot_timeout')),
              5000,
            );
          }),
        ]);
      } catch {
        report.failureSnapshotUnavailable = true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    let schemaRemoved = !database,
      temporaryRemoved = false;
    // Native JSONL persistence is needed for real durable adoption. It is
    // ephemeral, never copied into evidence, and removed only after host exit.
    if (nativeStopped) {
      try {
        await database?.close();
        schemaRemoved = true;
      } catch {
        schemaRemoved = false;
      }
      try {
        await rm(temporary, { recursive: true });
        temporaryRemoved = true;
      } catch {
        temporaryRemoved = false;
      }
    }
    report.cleanup = {
      nativeStopped,
      schemaRemoved,
      temporaryRemoved,
      ownedNativeClients: clients?.snapshot().owned ?? 0,
      closedNativeClients: clients?.snapshot().closed ?? 0,
      executionSettled,
    };
    if (!nativeStopped || !schemaRemoved || !temporaryRemoved) {
      report.status = 'cleanup_blocked';
      process.exitCode = 1;
      // Only a newly created private temp path, not credential/config paths.
      report.retainedTemporary = temporary;
    }
    report.finishedAt = new Date().toISOString();
    await save();
    process.stdout.write(
      `${JSON.stringify({ status: report.status, candidateSha: args.sha, evidenceDirectory })}\n`,
    );
  }
}
main().catch(() => {
  // Even preflight OS errors must not echo an environment value or pathname.
  process.stderr.write(
    'P27 blocked before execution or evidence finalization; no raw error retained.\n',
  );
  process.exitCode = 1;
});
