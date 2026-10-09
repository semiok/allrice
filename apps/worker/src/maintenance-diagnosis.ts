import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { LocalCommandOutputFilter } from '@allrice/project-runtime';
import {
  DataAccessError,
  repositoryDigest,
  technicalDigest,
  repositoryCatalog,
  loadRepositoryBaseline,
  maintenanceRepairPlan,
  maintenanceOracleChecksum,
  maintenanceDiagnosisCandidates,
  recordMaintenanceDiagnosis,
  verifyServiceBuildIdentity,
  ServiceBuildManifestSchema,
  type ServiceBuildIdentity,
} from '@allrice/database';
import {
  MaintenanceSourceMappingSchema,
  MaintenanceDiagnosisProofSchema,
  maintenanceProbeFixtures,
} from '@allrice/database/technical-contracts';

/** Uses the actual production package export loaded by this Worker. Exceptions
 * and incomplete probes are not converted into healthy/confirmed results. */
export function runCentralMaintenanceProbe() {
  return maintenanceProbeFixtures.map((fixture) => {
    const filter = new LocalCommandOutputFilter();
    let output = '';
    for (const chunk of fixture.chunks)
      output += filter.push(Buffer.from(chunk));
    output += filter.push(Buffer.alloc(0), true);
    const redactionMarkerPresent = output.includes('[REDACTED]');
    const secretAbsent = fixture.forbidden.every(
      (word) => !output.includes(word),
    );
    return {
      id: fixture.id,
      completed: true as const,
      redactionMarkerPresent,
      secretAbsent,
      passed: redactionMarkerPresent && secretAbsent,
    };
  });
}

export async function captureMaintenanceDiagnosticRuntime(
  identity: ServiceBuildIdentity | null,
) {
  const ending = '/apps/worker/dist/index.js';
  if (
    !identity ||
    identity.service !== 'worker' ||
    identity.mode !== 'production' ||
    !process.argv[1]
  )
    return null;
  const entry = await realpath(resolve(process.argv[1]));
  if (!entry.endsWith(ending)) return null;
  const root = entry.slice(0, -ending.length);
  try {
    const mappingBytes = await readFile(
      root + '/apps/worker/dist/maintenance-source-proof.json',
    );
    if (mappingBytes.length > 20000) return null;
    const mapping = MaintenanceSourceMappingSchema.parse(
      JSON.parse(mappingBytes.toString('utf8')),
    );
    const manifestBytes = await readFile(
      root + '/.local/dev-build-identity.json',
    );
    if (manifestBytes.length > 4 * 1024 ** 2) return null;
    const manifest = ServiceBuildManifestSchema.parse(
      JSON.parse(manifestBytes.toString('utf8')),
    );
    const measured = (path: string, checksum: string) =>
      manifest.files.some((f) => f.path === path && f.checksum === checksum);
    const resolvedExport = await realpath(
      fileURLToPath(import.meta.resolve('@allrice/project-runtime')),
    );
    if (
      identity.manifestDigest !== manifest.manifestDigest ||
      identity.sourceTree !== mapping.sourceTree ||
      identity.sourceSha !== manifest.sourceSha ||
      resolvedExport !== root + '/' + mapping.exportEntryPath ||
      !measured(
        'apps/worker/dist/maintenance-source-proof.json',
        repositoryDigest(mappingBytes),
      ) ||
      !measured(mapping.outputPath, mapping.outputChecksum) ||
      !measured(mapping.exportEntryPath, mapping.exportEntryChecksum)
    )
      return null;
    if (
      repositoryDigest(await readFile(root + '/' + mapping.outputPath)) !==
        mapping.outputChecksum ||
      repositoryDigest(await readFile(resolvedExport)) !==
        mapping.exportEntryChecksum
    )
      return null;
    return {
      root,
      entry,
      identity,
      mapping,
      mappingBytesDigest: repositoryDigest(mappingBytes),
    };
  } catch {
    return null;
  }
}

export async function runMaintenanceDiagnosisTick(
  runtime: Awaited<ReturnType<typeof captureMaintenanceDiagnosticRuntime>>,
  signal?: AbortSignal,
) {
  if (!runtime || signal?.aborted) return;
  const candidates = await maintenanceDiagnosisCandidates(
    runtime.identity.sourceSha,
  );
  if (!candidates.length || signal?.aborted) return;
  // Re-measure before using the boot capture. Rewriting a release after the
  // module was loaded cannot create evidence for the old loaded object.
  const measured = await verifyServiceBuildIdentity({
    entrypoint: runtime.entry,
    service: 'worker',
    mode: 'production',
    claimedSha: runtime.identity.sourceSha,
  });
  if (
    !measured ||
    measured.manifestDigest !== runtime.identity.manifestDigest ||
    measured.artifactDigest !== runtime.identity.artifactDigest ||
    measured.runtimeGraphDigest !== runtime.identity.runtimeGraphDigest
  )
    return;
  const catalog = repositoryCatalog(
    process.env.ALLRICE_REPOSITORY_BASELINE_DIR,
  );
  const baseline = catalog.baselines.find(
    (b) =>
      b.sourceSha === runtime.identity.sourceSha &&
      b.gitTree === runtime.identity.sourceTree,
  );
  if (!baseline || !baseline.compiledDependencies) return;
  const registered = loadRepositoryBaseline(
    process.env.ALLRICE_REPOSITORY_BASELINE_DIR,
    baseline.id,
  );
  const verificationPlan = maintenanceRepairPlan(baseline, registered.archive),
    probeResults = runCentralMaintenanceProbe();
  const failedAssertions = probeResults
    .filter((r) => !r.passed)
    .map((r) => r.id);
  const proof = MaintenanceDiagnosisProofSchema.parse({
    version: 1,
    specId: 'command-output.credentials.v2',
    baseline,
    verificationPlan,
    verificationPlanDigest: technicalDigest(verificationPlan),
    producerSourceSha: runtime.identity.sourceSha,
    producerSourceTree: runtime.identity.sourceTree,
    producerManifestDigest: runtime.identity.manifestDigest,
    producerArtifactDigest: runtime.identity.artifactDigest,
    producerBootId: runtime.identity.bootId,
    producerNodeVersion: runtime.identity.nodeVersion,
    producerRuntimeGraphDigest: runtime.identity.runtimeGraphDigest,
    sourceMapping: runtime.mapping,
    sourceMappingDigest: technicalDigest(runtime.mapping),
    moduleArtifactDigest: runtime.mapping.outputChecksum,
    exportEntryArtifactDigest: runtime.mapping.exportEntryChecksum,
    oracleChecksum: maintenanceOracleChecksum,
    probeResults,
    failedAssertions,
    verdict: failedAssertions.length ? 'confirmed_code' : 'not_reproduced',
  });
  for (const report of candidates) {
    if (signal?.aborted) return;
    try {
      await recordMaintenanceDiagnosis(report.id, proof);
    } catch (error) {
      if (!(error instanceof DataAccessError)) throw error;
    }
  }
}
