import { withFixturePlatformAdministrator } from './fixture-platform-authority.ts';
/** One isolated ordinary Codex Worker task. Preparation never executes a model or reads credentials. */
import { createHash, randomUUID } from 'node:crypto';
import type {
  PromptImageAttachment,
  RequestContext,
} from '../../../packages/contracts/src/index.ts';
import type {
  RuntimeFixtureCleanupProof,
  createRuntimeFixtureDatabase,
} from '../../../packages/database/src/runtime.fixture.ts';
import { P27_CODEX_ORDINARY_LIMITS as ordinaryRunLimits } from './p27-codex-worker-preflight.ts';

const localFixtureDatabaseUrl = 'postgres://a123@127.0.0.1:5432/allrice_b2';
const ciFixtureDatabaseUrl =
  'postgres://allrice:allrice@127.0.0.1:54329/allrice';
let owned = false;

export interface P27CodexWorkerFixtureCleanup {
  globalDatabaseClosed: boolean;
  databaseEnvironmentRestored: boolean;
  fixture: RuntimeFixtureCleanupProof | null;
}

export class P27CodexWorkerFixtureError extends Error {
  constructor(
    readonly code: string,
    readonly cleanup?: P27CodexWorkerFixtureCleanup,
  ) {
    super(code);
  }
}

function requireFixture(ok: unknown, code: string): asserts ok {
  if (!ok) throw new P27CodexWorkerFixtureError(code);
}

/** Must precede dynamic import of employee-run/router in a fresh smoke process.
 * The caller owns native processes, heartbeat and execution. Close only AFTER
 * those are confirmed stopped; this helper owns both PG pools and its schema. */
