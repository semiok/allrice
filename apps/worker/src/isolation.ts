import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { UuidSchema } from '@allrice/contracts';

export interface ExecutionIsolation {
  workDirectory: string;
  environment: Readonly<Record<string, string>>;
  cleanup(): Promise<void>;
}

export async function prepareExecutionIsolation(input: {
  root: string;
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  runId: string;
  jobId: string;
  attempt: number;
}): Promise<ExecutionIsolation> {
  const ids = {
    organizationId: UuidSchema.parse(input.organizationId),
    workspaceId: UuidSchema.parse(input.workspaceId),
    ownerId: UuidSchema.parse(input.ownerId),
    runId: UuidSchema.parse(input.runId),
    jobId: UuidSchema.parse(input.jobId),
  };
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error('execution attempt must be a positive integer');
  }
  const root = resolve(input.root);
  const runRoot = resolve(
    root,
    ids.organizationId,
    ids.workspaceId,
    ids.ownerId,
    ids.runId,
  );
  if (!runRoot.startsWith(`${root}${sep}`)) {
    throw new Error('execution path escaped its configured root');
  }
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  const previousAttempts = await readdir(runRoot, { withFileTypes: true });
  for (const entry of previousAttempts) {
    if (entry.isDirectory() && entry.name.startsWith('attempt-')) {
      await rm(resolve(runRoot, entry.name), { recursive: true, force: true });
    }
  }
  const workDirectory = await mkdtemp(
    join(runRoot, `attempt-${input.attempt}-`),
  );
  return {
    workDirectory,
    environment: Object.freeze({
      ALLRICE_RUN_ID: ids.runId,
      ALLRICE_JOB_ID: ids.jobId,
      ALLRICE_ORGANIZATION_ID: ids.organizationId,
      ALLRICE_WORKSPACE_ID: ids.workspaceId,
      ALLRICE_OWNER_ID: ids.ownerId,
      ALLRICE_ATTEMPT: String(input.attempt),
    }),
    async cleanup() {
      await rm(workDirectory, { recursive: true, force: true });
    },
  };
}
