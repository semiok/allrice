/** Actual Bridge project preparation, scoped network and shared budget checks.
 * Only the operator's synthetic projects, containers and cache volumes are used. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeLocalCommandSchema,
  managedPythonPayloadForPlatform,
  localCommandToolchainImageV1,
  SandboxNetworkLeaseSchema,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
} from '../../../packages/contracts/src/index.js';
import { SandboxExecutionBudgetController } from '../../../packages/project-runtime/src/sandbox-execution-budget.js';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import { projectFixture } from '../../../apps/rice-bridge/test/project-fixture.js';
import {
  projectSourceDigest,
  projectCacheKey,
} from '../../../apps/rice-bridge/src/project-preparation.js';
assert.equal(process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW, 'owned');
const output = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT,
  socketPath = process.env.ALLRICE_BRIDGE_ACCEPTANCE_SOCKET;
assert.ok(output && socketPath);
const release = managedPythonPayloadForPlatform(`macos-${process.arch}`)!;
const runner = new LocalCommandRunner({
  socketPath,
  imageDigest: localCommandToolchainImageV1,
  projectPreparation: {
    root: join(output, 'archives'),
    pythonImage: release.imageId,
    architecture: release.architecture,
  },
});
const proof = {
  architecture: release.architecture,
  checks: {} as Record<string, unknown>,
  passed: false,
};
const save = () =>
  writeFile(
    join(output, 'report.json'),
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
const sha = (x: Buffer | string) =>
  'sha256:' + createHash('sha256').update(x).digest('hex');
for (const manager of ['pnpm', 'uv'] as const) {
  if (
    process.env.ALLRICE_BRIDGE_ACCEPTANCE_PROJECT_MANAGER &&
    process.env.ALLRICE_BRIDGE_ACCEPTANCE_PROJECT_MANAGER !== manager
  )
    continue;
  const f = projectFixture(manager, release.architecture),
    root = await mkdtemp(join(tmpdir(), 'allrice-project-network-'));
  const scope = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };
  const file = manager === 'pnpm' ? 'verify.cjs' : 'verify.py';
  f.files[file] = Buffer.concat([
    f.files[file]!,
    Buffer.from(
      manager === 'pnpm'
        ? `
async function main(){const r=await fetch('https://pypi.org/simple/six/',{signal:AbortSignal.timeout(15000)});if(r.status!==200)throw Error('HTTP '+r.status);await r.text();console.log('NETWORK_OK');if(process.argv.includes('long')){const until=Date.now()+65000;let n=0;while(Date.now()<until){for(let j=0;j<1000;j++)n=Math.sin(n+j);}console.log('CONTINUED',n);}}main().catch(e=>{console.error(e);process.exitCode=1});
`
        : `
import urllib.request
with urllib.request.urlopen('https://pypi.org/simple/six/',timeout=15) as r:assert r.status==200;r.read()
print('NETWORK_OK')
`,
    ),
  ]);
  const files = Object.entries(f.files).map(([path, bytes]) => ({
    path,
    sha256: sha(bytes),
  }));
  const prep = {
    ...f.command.arguments.projectPreparation!,
    sourceDigest: projectSourceDigest(files),
  };
  const cacheKey = projectCacheKey({
    spec: prep,
    scope,
    image: f.command.arguments.imageDigest,
    architecture: release.architecture,
  });
  try {
    for (const warm of [false, true]) {
      const mode = manager + (warm ? '-warm' : '-cold'),
        attemptId = randomUUID(),
        started = Date.now(),
        hard = started + 600000;
      const execution = { version: 1 as const, kind: 'compute' as const };
      const spec = sandboxExecutionBudgetSpec(
        execution,
        resolveSandboxExecutionPolicy([]),
      );
      let state = startSandboxExecutionBudget(spec, started, hard),
        renewals = 0;
      const budget = new SandboxExecutionBudgetController(
        state,
        spec,
        async (request) => {
          renewals++;
          return (state = renewSandboxExecutionBudget(
            state,
            request,
            Date.now(),
            hard,
          ));
        },
      );
      const network = {
          mode: 'controlled_https' as const,
          origins: ['https://pypi.org'],
        },
        grant = {
          id: randomUUID(),
          version: 1,
          digest: sha(JSON.stringify(network)),
        };
      const lease = SandboxNetworkLeaseSchema.parse({
        version: 1,
        ...scope,
        runId: randomUUID(),
        operationId: randomUUID(),
        attemptId,
        target: {
          kind: 'bridge',
          deviceId: randomUUID(),
          targetId: randomUUID(),
        },
        policyDigest: grant.digest,
        grantId: grant.id,
        grantVersion: 1,
        network,
        expiresAt: new Date(hard).toISOString(),
        maximumConnections: 8,
        maximumBytes: 1000000,
      });
      const payload = RuntimeLocalCommandSchema.parse({
        ...f.command,
        executionBudget: spec,
        networkGrant: grant,
        arguments: {
          ...f.command.arguments,
          files,
          projectPreparation: prep,
          network,
          execution,
          args: [file, ...(manager === 'pnpm' && !warm ? ['long'] : [])],
          limits: { ...f.command.arguments.limits, timeoutMs: 1000 },
        },
      });
      for (const [name, bytes] of Object.entries(f.files))
        await writeFile(join(root, name), bytes);
      console.log(JSON.stringify({ started: mode, attemptId }));
      try {
        const result = await runner.execute(root, payload, {
          attemptId,
          scope,
          executionBudget: budget,
          networkLease: lease,
          maintainLease: async () => true,
        });
        proof.checks[mode] = {
          elapsedMs: Date.now() - started,
          renewals,
          result,
        };
        await save();
        assert.equal(result.stopped, true);
        assert.equal(result.reason, 'exited');
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.errorCode, undefined);
        assert.match(result.stdout, /dependency verification: 42/);
        assert.match(result.stdout, /NETWORK_OK/);
        assert.ok((result.network?.receivedBytes ?? 0) > 0);
        if (manager === 'pnpm' && !warm) {
          assert.ok(renewals > 0);
          assert.match(result.stdout, /CONTINUED/);
          assert.ok(Date.now() - started > 65000);
        }
      } catch (error) {
        proof.checks[mode] = {
          ...(proof.checks[mode] as object),
          error: String(error),
        };
        await save();
        throw error;
      } finally {
        const c = await runner.api
          .json<{
            Id: string;
            Config: { Labels: Record<string, string> };
            State: { Running: boolean };
          }>('GET', `/containers/allrice-project-${attemptId}/json`)
          .catch(() => null);
        if (c) {
          assert.equal(
            c.Config.Labels['xyz.bplabs.allrice.attempt'],
            attemptId,
          );
          if (c.State.Running)
            await runner.api.json(
              'POST',
              `/containers/${c.Id}/kill?signal=KILL`,
            );
          await runner.projects!.cleanup(attemptId, c.Id);
        }
      }
    }
  } finally {
    const name = 'allrice-project-cache-' + cacheKey.slice(7);
    const v = await runner.api
      .json<{ Labels: Record<string, string> }>('GET', '/volumes/' + name)
      .catch(() => null);
    if (v) {
      assert.equal(v.Labels['xyz.bplabs.allrice.project.cache'], cacheKey);
      await runner.api.json('DELETE', '/volumes/' + name);
    }
    await rm(root, { recursive: true, force: true });
  }
}
proof.passed = true;
await save();
console.log(
  JSON.stringify({ passed: true, checks: Object.keys(proof.checks) }),
);