export async function createP27CodexWorkerFixture(
  options: {
    throughMigration?: '0096_assistant_pricing.sql';
    /** Synthetic SQL tests only. Live model drivers retain the default local pin. */
    allowCiDatabase?: boolean;
    /** Synthetic Worker regression only; never used by live Codex smoke. */
    syntheticImages?: boolean;
    /** Isolated MET-163 image execution acceptance. */
    imageGeneration?: boolean;
    /** Synthetic current-schema instance/Worker wiring regression. */
    personalProfile?: 'writable' | 'read_only';
  } = {},
) {
  const requestedRunLimits = options.imageGeneration
    ? { ...ordinaryRunLimits, timeoutMs: 600_000 }
    : ordinaryRunLimits;
  requireFixture(
    options.throughMigration === undefined ||
      options.throughMigration === '0096_assistant_pricing.sql',
    'P27_CODEX_WORKER_MIGRATION_CHECKPOINT_INVALID',
  );
  requireFixture(!owned, 'P27_CODEX_WORKER_FIXTURE_ALREADY_OWNED');
  requireFixture(
    !options.personalProfile ||
      (options.allowCiDatabase === true && !options.throughMigration),
    'P27_PROFILE_REQUIRES_CURRENT_SYNTHETIC_FIXTURE',
  );
  requireFixture(
    !options.syntheticImages || options.allowCiDatabase === true,
    'P27_CODEX_WORKER_SYNTHETIC_IMAGES_ONLY',
  );
  requireFixture(
    !process.env.DATABASE_URL,
    'P27_CODEX_WORKER_AMBIENT_DATABASE',
  );
  const fixtureDatabaseUrl =
    options.allowCiDatabase === true &&
    process.env.ALLRICE_TEST_DATABASE_URL === ciFixtureDatabaseUrl
      ? ciFixtureDatabaseUrl
      : localFixtureDatabaseUrl;
  const expectedDatabase = new URL(fixtureDatabaseUrl).pathname.slice(1);
  requireFixture(
    process.env.ALLRICE_TEST_DATABASE_URL === fixtureDatabaseUrl,
    'P27_CODEX_WORKER_DATABASE_NOT_AUTHORIZED',
  );
  owned = true;
  let fixture:
    Awaited<ReturnType<typeof createRuntimeFixtureDatabase>> | undefined;
  let databaseUrl: string | undefined;
  let initializationAttempted = false;
  let initializationCleanup: RuntimeFixtureCleanupProof | null = null;
  let globalAttempted = false;
  let globalOwned = false;
  let globalClose: (() => Promise<void>) | undefined;
  let closePromise: Promise<P27CodexWorkerFixtureCleanup> | undefined;
  let closed = false;
  const close = () =>
    (closePromise ??= (async () => {
      closed = true;
      const proof: P27CodexWorkerFixtureCleanup = {
        globalDatabaseClosed: !globalAttempted,
        databaseEnvironmentRestored: false,
        fixture: initializationCleanup,
      };
      try {
        if (globalOwned) {
          await globalClose!();
          proof.globalDatabaseClosed = true;
        }
      } catch {
        // Do not drop a schema while the global pool might still use it.
      }
      if (proof.globalDatabaseClosed && fixture) {
        try {
          proof.fixture = await fixture.close();
        } catch (error) {
          const { RuntimeFixtureCleanupError } =
            await import('../../../packages/database/src/runtime.fixture.ts');
          if (error instanceof RuntimeFixtureCleanupError)
            proof.fixture = error.cleanup;
        }
      }
      if (databaseUrl && process.env.DATABASE_URL === databaseUrl) {
        delete process.env.DATABASE_URL;
        proof.databaseEnvironmentRestored = true;
      } else if (!databaseUrl && !process.env.DATABASE_URL) {
        proof.databaseEnvironmentRestored = true;
      }
      const disposed =
        proof.globalDatabaseClosed &&
        proof.databaseEnvironmentRestored &&
        (!initializationAttempted ||
          (proof.fixture?.schemaRemoved &&
            proof.fixture.storageRemoved &&
            proof.fixture.databaseClosed &&
            proof.fixture.adminClosed));
      if (!disposed)
        throw new P27CodexWorkerFixtureError(
          'P27_CODEX_WORKER_CLEANUP_UNCONFIRMED',
          proof,
        );
      owned = false;
      return proof;
    })());

  try {
    if (options.allowCiDatabase && !options.throughMigration) {
      // Only the explicit synthetic test path may supply a fake SQL approval.
      // Live model drivers and historical migration fixtures remain unchanged.
      const { approveSyntheticCurrentEmployeeExecution } =
        await import('../../../packages/database/src/current-execution.fixture.ts');
      approveSyntheticCurrentEmployeeExecution();
    }
    const { createRuntimeFixtureDatabase, RuntimeFixtureInitializationError } =
      await import('../../../packages/database/src/runtime.fixture.ts');
    initializationAttempted = true;
    try {
      fixture = await createRuntimeFixtureDatabase({
        throughMigration: options.throughMigration,
      });
    } catch (error) {
      if (error instanceof RuntimeFixtureInitializationError)
        initializationCleanup = error.cleanup;
      throw error;
    }
    const { db } = fixture;
    const [scope] = await db<{ schema: string; database: string }[]>`
      select current_schema() as schema, current_database() as database`;
    requireFixture(
      scope?.database === expectedDatabase &&
        /^p25_[a-f0-9]{32}$/.test(scope.schema),
      'P27_CODEX_WORKER_SCHEMA_INVALID',
    );
    const schema = scope.schema;
    const url = new URL(fixtureDatabaseUrl);
    url.searchParams.set(
      'options',
      `-csearch_path=${options.throughMigration ? schema : `${schema},public`}`,
    );
    databaseUrl = url.toString();
    process.env.DATABASE_URL = databaseUrl;
    const client =
      await import('../../../packages/database/src/core/client.ts');
    globalAttempted = true;
    const globalDb = client.getDatabase();
    const [globalScope] = await globalDb<
      { schema: string; database: string }[]
    >`
      select current_schema() as schema, current_database() as database`;
    requireFixture(
      globalScope?.schema === schema &&
        globalScope.database === expectedDatabase,
      'P27_CODEX_WORKER_GLOBAL_DATABASE_MISMATCH',
    );
    globalOwned = true;
    globalClose = client.closeDatabase;
    // Every migrated business relation must resolve into our own schema.
    const [relations] = await globalDb<{ safe: boolean }[]>`
      select bool_and(to_regclass(quote_ident(c.relname)) = c.oid) as safe
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname=${schema} and c.relname like 'allrice_%'
        and c.relkind in ('r','p')`;
    requireFixture(relations?.safe === true, 'P27_CODEX_WORKER_RELATION_SCOPE');
    const [employees, models, queue, config] = await Promise.all([
      import('../../../packages/database/src/employees/employeehub.ts'),
      import('../../../packages/database/src/providers/model-pool.ts'),
      import('../../../packages/database/src/execution/queue.ts'),
      import('../../../packages/database/src/employees/employee-config.ts'),
    ]);
    const organizationId = randomUUID(),
      workspaceId = randomUUID(),
      ownerId = randomUUID();
    const membershipId = randomUUID(),
      employeeId = randomUUID(),
      employeeVersionId = randomUUID();
    const assignmentId = randomUUID(),
      workerId = randomUUID();
    const { readPlatformModelSettings } =
      await import('../../../packages/database/src/providers/platform-model-settings.ts');
    // The pre-0117 migration fixture has no platform settings table. Current
    // Worker acceptance must consume the migrated settings without overriding them.
    let platformSettings = options.throughMigration
      ? undefined
      : await readPlatformModelSettings(db);
    const connectionId =
      platformSettings?.configuration.connectionId ?? randomUUID();
    const model = platformSettings?.configuration.workModel ?? 'gpt-5.6-luna';
    const reasoningEffort =
      platformSettings?.configuration.reasoningEffort ?? 'low';
    const runLimits = {
      ...requestedRunLimits,
      timeoutMs:
        platformSettings?.configuration.timeoutMs ??
        requestedRunLimits.timeoutMs,
    };
    const [catalog] = await db<{ id: string; provider_id: string }[]>`
      select m.id,m.provider_id from allrice_model_catalog_entries m
      join allrice_model_providers p on p.id=m.provider_id
      where p.provider_key='codex' and p.auth_mode='chatgpt_subscription'
        and m.model=${model}
        and (${!platformSettings} or m.provider_id=(select provider_id from allrice_model_connections where id=${connectionId}))`;
    requireFixture(catalog, 'P27_CODEX_WORKER_CATALOG_MISSING');
    const catalogId = catalog.id;
    const context: RequestContext = {
      actor: { type: 'user', id: ownerId },
      organizationId,
      workspaceId,
      requestId: randomUUID(),
      sessionId: randomUUID(),
      authenticatedAt: new Date().toISOString(),
      memberships: [
        {
          id: membershipId,
          userId: ownerId,
          organizationId,
          workspaceId,
          role: 'admin',
          active: true,
        },
      ],
    };
    const manifest = config.employeeManifest({
      key: 'p27-codex-worker',
      name: 'P27 isolated ordinary Codex Worker',
      description: 'Synthetic acceptance only',
      toolNames: options.imageGeneration
        ? [
            'workspace.file.list',
            'workspace.document.read',
            'workspace.export.create',
          ]
        : options.personalProfile === 'writable'
          ? ['workspace.export.create']
          : [],
      runtimePolicy: {
        harness: 'dsh',
        provider: 'openai-codex',
        model,
        reasoningEffort,
        timeoutMs: runLimits.timeoutMs,
        fallbackModels: [],
        credentialReference: 'deployment:codex-default',
        baseUrl: null,
      },
      securityPolicy: {
        dataScopes: ['workspace'],
        connectorIdentityModes: ['user'],
        approvalPolicy: 'confirm_side_effects',
        deniedCapabilities:
          options.imageGeneration ||
          options.personalProfile?.startsWith('writable')
            ? ['secret:use', 'automation:write', 'network:outbound']
            : [
                'secret:use',
                'storage:read',
                'storage:write',
                'automation:write',
                'network:outbound',
              ],
      },
    });
    const checksum = config.employeeManifestChecksum(manifest);
    await db.begin(async (tx) => {
      await tx`insert into allrice_users(id,email,display_name,password_hash) values(${ownerId},${`${ownerId}@example.test`},'P27 isolated','not-login')`;
      if (options.personalProfile)
        await tx`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${context.sessionId!},${ownerId},${createHash('sha256').update(randomUUID()).digest('hex')},clock_timestamp()+interval '1 hour')`;
      await tx`insert into allrice_organizations(id,slug,name) values(${organizationId},${`p27-codex-worker-${organizationId}`},'P27 isolated')`;
      await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'synthetic','P27 isolated')`;
      await tx`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${membershipId},${organizationId},${workspaceId},${ownerId},'admin')`;
      await tx`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employeeId},${organizationId},${workspaceId},'p27-codex-worker','P27 isolated')`;
      await tx`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot)
        values(${employeeVersionId},${organizationId},${workspaceId},${employeeId},1,'P27 isolated',${manifest.provider.model},${manifest.systemPrompt},${tx.json(manifest.capabilities)},${checksum},${tx.json(manifest)},${tx.json(manifest.provider)})`;
      await tx`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id,is_default)
        values(${assignmentId},${organizationId},${workspaceId},${employeeId},${employeeVersionId},${ownerId},false)`;
      if (options.throughMigration) {
        await tx`update allrice_model_providers set enabled=true where id=${catalog.provider_id}`;
        await tx`update allrice_model_catalog_entries set enabled=true,input_modalities='["text"]' where id=${catalogId}`;
        await tx`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,base_url,status)
        values(${connectionId},${catalog.provider_id},'platform','P27 isolated Codex','deployment:codex-default',null,'ready')`;
        await tx`insert into allrice_provider_release_controls(connection_id,release_stage,allowlisted_organization_ids,production_approved)
        values(${connectionId},'canary',${[organizationId]},false)`;
      }
      if (options.imageGeneration)
        await tx`update allrice_platform_model_settings set configuration=jsonb_set(configuration,'{imagesEnabled}','true'::jsonb) where singleton`;
      await tx`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls)
        values(${organizationId},${workspaceId},1,${tx.json({ version: 1, enabled: true, mode: 'execute', rules: [] })})`;
    });
    if (options.imageGeneration)
      platformSettings = await readPlatformModelSettings(db);
    await withFixturePlatformAdministrator(ownerId, () =>
      models.upsertEmployeeModelPolicy({
        context,
        workspaceId,
        employeeId,
        policy: {
          connectionId,
          modelCatalogEntryId: catalogId,
          reasoningEffort,
          fallbackPolicy: 'disabled',
          fallbackTargets: [],
          fallbackOn: [],
          runLimits,
        },
      }),
    );
    let preparing = false;
    let attempted = false;
    const personalInstance = options.personalProfile
      ? await (
          await import('../../../packages/database/src/employees/employee-instances.ts')
        ).createEmployeeInstance(context, {
          workspaceId,
          assignmentId,
          requestId: randomUUID(),
          profile: { name: '小白', expressionStyle: 'structured' },
        })
      : null;
    async function prepare(prompt: string, images?: PromptImageAttachment[]) {
      requireFixture(
        !closed && !preparing,
        'P27_CODEX_WORKER_FIXTURE_NOT_IDLE',
      );
      requireFixture(
        process.env.DATABASE_URL === databaseUrl,
        'P27_CODEX_WORKER_DATABASE_CHANGED',
      );
      requireFixture(
        typeof prompt === 'string' &&
          prompt.trim().length > 0 &&
          prompt.length <= 20000,
        'P27_CODEX_WORKER_PROMPT_INVALID',
      );
      preparing = true;
      try {
        const sessionId = randomUUID(),
          userMessageId = randomUUID(),
          assistantMessageId = randomUUID();
        await db.begin(async (tx) => {
          await tx`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id)
            values(${sessionId},${organizationId},${workspaceId},${ownerId},'P27 isolated',${assignmentId},${employeeVersionId})`;
          if (personalInstance)
            await tx`update allrice_chat_sessions set employee_instance_id=${personalInstance.id} where id=${sessionId}`;
          await tx`insert into allrice_messages(id,organization_id,workspace_id,session_id,owner_id,role,content)
            values(${userMessageId},${organizationId},${workspaceId},${sessionId},${ownerId},'user',${tx.json({ text: prompt, citations: [] })}),
              (${assistantMessageId},${organizationId},${workspaceId},${sessionId},${ownerId},'assistant','{"text":"","citations":[]}')`;
        });
        const binding = await employees.prepareEmployeeRunBinding({
          context,
          workspaceId,
          assignmentId,
          employeeVersionId,
          sessionId,
          userMessageId,
          assistantMessageId,
          promptSnapshot: {
            systemPrompt: manifest.systemPrompt,
            userRequest: prompt,
            conversation: [],
            memories: [],
            imageAttachments: images ?? [],
          },
        });
        requireFixture(
          binding.executionSnapshot.modelSnapshot?.connectionId ===
            connectionId &&
            binding.executionSnapshot.modelSnapshot.modelCatalogEntryId ===
              catalogId &&
            binding.executionSnapshot.modelSnapshot.model === model &&
            binding.executionSnapshot.modelSnapshot.reasoningEffort ===
              reasoningEffort &&
            binding.executionSnapshot.modelSnapshot.runLimits.timeoutMs ===
              runLimits.timeoutMs &&
            (!platformSettings ||
              binding.executionSnapshot.modelSnapshot.policyRevision ===
                platformSettings.revision),
          'P27_CODEX_WORKER_FROZEN_MODEL_MISMATCH',
        );
        // This one migration fixture intentionally seeds a pre-0103 Run. Keep
        // its historical policy; never rewrite a persisted production snapshot.
        if (options.throughMigration) {
          delete binding.executionSnapshot.taskRuntimePolicy;
          binding.executionSnapshot.runtimePolicy.timeoutMs =
            runLimits.timeoutMs;
        }
        const submission = await queue.enqueueRun(
          context,
          {
            workspaceId,
            idempotencyKey: randomUUID(),
            type: 'allrice.employee.run',
            maxAttempts: 1,
            timeoutMs: binding.executionSnapshot.runtimePolicy.timeoutMs,
            input: {
              employeeAssignmentId: assignmentId,
              employeeVersionId,
              sessionId,
              userMessageId,
              assistantMessageId,
            },
          },
          // The 0096 checkpoint represents an already-created historical Run,
          // not admission by today's binary into an incompletely migrated DB.
          // Keep the real generic queue/lease path and seed only its historical
          // employee row below; current-schema fixtures use real admission.
          options.throughMigration ? {} : { employeeBinding: binding },
        );
        if (options.throughMigration) {
          const [run] = await db<{ policy_snapshot_id: string }[]>`
            select policy_snapshot_id from allrice_runs
            where id=${submission.run.id} and organization_id=${organizationId}
              and workspace_id=${workspaceId} and owner_id=${ownerId}`;
          requireFixture(run, 'P27_HISTORICAL_RUN_MISSING');
          const snapshot = {
            ...binding.executionSnapshot,
            tenantContext: {
              organizationId,
              workspaceId,
              actorId: ownerId,
              policySnapshotId: run.policy_snapshot_id,
            },
            createdAt: new Date().toISOString(),
          };
          await db`
            insert into allrice_employee_runs (
              run_id, organization_id, workspace_id, owner_id,
              employee_assignment_id, employee_version_id, session_id,
              user_message_id, assistant_message_id, status, provider_snapshot,
              skill_bindings, native_skills, prompt_snapshot, execution_snapshot,
              created_at
            ) values (
              ${submission.run.id}, ${organizationId}, ${workspaceId}, ${ownerId},
              ${assignmentId}, ${employeeVersionId}, ${sessionId},
              ${userMessageId}, ${assistantMessageId}, 'queued',
              ${db.json(JSON.parse(JSON.stringify(binding.providerSnapshot)))},
              ${db.json(JSON.parse(JSON.stringify(binding.skillBindings)))},
              ${db.json(JSON.parse(JSON.stringify(binding.nativeSkills)))},
              ${db.json(JSON.parse(JSON.stringify(binding.promptSnapshot)))},
              ${db.json(JSON.parse(JSON.stringify(snapshot)))},
              ${snapshot.createdAt}
            )`;
        }
        const [pending] = await db<
          { count: number }[]
        >`select count(*)::int as count from allrice_jobs where status='queued'`;
        requireFixture(
          pending?.count === 1,
          'P27_CODEX_WORKER_UNEXPECTED_QUEUE',
        );
        const leaseMs = 30000;
        const [expectedJob] = await db<{ id: string }[]>`
          select id from allrice_jobs where run_id=${submission.run.id}`;
        const job = await queue.claimNextJob(workerId, leaseMs);
        requireFixture(
          job && expectedJob && job.id === expectedJob.id && job.lease?.token,
          'P27_CODEX_WORKER_CLAIM_MISMATCH',
        );
        const workflowLease = {
          workerId,
          jobId: job.id,
          leaseToken: job.lease.token,
          leaseMs,
        };
        const execution = await queue.startClaimedJob(
          workerId,
          job.id,
          job.lease.token,
        );
        requireFixture(
          execution && execution.context.runId === submission.run.id,
          'P27_CODEX_WORKER_START_MISMATCH',
        );
        return {
          runId: submission.run.id,
          sessionId,
          userMessageId,
          assistantMessageId,
          binding,
          execution,
          workflowLease,
        };
      } finally {
        preparing = false;
      }
    }
    return {
      db,
      schema,
      databaseUrl,
      context,
      organizationId,
      workspaceId,
      ownerId,
      employeeId,
      employeeVersionId,
      assignmentId,
      connectionId,
      catalogId,
      platformSettings,
      runLimits,
      async prepareOrdinaryTask(
        prompt: string,
        syntheticImages?: PromptImageAttachment[],
      ) {
        // Capture attachments BEFORE the production snapshot is frozen. The
        // live ordinary smoke retains its no-assistant behavior; only opted-in
        // synthetic integration tests may exercise this image/assistant path.
        requireFixture(
          syntheticImages === undefined || options.syntheticImages === true,
          'P27_CODEX_WORKER_SYNTHETIC_IMAGES_ONLY',
        );
        requireFixture(!attempted, 'P27_CODEX_WORKER_ALREADY_ATTEMPTED');
        attempted = true;
        return prepare(prompt, syntheticImages);
      },
      close,
    };
  } catch (error) {
    const cleanup = await close();
    throw new P27CodexWorkerFixtureError(
      error instanceof P27CodexWorkerFixtureError
        ? error.code
        : 'P27_CODEX_WORKER_INITIALIZATION_FAILED',
      cleanup,
    );
  }
}

export type P27CodexWorkerFixture = Awaited<
  ReturnType<typeof createP27CodexWorkerFixture>
>;
export type P27PreparedCodexWorkerTask = Awaited<
  ReturnType<P27CodexWorkerFixture['prepareOrdinaryTask']>
>;
