/** Opt-in actual Bridge runner checks. Synthetic owner leases authorize public
 * package hosts only; no pairing, account, model Run or installed app changes. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RuntimeLocalCommandSchema,
  RuntimeLocalPythonPayloadSchema,
  managedPythonPayloadForPlatform,
  localCommandToolchainImageV1,
  SandboxNetworkLeaseSchema,
  resolveSandboxExecutionPolicy,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
} from '../../../packages/contracts/src/index.js';
import { SandboxExecutionBudgetController } from '../../../packages/project-runtime/src/sandbox-execution-budget.js';
import { LocalPythonRunner } from '../../../apps/rice-bridge/src/local-python-runner.js';
import { LocalCommandRunner } from '../../../apps/rice-bridge/src/local-command-runner.js';
import { unconfirmedLocalNetworkOutcome } from '../../../apps/rice-bridge/src/local-sandbox-network.js';

assert.equal(process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW, 'owned');
const output = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT,
  socketPath = process.env.ALLRICE_BRIDGE_ACCEPTANCE_SOCKET;
assert.ok(output && socketPath);
const release = managedPythonPayloadForPlatform(`macos-${process.arch}`)!;
const python = new LocalPythonRunner({ socketPath, release }),
  node = new LocalCommandRunner({
    socketPath,
    imageDigest: localCommandToolchainImageV1,
  });
await python.preflight(AbortSignal.timeout(60000));
const proof = {
  architecture: release.architecture,
  checks: {} as Record<string, unknown>,
  passed: false,
};
const digest = (text: string) =>
  'sha256:' + createHash('sha256').update(text).digest('hex');
for (const mode of [
  'node-fetch',
  'python-install',
  'python-denied',
  'python-revoked',
] as const) {
  const attemptId = randomUUID(),
    started = Date.now(),
    hardDeadline = started + 600000;
  const execution = {
    version: 1 as const,
    kind:
      mode === 'python-install' ? ('install' as const) : ('compute' as const),
  };
  const spec = sandboxExecutionBudgetSpec(
    execution,
    resolveSandboxExecutionPolicy([]),
  );
  let state = startSandboxExecutionBudget(spec, started, hardDeadline);
  const budget = new SandboxExecutionBudgetController(
    state,
    spec,
    async (request) =>
      (state = renewSandboxExecutionBudget(
        state,
        request,
        Date.now(),
        hardDeadline,
      )),
  );
  const network = {
    mode: 'controlled_https' as const,
    origins: ['https://pypi.org', 'https://files.pythonhosted.org'],
  };
  const grant = {
    id: randomUUID(),
    version: 1,
    digest: digest(JSON.stringify(network)),
  };
  const lease = SandboxNetworkLeaseSchema.parse({
    version: 1,
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    runId: randomUUID(),
    operationId: randomUUID(),
    attemptId,
    target: { kind: 'bridge', deviceId: randomUUID(), targetId: randomUUID() },
    policyDigest: grant.digest,
    grantId: grant.id,
    grantVersion: 1,
    network,
    expiresAt: new Date(hardDeadline).toISOString(),
    maximumConnections: 8,
    maximumBytes: 10000000,
  });
  const script =
    mode === 'node-fetch'
      ? "const r=await fetch('https://pypi.org/simple/six/');if(r.status!==200)throw Error('HTTP '+r.status);const text=await r.text();if(!text.includes('six-1.17.0'))throw Error('missing release');console.log('NETWORK_OK');"
      : mode === 'python-install'
        ? `import subprocess,os
p=subprocess.run(['/opt/python/bin/python','-m','pip','install','--disable-pip-version-check','--no-cache-dir','--target','cache/packages','--index-url','https://pypi.org/simple','six==1.17.0'],capture_output=True,text=True)
assert p.returncode==0,p.stderr
p=subprocess.run(['/opt/python/bin/python','-I','-c',"import sys;sys.path.insert(0,'cache/packages');import six;assert six.__version__=='1.17.0';print('CACHE_REUSED')"],capture_output=True,text=True)
assert p.returncode==0,p.stderr
print(p.stdout);print('NETWORK_OK')
`
        : mode === 'python-denied'
          ? `import urllib.request,socket
try:urllib.request.urlopen('https://example.com',timeout=5);raise AssertionError('ungranted host allowed')
except urllib.error.URLError as e:assert '403' in str(e),str(e)
try:socket.create_connection(('169.254.169.254',80),timeout=1);raise AssertionError('direct network allowed')
except OSError:pass
print('DENIED_OK')
`
          : `import urllib.request,time
with urllib.request.urlopen('https://pypi.org/simple/six/',timeout=10) as r:assert r.status==200;r.read()
print('REQUEST_SENT',flush=True)
while True:time.sleep(.1)
`;
  const root = await mkdtemp(join(tmpdir(), 'allrice-network-native-'));
  let id: string | undefined;
  const payload =
    mode === 'node-fetch'
      ? RuntimeLocalCommandSchema.parse({
          capability: 'local.process.execute',
          executionBudget: spec,
          networkGrant: grant,
          arguments: {
            executable: '/usr/local/bin/node',
            args: ['probe.mjs'],
            path: '.',
            files: [{ path: 'probe.mjs', sha256: digest(script) }],
            imageDigest: localCommandToolchainImageV1,
            isolation: 'local-vm-container-v1',
            network,
            execution,
            limits: {
              timeoutMs: 1000,
              outputBytes: 8192,
              memoryMiB: 128,
              cpuMillis: 500,
              pids: 32,
            },
          },
        })
      : RuntimeLocalPythonPayloadSchema.parse({
          capability: 'local.python.execute',
          executionBudget: spec,
          networkGrant: grant,
          arguments: {
            path: '.',
            purpose: 'python_charts',
            origin: {
              toolName: 'python.execute',
              callId: randomUUID(),
              argumentsDigest: digest(script),
            },
            script,
            inputs: [],
            outputs: [],
            profileVersion: 1,
            imageId: release.imageId,
            architecture: release.architecture,
            isolation: 'local-vm-container-v1',
            network,
            execution,
            limits: {
              timeoutMs: 1000,
              inputBytes: 2000000,
              artifactBytes: 1000000,
              outputBytes: 8192,
              memoryMiB: 512,
              cpuMillis: 500,
              pids: 64,
            },
          },
        });
  try {
    const maintainLease = async () =>
      mode !== 'python-revoked' || Date.now() - started < 12000;
    await writeFile(join(root, 'probe.mjs'), script);
    const result =
      payload.capability === 'local.process.execute'
        ? await node.execute(root, payload, {
            attemptId,
            executionBudget: budget,
            networkLease: lease,
            maintainLease,
          })
        : await python.execute(payload, {
            attemptId,
            executionBudget: budget,
            networkLease: lease,
            maintainLease,
            transport: {
              download: async () => {
                throw Error('unexpected download');
              },
              upload: async () => {
                throw Error('unexpected upload');
              },
            },
          });
    id = result.containerId;
    proof.checks[mode] = { elapsedMs: Date.now() - started, result };
    await writeFile(
      join(output, 'report.json'),
      JSON.stringify(proof, null, 2) + '\n',
      { mode: 0o600 },
    );
    assert.equal(result.stopped, true);
    if (mode === 'python-revoked') {
      assert.equal(result.reason, 'lease_lost');
      assert.ok(Date.now() - started < 20000);
      assert.ok((result.network?.sentBytes ?? 0) > 0);
      assert.equal(unconfirmedLocalNetworkOutcome(payload, result), true);
    } else if (mode === 'python-denied') {
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /DENIED_OK/);
      assert.equal(result.errorCode, 'SANDBOX_NETWORK_DENIED');
      assert.equal(result.network?.sentBytes, 0);
    } else {
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.reason, 'exited');
      assert.equal(result.errorCode, undefined);
      assert.match(result.stdout, /NETWORK_OK/);
      assert.ok((result.network?.receivedBytes ?? 0) > 0);
    }
  } catch (error) {
    const runner =
      payload.capability === 'local.python.execute' ? python : node;
    const name =
      payload.capability === 'local.python.execute'
        ? `allrice-python-${attemptId}`
        : `allrice-${attemptId}`;
    const current = await runner.api
      .json<{ Id: string; State: unknown }>('GET', `/containers/${name}/json`)
      .catch(() => null);
    let logs = '';
    if (current)
      await runner.api
        .logs(
          current.Id,
          (bytes) => {
            if (logs.length < 32768) logs += bytes.toString('utf8');
          },
          2000,
        )
        .catch(() => undefined);
    proof.checks[mode] = {
      elapsedMs: Date.now() - started,
      error: String(error),
      cause: error instanceof Error ? String(error.cause) : null,
      state: current?.State,
      logs,
    };
    await writeFile(
      join(output, 'report.json'),
      JSON.stringify(proof, null, 2) + '\n',
      { mode: 0o600 },
    );
    throw error;
  } finally {
    const runner =
      payload.capability === 'local.python.execute' ? python : node;
    const name =
      payload.capability === 'local.python.execute'
        ? `allrice-python-${attemptId}`
        : `allrice-${attemptId}`;
    const c = await runner.api
      .json<{
        Id: string;
        State: { Running: boolean };
        Config: { Labels: Record<string, string> };
      }>('GET', `/containers/${id ?? name}/json`)
      .catch(() => null);
    if (c) {
      const label =
        payload.capability === 'local.python.execute'
          ? 'xyz.bplabs.allrice.python.attempt'
          : 'xyz.bplabs.allrice.attempt';
      assert.equal(c.Config.Labels[label], attemptId);
      if (c.State.Running)
        await runner.api.json('POST', `/containers/${c.Id}/kill?signal=KILL`);
      if (payload.capability === 'local.python.execute')
        await python.cleanup(attemptId, c.Id, payload);
      else await node.cleanup(attemptId, c.Id);
    }
    await rm(root, { recursive: true, force: true });
  }
}
proof.passed = true;
await writeFile(
  join(output, 'report.json'),
  JSON.stringify(proof, null, 2) + '\n',
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    passed: true,
    architecture: proof.architecture,
    checks: Object.keys(proof.checks),
  }),
);
