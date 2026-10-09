import { acceptedRepositoryFixture } from './platform-repository-publication.fixture.ts';
import { startMaintenancePublication } from './platform-maintenance-publication.ts';
import {
  repositoryRequestGate,
  readAcceptedRepositorySource,
} from './platform-repository-publication-authority.ts';
import { readRepositoryAction } from './platform-repository-publication-ledger.ts';
import { repositoryCandidate } from './platform-repository-source.ts';
import {
  maintenanceCompiledProfileId,
  RepairReportSchema,
} from './platform-repair-contracts.ts';
/** Real PostgreSQL authority tests. Synthetic build-proof transport below is
 * not evidence that the production module or compiled verifier ran. */
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { updateMaintenanceGithubBot } from './platform-maintenance-github.ts';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
} from './identity.ts';
import {
  registerMaintenanceDeployment,
  rotateMaintenanceCredential,
  updateMaintenanceDeployment,
} from './platform-maintenance.ts';
import { receiveMaintenanceReport } from './platform-maintenance-reports.ts';
import {
  recordMaintenanceDiagnosis,
  maintenanceDiagnosisCandidates,
  createMaintenanceGrant,
  createAutomaticMaintenanceGrant,
  getMaintenanceReportAuthority,
  assertMaintenanceGrant,
  revokeMaintenanceGrant,
} from './platform-maintenance-authority.ts';
import {
  RepositoryBaselineSchema,
  repairProductPath,
  repairProfileId,
  type RepositoryBaseline,
} from './platform-repair-contracts.ts';
import {
  repositoryDigest,
  repositoryMaterialDigest,
  repositoryDependencyDigest,
  validateRepositoryArchive,
} from './platform-repository-source.ts';
import { compiledDependencyFixture } from './platform-repair-compiled.fixture.ts';
import {
  maintenanceRepairPlan,
  maintenanceFixtureDigest,
  maintenanceOracleChecksum,
} from './platform-maintenance-profile.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import type { MaintenanceDiagnosisProof } from './platform-maintenance-authority-contracts.ts';
import { LocalStorageAdapter } from '@allrice/storage';
import { preparePlatformRepairInput } from './platform-repair.ts';
import { preparePlatformRepairVerification } from './platform-repair-verification.ts';
import { startMaintenanceRepairGrant } from './platform-maintenance-repair.ts';
import { createExperienceFixture } from './experience.fixture.ts';
import { buildEmployeeRuntimePackage } from './platform-employees/runtime-package.ts';
import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
} from '@allrice/contracts';
import {
  claimNextJob,
  startClaimedJob,
  heartbeatJob,
} from './execution/queue.ts';
import { getPlatformRepairExecution } from './platform-repair-authority.ts';
import {
  readPlatformRepairSource,
  applyPlatformRepairCandidate,
  cancelPlatformRepairTask,
} from './platform-repair.ts';
import { defaultMaintenancePolicy } from './platform-maintenance-contracts.ts';
import { createTaskProgressRuntime } from './task-progress.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('immutable report-bound maintenance authority', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    admin: RequestContext,
    other: RequestContext,
    ordinary: RequestContext,
    root: string,
    baseline: RepositoryBaseline,
    proof: MaintenanceDiagnosisProof;
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
        displayName: 'Authority fixture',
        role: 'member',
      });
      return (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
    }
    admin = await principal('authority-admin@example.test');
    other = await principal('authority-other@example.test');
    ordinary = await principal('authority-ordinary@example.test');
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      'authority-admin@example.test,authority-other@example.test',
    );
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'c'.repeat(64));
    vi.stubEnv('ALLRICE_MAINTENANCE_CENTRAL_ENABLED', '1');
    await updateMaintenanceGithubBot(
      admin,
      {
        action: 'replace',
        requestId: randomUUID(),
        expectedRevision: 0,
        expectedLogin: 'rice-maintenance',
        token: 'github_pat_' + 'SyntheticOnly'.repeat(7),
      },
      {
        fetcher: (async (url) =>
          Response.json(
            String(url).endsWith('/user')
              ? { id: 901, login: 'rice-maintenance' }
              : {
                  id: 1323769790,
                  full_name: 'semiok/allrice',
                  permissions: { push: true },
                },
          )) as typeof fetch,
      },
    );

    root = realpathSync(
      mkdtempSync(join(tmpdir(), 'allrice-maintenance-authority-')),
    );
    vi.stubEnv('ALLRICE_REPOSITORY_BASELINE_DIR', root);
    const paths = [
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'package.json',
      'tsconfig.base.json',
      'packages/project-runtime/tsconfig.json',
      'packages/project-runtime/tsconfig.build.json',
      'packages/project-runtime/package.json',
      repairProductPath,
    ];
    const files = paths.map((path) => {
      const text = readFileSync(new URL('../../../' + path, import.meta.url));
      return {
        path,
        mode: '100644' as const,
        sizeBytes: text.length,
        checksum: repositoryDigest(text),
        contentBase64: text.toString('base64'),
      };
    });
    const archive = validateRepositoryArchive({ version: 1, files }),
      bytes = gzipSync(Buffer.from(JSON.stringify(archive))),
      dep = compiledDependencyFixture();
    const deps = {
      ...dep.descriptor,
      rootLockChecksum: files[0]!.checksum,
      dependencyConfigurationDigest: repositoryDependencyDigest(files),
    };
    const dependencyBytes = gzipSync(
      Buffer.from(
        JSON.stringify({
          ...dep.bundle,
          rootLockChecksum: deps.rootLockChecksum,
          dependencyConfigurationDigest: deps.dependencyConfigurationDigest,
        }),
      ),
    );
    deps.bundleBytes = dependencyBytes.length;
    deps.bundleChecksum = repositoryDigest(dependencyBytes);
    baseline = RepositoryBaselineSchema.parse({
      version: 1,
      id: randomUUID(),
      repositoryId: 'semiok/allrice',
      sourceSha: 'a'.repeat(40),
      gitTree: 'b'.repeat(40),
      sourceDigest: repositoryMaterialDigest(files),
      rootLockChecksum: files[0]!.checksum,
      dependencyConfigurationDigest: deps.dependencyConfigurationDigest,
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
      compiledDependencies: deps,
    });
    mkdirSync(join(root, baseline.id));
    writeFileSync(
      join(root, baseline.id, 'baseline.json'),
      JSON.stringify(baseline),
    );
    writeFileSync(join(root, baseline.id, 'source.json.gz'), bytes);
    writeFileSync(
      join(root, baseline.id, 'dependencies.json.gz'),
      dependencyBytes,
    );
    const verificationPlan = maintenanceRepairPlan(baseline, archive),
      h = repositoryDigest('synthetic-build-transport');
    const sourceMapping = {
      version: 1 as const,
      specId: 'command-output.credentials.v2' as const,
      sourceTree: baseline.gitTree,
      sourcePath:
        repairProductPath as 'packages/project-runtime/src/command-output.ts',
      sourceChecksum: files.at(-1)!.checksum,
      outputPath: 'packages/project-runtime/dist/command-output.js' as const,
      outputChecksum: h,
      exportEntryPath: 'packages/project-runtime/dist/index.js' as const,
      exportEntryChecksum: h,
      compilerVersion: '5.9.3' as const,
      compilerChecksum: h,
      configuration: files.slice(3, 7).map((f) => ({
        path: f.path as 'tsconfig.base.json',
        checksum: f.checksum,
      })),
      sourceIndependentlyCompiled: true as const,
    };
    proof = {
      version: 1,
      specId: 'command-output.credentials.v2',
      baseline,
      verificationPlan,
      verificationPlanDigest: technicalDigest(verificationPlan),
      producerSourceSha: baseline.sourceSha,
      producerSourceTree: baseline.gitTree,
      producerManifestDigest: h,
      producerArtifactDigest: h,
      producerBootId: randomUUID(),
      producerNodeVersion: 'v22.23.2',
      producerRuntimeGraphDigest: h,
      sourceMapping,
      sourceMappingDigest: technicalDigest(sourceMapping),
      moduleArtifactDigest: h,
      exportEntryArtifactDigest: h,
      oracleChecksum: maintenanceOracleChecksum,
      probeResults: ['quoted_spaces', 'quoted_escapes', 'streamed_secret'].map(
        (id) => ({
          id: id as 'quoted_spaces',
          completed: true,
          redactionMarkerPresent: true,
          secretAbsent: false,
          passed: false,
        }),
      ),
      failedAssertions: ['quoted_spaces', 'quoted_escapes', 'streamed_secret'],
      verdict: 'confirmed_code',
    };
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fixture?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const install = (owner = admin) =>
    registerMaintenanceDeployment(owner, {
      requestId: randomUUID(),
      companyName: 'Isolated QA',
      companySlug: 'qa-' + randomUUID().slice(0, 8),
      deploymentName: 'Primary',
    });
  async function report(
    installation: Awaited<ReturnType<typeof install>>,
    sampledAt = new Date().toISOString(),
    fixtureDigest = maintenanceFixtureDigest,
  ) {
    const receipt = await receiveMaintenanceReport(
      {
        deploymentId: installation.deployment.id,
        installationKey: installation.installationKey!,
      },
      {
        version: 1,
        sourceReportId: randomUUID(),
        sourceKind: 'deployment_health',
        sampledAt,
        observedReleaseSha: 'c'.repeat(40),
        producerVersion: 'allrice-maintenance.v1',
        facts: {
          findings: [{ id: 'secret_output', occurrences: 3, errorCode: null }],
          quality: null,
          probe: {
            specId: 'command-output.credentials.v2',
            fixtureDigest,
            failedAssertions: [
              'quoted_spaces',
              'quoted_escapes',
              'streamed_secret',
            ],
          },
        },
      },
      new Date().toISOString(),
    );
    return receipt;
  }
  async function diagnosed(owner = admin) {
    const installation = await install(owner),
      receipt = await report(installation),
      d = await recordMaintenanceDiagnosis(receipt.reportId, proof);
    return {
      installation,
      receipt,
      d,
      request: {
        requestId: randomUUID(),
        reportId: receipt.reportId,
        expectedReportDigest: receipt.payloadDigest,
        expectedDiagnosisDigest: d.proofDigest,
        expectedDeploymentRevision: installation.deployment.revision,
      },
    };
  }
  it('binds current central source independently of installed SHA; rejects forged mappings/oracles and incomplete probes', async () => {
    const i = await install(),
      r = await report(i);
    for (const changed of [
      { ...proof, sourceMappingDigest: repositoryDigest('wrong') },
      { ...proof, producerSourceTree: 'f'.repeat(40) },
      { ...proof, oracleChecksum: repositoryDigest('wrong') },
      { ...proof, probeResults: proof.probeResults.slice(1) },
    ])
      await expect(
        recordMaintenanceDiagnosis(
          r.reportId,
          changed as MaintenanceDiagnosisProof,
        ),
      ).rejects.toThrow();
    const d = await recordMaintenanceDiagnosis(r.reportId, proof);
    expect(d.targetSha).toBe('a'.repeat(40));
    expect(d.defectId).not.toBeNull();
    expect((await recordMaintenanceDiagnosis(r.reportId, proof)).id).toBe(d.id);
    await expect(
      getMaintenanceReportAuthority(other, r.reportId),
    ).rejects.toThrow();
    await expect(
      getMaintenanceReportAuthority(ordinary, r.reportId),
    ).rejects.toThrow();
  });
  it('creates one real Employee Run from persisted authority without fabricating a browser login; manifest, budgets and revocation survive DB round trips', async () => {
    const company = await createExperienceFixture(fixture.db);
    const untouched =
      await fixture.db`select * from allrice_memberships where organization_id=${company.org} order by id`;
    for (const f of [
      'RUNTIME_POLICY',
      'BRIDGE_OPERATION_LEDGER',
      'LOCAL_COMMAND',
      'CLOUD_RUNNER',
      'BROWSER_CONTROL',
      'WORKBENCH',
    ])
      vi.stubEnv('ALLRICE_' + f + '_ENABLED', '1');
    await fixture.db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
    await fixture.db`update allrice_model_providers set enabled=true where provider_key='codex'`;
    const [r] =
      await fixture.db`select r.* from allrice_platform_employee_revisions r join allrice_platform_employees e on e.current_published_revision_id=r.id where e.employee_key='rice'`;
    const definition = PlatformEmployeeDefinitionSchema.parse({
      ...r!.definition,
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
    const runtimePackage = buildEmployeeRuntimePackage({
      revision: r!.revision,
      definition,
      skills: [],
    });
    const profile = PlatformEmployeeRuntimeProfileSchema.parse({
      ...r!.runtime_profile,
      toolNames: definition.capabilities.toolNames,
      nativeSkillIds: [],
      nativeSkillChecksums: [],
      runtimePackage,
    });
    await fixture.db`update allrice_platform_employee_revisions set definition=${fixture.db.json(definition)},runtime_profile=${fixture.db.json(profile)},checksum=${runtimePackage.checksum},status='published',published_at=now() where id=${r!.id}`;
    await fixture.db`update allrice_platform_employees set status='published' where id=${r!.employee_id}`;
    const a = await diagnosed(),
      g = await createMaintenanceGrant(admin, a.request);
    // Force the old issuer/deployment inversion: transaction A already owns
    // issuer UPDATE, B must block there before taking deployment SHARE.
    let announceIssuer!: () => void, announceWaiter!: (pid: number) => void;
    const issuerHeld = new Promise<void>((resolve) => {
      announceIssuer = resolve;
    });
    const waiterPid = new Promise<number>((resolve) => {
      announceWaiter = resolve;
    });
    const lockOwner = fixture.db.begin(async (tx) => {
      await tx`set local statement_timeout='2s'`;
      const [self] = await tx`select pg_backend_pid() pid`;
      await tx`select id from allrice_users where id=${admin.actor.id} for update`;
      announceIssuer();
      const pid = await waiterPid;
      const until = Date.now() + 1000;
      let blocked = false;
      while (Date.now() < until) {
        const [state] =
          await fixture.db`select ${self!.pid}::int=any(pg_blocking_pids(${pid}::int)) blocked`;
        if (state!.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      await tx`select id from allrice_platform_maintenance_deployments where id=${g.deploymentId} for update`;
    });
    const lockWaiter = fixture.db.begin(async (tx) => {
      await issuerHeld;
      const [self] = await tx`select pg_backend_pid() pid`;
      announceWaiter(self!.pid);
      return assertMaintenanceGrant(tx, g.id, admin.actor.id);
    });
    const locks = await Promise.allSettled([lockOwner, lockWaiter]);
    expect(locks.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    const concurrent = await Promise.all([
      startMaintenanceRepairGrant(g.id),
      startMaintenanceRepairGrant(g.id),
    ]);
    const started = concurrent[0]!;
    expect(concurrent.map((x) => x.repairTaskId)).toEqual([
      started.repairTaskId,
      started.repairTaskId,
    ]);
    expect(concurrent.filter((x) => x.created)).toHaveLength(1);
    expect((await startMaintenanceRepairGrant(g.id)).repairTaskId).toBe(
      started.repairTaskId,
    );
    const [q] =
      await fixture.db`select q.*,j.timeout_at,e.execution_snapshot from allrice_platform_repair_tasks q join allrice_jobs j on j.id=q.job_id join allrice_employee_runs e on e.run_id=q.run_id where q.id=${started.repairTaskId!}`;
    expect(q!.frozen.version).toBe(2);
    expect(q!.frozen).not.toHaveProperty('loginSessionId');
    expect(q!.frozen).not.toHaveProperty('loginAuthenticatedAt');
    expect(q!.frozen.maintenance.grantId).toBe(g.id);
    expect(
      q!.execution_snapshot.modelSnapshot.runLimits.maxOutputTokens,
    ).toBeLessThanOrEqual(defaultMaintenancePolicy.maxOutputTokens);
    expect(q!.timeout_at.getTime()).toBeLessThanOrEqual(
      Date.parse(g.expiresAt),
    );
    const workerId = randomUUID(),
      job = await claimNextJob(workerId, 60000);
    expect(job?.id).toBe(q!.job_id);
    const lease = {
      workerId,
      jobId: job!.id,
      leaseToken: job!.lease!.token,
      attempt: job!.attempt,
    };
    const claimed = await startClaimedJob(workerId, job!.id, lease.leaseToken);
    const execution = await getPlatformRepairExecution(lease);
    expect(execution.frozen.version).toBe(2);
    const progress = createTaskProgressRuntime(
      { context: claimed!.context, worker: lease },
      fixture.db,
    );
    const nativeSessionId = 'maintenance-real-ledger';
    const call = randomUUID();
    const cap = defaultMaintenancePolicy.maxOutputTokens;
    expect(
      await progress({
        action: 'model_prepare',
        nativeSessionId,
        callId: call,
        requestedOutputTokens: cap,
      }),
    ).toMatchObject({ outputTokens: cap });
    await progress({
      action: 'start',
      kind: 'model',
      nativeSessionId,
      callId: call,
      outputTokens: cap,
      requestDigest: technicalDigest('real-native-request'),
    });
    await progress({
      action: 'finish',
      kind: 'model',
      nativeSessionId,
      callId: call,
      resultDigest: technicalDigest('first-result'),
      outcome: 'success',
      outputTokens: 1000,
    });
    // A new runtime object does not replenish the persisted grant budget.
    const restarted = createTaskProgressRuntime(
      { context: claimed!.context, worker: lease },
      fixture.db,
    );
    const second = randomUUID();
    expect(
      await restarted({
        action: 'model_prepare',
        nativeSessionId,
        callId: second,
        requestedOutputTokens: cap,
      }),
    ).toMatchObject({ outputTokens: cap - 1000 });
    await restarted({
      action: 'start',
      kind: 'model',
      nativeSessionId,
      callId: second,
      outputTokens: cap - 1000,
      requestDigest: technicalDigest('second-native-request'),
    });
    // An unresolved call retains its whole reservation; restarting cannot
    // create new credit. Its first receipt will arrive only after cancel.
    await expect(
      restarted({
        action: 'model_prepare',
        nativeSessionId,
        callId: randomUUID(),
        requestedOutputTokens: 1000,
      }),
    ).rejects.toThrow('maintenance_model_usage_unknown');
    const [clockBefore] =
      await fixture.db`select policy from allrice_task_clocks where run_id=${q!.run_id}`;
    await fixture.db`update allrice_task_clocks set policy=jsonb_set(policy,'{authorizationExpiresAt}',to_jsonb((select created_at+interval '1 millisecond' from allrice_jobs where id=${q!.job_id})::text)) where run_id=${q!.run_id}`;
    await expect(
      progress({ action: 'check', nativeSessionId }),
    ).rejects.toThrow('authorization_denied');
    await fixture.db`update allrice_task_clocks set policy=${fixture.db.json(clockBefore!.policy)} where run_id=${q!.run_id}`;
    const source = await readPlatformRepairSource(lease);
    const storage = new LocalStorageAdapter(join(root, 'private-storage'));
    const input = await preparePlatformRepairInput(
      lease,
      claimed!.context,
      storage,
    );
    const replay = await preparePlatformRepairInput(
      lease,
      claimed!.context,
      storage,
    );
    expect(replay.object).toEqual(input.object);
    await preparePlatformRepairInput(
      lease,
      claimed!.context,
      storage,
      'dependencies',
    );
    const prepared = await preparePlatformRepairVerification(
      lease,
      claimed!.context,
      source.candidate.checksum,
    );
    const [v] =
      await fixture.db`select proof from allrice_platform_repair_verifications where operation_id=${prepared.operationId}`;
    expect(v!.proof.version).toBe(3);
    expect(v!.proof.verificationPlanDigest).toBe(proof.verificationPlanDigest);
    expect(prepared.arguments.inputs).toHaveLength(2);
    expect(prepared.arguments.script).toContain(
      'config.maintenance.verificationPlan.approvedFiles',
    );
    // A comment outside the old regex slot is allowed by this full-file
    // manifest, but is not claimed to fix or pass any physical assertion.
    const next = await applyPlatformRepairCandidate(
      lease,
      'full-file-manifest',
      {
        action: 'apply',
        expectedCandidate: source.candidate.checksum,
        proposal: {
          files: [
            {
              path: repairProductPath,
              before: source.file.text,
              after:
                source.file.text + '\n// isolated manifest transport fixture\n',
            },
          ],
        },
      },
    );
    expect(next.revision).toBe(1);
    await expect(
      applyPlatformRepairCandidate(lease, 'assertion-write', {
        action: 'apply',
        expectedCandidate: next.checksum,
        proposal: {
          files: [
            {
              path: 'packages/project-runtime/src/command-output.test.ts',
              before: 'x',
              after: 'y',
            },
          ],
        },
      }),
    ).rejects.toThrow();
    await revokeMaintenanceGrant(admin, g.id);
    await expect(
      progress({ action: 'check', nativeSessionId }),
    ).rejects.toThrow('authorization_denied');
    await expect(
      progress({
        action: 'start',
        kind: 'model',
        nativeSessionId,
        callId: randomUUID(),
        outputTokens: 1,
        requestDigest: technicalDigest('revoked'),
      }),
    ).rejects.toThrow('authorization_denied');
    await expect(readPlatformRepairSource(lease)).rejects.toThrow(
      'authorization_denied',
    );
    // Historical read and explicit cancel remain possible after revocation.
    await cancelPlatformRepairTask(admin, q!.id);
    // The first receipt arrives after both revoke and cancel; it is stored
    // once, remains readable, and cannot be rewritten by a conflicting replay.
    await restarted({
      action: 'finish',
      kind: 'model',
      nativeSessionId,
      callId: second,
      resultDigest: technicalDigest('unknown-usage'),
      outcome: 'error',
    });
    const [settled] =
      await fixture.db`select finished_at,result_digest,settled_output_tokens from allrice_task_calls where run_id=${q!.run_id} and call_id=${second}`;
    expect(settled!.finished_at).toBeInstanceOf(Date);
    expect(settled!.result_digest).toBe(technicalDigest('unknown-usage'));
    expect(settled!.settled_output_tokens).toBeNull();
    await restarted({
      action: 'finish',
      kind: 'model',
      nativeSessionId,
      callId: second,
      resultDigest: technicalDigest('unknown-usage'),
      outcome: 'error',
    });
    await expect(
      restarted({
        action: 'finish',
        kind: 'model',
        nativeSessionId,
        callId: second,
        resultDigest: technicalDigest('conflicting-result'),
        outcome: 'error',
        outputTokens: 100,
      }),
    ).rejects.toThrow('task_progress_receipt_conflict');
    expect(
      await fixture.db`select * from allrice_memberships where organization_id=${company.org} order by id`,
    ).toEqual(untouched);
  });
  it('manual report-only authorization is immutable, idempotent and deduplicated across installations', async () => {
    const jobsBefore = (
      await fixture.db`select count(*)::int n from allrice_jobs`
    )[0]!.n;
    const a = await diagnosed(),
      b = await diagnosed();
    const [first, second] = await Promise.all([
      createMaintenanceGrant(admin, a.request),
      createMaintenanceGrant(admin, b.request),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(first.attemptId).toBe(second.attemptId);
    expect((await createMaintenanceGrant(admin, a.request)).id).toBe(first.id);
    await expect(
      createMaintenanceGrant(admin, {
        ...a.request,
        expectedReportDigest: repositoryDigest('wrong'),
      }),
    ).rejects.toThrow();
    const actual = await fixture.db.begin((tx) =>
      assertMaintenanceGrant(tx, first.id, admin.actor.id),
    );
    expect(actual.frozen.installedReleaseSha).toBe('c'.repeat(40));
    expect(actual.frozen.baseline.sourceSha).toBe('a'.repeat(40));
    expect(actual.frozen.origin).toBe('manual');
    expect(
      (await fixture.db`select count(*)::int n from allrice_jobs`)[0]!.n,
    ).toBe(jobsBefore);
    await revokeMaintenanceGrant(admin, first.id);
    const countBefore = (
      await fixture.db`select count(*)::int n from allrice_platform_maintenance_grants`
    )[0]!.n;
    expect(
      (await createMaintenanceGrant(admin, a.request)).revokedAt,
    ).not.toBeNull();
    expect(
      (
        await fixture.db`select count(*)::int n from allrice_platform_maintenance_grants`
      )[0]!.n,
    ).toBe(countBefore);
    await revokeMaintenanceGrant(admin, second.id);
    await expect(
      fixture.db.begin((tx) =>
        assertMaintenanceGrant(tx, first.id, admin.actor.id),
      ),
    ).rejects.toThrow();
  });
  it('configuration change, key rotation, expired grant, and revoked issuing login fence authority', async () => {
    for (const reason of ['policy', 'key', 'expiry'] as const) {
      const a = await diagnosed(),
        g = await createMaintenanceGrant(admin, a.request);
      if (reason === 'policy')
        await updateMaintenanceDeployment(admin, a.installation.deployment.id, {
          expectedRevision: 1,
          policy: { ...defaultMaintenancePolicy, paused: true },
        });
      if (reason === 'key')
        await rotateMaintenanceCredential(admin, a.installation.deployment.id, {
          expectedRevision: 1,
          action: 'rotate',
        });
      if (reason === 'expiry')
        await fixture.db`update allrice_platform_maintenance_grants set expires_at=clock_timestamp()-interval '1 second' where id=${g.id}`;
      await expect(
        fixture.db.begin((tx) =>
          assertMaintenanceGrant(tx, g.id, admin.actor.id),
        ),
      ).rejects.toThrow();
      await revokeMaintenanceGrant(admin, g.id);
    }
    const a = await diagnosed();
    await expect(
      createMaintenanceGrant({ ...admin, sessionId: randomUUID() }, a.request),
    ).rejects.toThrow();
    await expect(createMaintenanceGrant(ordinary, a.request)).rejects.toThrow();
  });
  it('automatic authorization excludes old reports and respects explicit expiry; manual can still select an old report', async () => {
    const i = await install(),
      r = await report(i, new Date(Date.now() - 60000).toISOString());
    await recordMaintenanceDiagnosis(r.reportId, proof);
    await updateMaintenanceDeployment(admin, i.deployment.id, {
      expectedRevision: 1,
      policy: {
        ...defaultMaintenancePolicy,
        mode: 'repair_and_pr',
        automaticAuthorizationUntil: new Date(
          Date.now() + 600000,
        ).toISOString(),
      },
    });
    await expect(createAutomaticMaintenanceGrant(r.reportId)).rejects.toThrow();
    const fresh = await report(i);
    await recordMaintenanceDiagnosis(fresh.reportId, proof);
    const g = await createAutomaticMaintenanceGrant(fresh.reportId);
    expect(g.origin).toBe('automatic');
    await revokeMaintenanceGrant(admin, g.id);
    const d = (await getMaintenanceReportAuthority(admin, r.reportId))
      .diagnoses[0]!;
    const manual = await createMaintenanceGrant(admin, {
      requestId: randomUUID(),
      reportId: r.reportId,
      expectedReportDigest: r.payloadDigest,
      expectedDiagnosisDigest: d.proofDigest,
      expectedDeploymentRevision: 2,
    });
    expect(manual.origin).toBe('manual');
    await revokeMaintenanceGrant(admin, manual.id);
  });
  it('a current target that does not reproduce remains report-only', async () => {
    const i = await install(),
      r = await report(i);
    const healthy = {
      ...proof,
      probeResults: proof.probeResults.map((x) => ({
        ...x,
        secretAbsent: true,
        passed: true,
      })),
      failedAssertions: [],
      verdict: 'not_reproduced' as const,
    };
    const d = await recordMaintenanceDiagnosis(r.reportId, healthy);
    expect(d.defectId).toBeNull();
    await expect(
      createMaintenanceGrant(admin, {
        requestId: randomUUID(),
        reportId: r.reportId,
        expectedReportDigest: r.payloadDigest,
        expectedDiagnosisDigest: d.proofDigest,
        expectedDeploymentRevision: 1,
      }),
    ).rejects.toThrow();
  });
  it('keeps separate authorizations and request provenance across two administrators without lending grants', async () => {
    const a = await diagnosed(),
      b = await diagnosed(other);
    const [first, second] = await Promise.all([
      createMaintenanceGrant(admin, a.request),
      createMaintenanceGrant(other, b.request),
    ]);
    expect(first.id).not.toBe(second.id);
    expect(first.attemptId).toBe(second.attemptId);
    expect(first.reportId).toBe(a.receipt.reportId);
    expect(second.reportId).toBe(b.receipt.reportId);
    await expect(
      getMaintenanceReportAuthority(other, a.receipt.reportId),
    ).rejects.toThrow();
    expect(
      (
        await getMaintenanceReportAuthority(other, b.receipt.reportId)
      ).grants.map((g) => g.id),
    ).toEqual([second.id]);
    await expect(
      fixture.db.begin((tx) =>
        assertMaintenanceGrant(tx, first.id, other.actor.id),
      ),
    ).rejects.toThrow();
    await expect(
      createAutomaticMaintenanceGrant(a.receipt.reportId),
    ).rejects.toThrow();
    await revokeMaintenanceGrant(admin, first.id);
    await revokeMaintenanceGrant(other, second.id);
  });
  it('serializes the per-deployment daily cap across different defects, without charging an idempotent replay', async () => {
    const installation = await install();
    await updateMaintenanceDeployment(admin, installation.deployment.id, {
      expectedRevision: 1,
      policy: { ...defaultMaintenancePolicy, dailyRepairLimit: 1 },
    });
    const a = await report(installation),
      b = await report(installation);
    const da = await recordMaintenanceDiagnosis(a.reportId, proof);
    const alternate = {
      ...proof,
      probeResults: proof.probeResults.map((r, i) =>
        i === 0 ? { ...r, secretAbsent: true, passed: true } : r,
      ),
      failedAssertions: proof.failedAssertions.slice(1),
    };
    const db = await recordMaintenanceDiagnosis(b.reportId, alternate);
    const request = (r: typeof a, d: typeof da) => ({
      requestId: randomUUID(),
      reportId: r.reportId,
      expectedReportDigest: r.payloadDigest,
      expectedDiagnosisDigest: d.proofDigest,
      expectedDeploymentRevision: 2,
    });
    const requests = [request(a, da), request(b, db)];
    const results = await Promise.allSettled(
      requests.map((r) => createMaintenanceGrant(admin, r)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const index = results.findIndex((r) => r.status === 'fulfilled');
    const granted = (
      results[index] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof createMaintenanceGrant>>
      >
    ).value;
    expect((await createMaintenanceGrant(admin, requests[index])).id).toBe(
      granted.id,
    );
    expect(
      (
        await fixture.db`select count(*)::int n from allrice_platform_maintenance_grants where deployment_id=${installation.deployment.id}`
      )[0]!.n,
    ).toBe(1);
    await revokeMaintenanceGrant(admin, granted.id);
  });
  it('wires a persisted grant through the real publication queue, fences inspect writes, and avoids running-repair lock inversion', async () => {
    // Finish only this suite's already-canceled synthetic Job; no Worker runs here.
    await fixture.db`update allrice_jobs set status='canceled' where owner_id=${admin.actor.id} and cancel_requested_at is not null`;
    const installation = await install(),
      receipt = await report(installation);
    const uniqueProof = {
      ...proof,
      probeResults: proof.probeResults.map((r, i) =>
        i === 0 ? r : { ...r, secretAbsent: true, passed: true },
      ),
      failedAssertions: proof.failedAssertions.slice(0, 1),
    };
    const diagnosis = await recordMaintenanceDiagnosis(
      receipt.reportId,
      uniqueProof,
    );
    const grant = await createMaintenanceGrant(admin, {
      requestId: randomUUID(),
      reportId: receipt.reportId,
      expectedReportDigest: receipt.payloadDigest,
      expectedDiagnosisDigest: diagnosis.proofDigest,
      expectedDeploymentRevision: 1,
    });
    const started = await startMaintenanceRepairGrant(grant.id);
    const [q] =
      await fixture.db`select * from allrice_platform_repair_tasks where id=${started.repairTaskId!}`;
    const principal = {
      ...admin,
      organizationId: q!.organization_id,
      workspaceId: q!.workspace_id,
    };
    let held!: () => void, credentials!: () => void;
    const jobHeld = new Promise<void>((r) => (held = r)),
      credentialHeld = new Promise<void>((r) => (credentials = r));
    // Real barrier: repair owns Job UPDATE, publication owns issuer/bot locks.
    // A running Job must be excluded before SELECT ... FOR SHARE waits on it.
    const repairTx = fixture.db.begin(async (tx) => {
      await tx`set local statement_timeout='2s'`;
      await tx`select id from allrice_jobs where id=${q!.job_id} for update`;
      held();
      await credentialHeld;
      await assertMaintenanceGrant(tx, grant.id, admin.actor.id);
    });
    const publicationTx = fixture.db.begin(async (tx) => {
      await tx`set local statement_timeout='2s'`;
      await jobHeld;
      await assertMaintenanceGrant(tx, grant.id, admin.actor.id);
      credentials();
      await expect(
        readAcceptedRepositorySource(tx, principal, q!.id, baseline.sourceSha),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
    expect(
      (await Promise.allSettled([repairTx, publicationTx])).map(
        (r) => r.status,
      ),
    ).toEqual(['fulfilled', 'fulfilled']);
    await expect(startMaintenancePublication(grant.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    // Explicitly synthetic accepted verifier receipts: this tests PostgreSQL
    // admission and authority, not physical compilation or an actual repair.
    const synthetic = acceptedRepositoryFixture(
      admin.sessionId!,
      admin.authenticatedAt!,
    );
    const frozen = q!.frozen,
      after =
        frozen.baselineText + '\n// synthetic publication authority fixture\n';
    const candidate = repositoryCandidate(1, [
      {
        path: repairProductPath,
        beforeChecksum: repositoryDigest(frozen.baselineText),
        afterBase64: Buffer.from(after).toString('base64'),
      },
    ]);
    const deps = frozen.baseline.compiledDependencies;
    const verification = (
      r: typeof synthetic.report.before.report,
      revision: number,
    ) => {
      if (r.version !== 2) throw Error('COMPILED_SYNTHETIC_FIXTURE_REQUIRED');
      return {
        ...r,
        version: 3,
        profileId: maintenanceCompiledProfileId,
        baselineId: baseline.id,
        sourceSha: baseline.sourceSha,
        baselineSourceDigest: baseline.sourceDigest,
        restoredDigest: baseline.sourceDigest,
        candidateChecksum: revision
          ? candidate.checksum
          : repositoryCandidate(0, []).checksum,
        rootLockChecksum: baseline.rootLockChecksum,
        dependencyConfigurationDigest: baseline.dependencyConfigurationDigest,
        harnessChecksum: frozen.harnessChecksum,
        sourceFileCount: baseline.fileCount,
        sourceBytes:
          baseline.sourceBytes +
          (revision
            ? Buffer.byteLength(after) - Buffer.byteLength(frozen.baselineText)
            : 0),
        verificationPlanDigest: frozen.maintenance.verificationPlanDigest,
        manifestDigest: technicalDigest(
          frozen.maintenance.verificationPlan.approvedFiles,
        ),
        compiled: {
          ...r.compiled,
          dependencyBundleChecksum: deps.bundleChecksum,
          dependencyMaterialDigest: deps.materialDigest,
          planDigest: deps.planDigest,
        },
      };
    };
    const accepted = RepairReportSchema.parse({
      ...synthetic.report,
      candidateChecksum: candidate.checksum,
      before: {
        ...synthetic.report.before,
        report: verification(synthetic.report.before.report, 0),
      },
      after: {
        ...synthetic.report.after,
        report: verification(synthetic.report.after.report, 1),
      },
    });
    await fixture.db`update allrice_platform_repair_tasks set candidate=${fixture.db.json(candidate)},report=${fixture.db.json(accepted)} where id=${q!.id}`;
    await fixture.db`update allrice_jobs set status='succeeded' where id=${q!.job_id}`;
    const p = await startMaintenancePublication(grant.id);
    expect((await startMaintenancePublication(grant.id)).runId).toBe(p.runId);
    const [a] =
      await fixture.db`select a.*,p.provenance from allrice_platform_repository_actions a join allrice_platform_repository_publications p on p.id=a.publication_id where a.publication_id=${p.publicationId}`;
    expect(a!.authority_version).toBe(2);
    expect(a!.login_session_id).toBeNull();
    expect(a!.maintenance_grant_id).toBe(grant.id);
    expect(a!.provenance.companySlug).toBe(installation.deployment.companySlug);
    const workerId = randomUUID(),
      j = await claimNextJob(workerId, 60000);
    expect(j!.id).toBe(a!.job_id);
    await startClaimedJob(workerId, j!.id, j!.lease!.token);
    const lease = {
      workerId,
      jobId: j!.id,
      leaseToken: j!.lease!.token,
      attempt: j!.attempt,
    };
    expect((await repositoryRequestGate(lease, 'POST')).token).toMatch(
      /^github_pat_/,
    );
    const shown = await getMaintenanceReportAuthority(admin, receipt.reportId);
    expect(shown.grants[0]!.publication?.id).toBe(p.publicationId);
    await revokeMaintenanceGrant(admin, grant.id);
    await expect(repositoryRequestGate(lease, 'POST')).rejects.toThrow();
    expect((await repositoryRequestGate(lease, 'GET')).token).toMatch(
      /^github_pat_/,
    );
    // Inspection is a separate canonical Job; only GET may use reconciliation
    // even after revocation, expiry and a same-account credential rotation.
    await fixture.db`update allrice_jobs set status='failed' where id=${j!.id}`;
    const inspect = await startMaintenancePublication(grant.id, 'inspect');
    const inspectWorker = randomUUID(),
      ij = await claimNextJob(inspectWorker, 60000);
    expect(
      (await fixture.db`select run_id from allrice_jobs where id=${ij!.id}`)[0]!
        .run_id,
    ).toBe(inspect.runId);
    await startClaimedJob(inspectWorker, ij!.id, ij!.lease!.token);
    const il = {
      workerId: inspectWorker,
      jobId: ij!.id,
      leaseToken: ij!.lease!.token,
      attempt: ij!.attempt,
    };
    await fixture.db`update allrice_platform_maintenance_grants set expires_at=clock_timestamp()-interval '1 second' where id=${grant.id}`;
    await updateMaintenanceGithubBot(
      admin,
      {
        action: 'replace',
        requestId: randomUUID(),
        expectedRevision: 1,
        expectedLogin: 'rice-maintenance',
        token: 'github_pat_' + 'SyntheticOnly'.repeat(7),
      },
      {
        fetcher: (async (url) =>
          Response.json(
            String(url).endsWith('/user')
              ? { id: 901, login: 'rice-maintenance' }
              : {
                  id: 1323769790,
                  full_name: 'semiok/allrice',
                  permissions: { push: true },
                },
          )) as typeof fetch,
      },
    );
    expect((await readRepositoryAction(il)).source.version).toBe(2);
    expect(
      await heartbeatJob(il.workerId, il.jobId, il.leaseToken, 60000),
    ).toEqual({ active: true, canceled: false });
    for (const method of ['POST', 'PUT'] as const)
      await expect(repositoryRequestGate(il, method)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
    expect((await repositoryRequestGate(il, 'GET')).token).toMatch(
      /^github_pat_/,
    );
    await expect(
      getMaintenanceReportAuthority(other, receipt.reportId),
    ).rejects.toThrow();
  });
  it('invalid fixture reports cannot occupy the finite diagnosis window', async () => {
    const installation = await install();
    for (let n = 0; n < 10; n++)
      await report(
        installation,
        new Date().toISOString(),
        repositoryDigest('wrong-public-fixture'),
      );
    const valid = await report(installation);
    expect(
      (await maintenanceDiagnosisCandidates(baseline.sourceSha)).map(
        (r) => r.id,
      ),
    ).toContain(valid.reportId);
  });
});
