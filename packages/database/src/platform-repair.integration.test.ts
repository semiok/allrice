/** Real isolated PostgreSQL/Employee Run authority. Physical and paid-model checks are separate. */
import { randomUUID, createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EmployeeKernelRequestSchema,
  EmployeePromptSnapshotSchema,
  PlatformEmployeeDefinitionSchema,
  type RequestContext,
  cloudPlatform,
} from '@allrice/contracts';
import * as client from './core/client.ts';
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { ensureBootstrapPortalPrincipal } from './identity.ts';
import {
  savePlatformEmployeeDraft,
  publishPlatformEmployee,
} from './employees/platform-employees.ts';
import {
  createPlatformRepairTask,
  getPlatformRepairTask,
  cancelPlatformRepairTask,
  findPlatformRepairTask,
  listPlatformRepairTasks,
  readPlatformRepairSource,
  applyPlatformRepairCandidate,
  platformRepairInstructions,
} from './platform-repair.ts';
import { resolveEmployeeExecution } from './employees/employeehub.ts';
import { readEmployeeChatSourceKind } from './employees/employee-chat-authority.ts';
import * as modelPool from './providers/model-pool.ts';
import * as harnessRouter from '../../../apps/worker/src/harness/router.js';
import { DshHarnessAdapter } from '../../../apps/worker/src/harness/dsh-adapter.js';
import {
  measureDshNativeArtifact,
  installDshNativeArtifact,
  nativeArtifactPath,
} from '../../../apps/worker/src/harness/dsh-native-artifact.js';
import { p24Fixture } from '../../../apps/worker/test/p24/fixture.js';
import { executeEmployeeRun } from '../../../apps/worker/src/jobs/employee-run.js';
import type * as RepairWorker from '../../../apps/worker/src/jobs/platform-repair.js';
import { prepareExecutionIsolation } from '../../../apps/worker/src/isolation.js';
import { getPlatformRepairExecution } from './platform-repair-authority.ts';
import {
  claimNextJob,
  startClaimedJob,
  completeJob,
  failJob,
} from './execution/queue.ts';
import {
  repositoryDigest,
  repositoryMaterialDigest,
  repositoryDependencyDigest,
  validateRepositoryArchive,
} from './platform-repository-source.ts';
import {
  RepositoryBaselineSchema,
  repairProfileId,
  repairProductPath,
  type RepositoryBaseline,
  RepairReportSchema,
} from './platform-repair-contracts.ts';
import { compiledDependencyFixture } from './platform-repair-compiled.fixture.ts';
import {
  repairAssertionCases,
  repairHarnessChecksum,
} from './platform-repair-profile.ts';
import {
  preparePlatformRepairVerification,
  resolvePlatformRepositoryExecutionProofTx,
} from './platform-repair-verification.ts';
// Keep the real task, source, queue, lease and Worker. Only the physical repair
// backend is replaced; this input test must not launch cloud verification.
vi.mock(
  '../../../apps/worker/src/jobs/platform-repair.js',
  async (original) => ({
    ...(await original<typeof RepairWorker>()),
    createPlatformRepairController: vi.fn(async () => ({
      onToolCall: async () => {
        throw Error('INPUT_TEST_NO_REPAIR_TOOL');
      },
      finish: async () => {
        throw Error('INPUT_TEST_NO_REPAIR_FINISH');
      },
    })),
  }),
);
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET167 private repository repair normal Employee Run authority', () => {
  let fixture: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>,
    company: Awaited<ReturnType<typeof createExperienceFixture>>,
    admin: RequestContext,
    adminEmail: string,
    catalogRoot: string,
    baseline: RepositoryBaseline;
  let model: Awaited<ReturnType<typeof p24Fixture>>;
  let manifestPath: string, previousManifest: Buffer | undefined;
  const testHarnessExecArgv = process.execArgv;
  beforeAll(async () => {
    const repository = await realpath(resolve(import.meta.dirname, '../../..'));
    const artifact = await measureDshNativeArtifact(repository, undefined, {
      schemaVersion: 2,
    });
    manifestPath = join(repository, nativeArtifactPath);
    previousManifest = await readFile(manifestPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      },
    );
    await mkdir(join(repository, '.local'), { recursive: true });
    await writeFile(manifestPath, JSON.stringify(artifact));
    process.execArgv = [];
    vi.stubEnv('NODE_OPTIONS', '');
    await installDshNativeArtifact({
      root: repository,
      expectedId: artifact.artifactId,
    });
    vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact.artifactId);
    vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact.artifactId);
    fixture = await createRuntimeFixtureDatabase();
    vi.stubEnv('ALLRICE_STORAGE_ROOT', fixture.storageRoot);
    vi.stubEnv(
      'ALLRICE_DSH_PLATFORM_HOME',
      join(fixture.storageRoot, 'synthetic-platform-home'),
    );
    model = await p24Fixture(async () => ({
      text: '仅核对冻结人设，不调用修复工具。',
    }));
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    company = await createExperienceFixture(fixture.db);
    const account = await ensureBootstrapPortalPrincipal({
      organizationSlug: 'allrice-platform',
      organizationName: 'Internal',
      workspaceSlug: 'control-plane',
      workspaceName: 'Internal',
      email: 'quality-admin@example.test',
      displayName: 'Quality admin',
      role: 'member',
    });
    await fixture.db`delete from allrice_memberships where user_id=${account.user.id}`;
    admin = {
      ...company.owner,
      actor: { type: 'user', id: account.user.id },
      workspaceId: null,
      memberships: [],
    };
    adminEmail = account.user.email;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
    vi.stubEnv('ALLRICE_ENV', 'development');
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
    for (const f of [
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'LOCAL_COMMAND',
      'CLOUD_RUNNER',
      'BROWSER_CONTROL',
      'WORKBENCH',
    ])
      vi.stubEnv(`ALLRICE_${f}_ENABLED`, '1');
    await fixture.db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
    await fixture.db`update allrice_model_providers set enabled=true where provider_key='codex'`;
    // Publish a new revision and preserve the original seed.
    const [r] =
      await fixture.db`select r.* from allrice_platform_employee_revisions r join allrice_platform_employees e on e.current_published_revision_id=r.id where e.employee_key='rice'`;
    const definition = PlatformEmployeeDefinitionSchema.parse({
      ...r!.definition,
      identity: {
        ...r!.definition.identity,
        mission: 'FIXED_PERSONA_LITERAL {{missing}}',
      },
      capabilities: {
        ...r!.definition.capabilities,
        nativeSkillIds: [],
        toolNames: [
          'workspace.project',
          'browser.workspace',
          'cloud.process.execute',
        ],
      },
    });
    await savePlatformEmployeeDraft(r!.employee_id, { definition });
    const publication = await publishPlatformEmployee(r!.employee_id, {
      scope: 'assigned',
    });
    expect(publication.errors).toEqual([]);
    expect(publication.valid).toBe(true);
    await fixture.db`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${admin.sessionId!},${admin.actor.id},${createHash('sha256').update(randomUUID()).digest('hex')},clock_timestamp()+interval '1 hour')`;
    catalogRoot = realpathSync(
      mkdtempSync(join(tmpdir(), 'allrice-repair-db-')),
    );
    vi.stubEnv('ALLRICE_REPOSITORY_BASELINE_DIR', catalogRoot);
    const product = readFileSync(
      new URL('../../project-runtime/src/command-output.ts', import.meta.url),
      'utf8',
    );
    const files = [
      ['pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
      ['pnpm-workspace.yaml', "packages: ['packages/*']\n"],
      ['package.json', '{}\n'],
      [repairProductPath, product],
    ].map(([path, text]) => ({
      path: path!,
      mode: '100644' as const,
      sizeBytes: Buffer.byteLength(text!),
      checksum: repositoryDigest(text!),
      contentBase64: Buffer.from(text!).toString('base64'),
    }));
    const archive = validateRepositoryArchive({ version: 1, files }),
      bytes = gzipSync(Buffer.from(JSON.stringify(archive)));
    baseline = RepositoryBaselineSchema.parse({
      version: 1,
      id: randomUUID(),
      repositoryId: 'semiok/allrice',
      sourceSha: 'a'.repeat(40),
      gitTree: 'b'.repeat(40),
      sourceDigest: repositoryMaterialDigest(archive.files),
      rootLockChecksum: files[0]!.checksum,
      dependencyConfigurationDigest: repositoryDependencyDigest(archive.files),
      archiveChecksum: repositoryDigest(bytes),
      archiveBytes: bytes.length,
      fileCount: files.length,
      sourceBytes: files.reduce((n, f) => n + f.sizeBytes, 0),
      observedDevSha: 'a'.repeat(40),
      registeredAt: new Date().toISOString(),
      materializer: 'git-tracked-json-gzip-v1',
      profileId: repairProfileId,
      dependencyMode: 'runtime_builtins_only',
      monorepoDependenciesInstalled: false,
    });
    mkdirSync(join(catalogRoot, baseline.id));
    writeFileSync(
      join(catalogRoot, baseline.id, 'baseline.json'),
      JSON.stringify(baseline),
    );
    writeFileSync(join(catalogRoot, baseline.id, 'source.json.gz'), bytes);
  }, 120000);

  afterAll(async () => {
    try {
      await model?.close();
      await fixture?.close();
    } finally {
      if (manifestPath) {
        if (previousManifest) await writeFile(manifestPath, previousManifest);
        else await rm(manifestPath, { force: true });
      }
      process.execArgv = testHarnessExecArgv;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (catalogRoot) rmSync(catalogRoot, { recursive: true, force: true });
    }
  });
  const submit = (requestId = randomUUID()) =>
    createPlatformRepairTask(admin, { requestId, baselineId: baseline.id });
  function enableCompiledTransportFixture() {
    const dep = compiledDependencyFixture();
    const descriptor = {
      ...dep.descriptor,
      rootLockChecksum: baseline.rootLockChecksum,
      dependencyConfigurationDigest: baseline.dependencyConfigurationDigest,
    };
    const bytes = gzipSync(
      Buffer.from(
        JSON.stringify({
          ...dep.bundle,
          rootLockChecksum: baseline.rootLockChecksum,
          dependencyConfigurationDigest: baseline.dependencyConfigurationDigest,
        }),
      ),
    );
    descriptor.bundleBytes = bytes.length;
    descriptor.bundleChecksum = repositoryDigest(bytes);
    baseline = RepositoryBaselineSchema.parse({
      ...baseline,
      compiledDependencies: descriptor,
    });
    writeFileSync(
      join(catalogRoot, baseline.id, 'baseline.json'),
      JSON.stringify(baseline),
    );
    writeFileSync(
      join(catalogRoot, baseline.id, 'dependencies.json.gz'),
      bytes,
    );
  }
  async function acceptedHistoryFixture(revision = 1) {
    // Synthetic durable history for authority tests only. This does not claim
    // a physical build. The separately gated native chain uses real Dev history.
    const q = await submit(),
      lease = await start(q);
    const original = (await readPlatformRepairSource(lease)).file.text;
    const begin = original.lastIndexOf('      .replace('),
      end = original.indexOf('      );', begin) + '      );'.length;
    const slot = String.raw`      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'}]+)/gi,
        '$1[REDACTED]',
      );`;
    let candidate = q.candidate;
    for (let i = 0; i < revision; i++) {
      const before = (await readPlatformRepairSource(lease)).file.text;
      const after =
        original.slice(0, begin) +
        slot.replace('$1[REDACTED]', '$1' + ' '.repeat(i) + '[REDACTED]') +
        original.slice(end);
      candidate = await applyPlatformRepairCandidate(lease, `fixture-${i}`, {
        action: 'apply',
        expectedCandidate: candidate.checksum,
        proposal: { files: [{ path: repairProductPath, before, after }] },
      });
    }
    const proof = (after: boolean) => ({
      version: 1,
      profileId: repairProfileId,
      dependencyMode: 'runtime_builtins_only',
      baselineId: baseline.id,
      sourceSha: baseline.sourceSha,
      baselineSourceDigest: baseline.sourceDigest,
      restoredDigest: baseline.sourceDigest,
      candidateChecksum: after ? candidate.checksum : q.candidate.checksum,
      candidateMaterialDigest: baseline.sourceDigest,
      actualMaterialDigest: baseline.sourceDigest,
      rootLockChecksum: baseline.rootLockChecksum,
      dependencyConfigurationDigest: baseline.dependencyConfigurationDigest,
      harnessChecksum: repairHarnessChecksum,
      monorepoDependenciesInstalled: false,
      nodeVersion: 'v22.23.2',
      sourceFileCount: baseline.fileCount,
      sourceBytes: baseline.sourceBytes,
      candidateIdentity: { uid: 1001, gid: 1001, capabilities: 'none' },
      assertions: repairAssertionCases.map((c, i) => ({
        id: c.id,
        passed: after || i > 0,
      })),
      failureKind: after ? null : 'assertion_failed',
      exitCode: after ? 0 : 1,
    });
    const at = new Date().toISOString(),
      report = RepairReportSchema.parse({
        version: 1,
        candidateChecksum: candidate.checksum,
        before: {
          completedAt: at,
          revision: 0,
          operationId: randomUUID(),
          report: proof(false),
          stopped: true,
          cleanup: 'confirmed',
        },
        after: {
          completedAt: at,
          revision,
          operationId: randomUUID(),
          report: proof(true),
          stopped: true,
          cleanup: 'confirmed',
        },
        artifacts: ['candidate', 'report'].map((kind) => ({
          artifactId: randomUUID(),
          versionId: randomUUID(),
          objectId: randomUUID(),
          checksum: repositoryDigest(kind),
          fileName: kind + '.json',
          sizeBytes: 100,
          kind,
        })),
        completedAt: at,
        verdict: 'fixed_assertions_passed',
        publishedToMain: false,
        wholeRepositoryBuildVerified: false,
      });
    await fixture.db`update allrice_platform_repair_tasks set report=${fixture.db.json(report)} where id=${q.id}`;
    await fixture.db`update allrice_jobs set status='succeeded' where id=${q.jobId}`;
    return getPlatformRepairTask(admin, q.id);
  }
  async function start(q: Awaited<ReturnType<typeof submit>>) {
    const workerId = randomUUID(),
      job = await claimNextJob(workerId, 60000);
    expect(job?.id).toBe(q.jobId);
    const lease = {
      workerId,
      jobId: job!.id,
      leaseToken: job!.lease!.token,
      attempt: job!.attempt,
    };
    await startClaimedJob(workerId, job!.id, lease.leaseToken);
    return lease;
  }
  async function assertFrozenCommandRecovery(
    prepared: Awaited<ReturnType<typeof preparePlatformRepairVerification>>,
    lease: Parameters<typeof preparePlatformRepairVerification>[0],
    context: Parameters<typeof preparePlatformRepairVerification>[1],
  ) {
    const [prior] =
      await fixture.db`select * from allrice_platform_repair_verifications where operation_id=${prepared.operationId}`;
    expect(prior!.proof.tmpfsMiB).toBe(128);
    const script = prepared.arguments.script.replace(
      '"totalBytes":64000000,"archiveBytes":12000000,"jsonBytes":96000000',
      '"totalBytes":40000000,"archiveBytes":12000000,"jsonBytes":60000000',
    );
    expect(script).not.toBe(prepared.arguments.script);
    const command = {
      ...prepared.command,
      arguments: { ...prepared.arguments, script },
    };
    const proof = {
      ...prior!.proof,
      commandDigest: repositoryDigest(JSON.stringify(command)),
      tmpfsMiB: prior!.proof.version === 1 ? 64 : 128,
    };
    const scope = {
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      ownerId: context.policySnapshot.subjectId,
      runId: context.runId,
      jobId: context.jobId,
      workerId: lease.workerId,
      leaseToken: lease.leaseToken,
      operationId: prepared.operationId,
    };
    try {
      await fixture.db`update allrice_platform_repair_verifications set command=${fixture.db.json(command)},command_digest=${proof.commandDigest},proof=${fixture.db.json(proof)} where operation_id=${prepared.operationId}`;
      const recovered = await preparePlatformRepairVerification(
        lease,
        context,
        proof.candidateChecksum,
      );
      expect(recovered.command).toEqual(command);
      expect(
        await fixture.db.begin((tx) =>
          resolvePlatformRepositoryExecutionProofTx(tx, scope, command),
        ),
      ).toEqual(proof);
      const [unchanged] =
        await fixture.db`select command,command_digest,proof from allrice_platform_repair_verifications where operation_id=${prepared.operationId}`;
      expect(unchanged).toEqual({
        command,
        command_digest: proof.commandDigest,
        proof,
      });
      const forged = {
        ...command,
        arguments: {
          ...command.arguments,
          script: command.arguments.script + '\n// not the frozen harness',
        },
      };
      const forgedDigest = repositoryDigest(JSON.stringify(forged));
      await fixture.db`update allrice_platform_repair_verifications set command=${fixture.db.json(forged)},command_digest=${forgedDigest},proof=${fixture.db.json({ ...proof, commandDigest: forgedDigest })} where operation_id=${prepared.operationId}`;
      await expect(
        fixture.db.begin((tx) =>
          resolvePlatformRepositoryExecutionProofTx(tx, scope, forged),
        ),
      ).rejects.toThrow('authorization_denied');
      await expect(
        preparePlatformRepairVerification(
          lease,
          context,
          proof.candidateChecksum,
        ),
      ).rejects.toThrow('conflict');
    } finally {
      await fixture.db`update allrice_platform_repair_verifications set command=${fixture.db.json(prior!.command)},command_digest=${prior!.command_digest},proof=${fixture.db.json(prior!.proof)} where operation_id=${prepared.operationId}`;
    }
  }
  it('retains the exact original source-only command and 64 MiB proof during prepare and recovery without accepting changed frozen bytes', async () => {
    const q = await submit();
    const workerId = randomUUID(),
      job = await claimNextJob(workerId, 60000);
    expect(job?.id).toBe(q.jobId);
    const lease = {
      workerId,
      jobId: job!.id,
      leaseToken: job!.lease!.token,
      attempt: job!.attempt,
    };
    const execution = await startClaimedJob(
      workerId,
      job!.id,
      lease.leaseToken,
    );
    const task = await getPlatformRepairExecution(lease);
    const { acquireConversationRuntime } =
      await import('./conversation/conversation-runtime.ts');
    await acquireConversationRuntime({
      organizationId: task.organization_id,
      workspaceId: task.workspace_id,
      sessionId: task.session_id,
      ownerId: task.owner_id,
      runId: task.run_id,
      workerId,
      configChecksum: task.frozen.fingerprint,
      compactThresholdTokens: 40000,
    });
    const { preparePlatformRepairInput } = await import('./platform-repair.ts');
    const { runtimeFixtureStorage } = await import('./runtime.fixture.ts');
    await preparePlatformRepairInput(
      lease,
      execution!.context,
      runtimeFixtureStorage(fixture.db),
    );
    const prepared = await preparePlatformRepairVerification(
      lease,
      execution!.context,
      q.candidate.checksum,
    );
    await assertFrozenCommandRecovery(prepared, lease, execution!.context);
    await cancelPlatformRepairTask(admin, q.id);
  });
  it('fresh fixed repair freezes real source through Worker and native Host to the HTTP provider', async () => {
    const originalFreeze = modelPool.freezeSessionModelSnapshot;
    const freeze = vi
      .spyOn(modelPool, 'freezeSessionModelSnapshot')
      .mockImplementation(async (...args) => ({
        ...(await originalFreeze(...args)),
        provider: 'openai-compatible',
        authMode: 'api_key',
        model: 'p24-synthetic',
        reasoningEffort: 'low',
        credentialReference: 'test:synthetic',
        baseUrl: model.baseUrl,
      }));
    const task = await submit().finally(() => freeze.mockRestore());
    const [stored] =
      await fixture.db`select * from allrice_employee_runs where run_id=${task.runId}`;
    const prompt = EmployeePromptSnapshotSchema.parse(stored!.prompt_snapshot);
    const scope = {
      runId: task.runId,
      organizationId: stored!.organization_id as string,
      workspaceId: stored!.workspace_id as string,
      ownerId: stored!.owner_id as string,
    };
    const resolved = await resolveEmployeeExecution(scope);
    expect(resolved.executionSnapshot?.schemaVersion).toBe(2);
    expect(resolved.executionSnapshot).toHaveProperty(
      'persona.source.kind',
      'employee_run',
    );
    expect(prompt.employeeDocuments).toEqual({
      persona: expect.any(String),
      user: '',
      memory: '',
    });
    expect(prompt.memories).toEqual([]);
    const workerId = randomUUID(),
      job = await claimNextJob(workerId, 60000);
    expect(job?.id).toBe(task.jobId);
    const lease = {
      workerId,
      jobId: job!.id,
      leaseToken: job!.lease!.token,
      leaseMs: 60000,
    };
    const execution = await startClaimedJob(
      workerId,
      job!.id,
      lease.leaseToken,
    );
    expect(
      await readEmployeeChatSourceKind({
        context: execution!.context,
        userMessageId: stored!.user_message_id as string,
      }),
    ).toBe('internal');
    const isolation = await prepareExecutionIsolation({
      root: fixture.storageRoot,
      ...scope,
      jobId: job!.id,
      attempt: job!.attempt,
    });
    const adapter = new DshHarnessAdapter({
      runtimeRoot: join(fixture.storageRoot, 'fixed-repair-native'),
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-only' }),
      },
      requestTimeoutMs: 15000,
    });
    const router = vi
      .spyOn(harnessRouter, 'getHarnessRouter')
      .mockReturnValue(new harnessRouter.HarnessRouter([adapter]));
    const actualExecute = adapter.execute.bind(adapter);
    const execute = vi
      .spyOn(adapter, 'execute')
      .mockImplementation(async (input) => {
        const kernel = EmployeeKernelRequestSchema.parse(input.kernel);
        expect(kernel.employeeDocuments).toEqual(prompt.employeeDocuments);
        expect(kernel.rootSystemInstructions).toBe(kernel.systemInstructions);
        expect(input.tools.map((tool) => tool.name)).toEqual([
          'platform.repository.repair',
        ]);
        expect(input.nativeSkills).toEqual([]);
        expect(input.nativeSubagents).toBeUndefined();
        expect(input.nativeRunAuthority).toBeUndefined();
        return actualExecute(input);
      });
    try {
      await expect(
        executeEmployeeRun({
          execution: execution!,
          isolation,
          workflowLease: lease,
          signal: new AbortController().signal,
          onHarnessEvent: async () => {},
        }),
      ).rejects.toThrow('INPUT_TEST_NO_REPAIR_FINISH');
      expect(execute).toHaveBeenCalledOnce();
      expect(model.requests).toHaveLength(1);
      const request = model.requests[0]!;
      const content = (role: string) =>
        request.messages
          .filter((m) => m.role === role)
          .map((m) =>
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((p) => p.text ?? '').join('\n')
                : '',
          )
          .join('\n');
      expect(content('user')).toContain(prompt.employeeDocuments!.persona!);
      expect(content('user')).toContain('FIXED_PERSONA_LITERAL {{missing}}');
      expect(content('system')).toContain(platformRepairInstructions);
      expect(content('system')).toContain(prompt.systemPrompt);
      expect(content('system')).not.toContain('FIXED_PERSONA_LITERAL');
      // The restricted profile retains these native DSH control tools.
      expect(request.tools?.map((tool) => tool.function.name)).toEqual([
        'ask_user_question',
        'platform_repository_repair',
        'skill',
        'todo_write',
      ]);
      expect(
        request.messages.some(
          (m) => m.role === 'assistant' || m.role === 'tool',
        ),
      ).toBe(false);
    } finally {
      execute.mockRestore();
      router.mockRestore();
      await adapter.close();
      await isolation.cleanup();
      await cancelPlatformRepairTask(admin, task.id);
      await failJob({
        ...lease,
        code: 'INPUT_FIXTURE_COMPLETE',
        message: 'Synthetic HTTP input observed; no physical repair executed',
        retryable: false,
      });
    }
  }, 60000);
  it('maintenance repair stays outside final-delivery eligibility with the Workbench enabled', async () => {
    const previous = process.env.ALLRICE_WORKBENCH_ENABLED;
    vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
    try {
      const task = await submit();
      const [run] =
        await fixture.db`select execution_snapshot from allrice_employee_runs where run_id=${task.runId}`;
      expect(run).toBeDefined();
      expect(run!.execution_snapshot).not.toHaveProperty('finalDeliveryPolicy');
      expect(run!.execution_snapshot).not.toHaveProperty(
        'officeFirstDeliveryPolicy',
      );
      await cancelPlatformRepairTask(admin, task.id);
    } finally {
      vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', previous);
    }
  });
  it('concurrent identical requests bind one actual private employee Run and retain frozen actual version, source, login and 30-minute budget', async () => {
    const before =
      await fixture.db`select * from allrice_memberships where organization_id=${company.org}`;
    const requestId = randomUUID(),
      [a, b] = await Promise.all([submit(requestId), submit(requestId)]);
    expect(a.runId).toBe(b.runId);
    expect(a.candidate.revision).toBe(0);
    expect(a.accepted).toBe(false);
    const [e] =
      await fixture.db`select e.*,j.max_attempts,o.slug from allrice_employee_runs e join allrice_jobs j on j.run_id=e.run_id join allrice_organizations o on o.id=e.organization_id where e.run_id=${a.runId}`;
    expect(e!.slug).toBe('allrice-platform');
    expect(e!.owner_id).toBe(admin.actor.id);
    expect(e!.employee_version_id).toBe(a.employeeVersionId);
    expect(e!.max_attempts).toBe(1);
    expect(e!.execution_snapshot.taskRuntimePolicy.timeoutMs).toBe(1800000);
    expect(
      await fixture.db`select * from allrice_memberships where organization_id=${company.org}`,
    ).toEqual(before);
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'c'.repeat(40));
    expect((await submit(requestId)).releaseSha).toBe('a'.repeat(40));
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
    await expect(
      createPlatformRepairTask(admin, { requestId, baselineId: randomUUID() }),
    ).rejects.toThrow('conflict');
    expect((await findPlatformRepairTask(admin, requestId))?.runId).toBe(
      a.runId,
    );
    expect(await findPlatformRepairTask(admin, randomUUID())).toBeNull();
    await cancelPlatformRepairTask(admin, a.id);
  });
  it('denies ordinary accounts and scopes read, cancellation and request reconciliation to the originating platform administrator', async () => {
    const q = await submit();
    for (const action of [
      () => getPlatformRepairTask(company.owner, q.id),
      () => cancelPlatformRepairTask(company.owner, q.id),
      () =>
        createPlatformRepairTask(company.owner, {
          requestId: randomUUID(),
          baselineId: baseline.id,
        }),
    ])
      await expect(action()).rejects.toThrow('authorization_denied');
    const [other] =
      await fixture.db`select email from allrice_users where id=${company.neighbor.actor.id}`;
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      adminEmail + ',' + other!.email,
    );
    await expect(getPlatformRepairTask(company.neighbor, q.id)).rejects.toThrow(
      'not_found',
    );
    await expect(
      cancelPlatformRepairTask(company.neighbor, q.id),
    ).rejects.toThrow('not_found');
    expect(
      await findPlatformRepairTask(company.neighbor, q.requestId),
    ).toBeNull();
    expect(await listPlatformRepairTasks(company.neighbor)).toEqual([]);
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
    await cancelPlatformRepairTask(admin, q.id);
  });
  it('uses the current originating lease and denies the missing-proof completion and revoked login', async () => {
    const q = await submit(),
      lease = await start(q),
      e = await getPlatformRepairExecution(lease);
    expect(e.frozen.version).toBe(1);
    if (e.frozen.version !== 1) throw Error('legacy_fixture_expected');
    expect(e.frozen.loginSessionId).toBe(admin.sessionId);
    expect(e.frozen.baselineId).toBe(baseline.id);
    await expect(
      getPlatformRepairExecution({ ...lease, leaseToken: randomUUID() }),
    ).rejects.toThrow('authorization_denied');
    await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${admin.sessionId!}`;
    await expect(readPlatformRepairSource(lease)).rejects.toThrow(
      'authorization_denied',
    );
    await fixture.db`update allrice_sessions set revoked_at=null where id=${admin.sessionId!}`;
    await cancelPlatformRepairTask(admin, q.id);
    await expect(getPlatformRepairExecution(lease)).rejects.toThrow(
      'authorization_denied',
    );
    const missing = await submit(),
      missingLease = await start(missing);
    const privateTask = await getPlatformRepairExecution(missingLease);
    const { acquireConversationRuntime } =
      await import('./conversation-runtime.ts');
    await acquireConversationRuntime({
      organizationId: privateTask.organization_id,
      workspaceId: privateTask.workspace_id,
      ownerId: admin.actor.id,
      sessionId: missing.sessionId,
      runId: missing.runId,
      workerId: missingLease.workerId,
      configChecksum: repositoryDigest('deterministic-no-model'),
      compactThresholdTokens: 50000,
    });
    await completeJob({ ...missingLease, result: { answer: 'pretend' } });
    const [released] =
      await fixture.db`select state,active_run_id,worker_id from allrice_conversation_runtimes where session_id=${missing.sessionId}`;
    expect(released?.state).toBe('error');
    expect(released?.active_run_id).toBeNull();
    expect(released?.worker_id).toBeNull();
    const denied = await getPlatformRepairTask(admin, missing.id);
    expect(denied.accepted).toBe(false);
    expect(denied.status).toBe('failed');
    expect(denied.errorCode).toBe('QUALITY_EVIDENCE_REQUIRED');
  });
  it('rejects top-level or callback proposals, preserves exact before/CAS, and recovers the same committed call without another candidate', async () => {
    const q = await submit(),
      lease = await start(q),
      source = await readPlatformRepairSource(lease),
      text = source.file.text;
    const request = (after: string, expected = q.candidate.checksum) => ({
      action: 'apply',
      expectedCandidate: expected,
      proposal: { files: [{ path: repairProductPath, before: text, after }] },
    });
    await expect(
      applyPlatformRepairCandidate(
        lease,
        'spoof',
        request('process.exit(0);\n' + text),
      ),
    ).rejects.toThrow('grant_invalid');
    const after = text.replace("'$1[REDACTED]'", "'$1[REDACTED] '"),
      a = await applyPlatformRepairCandidate(
        lease,
        'stable-call',
        request(after),
      ),
      b = await applyPlatformRepairCandidate(
        lease,
        'stable-call',
        request(after),
      );
    expect(a).toEqual(b);
    expect(a.revision).toBe(1);
    expect((await getPlatformRepairTask(admin, q.id)).source.after).toBe(after);
    expect(
      (
        await fixture.db`select * from allrice_platform_repair_candidates where task_id=${q.id}`
      ).length,
    ).toBe(2);
    await expect(
      applyPlatformRepairCandidate(lease, 'stable-call', request(after + '\n')),
    ).rejects.toThrow('conflict');
    await expect(
      applyPlatformRepairCandidate(lease, 'stale', request(after)),
    ).rejects.toThrow('conflict');
    await cancelPlatformRepairTask(admin, q.id);
    await expect(
      applyPlatformRepairCandidate(lease, 'late', request(after, a.checksum)),
    ).rejects.toThrow('authorization_denied');
  });
  it('freezes an owned accepted revision3 as data into a new compiled Run and reconciles its own request independently of the historical login', async () => {
    enableCompiledTransportFixture();
    const source = await acceptedHistoryFixture(3),
      oldLogin = admin.sessionId!,
      newLogin = randomUUID();
    // Keep this synthetic login expired even when the suite reaches this point
    // within its first second, while preserving expires_at > created_at.
    await fixture.db`update allrice_sessions set created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' where id=${oldLogin}`;
    await fixture.db`insert into allrice_sessions(id,user_id,token_hash,expires_at) values(${newLogin},${admin.actor.id},${repositoryDigest(newLogin).slice(7)},clock_timestamp()+interval '1 hour')`;
    admin = { ...admin, sessionId: newLogin };
    const request = {
      requestId: randomUUID(),
      baselineId: baseline.id,
      verificationMode: 'compiled_packages',
      reuseAcceptedTaskId: source.id,
    };
    const [a, b] = await Promise.all([
      createPlatformRepairTask(admin, request),
      createPlatformRepairTask(admin, request),
    ]);
    expect(a.id).toBe(b.id);
    expect(a.runId).not.toBe(source.runId);
    expect(a.candidate.revision).toBe(0);
    expect(a.verifications).toEqual([]);
    expect(a.report).toBeNull();
    const [row] =
      await fixture.db`select frozen from allrice_platform_repair_tasks where id=${a.id}`;
    expect(row!.frozen.reuseSeed.sourceCandidateChecksum).toBe(
      source.candidate.checksum,
    );
    expect(row!.frozen.reuseSeed.afterBase64).toBe(
      source.candidate.files[0]!.afterBase64,
    );
    await expect(
      createPlatformRepairTask(admin, {
        ...request,
        reuseAcceptedTaskId: randomUUID(),
      }),
    ).rejects.toThrow('conflict');
    await expect(
      createPlatformRepairTask(admin, {
        ...request,
        requestId: randomUUID(),
        verificationMode: undefined,
      }),
    ).rejects.toThrow('grant_invalid');
    await cancelPlatformRepairTask(admin, a.id);
    await expect(
      createPlatformRepairTask(company.owner, {
        ...request,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow('authorization_denied');
  });
  it('rechecks source completion under the original enqueue transaction rather than trusting the first accepted read', async () => {
    const source = await acceptedHistoryFixture(),
      requestId = randomUUID();
    let reached!: () => void, unblock!: () => void;
    const locked = new Promise<void>((r) => {
        reached = r;
      }),
      resume = new Promise<void>((r) => {
        unblock = r;
      });
    const writer = fixture.db.begin(async (tx) => {
      await tx`select id from allrice_platform_repair_tasks where id=${source.id} for update`;
      reached();
      await resume;
      await tx`update allrice_platform_repair_tasks set report=null where id=${source.id}`;
    });
    await locked;
    const attempt = createPlatformRepairTask(admin, {
      requestId,
      baselineId: baseline.id,
      verificationMode: 'compiled_packages',
      reuseAcceptedTaskId: source.id,
    });
    // Attach rejection immediately; the pending transaction is expected to fail.
    const rejected = expect(attempt).rejects.toThrow('authorization_denied');
    try {
      await vi.waitFor(
        async () => {
          const [r] =
            await fixture.db`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%allrice_platform_repair_tasks%' and query like '%for share of q,j%'`;
          expect(r!.n).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 30 },
      );
      unblock();
      await writer;
      await rejected;
      expect(await findPlatformRepairTask(admin, requestId)).toBeNull();
    } finally {
      unblock();
      await writer;
      await attempt.catch(() => undefined);
    }
  });
  it('reserves the frozen five-minute proof when the existing root meters wall time, without changing its capacity', async () => {
    enableCompiledTransportFixture();
    const { recordManagedCloudEnvironment } =
      await import('./tenant-employee-access.ts');
    const { cloudToolchainImageV1 } = await import('@allrice/contracts');
    // DB-only environment contract; this case never dispatches a container.
    await recordManagedCloudEnvironment(
      {
        workerId: randomUUID(),
        compute: {
          available: true,
          reason: null,
          profile: {
            backend: 'cloud-gvisor-v1',
            imageDigest: cloudToolchainImageV1,
            architecture: cloudPlatform.architecture,
            runtime: 'runsc',
            runtimeVersion: 'release-20260831.0',
            runtimeChecksum: cloudPlatform.runtimeChecksum,
            network: 'none',
            maximumConcurrency: 2,
          },
        },
        browser: {
          available: false,
          profile: null,
          reason: 'fixture_not_requested',
        },
      },
      fixture.db,
    );
    const q = await createPlatformRepairTask(admin, {
      requestId: randomUUID(),
      baselineId: baseline.id,
      verificationMode: 'compiled_packages',
    });
    const workerId = randomUUID(),
      job = await claimNextJob(workerId, 60000);
    expect(job?.id).toBe(q.jobId);
    const lease = {
      workerId,
      jobId: job!.id,
      leaseToken: job!.lease!.token,
      attempt: job!.attempt,
    };
    const execution = await startClaimedJob(
      workerId,
      job!.id,
      lease.leaseToken,
    );
    const task = await getPlatformRepairExecution(lease);
    const { acquireConversationRuntime } =
      await import('./conversation/conversation-runtime.ts');
    await acquireConversationRuntime({
      organizationId: task.organization_id,
      workspaceId: task.workspace_id,
      sessionId: task.session_id,
      ownerId: task.owner_id,
      runId: task.run_id,
      workerId,
      configChecksum: task.frozen.fingerprint,
      compactThresholdTokens: 40000,
    });
    const { preparePlatformRepairInput } = await import('./platform-repair.ts');
    const { runtimeFixtureStorage } = await import('./runtime.fixture.ts');
    const storage = runtimeFixtureStorage(fixture.db);
    await preparePlatformRepairInput(lease, execution!.context, storage);
    await preparePlatformRepairInput(
      lease,
      execution!.context,
      storage,
      'dependencies',
    );
    const { preparePlatformRepairVerification } =
      await import('./platform-repair-verification.ts');
    const prepared = await preparePlatformRepairVerification(
      lease,
      execution!.context,
      q.candidate.checksum,
    );
    await assertFrozenCommandRecovery(prepared, lease, execution!.context);
    const [run] =
      await fixture.db`select r.execution_spec,j.timeout_at from allrice_runs r join allrice_jobs j on j.run_id=r.id where r.id=${q.runId}`;
    const { runtimePolicyDigest } = await import('./runtime-policy.ts');
    const { createRuntimeOperationLedger } =
      await import('./runtime-ledger/ledger.ts');
    await createRuntimeOperationLedger({
      database: fixture.db,
      admission: async () => {},
    }).createRoot({
      task: {
        scope: {
          organizationId: task.organization_id,
          workspaceId: task.workspace_id,
          projectId: null,
        },
        chatSessionId: q.sessionId,
        runId: q.runId,
        rootRunId: q.runId,
        parentRunId: null,
        frozenConfiguration: {
          employeeVersionId: q.employeeVersionId,
          digest: runtimePolicyDigest(run!.execution_spec),
        },
      },
      deadlineAt: run!.timeout_at.toISOString(),
      budgets: [
        {
          metric: 'wall_time',
          unit: 'milliseconds',
          currency: null,
          capacity: 600000,
          source: {
            kind: 'worker',
            sourceId: 'existing-compiled-wall-time-fixture',
          },
        },
      ],
    });
    const { createCloudCommandOperation } =
      await import('./cloud-execution.ts');
    const operation = await createCloudCommandOperation({
      context: execution!.context,
      arguments: prepared.arguments,
      callId: prepared.callId,
    });
    expect(operation.payload.arguments.limits.timeoutMs).toBe(60000);
    const [reservation] =
      await fixture.db`select r.amount,b.capacity,b.reserved from allrice_runtime_reservations r join allrice_runtime_budgets b using(root_run_id,metric) where r.operation_id=${operation.snapshot.binding.attempt.operationId} and r.metric='wall_time'`;
    expect(Number(reservation!.amount)).toBe(300000);
    expect(Number(reservation!.reserved)).toBe(300000);
    expect(Number(reservation!.capacity)).toBe(600000);
    await cancelPlatformRepairTask(admin, q.id);
  });
  (process.env.ALLRICE_RUN_COMPILED_REPAIR_NATIVE === '1' ? it : it.skip)(
    'the real Employee handler reuses accepted data without a model, compiles two packages and completes its own durable Run',
    { tags: ['manual:ALLRICE_RUN_COMPILED_REPAIR_NATIVE'], timeout: 900000 },
    async () => {
      const baselinePath = process.env.ALLRICE_REPOSITORY_NATIVE_BASELINE,
        catalog = process.env.ALLRICE_REPOSITORY_NATIVE_CATALOG,
        historyPath = process.env.ALLRICE_REPOSITORY_ACCEPTED_HISTORY;
      if (!baselinePath || !catalog || !historyPath)
        throw Error(
          'Registered source, frozen dependencies and accepted history required',
        );
      baseline = RepositoryBaselineSchema.parse(
        JSON.parse(readFileSync(baselinePath, 'utf8')),
      );
      expect(baseline.fileCount).toBeGreaterThan(2000);
      expect(baseline.compiledDependencies?.timeoutMs).toBe(300000);
      vi.stubEnv('ALLRICE_RELEASE_SHA', baseline.sourceSha);
      vi.stubEnv('ALLRICE_REPOSITORY_BASELINE_DIR', catalog);
      vi.stubEnv('ALLRICE_STORAGE_ROOT', fixture.storageRoot);
      const history = JSON.parse(readFileSync(historyPath, 'utf8'));
      const historicalReport = RepairReportSchema.parse(history.detail.report);
      expect(historicalReport.after.report.baselineId).toBe(baseline.id);
      // Import the already measured v1 history as fixture data; it is not a new
      // verification, model call, or production task. Only the new v2 Run below
      // executes physically in the dedicated VM and writes this isolated DB.
      const source = await submit(),
        sourceLease = await start(source);
      const oldText = (await readPlatformRepairSource(sourceLease)).file.text;
      const accepted = await applyPlatformRepairCandidate(
        sourceLease,
        'historical-data',
        {
          action: 'apply',
          expectedCandidate: source.candidate.checksum,
          proposal: {
            files: [
              {
                path: repairProductPath,
                before: oldText,
                after: Buffer.from(
                  history.detail.candidate.files[0].afterBase64,
                  'base64',
                ).toString('utf8'),
              },
            ],
          },
        },
      );
      expect(accepted.checksum).toBe(historicalReport.candidateChecksum);
      await fixture.db`update allrice_platform_repair_tasks set report=${fixture.db.json(historicalReport)} where id=${source.id}`;
      await fixture.db`update allrice_jobs set status='succeeded' where id=${source.jobId}`;
      const { recordManagedCloudEnvironment } =
        await import('./tenant-employee-access.ts');
      const { cloudToolchainImageV1 } = await import('@allrice/contracts');
      const { CloudRunnerBackend } =
        await import('../../../apps/worker/src/cloud-runner/backend.ts');
      await new CloudRunnerBackend().preflight(cloudToolchainImageV1);
      const cloudHealth = {
        workerId: randomUUID(),
        compute: {
          available: true,
          profile: {
            backend: 'cloud-gvisor-v1',
            imageDigest: cloudToolchainImageV1,
            architecture: cloudPlatform.architecture,
            runtime: 'runsc',
            runtimeVersion: 'release-20260831.0',
            runtimeChecksum: cloudPlatform.runtimeChecksum,
            network: 'none',
            maximumConcurrency: 2,
          },
          reason: null,
        },
        browser: {
          available: false,
          profile: null,
          reason: 'fixture_browser_not_requested',
        },
      };
      await recordManagedCloudEnvironment(cloudHealth, fixture.db);
      const q = await createPlatformRepairTask(admin, {
        requestId: randomUUID(),
        baselineId: baseline.id,
        verificationMode: 'compiled_packages',
        reuseAcceptedTaskId: source.id,
      });
      expect(q.runId).not.toBe(source.runId);
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 60000);
      expect(job?.id).toBe(q.jobId);
      const lease = {
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
      };
      const execution = await startClaimedJob(
        workerId,
        job!.id,
        lease.leaseToken,
      );
      expect(execution).toBeTruthy();
      const router = await import('../../../apps/worker/src/harness/router.ts');
      const model = vi
        .spyOn(router, 'getHarnessRouter')
        .mockImplementation(() => {
          throw Error('NO_MODEL_ALLOWED_IN_REVERIFICATION');
        });
      const { heartbeatJob } = await import('./execution/queue.ts');
      let heartbeatError: unknown,
        heartbeat = Promise.resolve<unknown>(undefined);
      const timer = setInterval(() => {
        heartbeat = heartbeatJob(
          workerId,
          lease.jobId,
          lease.leaseToken,
          60000,
        ).catch((error) => {
          heartbeatError = error;
        });
      }, 5000);
      // Production Worker refreshes managed target health every minute. A
      // one-shot fixture would revoke a healthy >120s compiled operation.
      let healthHeartbeat = Promise.resolve<unknown>(undefined);
      const healthTimer = setInterval(() => {
        healthHeartbeat = recordManagedCloudEnvironment(
          cloudHealth,
          fixture.db,
        ).catch((error) => {
          heartbeatError = error;
        });
      }, 60000);
      const abort = new AbortController();
      try {
        const { executeEmployeeRun } =
          await import('../../../apps/worker/src/jobs/employee-run.ts');
        const result = await executeEmployeeRun({
          execution: execution!,
          isolation: {} as never,
          signal: abort.signal,
          onHarnessEvent: async () => undefined,
          workflowLease: { ...lease, leaseMs: 60000 },
        });
        expect(result).toMatchObject({ modelUsed: false });
        expect(model).not.toHaveBeenCalled();
        const [busy] =
          await fixture.db`select state,active_run_id from allrice_conversation_runtimes where session_id=${q.sessionId}`;
        expect(busy!.active_run_id).toBe(q.runId);
        await completeJob({ ...lease, result });
        const detail = await getPlatformRepairTask(admin, q.id);
        expect(detail.accepted).toBe(true);
        expect(detail.status).toBe('succeeded');
        expect(detail.verifications).toHaveLength(2);
        expect(detail.candidate.revision).toBe(1);
        expect(detail.report?.after.report.version).toBe(2);
        if (detail.report?.after.report.version !== 2)
          throw Error('Actual compiled evidence missing');
        expect(
          detail.report.after.report.compiled.steps.every(
            (s) => s.status === 'passed',
          ),
        ).toBe(true);
        expect(
          detail.report.after.report.assertions.every((a) => a.passed),
        ).toBe(true);
        const [idle] =
          await fixture.db`select state,active_run_id,worker_id from allrice_conversation_runtimes where session_id=${q.sessionId}`;
        expect(idle!.state).toBe('idle');
        expect(idle!.active_run_id).toBeNull();
        expect(idle!.worker_id).toBeNull();
        const { getPlatformRepairArtifact } =
          await import('./platform-repair.ts');
        const { readArtifactBytes } = await import('./artifact-review.ts');
        const { runtimeFixtureStorage } = await import('./runtime.fixture.ts');
        const downloaded = [];
        for (const file of detail.report.artifacts) {
          const artifact = await getPlatformRepairArtifact(
            admin,
            q.id,
            file.artifactId,
          );
          const bytes = await readArtifactBytes(
            runtimeFixtureStorage(fixture.db),
            artifact.object,
          );
          expect(repositoryDigest(bytes)).toBe(file.checksum);
          downloaded.push({
            fileName: file.fileName,
            checksum: file.checksum,
            sizeBytes: bytes.length,
          });
          await expect(
            getPlatformRepairArtifact(company.owner, q.id, file.artifactId),
          ).rejects.toThrow('authorization_denied');
        }
        await expect(
          getPlatformRepairTask(company.owner, q.id),
        ).rejects.toThrow('authorization_denied');
        const physical =
          await fixture.db`select a.outcome,a.cleanup_confirmed_at,i.payload,o.snapshot,
            (select capacity from allrice_runtime_budgets where root_run_id=o.root_run_id and metric='wall_time') wall_time_capacity,
            (select amount from allrice_runtime_reservations where operation_id=a.operation_id and metric='wall_time') reserved_wall_time_ms
            from allrice_cloud_execution_attempts a join allrice_cloud_execution_inputs i on i.operation_id=a.operation_id
            join allrice_runtime_operations o on o.id=a.operation_id where i.run_id=${q.runId}`;
        // Keep the completed Run and downloaded bytes even if a later QA
        // assertion fails. Default roots meter calls, without a wall-time row.
        if (process.env.ALLRICE_REPOSITORY_COMPILED_CHAIN_EVIDENCE)
          writeFileSync(
            process.env.ALLRICE_REPOSITORY_COMPILED_CHAIN_EVIDENCE +
              '.checkpoint.json',
            JSON.stringify(
              {
                task: detail,
                physical,
                downloaded,
                modelCalls: model.mock.calls.length,
              },
              null,
              2,
            ),
          );
        expect(physical).toHaveLength(2);
        expect(
          physical.every(
            (p) =>
              p.outcome.stopped &&
              p.cleanup_confirmed_at &&
              (p.wall_time_capacity === null
                ? p.reserved_wall_time_ms === null
                : Number(p.reserved_wall_time_ms) === 300000) &&
              p.outcome.repositoryIsolation.timeoutMs === 300000 &&
              p.outcome.repositoryIsolation.memoryMiB === 768 &&
              p.payload.arguments.inputs.length === 2,
          ),
        ).toBe(true);
        expect(heartbeatError).toBeUndefined();
        if (process.env.ALLRICE_REPOSITORY_COMPILED_CHAIN_EVIDENCE)
          writeFileSync(
            process.env.ALLRICE_REPOSITORY_COMPILED_CHAIN_EVIDENCE,
            JSON.stringify(
              {
                scope:
                  'real Employee handler / isolated PostgreSQL / original accepted candidate data / physical runsc compiled packages',
                task: detail,
                physical,
                downloaded,
                modelCalls: model.mock.calls.length,
                runtimeReleasedOnlyAtCompletion: true,
              },
              null,
              2,
            ),
          );
      } catch (error) {
        if (process.env.ALLRICE_REPOSITORY_COMPILED_CHAIN_EVIDENCE) {
          const operations =
            await fixture.db`select a.operation_id,a.outcome,a.cleanup_confirmed_at,o.snapshot,o.lease_expires_at,t.last_heartbeat_at from allrice_cloud_execution_attempts a join allrice_cloud_execution_inputs i on i.operation_id=a.operation_id join allrice_runtime_operations o on o.id=a.operation_id join allrice_execution_targets t on t.id=o.target_id where i.run_id=${q.runId}`;
          writeFileSync(
            process.env.ALLRICE_REPOSITORY_COMPILED_CHAIN_EVIDENCE +
              '.failure.json',
            JSON.stringify(
              {
                taskId: q.id,
                runId: q.runId,
                error: error instanceof Error ? error.message : 'unknown',
                operations,
              },
              null,
              2,
            ),
          );
        }
        throw error;
      } finally {
        clearInterval(timer);
        clearInterval(healthTimer);
        await heartbeat;
        await healthHeartbeat;
        model.mockRestore();
        abort.abort();
        const cleanupBackend = new CloudRunnerBackend();
        const owned =
          await fixture.db`select i.binding from allrice_cloud_execution_inputs i where i.run_id=${q.runId} and i.job_id=${q.jobId}`;
        for (const o of owned) {
          const id = o.binding.attempt.attemptId;
          await cleanupBackend.stop(id);
          await cleanupBackend.cleanup(id);
          expect(await cleanupBackend.inspect(id)).toBeNull();
        }
      }
    },
  );
  (process.env.ALLRICE_RUN_REPAIR_CHAIN_NATIVE === '1' ? it : it.skip)(
    'minimum private DSH proposal, real cloud verifier, durable files, owner detail/download and completion chain',
    { tags: ['manual:ALLRICE_RUN_REPAIR_CHAIN_NATIVE'], timeout: 240000 },
    async () => {
      if (
        !process.env.ALLRICE_REPOSITORY_NATIVE_BASELINE ||
        !process.env.ALLRICE_REPOSITORY_NATIVE_CATALOG
      )
        throw Error('Full registered native baseline and catalog required');
      baseline = RepositoryBaselineSchema.parse(
        JSON.parse(
          readFileSync(process.env.ALLRICE_REPOSITORY_NATIVE_BASELINE, 'utf8'),
        ),
      );
      expect(baseline.archiveBytes).toBeGreaterThan(2_000_000);
      expect(baseline.fileCount).toBeGreaterThan(2000);
      vi.stubEnv('ALLRICE_RELEASE_SHA', baseline.sourceSha);
      vi.stubEnv(
        'ALLRICE_REPOSITORY_BASELINE_DIR',
        process.env.ALLRICE_REPOSITORY_NATIVE_CATALOG,
      );
      const { recordManagedCloudEnvironment } =
        await import('./tenant-employee-access.ts');
      const { cloudToolchainImageV1 } = await import('@allrice/contracts');
      const { CloudRunnerBackend } =
        await import('../../../apps/worker/src/cloud-runner/backend.ts');
      // Populate the isolated fixture through the existing trusted health path,
      // after a real pinned runsc/watchdog probe. No production data is modified.
      await new CloudRunnerBackend().preflight(cloudToolchainImageV1);
      await recordManagedCloudEnvironment(
        {
          workerId: randomUUID(),
          compute: {
            available: true,
            profile: {
              backend: 'cloud-gvisor-v1',
              imageDigest: cloudToolchainImageV1,
              architecture: cloudPlatform.architecture,
              runtime: 'runsc',
              runtimeVersion: 'release-20260831.0',
              runtimeChecksum: cloudPlatform.runtimeChecksum,
              network: 'none',
              maximumConcurrency: 2,
            },
            reason: null,
          },
          browser: {
            available: false,
            profile: null,
            reason: 'fixture_browser_not_requested',
          },
        },
        fixture.db,
      );
      const q = await submit(),
        workerId = randomUUID(),
        job = await claimNextJob(workerId, 60000);
      expect(job?.id).toBe(q.jobId);
      const execution = await startClaimedJob(
        workerId,
        job!.id,
        job!.lease!.token,
      );
      expect(execution).toBeTruthy();
      const lease = {
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
      };
      const { acquireConversationRuntime, releaseConversationRuntime } =
        await import('./conversation-runtime.ts');
      await acquireConversationRuntime({
        organizationId: execution!.context.organizationId,
        workspaceId: execution!.context.workspaceId!,
        ownerId: admin.actor.id,
        sessionId: q.sessionId,
        runId: q.runId,
        workerId,
        configChecksum: repositoryDigest('synthetic-controller-fixture'),
        compactThresholdTokens: 50000,
      });
      const { heartbeatJob } = await import('./execution/queue.ts');
      let heartbeatError: unknown,
        authorityBarrier = false;
      let heartbeatInFlight: Promise<unknown> = Promise.resolve();
      const timer = setInterval(() => {
        if (!authorityBarrier)
          heartbeatInFlight = heartbeatJob(
            workerId,
            lease.jobId,
            lease.leaseToken,
            60000,
          ).catch((e) => {
            heartbeatError = e;
          });
      }, 5000);
      try {
        const { createPlatformRepairController } =
          await import('../../../apps/worker/src/jobs/platform-repair.ts');
        const { nativeBrokerRoundtrip } =
          await import('../../../apps/worker/src/harness/dsh-native-broker.fixture.ts');
        const { runtimeFixtureStorage } = await import('./runtime.fixture.ts');
        let physicalExecutions = 0,
          revokeAfterExecution = true;
        class PublicationBarrierBackend extends CloudRunnerBackend {
          override async execute(
            ...args: Parameters<
              InstanceType<typeof CloudRunnerBackend>['execute']
            >
          ) {
            physicalExecutions++;
            const outcome = await super.execute(...args);
            if (outcome.reason === 'completed' && revokeAfterExecution) {
              authorityBarrier = true;
              await heartbeatInFlight;
              await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${admin.sessionId!}`;
            }
            return outcome;
          }
        }
        const backend = new PublicationBarrierBackend();
        const controllerInput = {
          execution: execution!,
          workflowLease: { ...lease, leaseMs: 60000 },
          signal: new AbortController().signal,
          onHarnessEvent: async () => undefined,
          isolation: {} as never,
        };
        const controller = await createPlatformRepairController(
          {
            execution: execution!,
            workflowLease: { ...lease, leaseMs: 60000 },
            signal: new AbortController().signal,
            onHarnessEvent: async () => undefined,
            isolation: {} as never,
          },
          { storage: runtimeFixtureStorage(fixture.db), backend },
        );
        expect(controller.before.report.exitCode).toBe(1);
        const { file } = await readPlatformRepairSource(lease),
          text = file.text,
          start = text.lastIndexOf('      .replace('),
          end = text.indexOf('      );', start) + '      );'.length;
        const slot = String.raw`      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'}]+)/gi,
        '$1[REDACTED]',
      );`;
        const args = {
          action: 'apply',
          expectedCandidate: q.candidate.checksum,
          proposal: {
            files: [
              {
                path: repairProductPath,
                before: text,
                after: text.slice(0, start) + slot + text.slice(end),
              },
            ],
          },
        };
        let appliedCallId = '';
        await nativeBrokerRoundtrip({
          canonicalName: 'platform.repository.repair',
          wireName: 'platform_repository_repair',
          args,
          invalidArgs: { ...args, parentUid: 0 },
          onToolCall: (call) => {
            appliedCallId = call.id;
            return controller.onToolCall(call);
          },
        });
        const [beforeWrite] =
          await fixture.db`select count(*)::int n from allrice_deliverable_versions where session_id=${q.sessionId}`;
        await expect(controller.finish()).rejects.toThrow(
          'cloud_input_not_authorized',
        );
        const [blocked] =
          await fixture.db`select q.report,(select count(*)::int from allrice_deliverable_versions where session_id=q.session_id) versions from allrice_platform_repair_tasks q where q.id=${q.id}`;
        expect(blocked?.report).toBeNull();
        expect(blocked?.versions).toBe(beforeWrite!.n);
        expect(physicalExecutions).toBe(2);
        await fixture.db`update allrice_sessions set revoked_at=null where id=${admin.sessionId!}`;
        const { publishCloudOperationArtifacts } =
          await import('./cloud-execution.ts');
        const [pendingWrite] =
          await fixture.db`select i.binding,i.payload,a.outcome from allrice_cloud_execution_inputs i join allrice_cloud_execution_attempts a on a.operation_id=i.operation_id join allrice_platform_repair_verifications v on v.operation_id=i.operation_id where v.task_id=${q.id} and v.revision=1`;
        expect(pendingWrite?.outcome.reason).toBe('completed');
        const publish = () =>
          publishCloudOperationArtifacts(
            {
              context: execution!.context,
              binding: pendingWrite!.binding,
              payload: pendingWrite!.payload,
              artifacts: pendingWrite!.outcome.artifacts,
            },
            runtimeFixtureStorage(fixture.db),
            fixture.db,
          );
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', 'unrelated@example.test');
        await expect(publish()).rejects.toThrow('cloud_input_not_authorized');
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
        await fixture.db`update allrice_platform_employee_tenant_assignments set active=false where tenant_employee_id in(select employee_id from allrice_platform_quality_deployments where owner_id=${admin.actor.id})`;
        await expect(publish()).rejects.toThrow(
          /cloud_input_not_authorized|employee_access_revoked/,
        );
        await fixture.db`update allrice_platform_employee_tenant_assignments set active=true where tenant_employee_id in(select employee_id from allrice_platform_quality_deployments where owner_id=${admin.actor.id})`;
        expect(
          (
            await fixture.db`select count(*)::int n from allrice_deliverable_versions where session_id=${q.sessionId}`
          )[0]!.n,
        ).toBe(beforeWrite!.n);
        // Hold an actual publication after q-S is acquired but before its
        // session writer. Reconcile the already committed native apply call,
        // which must wait for q-X without holding a session-S upgrade blocker.
        const baseStorage = runtimeFixtureStorage(fixture.db),
          originalPut = baseStorage.put.bind(baseStorage);
        let entered!: () => void, unblock!: () => void;
        const reached = new Promise<void>((done) => {
            entered = done;
          }),
          resume = new Promise<void>((done) => {
            unblock = done;
          });
        const putBarrier = vi
          .spyOn(baseStorage, 'put')
          .mockImplementationOnce(async (...args) => {
            entered();
            await resume;
            return originalPut(...args);
          });
        const publishing = publish();
        try {
          await Promise.race([
            reached,
            new Promise<never>((_, bad) =>
              setTimeout(
                () => bad(Error('publication barrier not reached')),
                5000,
              ),
            ),
          ]);
          const reconciling = applyPlatformRepairCandidate(
            lease,
            appliedCallId,
            args,
          );
          await vi.waitFor(
            async () => {
              const [wait] =
                await fixture.db`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%allrice_platform_repair_tasks%' and query like '%for update%'`;
              expect(wait!.n).toBeGreaterThan(0);
            },
            { timeout: 5000, interval: 30 },
          );
          unblock();
          const [published, again] = await Promise.race([
            Promise.all([publishing, reconciling]),
            new Promise<never>((_, bad) =>
              setTimeout(
                () => bad(Error('publication/apply lock cycle')),
                5000,
              ),
            ),
          ]);
          expect(published).toHaveLength(1);
          expect(again.revision).toBe(1);
        } finally {
          unblock();
          putBarrier.mockRestore();
          await publishing.catch(() => undefined);
        }
        revokeAfterExecution = false;
        authorityBarrier = false;
        const resumed = await createPlatformRepairController(controllerInput, {
          storage: runtimeFixtureStorage(fixture.db),
          backend,
        });
        const report = await resumed.finish();
        expect(physicalExecutions).toBe(2);
        expect(report.after.report.exitCode).toBe(0);
        expect(report.after.report.assertions.every((a) => a.passed)).toBe(
          true,
        );
        expect(report.artifacts).toHaveLength(2);
        const { getPlatformRepairArtifact } =
          await import('./platform-repair.ts');
        const { readArtifactBytes } = await import('./artifact-review.ts');
        for (const file of report.artifacts) {
          const artifact = await getPlatformRepairArtifact(
              admin,
              q.id,
              file.artifactId,
            ),
            bytes = await readArtifactBytes(
              runtimeFixtureStorage(fixture.db),
              artifact.object,
            );
          expect(repositoryDigest(bytes)).toBe(file.checksum);
          expect(JSON.parse(Buffer.from(bytes).toString('utf8'))).toBeTruthy();
          await expect(
            getPlatformRepairArtifact(company.owner, q.id, file.artifactId),
          ).rejects.toThrow('authorization_denied');
        }
        const materialCount =
          await fixture.db`select count(*)::int n from allrice_deliverable_versions where session_id=${q.sessionId}`;
        expect(await resumed.finish()).toEqual(report);
        expect(
          (
            await fixture.db`select count(*)::int n from allrice_deliverable_versions where session_id=${q.sessionId}`
          )[0]!.n,
        ).toBe(materialCount[0]!.n);
        await completeJob({
          ...lease,
          result: { answer: 'Trusted fixed assertions passed.' },
        });
        const detail = await getPlatformRepairTask(admin, q.id);
        expect(detail.accepted).toBe(true);
        expect(detail.status).toBe('succeeded');
        expect(detail.verifications).toHaveLength(2);
        expect(detail.report?.candidateChecksum).toBe(
          detail.candidate.checksum,
        );
        expect(heartbeatError).toBeUndefined();
        const [stops] =
          await fixture.db`select count(*)::int n from allrice_cloud_execution_attempts a join allrice_platform_repair_verifications v on v.operation_id=a.operation_id where v.task_id=${q.id} and a.cleanup_confirmed_at is not null and a.outcome->>'stopped'='true'`;
        expect(stops!.n).toBe(2);
        if (process.env.ALLRICE_REPOSITORY_NATIVE_CHAIN_EVIDENCE)
          writeFileSync(
            process.env.ALLRICE_REPOSITORY_NATIVE_CHAIN_EVIDENCE,
            JSON.stringify(
              {
                version: 1,
                scope:
                  'native DSH loopback / real full-source PostgreSQL ledger and runsc; no paid model',
                baseline,
                report,
                task: detail,
                physicalExecutions,
                revocations: ['login', 'platform_allowlist', 'deployment'],
                duplicateVersions: false,
                cleanupConfirmed: stops!.n,
              },
              null,
              2,
            ),
          );
      } finally {
        clearInterval(timer);
        await heartbeatInFlight;
        const cleanupBackend = new CloudRunnerBackend();
        const owned =
          await fixture.db`select i.binding,a.operation_id from allrice_cloud_execution_attempts a join allrice_cloud_execution_inputs i on i.operation_id=a.operation_id where i.run_id=${q.runId} and i.job_id=${q.jobId}`;
        for (const o of owned) {
          const id = o.binding.attempt.attemptId;
          await cleanupBackend.stop(id);
          await cleanupBackend.cleanup(id);
          expect(await cleanupBackend.inspect(id)).toBeNull();
        }
        if (process.env.ALLRICE_REPOSITORY_NATIVE_CHAIN_EVIDENCE)
          writeFileSync(
            process.env.ALLRICE_REPOSITORY_NATIVE_CHAIN_EVIDENCE +
              '.cleanup.json',
            JSON.stringify({
              runId: q.runId,
              jobId: q.jobId,
              attempts: owned.map((o) => o.binding.attempt.attemptId),
              physicallyRemoved: true,
            }),
          );
        // Canonical completeJob already releases this runtime. Only incomplete
        // fixture paths still own it; never release a completed turn twice.
        const [ownedRuntime] =
          await fixture.db`select state,active_run_id,worker_id from allrice_conversation_runtimes where session_id=${q.sessionId}`;
        if (
          ownedRuntime?.active_run_id === q.runId &&
          ownedRuntime.worker_id === workerId
        )
          await releaseConversationRuntime({
            organizationId: execution!.context.organizationId,
            workspaceId: execution!.context.workspaceId!,
            sessionId: q.sessionId,
            runId: q.runId,
            workerId,
            outcome: 'idle',
          });
        else expect(ownedRuntime?.active_run_id).not.toBe(q.runId);
      }
    },
  );
});
