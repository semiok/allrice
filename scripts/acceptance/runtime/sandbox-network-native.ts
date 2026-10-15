/** Real gVisor component acceptance. It does not invoke a model, modify a
 * tenant, install a watchdog or bypass preflight. The caller must hold the QA
 * window and verify the shared VM is idle. Only our UUID attempts are removed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CloudCommandSchema,
  SandboxNetworkLeaseSchema,
  canonicalRuntimeBridgeJson,
  cloudToolchainImageV1,
  cloudPythonImageV1,
} from '../../../packages/contracts/src/index.js';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';

const output = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
assert.ok(output && process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW === 'owned');
const directory = resolve(output);
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = JSON.parse(
  await readFile('/Users/a123/allrice-dev/.local/qa-validation.lock', 'utf8'),
);
assert.equal(lock.owner, 'met189-native-sandbox');
assert.equal(lock.pid, process.ppid);
process.env.ALLRICE_PROJECT_RUNTIME_CACHE_ROOT = directory + '/cache';
const backend = new CloudRunnerBackend();
const network = {
  mode: 'controlled_https' as const,
  origins: [
    'https://registry.npmjs.org',
    'https://pypi.org',
    'https://files.pythonhosted.org',
  ],
};
const checks: Record<string, unknown>[] = [];
await backend.preflight();
const cases = [
  {
    name: 'node-fetch',
    script: `let r;for(let attempt=1;attempt<=2;attempt++){try{r=await fetch('https://registry.npmjs.org/rea-agents/6.5.0',{signal:AbortSignal.timeout(15000)});break}catch(e){console.log('read-only GET attempt failed:'+attempt);if(attempt===2)throw e}}if(!r.ok)throw Error(String(r.status));const p=await r.json();if(p.version!=='6.5.0')throw Error('version');console.log('node-fetch:6.5.0')`,
    contains: 'node-fetch:6.5.0',
  },
  {
    name: 'node-https',
    script: `import https from 'node:https';await new Promise((resolve,reject)=>{const q=https.get('https://registry.npmjs.org/is-number/7.0.0',r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>{try{if(JSON.parse(s).version!=='7.0.0')throw Error('version');console.log('node-https:7.0.0');resolve()}catch(e){reject(e)}})});q.setTimeout(15000,()=>q.destroy(Error('timeout')));q.on('error',reject)});`,
    contains: 'node-https:7.0.0',
  },
  {
    name: 'npm-install-and-import',
    script: `import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';execFileSync('npm',['install','--prefix','/tmp/work/deps','--cache','/tmp/work/npm-cache','--ignore-scripts','--no-audit','--no-fund','--update-notifier=false','--fetch-retries=1','--fetch-timeout=10000','--fetch-retry-mintimeout=1000','--fetch-retry-maxtimeout=2000','--registry=https://registry.npmjs.org','is-number@7.0.0'],{stdio:'inherit',timeout:50000});const req=createRequire('/tmp/work/deps/package.json');if(!req('is-number')(42))throw Error('import');console.log('npm-install-and-import:ok')`,
    contains: 'npm-install-and-import:ok',
  },
  {
    name: 'python-urllib',
    language: 'python' as const,
    script: `import urllib.request,json\nwith urllib.request.urlopen('https://pypi.org/pypi/idna/3.10/json',timeout=15) as r:\n p=json.load(r)\nassert p['info']['version']=='3.10'\nprint('python-urllib:3.10')`,
    contains: 'python-urllib:3.10',
  },
  {
    name: 'python-requests',
    language: 'python' as const,
    script: `import subprocess,sys\nsubprocess.run([sys.executable,'-m','pip','install','--target','/tmp/work/deps','--no-cache-dir','--disable-pip-version-check','--index-url','https://pypi.org/simple','requests==2.32.5'],check=True,timeout=45)\nsys.path.insert(0,'/tmp/work/deps')\nimport requests\nr=requests.get('https://pypi.org/pypi/idna/3.10/json',timeout=10)\nr.raise_for_status()\nassert r.json()['info']['version']=='3.10'\nprint('python-requests:3.10')`,
    contains: 'python-requests:3.10',
  },
  {
    name: 'pip-install-and-import',
    language: 'python' as const,
    script: `import subprocess,sys\nsubprocess.run([sys.executable,'-m','pip','install','--target','/tmp/work/deps','--no-cache-dir','--disable-pip-version-check','--no-deps','--index-url','https://pypi.org/simple','idna==3.10'],check=True,timeout=30)\nsys.path.insert(0,'/tmp/work/deps')\nimport idna\nassert idna.__version__=='3.10'\nprint('pip-install-and-import:3.10')`,
    contains: 'pip-install-and-import:3.10',
  },
  {
    name: 'unapproved-origin-denied',
    script: `await fetch('https://example.com',{signal:AbortSignal.timeout(10000)});throw Error('unexpected allowed origin')`,
    denied: true,
  },
  {
    name: 'direct-egress-denied',
    script: `import net from 'node:net';await new Promise((resolve,reject)=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1500,()=>s.destroy(Error('blocked')));s.on('connect',()=>{s.destroy();reject(Error('direct connected'))});s.on('error',()=>{console.log('direct-egress:blocked');resolve()})})`,
    contains: 'direct-egress:blocked',
  },
  {
    name: 'lost-helper-stops-running-command',
    script: `import fs from 'node:fs';for(const pid of fs.readdirSync('/proc')){if(!/^\\d+$/.test(pid)||Number(pid)===process.pid)continue;let cmd='';try{cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8')}catch{}if(cmd.includes('const port=Number(process.argv[1])'))process.kill(Number(pid),'SIGKILL')}setInterval(()=>{},1000);`,
    failure: 'SANDBOX_NETWORK_UNAVAILABLE',
  },
  {
    name: 'revocation-closes-active-transfer',
    script: `while(true){try{const r=await fetch('https://registry.npmjs.org/pnpm/-/pnpm-10.33.3.tgz',{signal:AbortSignal.timeout(15000)});let bytes=0;for await(const chunk of r.body){bytes+=chunk.length;await new Promise(r=>setTimeout(r,100))}console.log('stream-bytes:'+bytes)}catch(e){console.log(String(e));await new Promise(r=>setTimeout(r,100))}}`,
    revoke: true,
  },
];
const requested = process.env.ALLRICE_SANDBOX_ACCEPTANCE_CASES?.split(',');
const selected = cases.filter(
  (item) => !requested || requested.includes(item.name),
);
assert.ok(selected.length > 0);
try {
  for (const item of selected) {
    const attemptId = randomUUID();
    const command = CloudCommandSchema.parse({
      capability: 'cloud.process.execute',
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      imageDigest: item.language ? cloudPythonImageV1 : cloudToolchainImageV1,
      network,
      arguments: {
        script: item.script,
        limits: { timeoutMs: 60000 },
        ...(item.language ? { language: item.language } : {}),
        network,
      },
    });
    const lease = SandboxNetworkLeaseSchema.parse({
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
      network,
      policyDigest:
        'sha256:' +
        createHash('sha256')
          .update(canonicalRuntimeBridgeJson({ network }))
          .digest('hex'),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maximumConnections: 16,
      maximumBytes: 64 * 1024 * 1024,
    });
    let valid = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await backend.execute(command, [], {
        attemptId,
        deadlineAt: lease.expiresAt,
        maintainLease: async () => valid,
        networkLease: lease,
        observe: async (event) => {
          if (item.revoke && event.stage === 'executing')
            timer = setTimeout(() => {
              valid = false;
            }, 8000);
        },
      });
      const passed = item.denied
        ? result.reason !== 'completed' &&
          result.network?.sentBytes === 0 &&
          result.errorCode === 'SANDBOX_NETWORK_DENIED'
        : item.failure
          ? result.reason === 'failed' &&
            result.stopped &&
            result.errorCode === item.failure &&
            result.elapsedMs < 15000
          : item.revoke
            ? result.reason === 'canceled' &&
              result.stopped &&
              (result.network?.sentBytes ?? 0) > 0 &&
              result.elapsedMs < 20000
            : result.reason === 'completed' &&
              result.exitCode === 0 &&
              !result.errorCode &&
              result.output.includes(item.contains!);
      checks.push({ name: item.name, attemptId, passed, result });
    } catch (error) {
      checks.push({
        name: item.name,
        attemptId,
        passed: false,
        error: String(error),
      });
    } finally {
      if (timer) clearTimeout(timer);
      const observed = await backend.inspect(attemptId);
      if (observed?.State.Running) await backend.stop(attemptId);
      await backend.cleanup(attemptId);
      assert.equal(await backend.inspect(attemptId), null);
      await writeFile(
        directory + '/report.json',
        JSON.stringify(
          {
            mode: 'physical component acceptance; synthetic authority; no model/tenant',
            checks,
          },
          null,
          2,
        ) + '\n',
      );
      console.log(JSON.stringify(checks.at(-1)));
    }
  }
} finally {
  await writeFile(
    directory + '/report.json',
    JSON.stringify(
      {
        passed:
          checks.length === selected.length && checks.every((c) => c.passed),
        checks,
      },
      null,
      2,
    ) + '\n',
  );
}
assert.ok(
  checks.every((c) => c.passed),
  'Native sandbox checks failed; inspect report.json',
);
