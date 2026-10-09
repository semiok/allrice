import { maintenanceProbeFixtures } from './platform-maintenance-probe.ts';
import { repositoryDigest } from './platform-repository-source.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  repairAssertionCases,
  repositoryHarness,
} from './platform-repair-oracle.ts';
import {
  compiledRepositoryHarness,
  compiledRepairChildHarness,
} from './platform-repair-compiled-profile.ts';
import { MaintenanceRepairPlanSchema } from './platform-maintenance-authority-contracts.ts';
import {
  maintenanceCompiledProfileId,
  repairProductPath,
  type RepositoryBaseline,
  type RepositoryArchive,
} from './platform-repair-contracts.ts';
export { maintenanceCompiledProfileId } from './platform-repair-contracts.ts';
/** Same immutable parent/compiler/child isolation, with an explicit approved
 * source manifest instead of a regex-replacement slot. Assertions never enter
 * the candidate's write set. This registered profile covers one pure module. */
export function maintenanceRepositoryHarness() {
  let value = compiledRepositoryHarness(repositoryHarness);
  const start = value.indexOf(
      " const original=Buffer.from(f.contentBase64,'base64').toString('utf8'),after=b.toString('utf8'),start=",
    ),
    end = value.indexOf(" const p=root+'/'+patch.path;", start);
  if (start < 0 || end < start) throw Error('MAINTENANCE_VERIFIER_TEMPLATE');
  value =
    value.slice(0, start) +
    String.raw`
 const allowed=config.maintenance.verificationPlan.approvedFiles.find(a=>a.path===patch.path);
 if(!allowed||allowed.mode!==f.mode||allowed.beforeChecksum!==f.checksum||b.length>allowed.maxBytes||b.includes(0)||!new TextDecoder('utf8',{fatal:true}).decode(b))throw Error('MAINTENANCE_MANIFEST_CHANGED');
` +
    value.slice(end);
  const before = 'const report={version:2,compiled,';
  if (value.split(before).length !== 2)
    throw Error('MAINTENANCE_VERIFIER_TEMPLATE');
  return value
    .replace(
      before,
      'const report={version:3,compiled,verificationPlanDigest:config.maintenance.verificationPlanDigest,manifestDigest:config.maintenance.manifestDigest,',
    )
    .replace(
      'profileId:config.profileId,harnessChecksum:',
      'profileId:config.maintenance.profileId,harnessChecksum:',
    );
}
export const maintenanceOracleVersion =
  'allrice-output-probe.oracle.v1' as const;
export const maintenanceFixtureDigest = repositoryDigest(
  JSON.stringify(maintenanceProbeFixtures),
);
export const maintenanceOracleChecksum = technicalDigest({
  version: maintenanceOracleVersion,
  fixtures: maintenanceProbeFixtures,
  predicate: 'completed && redactionMarkerPresent && secretAbsent',
});
export const maintenanceVerificationHarnessChecksum = technicalDigest({
  harness: maintenanceRepositoryHarness(),
  childHarness: compiledRepairChildHarness,
  cases: repairAssertionCases,
  oracle: maintenanceOracleVersion,
  allowedProductPath: repairProductPath,
  profileId: maintenanceCompiledProfileId,
});
export function maintenanceRepairPlan(
  baseline: RepositoryBaseline,
  archive: RepositoryArchive,
) {
  const deps = baseline.compiledDependencies,
    file = archive.files.find((f) => f.path === repairProductPath);
  if (!deps || !file || file.mode !== '100644' || file.sizeBytes > 50000)
    throw Error('MAINTENANCE_PROFILE_UNAVAILABLE');
  return MaintenanceRepairPlanSchema.parse({
    version: 1,
    specId: 'command-output.credentials.v2',
    fixtureDigest: technicalDigest({
      probe: maintenanceProbeFixtures,
      assertions: repairAssertionCases,
    }),
    harnessChecksum: maintenanceVerificationHarnessChecksum,
    approvedFiles: [
      {
        path: repairProductPath,
        mode: '100644',
        beforeChecksum: file.checksum,
        maxBytes: 50000,
      },
    ],
    dependencyBundleChecksum: deps.bundleChecksum,
    dependencyMaterialDigest: deps.materialDigest,
    dependencyPlanDigest: deps.planDigest,
    packages: ['@allrice/contracts', '@allrice/project-runtime'],
    compilerVersion: '5.9.3',
    nodeVersion: deps.nodeVersion,
    timeoutMs: deps.timeoutMs,
    network: 'none',
    candidateUid: 1001,
    compilerUid: 1002,
    memoryMiB: 768,
    compilerHeapMiB: 384,
  });
}
