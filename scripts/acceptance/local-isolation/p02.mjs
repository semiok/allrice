/** Standalone, synthetic P02 experiment. Never imported by Bridge or Worker. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
  copyFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

assert.equal(
  process.argv.length,
  2,
  'This fixture accepts no arbitrary commands or paths',
);
const source = fileURLToPath(new URL('./probe.c', import.meta.url));
const root = fileURLToPath(new URL('../../..', import.meta.url));
const report = {
  candidate: 'P02',
  schemaVersion: 1,
  fixtureVersion: 1,
  recordedAt: new Date().toISOString(),
  sourceBase: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  sourceDigests: {},
  platform: { os: platform(), arch: arch() },
  featureEnabled: false,
  productionChanges: false,
  cases: [],
  limitations: [],
};
for (const path of [source, fileURLToPath(import.meta.url)]) {
  report.sourceDigests[path.split('/').at(-1)] = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
if (platform() !== 'darwin') {
  console.log(
    JSON.stringify(
      {
        ...report,
        outcome: 'unsupported_not_tested',
        reason: 'macOS experiment only; no unsandboxed fallback',
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
report.platform.version = execFileSync(
  '/usr/bin/sw_vers',
  ['-productVersion'],
  { encoding: 'utf8' },
).trim();
report.platform.build = execFileSync('/usr/bin/sw_vers', ['-buildVersion'], {
  encoding: 'utf8',
}).trim();
report.platform.model = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], {
  encoding: 'utf8',
}).trim();
report.platform.node = process.version;

const temporary = await realpath(await mkdtemp(join(tmpdir(), 'allrice-p02-')));
const workspace = join(temporary, 'workspace');
const outside = join(temporary, 'outside');
const binary = join(temporary, 'probe');
const otherBinary = join(temporary, 'other-probe');
const credential = join(workspace, '.env');
const protectedDirectory = join(workspace, 'synthetic-credentials');
const sentinel = join(outside, 'sentinel');
const profilePath = join(temporary, 'strict.sb');
const forkProfilePath = join(temporary, 'fork.sb');
const sentinelText = 'synthetic-outside-canary\n';
const groups = new Set();
const cleanEnv = { PATH: '/usr/bin:/bin', LANG: 'C', TMPDIR: workspace };
const previousCanary = process.env.ALLRICE_P02_PARENT_CANARY;
process.env.ALLRICE_P02_PARENT_CANARY = 'synthetic-not-a-real-secret';
let tcpServer, udpServer, unixServer;

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function run(mode, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const sandboxed = options.sandboxed !== false;
    const argv = sandboxed
      ? ['-f', options.profile ?? profilePath, binary, 'limited', mode, ...args]
      : ['limited', mode, ...args];
    const child = spawn(sandboxed ? '/usr/bin/sandbox-exec' : binary, argv, {
      cwd: workspace,
      env: cleanEnv,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) groups.add(child.pid);
    let stdout = '',
      stderr = '',
      receivedBytes = 0,
      capturedBytes = 0,
      stoppedBy = null;
    const outputLimit = options.outputLimit ?? 16384;
    let force;
    const stop = (reason) => {
      if (stoppedBy || !child.pid) return;
      stoppedBy = reason;
      signalGroup(child.pid, 'SIGTERM');
      force = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), 100);
    };
    const collect = (channel, bytes) => {
      receivedBytes += bytes.length;
      const kept = bytes.subarray(0, Math.max(0, outputLimit - capturedBytes));
      capturedBytes += kept.length;
      if (channel === 'out') stdout += kept.toString();
      else stderr += kept.toString();
      if (receivedBytes > outputLimit) stop('output_limit');
    };
    child.stdout.on('data', (bytes) => collect('out', bytes));
    child.stderr.on('data', (bytes) => collect('err', bytes));
    const timeout = setTimeout(
      () => stop('wall_timeout'),
      options.timeout ?? 4000,
    );
    child.on('error', (error) => {
      clearTimeout(timeout);
      clearTimeout(force);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(force);
      if (child.pid) {
        signalGroup(child.pid, 'SIGKILL');
        groups.delete(child.pid);
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        receivedBytes,
        capturedBytes,
        stoppedBy,
      });
    });
  });
}
function success(result, text) {
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stoppedBy, null);
  assert.ok(result.stdout.includes(text), JSON.stringify(result));
}
async function test(id, evidence, fn, { observationOnly = false } = {}) {
  try {
    report.cases.push({
      id,
      evidence,
      status: observationOnly ? 'limitation_observed' : 'passed',
      observation: await fn(),
    });
  } catch (error) {
    report.cases.push({ id, evidence, status: 'failed', error: error.message });
  }
}
async function deny(id, mode, args, options) {
  await test(
    id,
    'OS sandbox denial plus parent-side sentinel checks',
    async () => {
      const result = await run(mode, args, options);
      success(result, 'denied errno=');
      assert.equal(await readFile(sentinel, 'utf8'), sentinelText);
      return { result: result.stdout.trim(), outsideSentinelUnchanged: true };
    },
  );
}

try {
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await mkdir(protectedDirectory);
  await Promise.all([
    writeFile(sentinel, sentinelText),
    writeFile(credential, 'synthetic-token-only\n'),
    writeFile(join(protectedDirectory, 'key'), 'synthetic-key-only\n'),
    symlink(outside, join(workspace, 'escape')),
    symlink(credential, join(workspace, 'credential-link')),
  ]);
  execFileSync(
    '/usr/bin/clang',
    ['-Wall', '-Wextra', '-Werror', '-O1', source, '-o', binary],
    {
      timeout: 30000,
      maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    },
  );
  await copyFile(binary, otherBinary);
  const q = (value) => JSON.stringify(value);
  // Explicit deny-default: no network, Mach lookup, IPC, Apple Events or broad
  // user-file content reads. dyld needs literal root read and directory metadata.
  // Executable and runtime content reads are separate from workspace read/write.
  const profile = `(version 1)
(deny default)
(allow file-read* (literal "/"))
(allow file-read-metadata (vnode-type DIRECTORY))
(allow file-read* (literal ${q(binary)}) (subpath "/usr/lib") (subpath "/System/Library"))
(allow file-map-executable)
(allow process-exec (literal ${q(binary)}))
(allow sysctl-read)
(allow signal (target same-sandbox))
(allow file-read* file-write* (subpath ${q(workspace)}))
(deny file-read* file-write* (literal ${q(credential)}) (subpath ${q(protectedDirectory)}))
`;
  await writeFile(profilePath, profile);
  await writeFile(forkProfilePath, `${profile}(allow process-fork)\n`);
  report.profileSha256 = createHash('sha256')
    .update(profile.replaceAll(temporary, '$FIXTURE'))
    .digest('hex');

  await test(
    'startup',
    'Actual sandbox-exec and compiled synthetic executable',
    async () => {
      success(await run('hello'), 'probe-started');
      return 'sandboxed probe started';
    },
  );
  await test(
    'workspace-read-write',
    'OS allowed root plus parent verification',
    async () => {
      const path = join(workspace, 'allowed');
      success(await run('rw', [path]), 'workspace-rw');
      assert.equal(await readFile(path, 'utf8'), 'synthetic-workspace\n');
      return 'authorized file created and reread';
    },
  );
  await deny('outside-read', 'read-denied', [sentinel]);
  await deny('outside-overwrite', 'write-denied', [sentinel]);
  await deny('outside-create', 'write-denied', [join(outside, 'new-file')]);
  await test(
    'outside-create-side-effects',
    'Parent verifies no new outside file',
    async () => {
      await assert.rejects(stat(join(outside, 'new-file')), { code: 'ENOENT' });
      return 'outside destination absent';
    },
  );
  await deny('relative-traversal', 'read-denied', ['../outside/sentinel']);
  await deny('symlink-read', 'read-denied', [
    join(workspace, 'escape', 'sentinel'),
  ]);
  await deny('symlink-write', 'write-denied', [
    join(workspace, 'escape', 'sentinel'),
  ]);
  await deny('synthetic-credential-read', 'read-denied', [credential]);
  await deny('synthetic-credential-link', 'read-denied', [
    join(workspace, 'credential-link'),
  ]);
  await deny('synthetic-credential-rename', 'rename-denied', [
    credential,
    join(workspace, 'moved-credential'),
  ]);
  await deny('credential-directory-rename', 'rename-denied', [
    protectedDirectory,
    join(workspace, 'moved-keys'),
  ]);
  await deny('synthetic-credential-hardlink', 'link-denied', [
    credential,
    join(workspace, 'linked-credential'),
  ]);
  await test(
    'credential-side-effects',
    'Parent verifies synthetic credentials, no renamed copies',
    async () => {
      assert.equal(
        await readFile(credential, 'utf8'),
        'synthetic-token-only\n',
      );
      assert.equal(
        await readFile(join(protectedDirectory, 'key'), 'utf8'),
        'synthetic-key-only\n',
      );
      await assert.rejects(stat(join(workspace, 'moved-credential')), {
        code: 'ENOENT',
      });
      await assert.rejects(stat(join(workspace, 'moved-keys')), {
        code: 'ENOENT',
      });
      await assert.rejects(stat(join(workspace, 'linked-credential')), {
        code: 'ENOENT',
      });
      return 'original credentials unchanged; no renamed destinations';
    },
  );
  await test(
    'environment-filter',
    'Trusted supervisor env allowlist, NOT OS credential proof',
    async () => {
      success(await run('env'), 'environment-filtered');
      return 'synthetic parent canary not inherited';
    },
  );
  let tcpConnections = 0,
    udpMessages = 0,
    unixConnections = 0;
  tcpServer = createServer((socket) => {
    tcpConnections++;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(0, '127.0.0.1', resolve);
  });
  udpServer = createSocket('udp4');
  udpServer.on('message', () => udpMessages++);
  await new Promise((resolve, reject) => {
    udpServer.once('error', reject);
    udpServer.bind(0, '127.0.0.1', resolve);
  });
  const tcpPort = String(tcpServer.address().port),
    udpPort = String(udpServer.address().port);
  const socketPath = join(workspace, 'ipc.sock');
  unixServer = createServer((socket) => {
    unixConnections++;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    unixServer.once('error', reject);
    unixServer.listen(socketPath, resolve);
  });
  await test(
    'network-positive-controls',
    'Only synthetic loopback listeners, unsandboxed control',
    async () => {
      success(
        await run('tcp', [tcpPort], { sandboxed: false }),
        'network-reached',
      );
      success(
        await run('udp', [udpPort], { sandboxed: false }),
        'network-reached',
      );
      success(
        await run('unix', [socketPath], { sandboxed: false }),
        'network-reached',
      );
      await delay(100);
      assert.equal(tcpConnections, 1);
      assert.equal(udpMessages, 1);
      assert.equal(unixConnections, 1);
      return 'one TCP connection, UDP message and Unix socket connection reached controlled listeners';
    },
  );
  await deny('tcp-denied', 'tcp', [tcpPort]);
  await deny('udp-denied', 'udp', [udpPort]);
  await deny('unix-socket-denied', 'unix', [socketPath]);
  await deny('listener-bind-denied', 'bind');
  await test(
    'no-network-side-effects',
    'Parent listener counters after sandbox attempts',
    async () => {
      await delay(100);
      assert.equal(tcpConnections, 1);
      assert.equal(udpMessages, 1);
      assert.equal(unixConnections, 1);
      return 'zero additional TCP/Unix connections or UDP packets';
    },
  );
  await deny('fork-denied', 'fork-denied');
  await deny(
    'fork-exec-inherits-filesystem-policy',
    'inherit',
    [binary, sentinel],
    { profile: forkProfilePath },
  );
  await deny('nonallowlisted-fixture-exec-denied', 'exec-denied', [
    otherBinary,
  ]);
  await test(
    'fd-limit',
    'Trusted pre-exec hard RLIMIT_NOFILE=32, per process',
    async () => {
      const result = await run('fds', [join(workspace, 'allowed')]);
      success(result, 'fds=');
      return result.stdout.trim();
    },
  );
  await test(
    'file-size-limit',
    'Trusted pre-exec hard RLIMIT_FSIZE=64KiB, not pipe output',
    async () => {
      const path = join(workspace, 'bounded-file');
      const result = await run('file-size', [path]);
      success(result, 'file-bytes=65536');
      assert.equal((await stat(path)).size, 65536);
      return result.stdout.trim();
    },
  );
  await test(
    'cpu-limit',
    'Trusted pre-exec RLIMIT_CPU soft1/hard2 seconds, per process',
    async () => {
      const result = await run('cpu');
      assert.equal(result.stoppedBy, null, JSON.stringify(result));
      assert.ok(
        ['SIGXCPU', 'SIGKILL'].includes(result.signal),
        JSON.stringify(result),
      );
      return { signal: result.signal, supervisorTimeout: false };
    },
  );
  await test(
    'cpu-hard-boundary-observation',
    'Probe ignores SIGXCPU; observe enforcement beyond hard2 using <=2.5CPU seconds',
    async () => {
      const result = await run('cpu-hard');
      assert.equal(result.stoppedBy, null, JSON.stringify(result));
      assert.ok(
        result.signal === 'SIGKILL' ||
          (result.code === 0 &&
            result.stdout.includes('survived-hard-limit cpu-us=')),
        JSON.stringify(result),
      );
      report.limitations.push(
        'CPU hard-limit observation is platform-specific; ignored SIGXCPU may outlive the configured hard limit. Never replace trusted wall/job supervision with rlimit alone.',
      );
      return {
        signal: result.signal,
        result: result.stdout.trim(),
        supervisorTimeout: false,
      };
    },
    { observationOnly: true },
  );
  await test(
    'wall-timeout',
    'Supervisor timeout of known process group, not all descendants',
    async () => {
      const result = await run('wall', [], { timeout: 300 });
      assert.equal(result.stoppedBy, 'wall_timeout');
      assert.ok(result.signal);
      return { stoppedBy: result.stoppedBy, signal: result.signal };
    },
  );
  await test(
    'output-cap',
    'Supervisor captures at most16KiB; fixture emits at most64KiB',
    async () => {
      const result = await run('output');
      assert.equal(result.stoppedBy, 'output_limit');
      assert.equal(result.capturedBytes, 16384);
      return {
        stoppedBy: result.stoppedBy,
        capturedBytes: result.capturedBytes,
        receivedBytes: result.receivedBytes,
      };
    },
  );
  await test(
    'memory-boundary-observation',
    'Bounded16MiB mmap probe; RLIMIT_DATA is not total memory limit',
    async () => {
      const result = await run('memory-gap');
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.match(
        result.stdout,
        /mapped-16MiB-despite-8MiB-DATA|mmap-denied errno=|mapped-16MiB-without-requested-DATA-limit/,
      );
      report.limitations.push(
        'No aggregate memory guarantee: DATA/mmap observation is not a VM or job memory boundary.',
      );
      return result.stdout.trim();
    },
    { observationOnly: true },
  );
  await test(
    'process-group-boundary-observation',
    'Exactly one setsid descendant, self-terminates after1.2s',
    async () => {
      const heartbeat = join(workspace, 'descendant-heartbeat'),
        done = join(workspace, 'descendant-done');
      const result = await run('process-group-gap', [heartbeat, done], {
        profile: forkProfilePath,
        timeout: 350,
      });
      assert.equal(result.stoppedBy, 'wall_timeout');
      assert.ok(result.stdout.includes('one-bounded-descendant-started'));
      const before = (await stat(heartbeat)).mtimeMs;
      await delay(300);
      const after = (await stat(heartbeat)).mtimeMs;
      await delay(1300);
      assert.equal(
        await readFile(done, 'utf8'),
        'bounded-descendant-finished\n',
      );
      assert.ok(
        after > before,
        'Expected independent descendant evidence; otherwise re-evaluate backend behavior',
      );
      report.limitations.push(
        'Observed setsid descendant surviving process-group cancellation. P05 must not claim full-tree stop.',
      );
      return {
        parentStopped: true,
        descendantWroteAfterGroupStop: true,
        boundedDescendantCompleted: true,
      };
    },
    { observationOnly: true },
  );
  await test(
    'invalid-profile-fails-closed',
    'Malformed profile cannot fall back to bare execution',
    async () => {
      const invalid = join(temporary, 'invalid.sb');
      await writeFile(
        invalid,
        '(version 1)\n(this-is-not-a-valid-profile-rule)\n',
      );
      const result = await run('hello', [], { profile: invalid });
      assert.notEqual(result.code, 0);
      assert.ok(!result.stdout.includes('probe-started'));
      return 'no probe startup after profile compilation error';
    },
  );
} finally {
  for (const pid of groups) signalGroup(pid, 'SIGKILL');
  if (tcpServer?.listening)
    await new Promise((resolve) => tcpServer.close(resolve));
  if (unixServer?.listening)
    await new Promise((resolve) => unixServer.close(resolve));
  if (udpServer) udpServer.close();
  // The sole detached fixture child has its own <=3s alarm; wait before cleanup
  // even when its assertion fails. No arbitrary process enumeration or kill.
  await delay(3100);
  if (previousCanary === undefined)
    delete process.env.ALLRICE_P02_PARENT_CANARY;
  else process.env.ALLRICE_P02_PARENT_CANARY = previousCanary;
  assert.equal(dirname(temporary), await realpath(tmpdir()));
  assert.ok(temporary.split('/').at(-1).startsWith('allrice-p02-'));
  await rm(temporary, { recursive: true, force: true });
}
report.limitations.push(
  'sandbox-exec is deprecated; profile is a narrow PoC, not a supported general-purpose CLI policy.',
);
report.limitations.push(
  'NPROC is per UID, CPU and FD limits are per process, not aggregate tenant/job budgets.',
);
report.summary = {
  passed: report.cases.filter((item) => item.status === 'passed').length,
  limitationsObserved: report.cases.filter(
    (item) => item.status === 'limitation_observed',
  ).length,
  failed: report.cases.filter((item) => item.status === 'failed').length,
  productionRunnerReady: false,
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.summary.failed ? 1 : 0;
