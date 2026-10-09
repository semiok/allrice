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
import { defaultMaintenancePolicy } from './platform-maintenance-contracts.ts';
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
  it('manual report-only authorization is immutable, idempotent and deduplicated across installations', async () => {
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
    ).toBe(0);
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
    // Test the service fence directly; the public pipeline remains disabled in PR2a.
    await fixture.db`update allrice_platform_maintenance_deployments set policy=${fixture.db.json({ ...defaultMaintenancePolicy, mode: 'repair_and_pr', automaticAuthorizationUntil: new Date(Date.now() + 600000).toISOString() })},enabled_at=clock_timestamp() where id=${i.deployment.id}`;
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
      expectedDeploymentRevision: 1,
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
