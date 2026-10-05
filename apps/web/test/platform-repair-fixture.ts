/** Synthetic API/UI transport only; no execution or repair acceptance evidence. */
import { randomUUID } from 'node:crypto';
import {
  RepairTaskSchema,
  RepositoryBaselineSchema,
} from '@allrice/database/technical-contracts';
export function repairFixture(
  requestId = randomUUID(),
  baseline = RepositoryBaselineSchema.parse({
    version: 1,
    id: randomUUID(),
    repositoryId: 'semiok/allrice',
    sourceSha: 'a'.repeat(40),
    gitTree: 'b'.repeat(40),
    sourceDigest: 'sha256:' + 'a'.repeat(64),
    rootLockChecksum: 'sha256:' + 'b'.repeat(64),
    dependencyConfigurationDigest: 'sha256:' + 'c'.repeat(64),
    archiveChecksum: 'sha256:' + 'd'.repeat(64),
    archiveBytes: 3000,
    fileCount: 4,
    sourceBytes: 6000,
    observedDevSha: 'a'.repeat(40),
    registeredAt: new Date().toISOString(),
    materializer: 'git-tracked-json-gzip-v1',
    profileId: 'allrice.output-redaction.v1',
    dependencyMode: 'runtime_builtins_only',
    monorepoDependenciesInstalled: false,
  }),
) {
  return RepairTaskSchema.parse({
    id: randomUUID(),
    requestId,
    runId: randomUUID(),
    jobId: randomUUID(),
    sessionId: randomUUID(),
    status: 'queued',
    baseline,
    releaseSha: baseline.sourceSha,
    employeeVersionId: randomUUID(),
    employeeRevisionId: randomUUID(),
    candidate: {
      version: 1,
      revision: 0,
      checksum: 'sha256:' + 'e'.repeat(64),
      files: [],
    },
    source: {
      path: 'packages/project-runtime/src/command-output.ts',
      before: 'Synthetic original source.',
      after: null,
    },
    verifications: [],
    report: null,
    accepted: false,
    createdAt: new Date().toISOString(),
    errorCode: null,
  });
}
