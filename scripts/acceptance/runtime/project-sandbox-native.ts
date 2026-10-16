/** Actual gVisor saved projects with synthetic authority and no model calls.
 * An outer operator owns both windows, installs/restores the candidate guard,
 * and checks the shared VM is idle. Only our recorded attempts/caches are used.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import {
  CloudProjectCommandSchema,
  SandboxNetworkLeaseSchema,
  canonicalRuntimeBridgeJson,
  cloudToolchainImageV1,
  cloudPythonImageV1,
  projectRuntimeCacheIdentity,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
  type SandboxExecutionBudgetState,
  type SandboxExecutionBudgetSpec,
} from '../../../packages/contracts/src/index.js';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';

const directory = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
assert.ok(
  directory && process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW === 'owned',
);
const lock = JSON.parse(
  await readFile('/Users/a123/allrice-dev/.local/qa-validation.lock', 'utf8'),
);
assert.equal(lock.owner, 'met189-native-sandbox');
process.kill(lock.pid, 0);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.env.ALLRICE_PROJECT_RUNTIME_CACHE_ROOT = directory + '/cache';
const save = (name: string, value: unknown) =>
  writeFile(
    directory + '/' + name + '.json',
    JSON.stringify(value, null, 2) + '\n',
    { mode: 0o600 },
  );
const sha = (data: string | Buffer) =>
  'sha256:' + createHash('sha256').update(data).digest('hex');
const backend = new CloudRunnerBackend();
const network = {
  mode: 'controlled_https' as const,
  origins: ['https://registry.npmjs.org', 'https://pypi.org'],
};
const checks: Record<string, unknown>[] = [];
const nodeLock =
  "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n";
const installProbe = String.raw`const assert=require('node:assert/strict'),net=require('node:net');assert.equal(process.env.HTTPS_PROXY,undefined);const s=net.connect({host:'127.0.0.1',port:3139});let response='';s.setTimeout(2500,()=>s.destroy(Error('gate timeout')));s.on('connect',()=>s.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n'));s.on('data',b=>{response+=b.toString()});s.on('error',()=>{});s.on('close',()=>{assert.match(response,/^HTTP\/1\.1 403 Forbidden/);console.log('preparation-network-blocked')});`;
const netProbe = String.raw`const assert=require('node:assert/strict'),net=require('node:net');async function main(){assert.equal(process.env.HTTPS_PROXY,'http://127.0.0.1:3139');const r=await fetch('https://registry.npmjs.org/is-number/7.0.0',{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);const p=await r.json();assert.equal(p.version,'7.0.0');await new Promise((resolve,reject)=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1000,()=>s.destroy(Error('blocked')));s.on('connect',()=>{s.destroy();reject(Error('direct egress opened'))});s.on('error',()=>resolve())});console.log('runtime-network:verified')};main().catch(e=>{console.error(e);process.exitCode=1});`;
const pythonProbe =
  "import os,urllib.request,json\nassert os.environ['HTTPS_PROXY']=='http://127.0.0.1:3139'\nwith urllib.request.urlopen('https://pypi.org/pypi/idna/3.10/json',timeout=15) as r:\n p=json.load(r)\nassert p['info']['version']=='3.10'\nprint('runtime-network:verified')\n";
type Case = {
  name: string;
  script: string;
  python?: boolean;
  network?: boolean;
  kind?: SandboxExecutionBudgetSpec['kind'];
  installProbe?: boolean;
  stop?: 'cancel' | 'revoke';
  long?: boolean;
  authorityDelayMs?: number;
  stagingControlLoss?: boolean;
  terminalControlLoss?: boolean;
};
const cases: Case[] = [
  {
    name: 'project-terminal-control-loss',
    terminalControlLoss: true,
    script: "console.log('terminal-collection:verified')",
  },
  {
    name: 'node-network-shared-budget',
    network: true,
    kind: 'compute',
    long: true,
    authorityDelayMs: 250,
    script: String.raw`async function main(){const r=await fetch('https://registry.npmjs.org/is-number/7.0.0',{signal:AbortSignal.timeout(15000)});if(r.status!==200||(await r.json()).version!=='7.0.0')throw Error('metadata mismatch');console.log('runtime-network:verified');const until=Date.now()+70000;let n=0;while(Date.now()<until){for(let j=0;j<1000;j++)n=Math.sin(n+j)}console.log('shared-clock:continued:'+n)}main().catch(e=>{console.error(e);process.exitCode=1});`,
  },
  {
    name: 'project-staging-control-loss',
    stagingControlLoss: true,
    script: "throw Error('tenant script must not start after control loss')",
  },
  {
    name: 'node-network-and-offline-installer',
    script: netProbe,
    network: true,
    installProbe: true,
  },
  {
    name: 'project-denied-destinations',
    network: true,
    script:
      "async function main(){for(const url of ['https://example.com','https://127.0.0.1']){let denied=false;try{await fetch(url,{signal:AbortSignal.timeout(5000)})}catch{denied=true}if(!denied)throw Error('unexpected destination:'+url)}console.log('runtime-network:verified')}main().catch(e=>{console.error(e);process.exitCode=1})",
  },
  {
    name: 'python-runtime-https',
    script: pythonProbe,
    python: true,
    network: true,
  },
  {
    name: 'node-continues-past-60-seconds',
    kind: 'compute',
    long: true,
    script:
      "const until=Date.now()+70000;let n=0;while(Date.now()<until){for(let j=0;j<1000;j++)n=Math.sin(n+j)}console.log('shared-clock:continued:'+n)",
  },
  {
    name: 'project-cancel',
    stop: 'cancel',
    script: "console.log('runtime-ready');setInterval(()=>{},1000)",
  },
  {
    name: 'project-revoke-network',
    stop: 'revoke',
    network: true,
    script: String.raw`
async function main() {
  let reported = false;
  for (;;) {
    try {
      const response = await fetch('https://registry.npmjs.org/pnpm/10.33.3', { signal: AbortSignal.timeout(10000) });
      for await (const chunk of response.body) {
        if (!reported) { console.log('network-read-confirmed'); reported = true; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    } catch (error) { console.error(String(error)); }
  }
}
main();`,
  },
];
function prepare(item: Case) {
  const projectId = randomUUID(),
    python = item.python === true;
  if (!python) new Script(item.script);
  if (item.installProbe) new Script(installProbe);
  const lockText = python ? '# no dependencies\n' : nodeLock;
  const files = [
    { path: python ? 'verify.py' : 'verify.cjs', text: item.script },
    { path: python ? 'requirements.lock' : 'pnpm-lock.yaml', text: lockText },
    ...(!python
      ? [
          {
            path: 'package.json',
            text: JSON.stringify({
              name: 'synthetic-project-sandbox',
              version: '1.0.0',
              packageManager: 'pnpm@10.33.3',
              ...(item.installProbe
                ? { scripts: { postinstall: 'node install.cjs' } }
                : {}),
            }),
          },
        ]
      : []),
    ...(item.installProbe ? [{ path: 'install.cjs', text: installProbe }] : []),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const manifest = files.map((f) => ({ path: f.path, sha256: sha(f.text) })),
    sourceDigest = sha(JSON.stringify(manifest));
  const snapshot = {
    version: 1,
    projectId,
    sourceDigest,
    files: files.map((f) => ({
      path: f.path,
      sha256: sha(f.text),
      sizeBytes: Buffer.byteLength(f.text),
      contentBase64: Buffer.from(f.text).toString('base64'),
    })),
  };
  const project = {
    projectId,
    snapshot: {
      kind: 'artifact',
      id: randomUUID(),
      checksum: sha(JSON.stringify(snapshot)),
    },
  };
  const scope = {
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
  };
  const spec = python
    ? {
        version: 1 as const,
        projectId,
        sourceDigest,
        lockChecksum: sha(lockText),
        offline: false,
        manager: 'uv' as const,
        managerVersion: '0.8.22' as const,
        lockPath: 'requirements.lock',
        scripts: 'disabled' as const,
        packages: [],
      }
    : {
        version: 1 as const,
        projectId,
        sourceDigest,
        lockChecksum: sha(lockText),
        offline: false,
        manager: 'pnpm' as const,
        managerVersion: '10.33.3' as const,
        lockPath: 'pnpm-lock.yaml',
        scripts: item.installProbe
          ? ('allow_in_isolated_copy' as const)
          : ('disabled' as const),
        packages: [],
      };
  const image = python ? cloudPythonImageV1 : cloudToolchainImageV1;
  const cacheKey = sha(
    JSON.stringify(
      projectRuntimeCacheIdentity({
        spec,
        scope,
        image,
        architecture: 'amd64',
      }),
    ),
  );
  const execution = { version: 1 as const, kind: item.kind ?? 'build' };
  const budgetSpec = sandboxExecutionBudgetSpec(execution, {
    version: 1,
    maxExecutionMs: 600000,
    sources: [],
  });
  const command = CloudProjectCommandSchema.parse({
    kind: 'project',
    capability: 'cloud.process.execute',
    backend: 'cloud-gvisor-v1',
    runtime: 'runsc',
    imageDigest: image,
    network: item.network ? network : 'none',
    executionBudget: budgetSpec,
    arguments: {
      execution,
      ...(item.network ? { network } : {}),
      executable: python
        ? '/workspace/.venv/bin/python'
        : '/usr/local/bin/node',
      args: [python ? 'verify.py' : 'verify.cjs'],
      path: '.',
      files: manifest,
      imageDigest: image,
      limits: {
        timeoutMs: 60000,
        memoryMiB: 512,
        cpuMillis: 1000,
        pids: 64,
        outputBytes: 16384,
      },
      projectPreparation: spec,
      projectSource: {
        version: 1,
        project,
        snapshot,
        architecture: 'amd64',
        cacheKey,
        executionOrigin: {
          toolName: 'workspace.project',
          callId: item.name,
          argumentsDigest: sha(item.script),
          selectionId: randomUUID(),
        },
        origin: {
          jobId: randomUUID(),
          workerId: randomUUID(),
          attempt: 1,
          leaseTokenDigest: '1'.repeat(64),
        },
      },
    },
  });
  return { scope, cacheKey, command, budgetSpec };
}
async function cleanupCache(cacheKey: string) {
  const name = 'allrice-project-cache-' + cacheKey.slice(7);
  const volume = await backend
    .json<{ Name: string; Labels: Record<string, string> }>(
      'GET',
      '/volumes/' + name,
    )
    .catch((e) => {
      if (e instanceof Error && e.message === 'CLOUD_DAEMON_404') return null;
      throw e;
    });
  if (volume) {
    assert.equal(volume.Name, name);
    assert.equal(volume.Labels['xyz.bplabs.allrice.project.cache'], cacheKey);
    await backend.call('DELETE', '/volumes/' + name);
  }
}
async function runtimeReady(id: string) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const logs = await backend.call(
      'GET',
      `/containers/${id}/logs?stdout=true&stderr=true`,
    );
    if (/"stage"\s*:\s*"running"/.test(logs.toString())) return;
    await delay(100);
  }
  throw Error('runtime command did not start');
}
async function networkReadConfirmed(id: string) {
  const until = Date.now() + 30000;
  let diagnostic = '';
  while (Date.now() < until) {
    const raw = await backend.call(
      'GET',
      `/containers/${id}/logs?stdout=true&stderr=true`,
    );
    let wire = '';
    for (let offset = 0; offset + 8 <= raw.length;) {
      const size = raw.readUInt32BE(offset + 4);
      wire += raw.subarray(offset + 8, offset + 8 + size).toString();
      offset += 8 + size;
    }
    const output = wire
      .split('\n')
      .flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event.type === 'stdout'
            ? [Buffer.from(event.data, 'base64').toString()]
            : [];
        } catch {
          return [];
        }
      })
      .join('');
    diagnostic = wire;
    if (output.includes('network-read-confirmed')) return;
    await delay(200);
  }
  await save('revocation-probe-before-stop', {
    containerId: id,
    wire: diagnostic,
  });
  throw Error('no actual network response before revocation');
}
async function execute(
  item: Case,
  existing?: ReturnType<typeof prepare>,
  offline = false,
) {
  const prepared = existing ?? prepare(item),
    { scope, cacheKey, budgetSpec } = prepared;
  const command = CloudProjectCommandSchema.parse({
    ...prepared.command,
    arguments: {
      ...prepared.command.arguments,
      projectPreparation: {
        ...prepared.command.arguments.projectPreparation,
        offline,
      },
    },
  });
  const attemptId = randomUUID(),
    cancel = new AbortController(),
    rootDeadline = Date.now() + 240000;
  let valid = true,
    state: SandboxExecutionBudgetState | undefined,
    stopAt: number | undefined,
    finished = false;
  let staging = false,
    collecting = false,
    terminalAuthorityCalls = 0;
  // Delay the daemon boundary while only the independent physical controller
  // can observe the stalled authority. The tenant start marker is never sent.
  class StalledStaging extends CloudRunnerBackend {
    override async putArchive(
      _id: string,
      _bytes: Uint8Array,
      signal: AbortSignal,
    ) {
      staging = true;
      stopAt ??= Date.now();
      await delay(10000, undefined, { signal });
      throw Error('staging did not observe physical controller cancellation');
    }
  }
  class SlowCollection extends CloudRunnerBackend {
    override async collect(...args: Parameters<CloudRunnerBackend['collect']>) {
      collecting = true;
      await delay(3500);
      return super.collect(...args);
    }
  }
  const runner = item.stagingControlLoss
    ? new StalledStaging()
    : item.terminalControlLoss
      ? new SlowCollection()
      : backend;
  const input = { ...prepared, command, attemptId };
  await save(item.name + '-input', input);
  const lease = item.network
    ? SandboxNetworkLeaseSchema.parse({
        version: 1,
        ...scope,
        runId: randomUUID(),
        operationId: randomUUID(),
        attemptId,
        target: { kind: 'cloud', targetId: randomUUID() },
        grantId: randomUUID(),
        grantVersion: 1,
        network,
        policyDigest: sha(canonicalRuntimeBridgeJson({ network })),
        expiresAt: new Date(rootDeadline).toISOString(),
        maximumConnections: 16,
        maximumBytes: 8000000,
      })
    : undefined;
  try {
    const result = await runner.execute(command, [], {
      attemptId,
      deadlineAt: new Date(rootDeadline).toISOString(),
      maintainLease: async () => {
        if (staging) return new Promise<boolean>(() => {});
        if (collecting) {
          terminalAuthorityCalls++;
          return new Promise<boolean>(() => {});
        }
        if (item.authorityDelayMs) await delay(item.authorityDelayMs);
        return valid;
      },
      signal: cancel.signal,
      projectScope: scope,
      ...(lease ? { networkLease: lease } : {}),
      sandboxExecution: {
        spec: budgetSpec,
        exchange: async (request) => {
          assert.ok(valid);
          state ??= startSandboxExecutionBudget(
            budgetSpec,
            Date.now(),
            rootDeadline,
          );
          if (request)
            state = renewSandboxExecutionBudget(
              state,
              request,
              Date.now(),
              rootDeadline,
            );
          await save(item.name + '-budget', { attemptId, state });
          return state;
        },
      },
      observe: async (event) => {
        if (
          event.stage === 'executing' &&
          event.containerId &&
          (item.stop || item.name.startsWith('project-controller-'))
        ) {
          await runtimeReady(event.containerId);
          await save(item.name + '-running', {
            attemptId,
            pid: process.pid,
            at: Date.now(),
          });
          if (item.stop) {
            if (item.stop === 'revoke')
              await networkReadConfirmed(event.containerId);
            else await delay(2000);
            assert.equal(
              (await backend.inspect(attemptId))?.State.Running,
              true,
            );
            stopAt = Date.now();
            if (item.stop === 'cancel') cancel.abort();
            else valid = false;
          }
        }
      },
    });
    await save(item.name, {
      attemptId,
      result,
      state,
      stopAt,
      finishedAt: Date.now(),
      ...(item.terminalControlLoss ? { terminalAuthorityCalls } : {}),
    });
    assert.equal(result.stopped, true);
    assert.equal(result.executionBudget?.startedAt, state?.startedAt);
    if (item.stagingControlLoss) {
      assert.equal(result.reason, 'failed');
      assert.equal(result.errorCode, 'SANDBOX_EXECUTION_AUTHORITY_UNCONFIRMED');
      assert.ok(stopAt && Date.now() - stopAt < 7000);
      assert.doesNotMatch(result.output, /tenant script must not start/);
    } else if (item.stop) {
      assert.equal(result.reason, 'canceled');
      assert.ok(stopAt && Date.now() - stopAt < 12000);
      if (item.stop === 'revoke') {
        assert.ok(
          result.network &&
            result.network.sentBytes > 0 &&
            result.network.receivedBytes > 0,
        );
        assert.match(result.output, /network-read-confirmed/);
      }
    } else {
      assert.equal(result.reason, 'completed');
      assert.equal(result.exitCode, 0);
      assert.equal(result.projectPreparation?.installation, 'succeeded');
      if (item.terminalControlLoss) {
        assert.equal(terminalAuthorityCalls, 0);
        assert.equal(result.errorCode, undefined);
        assert.match(result.output, /terminal-collection:verified/);
      }
      if (item.network) {
        assert.match(result.output, /runtime-network:verified/);
        if (item.name === 'project-denied-destinations') {
          assert.equal(result.network?.sentBytes, 0);
          assert.equal(result.network?.openedConnections, 0);
        } else
          assert.ok(
            result.network &&
              result.network.sentBytes > 0 &&
              result.network.receivedBytes > 0,
          );
      }
      if (item.installProbe)
        assert.match(result.output, /preparation-network-blocked/);
      if (item.long) {
        assert.ok(result.elapsedMs > 60000);
        assert.ok(result.executionBudget!.renewalCount >= 1);
        assert.match(result.output, /shared-clock:continued/);
      }
      if (offline)
        assert.equal(result.projectPreparation!.downloadedArchives, 0);
    }
    checks.push({
      name: item.name,
      passed: true,
      attemptId,
      elapsedMs: result.elapsedMs,
      executionBudget: result.executionBudget,
      network: result.network,
      stopped: result.stopped,
    });
    console.log(JSON.stringify(checks.at(-1)));
    await save('report', { passed: false, checks });
    finished = true;
    return prepared;
  } finally {
    const c = await backend.inspect(attemptId);
    if (c?.State.Running) await backend.stop(attemptId);
    await backend.cleanup(attemptId, command);
    assert.equal(await backend.inspect(attemptId), null);
    // The repeat case retains only its own cache until the next exact command.
    if (!finished || item.name !== 'node-network-and-offline-installer')
      await cleanupCache(cacheKey);
  }
}
const childMode = process.env.ALLRICE_SANDBOX_CONTROLLER_CHILD;
if (childMode) {
  try {
    await execute({
      name: childMode,
      script: "console.log('runtime-ready');setInterval(()=>{},1000)",
    });
  } catch (error) {
    await save(childMode + '-interrupted', { error: String(error) });
  }
} else
  try {
    const selected = process.env.ALLRICE_SANDBOX_ACCEPTANCE_CASES?.split(',');
    for (const item of cases.filter(
      (c) => !selected || selected.includes(c.name),
    )) {
      const prepared = await execute(item);
      if (item.name === 'node-network-and-offline-installer')
        try {
          await execute(
            { ...item, name: 'node-same-source-offline-reuse' },
            prepared,
            true,
          );
        } finally {
          await cleanupCache(prepared.cacheKey);
        }
    }
    if (!selected || selected.includes('controller-loss'))
      for (const signal of ['SIGSTOP', 'SIGKILL'] as const) {
        const name = 'project-controller-' + signal.toLowerCase();
        const child = spawn(
          process.execPath,
          [...process.execArgv, fileURLToPath(import.meta.url)],
          {
            env: { ...process.env, ALLRICE_SANDBOX_CONTROLLER_CHILD: name },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        for (const stream of [child.stdout, child.stderr])
          stream.on(
            'data',
            (b: Buffer) => (output = (output + b).slice(-6000)),
          );
        const ended = once(child, 'exit');
        let own:
          | (Awaited<ReturnType<typeof prepare>> & { attemptId: string })
          | undefined;
        try {
          const until = Date.now() + 45000;
          let ready = false;
          while (Date.now() < until) {
            try {
              const r = JSON.parse(
                await readFile(
                  directory + '/' + name + '-running.json',
                  'utf8',
                ),
              );
              assert.equal(r.pid, child.pid);
              own = JSON.parse(
                await readFile(directory + '/' + name + '-input.json', 'utf8'),
              );
              ready = true;
              break;
            } catch {
              if (child.exitCode !== null) break;
              await delay(100);
            }
          }
          assert.ok(ready && own, output);
          assert.equal(
            (await backend.inspect(own.attemptId))?.State.Running,
            true,
          );
          const stoppedAt = Date.now();
          child.kill(signal);
          let stopped = false;
          while (Date.now() - stoppedAt < 9000) {
            const c = await backend.inspect(own.attemptId);
            if (c && !c.State.Running) {
              stopped = true;
              break;
            }
            await delay(150);
          }
          assert.ok(
            stopped,
            'independent VM lease did not stop original project',
          );
          const stoppedWithinMs = Date.now() - stoppedAt;
          if (signal === 'SIGSTOP') child.kill('SIGCONT');
          await Promise.race([
            ended,
            delay(10000).then(() => {
              throw Error('controller did not finish');
            }),
          ]);
          checks.push({
            name,
            passed: true,
            attemptId: own.attemptId,
            stoppedWithinMs,
          });
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGCONT');
            child.kill('SIGKILL');
            await ended;
          }
          if (own) {
            const c = await backend.inspect(own.attemptId);
            if (c?.State.Running) await backend.stop(own.attemptId);
            await backend.cleanup(own.attemptId, own.command);
            assert.equal(await backend.inspect(own.attemptId), null);
            await cleanupCache(own.cacheKey);
          }
          await save(name + '-controller', {
            exitCode: child.exitCode,
            signal: child.signalCode,
            output,
          });
        }
      }
    await save('report', {
      passed: true,
      mode: 'real gVisor saved project, synthetic authority, no model',
      checks,
    });
  } catch (error) {
    await save('report', { passed: false, error: String(error), checks });
    throw error;
  }
