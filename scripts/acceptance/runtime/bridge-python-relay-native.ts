/** Component proof on the exact managed image, not a Bridge feature rollout.
 * The operator owns QA and checks idle first. Only this script's container is
 * removed; it never changes the VM, watchdog, images or a tenant's records. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { request } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  managedPythonPayloadForPlatform,
  SandboxNetworkLeaseSchema,
} from '../../../packages/contracts/src/index.js';
import {
  openSandboxNetwork,
  sandboxProxyEnvironment,
} from '../../../packages/project-runtime/src/sandbox-network-docker.js';
import { sandboxNetworkPythonRelay } from '../../../packages/project-runtime/src/sandbox-network-python-relay.js';
import { LocalDockerApi } from '../../../apps/rice-bridge/src/local-docker-api.js';

const output = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
const socketPath = process.env.ALLRICE_BRIDGE_ACCEPTANCE_SOCKET;
assert.equal(process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW, 'owned');
assert.ok(output && socketPath);
assert.equal(process.platform, 'darwin');
const release = managedPythonPayloadForPlatform(`macos-${process.arch}`);
assert.ok(release?.nativeSupported);
const api = new LocalDockerApi(socketPath);
await api.verifySocket();
const image = await api.json<{ Id: string; Architecture: string }>(
  'GET',
  `/images/${release.imageId}/json`,
);
assert.equal(image.Id, release.imageId);
assert.equal(image.Architecture, release.architecture);
const nonce = randomUUID();
const label = 'xyz.bplabs.allrice.bridge-relay-acceptance';
const network = {
  mode: 'controlled_https' as const,
  origins: ['https://pypi.org', 'https://files.pythonhosted.org'],
};
const lease = SandboxNetworkLeaseSchema.parse({
  version: 1,
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  ownerId: randomUUID(),
  runId: randomUUID(),
  operationId: randomUUID(),
  attemptId: randomUUID(),
  target: { kind: 'bridge', targetId: randomUUID(), deviceId: randomUUID() },
  grantId: randomUUID(),
  grantVersion: 1,
  policyDigest:
    'sha256:' +
    createHash('sha256').update(JSON.stringify(network)).digest('hex'),
  network,
  expiresAt: new Date(Date.now() + 90_000).toISOString(),
  maximumConnections: 16,
  maximumBytes: 16 * 1024 * 1024,
});
let id: string | undefined;
let session: Awaited<ReturnType<typeof openSandboxNetwork>> | undefined;
let current = true;
const checks: Record<string, unknown> = {};
const proof: Record<string, unknown> = {
  arch: process.arch,
  imageId: image.Id,
  helperSha256: createHash('sha256')
    .update(sandboxNetworkPythonRelay)
    .digest('hex'),
  checks,
  passed: false,
};

async function inspect() {
  assert.ok(id);
  const c = await api.json<{
    Config: { Image: string; Labels: Record<string, string> };
    HostConfig: {
      NetworkMode: string;
      ReadonlyRootfs: boolean;
      Privileged: boolean;
      Binds: unknown[] | null;
      PortBindings: Record<string, unknown> | null;
    };
    State: { Running: boolean };
  }>('GET', `/containers/${id}/json`);
  assert.equal(c.Config.Image, image.Id);
  assert.equal(c.Config.Labels[label], nonce);
  assert.equal(c.HostConfig.NetworkMode, 'none');
  assert.equal(c.HostConfig.ReadonlyRootfs, true);
  assert.equal(c.HostConfig.Privileged, false);
  assert.equal(c.HostConfig.Binds?.length ?? 0, 0);
  assert.equal(Object.keys(c.HostConfig.PortBindings ?? {}).length, 0);
  return c;
}
async function python(code: string, timeout = 25_000) {
  await inspect();
  const e = await api.json<{ Id: string }>('POST', `/containers/${id}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Privileged: false,
    User: '1000:1000',
    WorkingDir: '/tmp',
    Env: Object.entries(sandboxProxyEnvironment).map(([k, v]) => `${k}=${v}`),
    Cmd: ['/opt/python/bin/python', '-I', '-u', '-c', code],
  });
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: `/v1.45/exec/${e.Id}/start`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (r) => {
        const chunks: Buffer[] = [];
        let size = 0;
        r.on('data', (b: Buffer) => {
          size += b.length;
          if (size > 262144) req.destroy(Error('output limit'));
          else chunks.push(b);
        });
        r.once('error', reject);
        r.once('end', () =>
          r.statusCode === 200
            ? resolve(Buffer.concat(chunks))
            : reject(Error('exec HTTP ' + r.statusCode)),
        );
      },
    );
    const timer = setTimeout(() => req.destroy(Error('exec timeout')), timeout);
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end(JSON.stringify({ Detach: false, Tty: false }));
  });
  let text = '';
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(bytes.length - offset >= 8);
    const n = bytes.readUInt32BE(offset + 4);
    assert.ok(
      [1, 2].includes(bytes[offset]!) && offset + 8 + n <= bytes.length,
    );
    text += bytes.subarray(offset + 8, offset + 8 + n).toString('utf8');
    offset += 8 + n;
  }
  const result = await api.json<{ ExitCode: number; Running: boolean }>(
    'GET',
    `/exec/${e.Id}/json`,
  );
  assert.equal(result.Running, false);
  assert.equal(result.ExitCode, 0, text);
  return text;
}
try {
  const c = await api.json<{ Id: string }>(
    'POST',
    `/containers/create?name=allrice-bridge-relay-${nonce}`,
    {
      Image: image.Id,
      Labels: { [label]: nonce },
      User: '65532:65532',
      WorkingDir: '/tmp',
      Entrypoint: [
        '/usr/local/bin/python3',
        '-I',
        '-S',
        '-u',
        '-c',
        'import time;time.sleep(100)',
      ],
      Cmd: [],
      HostConfig: {
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 256 * 1024 * 1024,
        NanoCpus: 500_000_000,
        PidsLimit: 32,
        Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777' },
      },
    },
  );
  assert.match(c.Id, /^[a-f0-9]{64}$/);
  id = c.Id;
  await api.json('POST', `/containers/${id}/start`);
  session = await openSandboxNetwork(api, {
    containerId: id,
    relayRuntime: 'python',
    lease,
    signal: AbortSignal.timeout(85_000),
    assertContainer: async () => {
      assert.equal((await inspect()).State.Running, true);
    },
    assertCurrent: async () => {
      if (!current) throw Error('revoked');
    },
  });
  checks.verifiedPythonWithoutNode = await python(
    "import sys,os;assert sys.version_info[:3]==(3,11,13);assert not os.path.exists('/usr/local/bin/node');print('python-3.11.13-no-node')",
  );
  checks.https = await python(
    "import urllib.request,json\nwith urllib.request.urlopen('https://pypi.org/pypi/idna/3.10/json',timeout=10) as r:p=json.load(r)\nassert p['info']['version']=='3.10'\nprint('urllib-idna-3.10')",
  );
  checks.install = await python(
    "import subprocess,sys\nsubprocess.run([sys.executable,'-m','pip','install','--target','/tmp/deps','--no-cache-dir','--disable-pip-version-check','--no-deps','--retries','0','--timeout','10','--index-url','https://pypi.org/simple','idna==3.10'],check=True,timeout=20)\nprint('installed')",
  );
  checks.reuse = await python(
    "import sys;sys.path.insert(0,'/tmp/deps');import idna;assert idna.__version__=='3.10';print('reuse-idna-3.10')",
  );
  checks.deniedOrigin = await python(
    "import urllib.request,urllib.error\ntry:urllib.request.urlopen('https://example.com',timeout=3)\nexcept urllib.error.URLError as e:assert '403 Forbidden' in str(e);print('origin-denied')\nelse:raise RuntimeError('unexpected access')",
  );
  checks.directDenied = await python(
    "import socket,os\nfor k in list(os.environ):\n if k.lower().endswith('_proxy'):del os.environ[k]\nfor host in ['1.1.1.1','169.254.169.254']:\n try:s=socket.create_connection((host,443),timeout=1)\n except OSError:pass\n else:s.close();raise RuntimeError('unexpected direct access')\nprint('direct-denied')",
  );
  current = false;
  await delay(2000);
  checks.revoked = await python(
    "import socket\ntry:s=socket.create_connection(('127.0.0.1',3139),timeout=1)\nexcept OSError:print('relay-closed')\nelse:s.close();raise RuntimeError('relay remained open')",
  );
  proof.network = session.observation;
  proof.passed = true;
} finally {
  session?.close();
  if (id) {
    await inspect();
    await api.json('DELETE', `/containers/${id}?force=true&v=true`);
    proof.containerRemoved = true;
  }
  proof.finishedAt = new Date().toISOString();
  await writeFile(
    output + '/report.json',
    JSON.stringify(proof, null, 2) + '\n',
    { mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    passed: proof.passed,
    checks: Object.keys(checks),
    containerRemoved: proof.containerRemoved,
  }),
);
