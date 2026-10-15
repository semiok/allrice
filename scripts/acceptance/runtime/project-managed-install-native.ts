/** Resolve evidence -> exact saved source -> physical installation and repeat.
 * Component acceptance only: synthetic owner/scope, no model or business files.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import {
  CloudProjectCommandSchema,
  cloudToolchainImageV1,
  cloudPythonImageV1,
  projectRuntimeCacheIdentity,
} from '../../../packages/contracts/src/index.js';
import { readResolvedProject } from '../../../packages/project-runtime/src/project-resolution.js';
import { CloudRunnerBackend } from '../../../apps/worker/src/cloud-runner/backend.js';

const directory = process.env.ALLRICE_SANDBOX_ACCEPTANCE_OUTPUT;
const evidenceDirectory = process.env.ALLRICE_MANAGED_RESOLUTION_EVIDENCE;
assert.ok(
  directory &&
    evidenceDirectory &&
    process.env.ALLRICE_SANDBOX_ACCEPTANCE_WINDOW === 'owned',
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
const sha = (data: string | Buffer) =>
  'sha256:' + createHash('sha256').update(data).digest('hex');
const backend = new CloudRunnerBackend();
const checks: unknown[] = [];
const cases = [
  {
    name: 'pnpm-install',
    evidence: 'managed-resolution-native-pass1/pnpm-resolve.json',
    script:
      "const assert=require('node:assert/strict');assert.equal(require('is-number')(42),true);assert.equal(require('is-number')('no'),false);console.log('managed-install:verified')",
  },
  {
    name: 'uv-install',
    evidence: 'managed-resolution-native-pass3/uv-resolve.json',
    script:
      "import six\nassert six.__version__=='1.17.0'\nassert six.text_type(42)=='42'\nprint('managed-install:verified')\n",
  },
  {
    name: 'rea-install',
    evidence: 'managed-resolution-native-pass3/rea-resolve.json',
    web: true,
    script:
      "const assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');const p=require('./node_modules/rea-agents/package.json');assert.equal(p.version,'6.5.0');const bin=typeof p.bin==='string'?p.bin:p.bin?.rea;assert.ok(bin);const started=Date.now();const r=spawnSync(process.execPath,['node_modules/rea-agents/'+bin,'--help'],{encoding:'utf8',timeout:90000});console.log(r.stdout);console.error(r.stderr);console.log(JSON.stringify({cliExit:r.status,signal:r.signal,error:r.error?.code,elapsedMs:Date.now()-started}));assert.equal(r.status,0);assert.match(r.stdout,/rea/i);console.log('managed-install:verified')",
  },
];
const selected = process.env.ALLRICE_SANDBOX_ACCEPTANCE_CASES?.split(',');
// A diagnostic continuation may restore this acceptance's own exact scope and
// pinned lock to reuse already verified archive downloads. It is a new physical
// attempt and a new source version, never a replay of an uncertain operation.
const resumePath = process.env.ALLRICE_SANDBOX_ACCEPTANCE_RESUME_INPUT;
if (resumePath)
  assert.ok(
    resumePath.startsWith(evidenceDirectory + '/managed-install-native-') &&
      resumePath.endsWith('/rea-install-1-input.json') &&
      selected?.length === 1 &&
      selected[0] === 'rea-install',
  );
const resumed = resumePath
  ? JSON.parse(await readFile(resumePath, 'utf8'))
  : undefined;
if (resumed) {
  const prior = JSON.parse(
    await readFile(resumePath!.replace('-input.json', '.json'), 'utf8'),
  );
  assert.equal(prior.attemptId, resumed.attemptId);
  assert.ok(prior.result.stopped && prior.result.reason !== 'unknown');
  assert.equal(await backend.inspect(resumed.attemptId), null);
}
try {
  for (const item of cases.filter(
    (c) => !selected || selected.includes(c.name),
  )) {
    const original = JSON.parse(
      await readFile(evidenceDirectory + '/' + item.evidence, 'utf8'),
    );
    assert.equal(original.result.exitCode, 0);
    assert.equal(original.result.reason, 'completed');
    const request = {
      ...original.request,
      ...(item.web ? { resourceProfile: 'web-development' } : {}),
    };
    const resolved = readResolvedProject(
      request,
      Buffer.from(JSON.stringify(original.result.resolution)),
    );
    assert.ok(resolved.files && resolved.forProject);
    const python = request.manager === 'uv';
    if (resumed)
      assert.equal(
        resumed.command.arguments.projectPreparation.lockChecksum,
        resolved.forProject(randomUUID()).lockChecksum,
      );
    const projectId = resumed?.project.projectId ?? randomUUID();
    const files = [
      ...resolved.files,
      { path: python ? 'verify.py' : 'verify.cjs', text: item.script },
    ].sort((a, b) => a.path.localeCompare(b.path));
    const manifest = files.map((f) => ({ path: f.path, sha256: sha(f.text) }));
    const sourceDigest = sha(JSON.stringify(manifest));
    const spec = { ...resolved.forProject(projectId), sourceDigest };
    const snapshot = {
      version: 1 as const,
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
        kind: 'artifact' as const,
        id: randomUUID(),
        checksum: sha(JSON.stringify(snapshot)),
      },
    };
    const scope = resumed?.scope ?? {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
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
    const cacheVolume = 'allrice-project-cache-' + cacheKey.slice(7);
    try {
      for (let run = 1; run <= 2; run++) {
        const attemptId = randomUUID();
        const command = CloudProjectCommandSchema.parse({
          kind: 'project',
          capability: 'cloud.process.execute',
          backend: 'cloud-gvisor-v1',
          runtime: 'runsc',
          network: 'none',
          imageDigest: image,
          arguments: {
            executable: python
              ? '/workspace/.venv/bin/python'
              : '/usr/local/bin/node',
            args: [python ? 'verify.py' : 'verify.cjs'],
            path: '.',
            files: manifest,
            imageDigest: image,
            limits: {
              timeoutMs: item.web ? 600000 : 60000,
              memoryMiB: item.web ? 1536 : 512,
              cpuMillis: 1000,
              pids: item.web ? 128 : 64,
              outputBytes: 32768,
            },
            projectPreparation: { ...spec, offline: run === 2 },
            projectSource: {
              version: 1,
              project,
              snapshot,
              architecture: 'amd64',
              cacheKey,
              executionOrigin: {
                toolName: 'workspace.project',
                callId: item.name + '-' + run,
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
        await save(item.name + '-' + run + '-input', {
          attemptId,
          project,
          cacheKey,
          scope,
          command,
        });
        try {
          const result = await backend.execute(command, [], {
            attemptId,
            deadlineAt: new Date(
              Date.now() + command.arguments.limits.timeoutMs,
            ).toISOString(),
            maintainLease: async () => true,
            projectScope: scope,
          });
          await save(item.name + '-' + run, {
            attemptId,
            project,
            cacheKey,
            scope,
            command,
            result,
          });
          assert.equal(result.reason, 'completed');
          assert.equal(result.exitCode, 0);
          assert.equal(result.projectPreparation?.installation, 'succeeded');
          assert.equal(
            result.projectPreparation.savedSource?.restoredDigest,
            sourceDigest,
          );
          assert.ok(result.output.includes('managed-install:verified'));
          if (run === 2) {
            assert.equal(result.projectPreparation.downloadedArchives, 0);
            assert.ok(result.projectPreparation.archiveHits > 0);
          }
          const proof = {
            name: item.name,
            run,
            passed: true,
            elapsedMs: result.elapsedMs,
            installation: result.projectPreparation,
          };
          checks.push(proof);
          console.log(JSON.stringify(proof));
        } finally {
          const c = await backend.inspect(attemptId);
          if (c?.State.Running) await backend.stop(attemptId);
          await backend.cleanup(attemptId, command);
          assert.equal(await backend.inspect(attemptId), null);
        }
      }
    } finally {
      // Only this synthetic project's exact cache. Never touch business caches.
      const volume = await backend
        .json<{ Name: string; Labels: Record<string, string> }>(
          'GET',
          '/volumes/' + cacheVolume,
        )
        .catch((e: unknown) => {
          if (e instanceof Error && e.message === 'CLOUD_DAEMON_404')
            return null;
          throw e;
        });
      if (volume) {
        assert.equal(volume.Name, cacheVolume);
        assert.equal(
          volume.Labels['xyz.bplabs.allrice.project.cache'],
          cacheKey,
        );
        await backend.call('DELETE', '/volumes/' + cacheVolume);
      }
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
