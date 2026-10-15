/** Real gVisor component checks with synthetic scoped authority. The operator
 * owns both shared windows, checks idle, installs/restores the exact guard.
 * No model, tenant or Bridge state is changed by this script. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  CloudCommandSchema,
  ProjectDependencyResolveInputSchema,
  SandboxNetworkLeaseSchema,
  cloudToolchainImageV1,
  cloudPythonImageV1,
  projectResolutionCloudArguments,
  canonicalRuntimeBridgeJson,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
  type SandboxExecutionBudgetState,
} from '../../../packages/contracts/src/index.js';
import { readResolvedProject } from '../../../packages/project-runtime/src/project-resolution.js';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';
const directory = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
assert.ok(
  directory && process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW === 'owned',
);
const lock = JSON.parse(
  await readFile('/Users/a123/allrice-dev/.local/qa-validation.lock', 'utf8'),
);
assert.equal(lock.owner, 'met189-native-sandbox');
assert.equal(lock.pid, process.ppid);
await mkdir(directory, { recursive: true, mode: 0o700 });
const save = (name: string, value: unknown) =>
  writeFile(
    directory + '/' + name + '.json',
    JSON.stringify(value, null, 2) + '\n',
    { mode: 0o600 },
  );
const backend = new CloudRunnerBackend(),
  checks: unknown[] = [];
const cases = [
  {
    name: 'pnpm-resolve',
    manager: 'pnpm',
    packages: [{ name: 'is-number', version: '7.0.0' }],
  },
  {
    name: 'uv-resolve',
    manager: 'uv',
    packages: [{ name: 'six', version: '1.17.0' }],
  },
  {
    name: 'pnpm-missing-package',
    manager: 'pnpm',
    packages: [
      { name: 'allrice-nonexistent-synthetic-409831', version: '1.0.0' },
    ],
    failed: true,
  },
  {
    name: 'rea-resolve',
    manager: 'pnpm',
    packages: [{ name: 'rea-agents', version: '6.5.0' }],
    resourceProfile: 'web-development',
  },
];
const selected = process.env.ALLRICE_SANDBOX_ACCEPTANCE_CASES?.split(',');
try {
  for (const item of cases.filter(
    (c) => !selected || selected.includes(c.name),
  )) {
    const request = ProjectDependencyResolveInputSchema.parse({
      action: 'resolve',
      manager: item.manager,
      packages: item.packages,
      ...(item.resourceProfile
        ? { resourceProfile: item.resourceProfile }
        : {}),
    });
    const args = projectResolutionCloudArguments(request),
      attemptId = randomUUID();
    const spec = sandboxExecutionBudgetSpec(
      { version: 1, kind: 'install' },
      { version: 1, maxExecutionMs: 600000, sources: [] },
    );
    const command = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      imageDigest:
        request.manager === 'uv' ? cloudPythonImageV1 : cloudToolchainImageV1,
      arguments: args,
      network: args.network,
      executionBudget: spec,
      origin: {
        toolName: 'workspace.project',
        callId: item.name,
        purpose: 'project_dependency_resolution',
        argumentsDigest:
          'sha256:' +
          createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        request,
      },
    });
    const hard = Date.now() + 600000;
    const networkLease = SandboxNetworkLeaseSchema.parse({
      version: 1,
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
      runId: randomUUID(),
      operationId: randomUUID(),
      attemptId,
      target: { kind: 'cloud', targetId: randomUUID() },
      grantId: randomUUID(),
      grantVersion: 1,
      network: args.network,
      policyDigest:
        'sha256:' +
        createHash('sha256')
          .update(canonicalRuntimeBridgeJson({ network: args.network }))
          .digest('hex'),
      expiresAt: new Date(hard).toISOString(),
      maximumConnections: 16,
      maximumBytes: 64 * 1024 * 1024,
    });
    let state: SandboxExecutionBudgetState | undefined;
    try {
      const result = await backend.execute(command, [], {
        attemptId,
        deadlineAt: new Date(hard).toISOString(),
        maintainLease: async () => true,
        networkLease,
        sandboxExecution: {
          spec,
          exchange: async (renewal) => {
            state ??= startSandboxExecutionBudget(spec, Date.now(), hard);
            if (renewal)
              state = renewSandboxExecutionBudget(
                state,
                renewal,
                Date.now(),
                hard,
              );
            return state;
          },
        },
      });
      await save(item.name, { attemptId, request, result, state });
      if (item.failed) {
        assert.equal(result.reason, 'failed');
        assert.equal(result.resolution?.status, 'failed');
        assert.notEqual(result.exitCode, 0);
        assert.ok(result.resolution?.diagnostics.includes('404'));
      } else {
        assert.equal(result.reason, 'completed');
        assert.equal(result.exitCode, 0);
        assert.equal(result.resolution?.status, 'resolved');
        const project = readResolvedProject(
          request,
          Buffer.from(JSON.stringify(result.resolution)),
        );
        assert.ok(project.files && project.forProject);
        await save(item.name + '-project', {
          files: project.files,
          sourceDigest: project.sourceDigest,
          projectPreparation: project.forProject(randomUUID()),
        });
      }
      checks.push({
        name: item.name,
        passed: true,
        elapsedMs: result.elapsedMs,
        network: result.network,
      });
      console.log(JSON.stringify(checks.at(-1)));
    } finally {
      const c = await backend.inspect(attemptId);
      if (c?.State.Running) await backend.stop(attemptId);
      await backend.cleanup(attemptId, command);
      assert.equal(await backend.inspect(attemptId), null);
    }
  }
  await save('checks', { passed: true, checks });
} catch (error) {
  await save('checks', {
    passed: false,
    checks,
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}
