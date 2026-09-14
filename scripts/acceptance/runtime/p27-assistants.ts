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
import type {
  createAssistantFixtureDatabase as CreateDatabase,
  AssistantFixtureCleanupProof,
} from '../../../packages/database/src/assistant-runtime.fixture.ts';
import type { DshHarnessAdapter as Adapter } from '../../../apps/worker/src/harness/dsh-adapter.ts';
import { observeP27Clients } from './p27-owned-clients.ts';
import { collectP27InstalledRuntime } from './p27-installed-runtime.ts';
import { validateP27AssistantOutcome } from './p27-assistant-outcome.ts';
import { p27ErrorDiagnostics } from './p27-error-diagnostics.ts';
import type { AssistantFailureDiagnostics } from '../../../apps/worker/src/harness/dsh/assistant-diagnostics.ts';
import {
  correlateP27AssistantDiagnostics,
  retainP27AssistantDiagnostics,
  type P27DiagnosticAdmission,
  type P27DiagnosticReceipt,
} from './p27-assistant-diagnostics.ts';
import {
  assertP27PriceDate,
  P27_GEMINI_PRICE_FACTS,
  P27_GEMINI_PRICE_FACTS_DIGEST,
  P27_GEMINI_PRICE_EXPIRES_AT,
  verifyP27PricingReceipts,
  type P27CostReceipt,
  type P27PricedAdmission,
} from './p27-assistant-pricing.ts';
import {
  assertExecutionAuthorization,
  authorizedPlatformHome,
  authorizedGeminiCredentialFile,
  FIXTURE_DATABASE_URL,
  fixtureCleanupFlags,
  prepareP27PlatformEnvironment,
  parseArguments,
  providerExecutionEligibility,
  selectedProvider,
  readCandidate,
  requireCheck,
  runLimitsForProvider,
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
  'apps/worker/src/harness/dsh/assistant-diagnostics.ts',
  'packages/database/src/assistant-output.ts',
  'apps/worker/dsh/distribution.json',
  'apps/worker/dsh/upstream.json',
  'scripts/acceptance/runtime/p27-assistant-pricing.ts',
  'scripts/acceptance/runtime/p27-assistant-fixture.ts',
  'scripts/acceptance/runtime/p27-assistant-outcome.ts',
  'scripts/acceptance/runtime/p27-assistant-diagnostics.ts',
  'packages/contracts/src/assistant-pricing.ts',
  'packages/database/src/assistant-pricing.ts',
];
const prompt = `P27_ROOT_SYNTHETIC_ONLY. Use the actual assistant_delegate tool exactly twice, one independent child A and one B. Give each tools ["assistant.report"] only. Delegate BOTH before you synthesize. Each child must independently calculate its assigned synthetic inputs and call assistant_report once with status "completed", an accurate short summary, evidence [], incomplete [], and output {name:"report",content:<JSON string of its computed result>}. The platform, not you, attaches the immutable artifact evidence. Do not invent artifact IDs.
Child A: sale rows [{units:3,unitPriceCents:125},{units:2,unitPriceCents:250}]. Calculate totalCents and row count. Output JSON fields exactly case:"A",totalCents,rows.
Child B: invoice/payment rows [{invoiceCents:1000,paidCents:400},{invoiceCents:900,paidCents:900}]. Calculate invoiceCents,paidCents,outstandingCents. Output JSON fields exactly case:"B",invoiceCents,paidCents,outstandingCents.
Wait for BOTH actual child results. Do not call assistant_report as the parent. After consuming both results, return ONLY a JSON object with salesTotalCents from A, outstandingCents from B, reports:2. No markdown or extra text. If a child fails, say so; never manufacture success. No external research, file tools, local execution or additional delegation.`;

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const provider = selectedProvider(args.providerRoute);
  const runLimits = runLimitsForProvider(args.providerRoute);
  readCandidate(root, args.sha);
  const sources: Record<string, string> = {};
  for (const file of sourceFiles)
    sources[file] = hash(await readFile(join(root, file)));
  const installedRuntime = await collectP27InstalledRuntime(root);
  const providerEligibility = providerExecutionEligibility(provider);
  if (args.providerRoute === 'gemini')
    assertP27PriceDate(new Date().toISOString());
  if (args.mode === '--preflight') {
    process.stdout.write(
      `${JSON.stringify({
        status: 'preflight_only',
        candidateSha: args.sha,
        sources,
        installedRuntime,
        providerEligibility,
        provider,
        pricing:
          args.providerRoute === 'gemini'
            ? {
                scope: 'isolated_fixture_only',
                sourceFactsDigest: P27_GEMINI_PRICE_FACTS_DIGEST,
                expiresAt: P27_GEMINI_PRICE_EXPIRES_AT,
                maxCostCents: runLimits.maxCostCents,
                actualBillingNotProven: true,
              }
            : null,
        providerNotCalled: true,
        databaseNotOpened: true,
        credentialMetadataNotRead: true,
      })}\n`,
    );
    return;
  }
  // No DB import/connection, credential metadata inspection, native host or
  // filesystem mutation occurs before explicit SHA-bound execution authority.
  assertExecutionAuthorization(process.env, args.sha, args.providerRoute);
  if (!providerEligibility.eligible) {
    process.stdout.write(
      `${JSON.stringify({
        status: 'blocked_before_execution',
        candidateSha: args.sha,
        providerEligibility,
        providerNotCalled: true,
        databaseNotOpened: true,
        credentialMetadataNotRead: true,
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const codexPlatformHome =
    args.providerRoute === 'openai-codex'
      ? await authorizedPlatformHome(process.env.ALLRICE_DSH_PLATFORM_HOME)
      : undefined;
  const credentialFile =
    args.providerRoute === 'gemini'
      ? await authorizedGeminiCredentialFile(
          process.env.ALLRICE_B6_P27_GEMINI_CREDENTIAL_FILE,
        )
      : undefined;
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
  // credentials-local unconditionally loads the configured DSH home at boot.
  // A Gemini test must NEVER point it at an existing Codex credential store.
  const report: Record<string, unknown> = {
    version: 1,
    evidenceId,
    candidateSha: args.sha,
    sources,
    installedRuntime,
    provider,
    platformHomeKind:
      args.providerRoute === 'gemini'
        ? 'new_empty_private'
        : 'existing_authorized_codex',
    limits: runLimits,
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
      'full-worker-routing-model-connection-selection-and-monthly-quota',
      'provider-invoice-and-unreported-provider-internal-retries',
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
  let fixtureInitializationAttempted = false;
  let fixtureCleanupProof: AssistantFixtureCleanupProof | undefined;
  let closeFixture: (() => Promise<void>) | undefined;
  let adapter: Adapter | undefined;
  let clients: ReturnType<typeof observeP27Clients> | undefined;
  let executionPromise: Promise<unknown> | undefined;
  let executionSettled = false;
  let executeCount = 0;
  let snapshotFailure: (() => Promise<void>) | undefined;
  let failureNativeDiagnostics: AssistantFailureDiagnostics | undefined;
  try {
    report.phase = 'isolated_platform_setup';
    const environment = await prepareP27PlatformEnvironment({
      environment: process.env,
      temporary,
      codexPlatformHome,
      providerRoute: args.providerRoute,
      credentialFile,
    });
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
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
      {
        createAssistantFixtureDatabase,
        AssistantFixtureInitializationError,
        AssistantFixtureCleanupError,
      },
      { createP27AssistantFixture },
      { DshHarnessAdapter },
      { DshProtocolClient },
      { productionAssistantController },
      { createAssistantRuntime },
      { createAssistantPricing },
      { assertAssistantAuthority },
      { riceToolDefinitions },
      { allRiceToolManifest, runtimeContractEqual },
      { runtimePolicyDigest },
      { LocalStorageAdapter },
      { getWorkbenchArtifact, readArtifactBytes },
    ] = await Promise.all([
      import('../../../packages/database/src/assistant-runtime.fixture.ts'),
      import('./p27-assistant-fixture.ts'),
      import('../../../apps/worker/src/harness/dsh-adapter.ts'),
      import('../../../apps/worker/src/harness/dsh-protocol-client.ts'),
      import('../../../apps/worker/src/harness/dsh/assistant-controller.ts'),
      import('../../../packages/database/src/assistant-runtime.ts'),
      import('../../../packages/database/src/assistant-pricing.ts'),
      import('../../../packages/database/src/assistant-authority.ts'),
      import('../../../apps/worker/src/tool-broker.ts'),
      import('../../../packages/contracts/src/index.ts'),
      import('../../../packages/database/src/runtime-policy.ts'),
      import('../../../packages/storage/src/index.ts'),
      import('../../../packages/database/src/artifact-review.ts'),
    ]);
    fixtureInitializationAttempted = true;
    try {
      database = await createAssistantFixtureDatabase();
    } catch (error) {
      if (error instanceof AssistantFixtureInitializationError) {
        fixtureCleanupProof = error.cleanup;
        report.schema = error.cleanup.schema;
        report.fixtureInitializationCleanup = error.cleanup;
      }
      throw Error('p27_fixture_initialization_failure');
    }
    closeFixture = async () => {
      try {
        fixtureCleanupProof = await database!.close();
      } catch (error) {
        fixtureCleanupProof =
          error instanceof AssistantFixtureCleanupError
            ? error.cleanup
            : undefined;
        throw error;
      }
    };
    const { db } = database;
    const [schema] = await db<
      { name: string }[]
    >`select current_schema() as name`;
    verify(/^p25_[a-f0-9]{32}$/.test(schema!.name), 'random_isolated_schema');
    report.schema = schema!.name;
    const fixture = await createP27AssistantFixture(db, args.providerRoute);
    if (fixture.priceBinding)
      report.pricing = {
        sourceFacts: P27_GEMINI_PRICE_FACTS,
        sourceFactsDigest: P27_GEMINI_PRICE_FACTS_DIGEST,
        fixtureOnly: true,
        target: fixture.priceBinding.target,
        snapshotDigest: runtimePolicyDigest(fixture.priceBinding.snapshot),
        bound: fixture.priceBinding.bound,
      };
    snapshotFailure = async () => {
      // Explicit scalar allowlist. Never select message/result payloads,
      // provider errors or lease tokens, including on failed execution.
      const [instances, budgets, usage, admissions, receipts] =
        await Promise.all([
          db`select run_id,parent_run_id,status,depth from allrice_assistant_instances where root_run_id=${fixture.rootRunId}`,
          db`select metric,unit,currency,capacity,reserved,spent from allrice_runtime_budgets where root_run_id=${fixture.rootRunId}`,
          db`select run_id,metric,count(*)::integer as reservations,
          count(*) filter(where settled_amount is null)::integer as unsettled,
          coalesce(sum(settled_amount),0)::text as settled_amount
          from allrice_assistant_usage where root_run_id=${fixture.rootRunId} group by run_id,metric`,
          db<
            P27DiagnosticAdmission[]
          >`select a.call_id,a.run_id,i.native_session_id,
          a.request_digest,a.dispatched_at is not null as dispatched,
          a.finished_at is not null as finished
          from allrice_assistant_model_admissions a
          join allrice_assistant_instances i on i.run_id=a.run_id and i.root_run_id=a.root_run_id
          where a.root_run_id=${fixture.rootRunId} order by a.prepared_at`,
          db<
            P27DiagnosticReceipt[]
          >`select call_id,run_id,request_digest,snapshot_digest,
          usage_complete,usage->>'inputTokens' is not null as input_usage_known,
          usage->>'outputTokens' is not null as output_usage_known,
          cache_usage_known,actual_cost_known,cost_picounits is not null as cost_known
          from allrice_assistant_cost_receipts where root_run_id=${fixture.rootRunId} order by call_id`,
        ]);
      report.failureSnapshot = {
        instances: [...instances],
        budgets: [...budgets],
        usage: [...usage],
        admissions: [...admissions],
        receipts: [...receipts],
        nativeDiagnostics: correlateP27AssistantDiagnostics({
          diagnostics: failureNativeDiagnostics,
          admissions,
          receipts,
          snapshotDigest: fixture.priceBinding
            ? runtimePolicyDigest(fixture.priceBinding.snapshot)
            : undefined,
        }),
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
      runtimeContractEqual(fixture.manifest.provider, provider),
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
      requestTimeoutMs: runLimits.timeoutMs,
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
      runLimits,
      priceSnapshot: fixture.priceBinding?.snapshot,
      serverPricingProviderSnapshot: fixture.priceBinding
        ? provider
        : undefined,
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
      }, runLimits.timeoutMs);
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
        providerSnapshot: provider,
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
      failureNativeDiagnostics = retainP27AssistantDiagnostics(
        failureNativeDiagnostics,
        result,
      );
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
    const pricing = fixture.priceBinding
      ? createAssistantPricing({ database: db })
      : undefined;
    const costSummary = await pricing?.summarize({
      scope: {
        organizationId: fixture.org,
        workspaceId: fixture.workspace,
        projectId: null,
      },
      rootRunId: fixture.rootRunId,
      worker: fixture.worker,
    });
    if (fixture.priceBinding && costSummary) {
      const [admissions, receipts] = await Promise.all([
        db<
          P27PricedAdmission[]
        >`select call_id,run_id,request_digest,dispatched_at,finished_at
          from allrice_assistant_model_admissions where root_run_id=${fixture.rootRunId}`,
        db<
          P27CostReceipt[]
        >`select call_id,run_id,snapshot_digest,request_digest,usage,usage_complete,
          cache_usage_known,cost_basis,actual_cost_known,cost_picounits
          from allrice_assistant_cost_receipts where root_run_id=${fixture.rootRunId}`,
      ]);
      report.pricedLedger = verifyP27PricingReceipts({
        snapshot: fixture.priceBinding.snapshot,
        snapshotDigest: runtimePolicyDigest(fixture.priceBinding.snapshot),
        admissions,
        receipts,
        modelCalls:
          tree.budgets.find((b) => b.metric === 'model_calls')?.spent ?? 0,
        settledUsage: {
          inputTokens:
            tree.budgets.find((b) => b.metric === 'input_tokens')?.spent ?? 0,
          outputTokens:
            tree.budgets.find((b) => b.metric === 'output_tokens')?.spent ?? 0,
        },
        summary: costSummary,
      });
      verify(true, 'priced_call_receipts_and_whole_tree_summary');
    }
    report.harnessOutcome = validateP27AssistantOutcome(
      result,
      tree.budgets,
      args.providerRoute,
      costSummary,
    );
    verify(true, 'adapter_authoritative_whole_tree_outcome');
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
      costStatus: costSummary
        ? 'conservative_tariff_upper_bound_not_provider_invoice'
        : 'not_measured_no_authoritative_price_binding',
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
    report.status = costSummary
      ? 'passed_priced_native_assistants_subset_only'
      : 'passed_unpriced_native_assistants_subset_only';
  } catch (error) {
    report.status = 'failed';
    // Only bounded, allowlisted scalar diagnostics; no raw error is persisted.
    const diagnostics = p27ErrorDiagnostics(error);
    // A dedicated closed-schema sidecar; never inspect arbitrary error fields.
    // It is emitted only after matching fixture-native identities below.
    failureNativeDiagnostics = retainP27AssistantDiagnostics(
      failureNativeDiagnostics,
      error,
    );
    report.failureDiagnostics = diagnostics;
    report.failureCode =
      diagnostics.errors[0]?.code ?? 'p27_external_or_runtime_failure';
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
    let temporaryRemoved = false;
    // Native JSONL persistence is needed for real durable adoption. It is
    // ephemeral, never copied into evidence, and removed only after host exit.
    if (nativeStopped) {
      try {
        await closeFixture?.();
      } catch {
        /* Only the helper's explicit proof can confirm cleanup. */
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
      ...fixtureCleanupFlags(
        fixtureInitializationAttempted,
        fixtureCleanupProof,
      ),
      temporaryRemoved,
      ownedNativeClients: clients?.snapshot().owned ?? 0,
      closedNativeClients: clients?.snapshot().closed ?? 0,
      executionSettled,
    };
    if (fixtureCleanupProof) report.fixtureCleanupProof = fixtureCleanupProof;
    const fixtureFlags = fixtureCleanupFlags(
      fixtureInitializationAttempted,
      fixtureCleanupProof,
    );
    if (
      !nativeStopped ||
      !fixtureFlags.schemaRemoved ||
      !fixtureFlags.fixtureStorageRemoved ||
      !fixtureFlags.fixtureConnectionsClosed ||
      !temporaryRemoved
    ) {
      report.status = 'cleanup_blocked';
      process.exitCode = 1;
      // Do not label a successfully removed directory as retained just because
      // a separate helper schema/storage/connection remains unconfirmed.
      if (!temporaryRemoved) report.retainedTemporary = temporary;
      if (!fixtureFlags.schemaRemoved)
        report.retainedSchema = report.schema ?? 'unconfirmed';
      if (!fixtureFlags.fixtureStorageRemoved) {
        report.fixtureStorageCleanupUnconfirmed = true;
        if (fixtureCleanupProof?.storageRoot)
          report.retainedFixtureStorage = fixtureCleanupProof.storageRoot;
      }
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
