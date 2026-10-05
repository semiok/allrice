import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CloudCommandSchema,
  cloudBackendV1,
  cloudToolchainImageV1,
} from '@allrice/contracts';
import { CloudRunnerBackend } from '../cloud-runner/backend.js';
import {
  loadRepositoryBaseline,
  repositoryCandidate,
  repositoryDigest,
  applyRepositoryCandidate,
  repositoryMaterialDigest,
} from '@allrice/database';
import {
  repairProductPath,
  repairProfileId,
  repositorySourceLimits,
  RepositoryExecutionProofSchema,
} from '@allrice/database/technical-contracts';
import {
  repositoryVerificationCommand,
  readRepositoryVerification,
  repairHarnessChecksum,
} from '@allrice/database';

const suite =
  process.env.ALLRICE_RUN_REPOSITORY_NATIVE === '1'
    ? describe.sequential
    : describe.skip;
suite('registered full AllRice source through existing runsc backend', () => {
  it('restores the full actual baseline and preserves a real failing assertion before a bounded candidate passes', async () => {
    const baselineInput = JSON.parse(
      readFileSync(process.env.ALLRICE_REPOSITORY_NATIVE_BASELINE!, 'utf8'),
    );
    const source = loadRepositoryBaseline(
      process.env.ALLRICE_REPOSITORY_NATIVE_CATALOG,
      baselineInput.id,
    );
    expect(source.baseline.fileCount).toBeGreaterThan(2000);
    expect(source.baseline.sourceBytes).toBeGreaterThan(20_000_000);
    expect(source.bytes.length).toBeGreaterThan(2_000_000);
    const file = source.archive.files.find(
      (f) => f.path === repairProductPath,
    )!;
    const original = Buffer.from(file.contentBase64, 'base64').toString('utf8');
    // Deterministic adapter fixture only. The actual private repair Run must
    // obtain its own model proposal and operation receipts; this is not that.
    const start = original.lastIndexOf('      .replace(');
    expect(start).toBeGreaterThan(0);
    const fixed =
      original.slice(0, start) +
      String.raw`      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'}]+)/gi,
        '$1[REDACTED]',
      );
  }
}
`;
    const candidates = [
      repositoryCandidate(0, []),
      repositoryCandidate(1, [
        {
          path: repairProductPath,
          beforeChecksum: file.checksum,
          afterBase64: Buffer.from(fixed).toString('base64'),
        },
      ]),
    ];
    const backend = new CloudRunnerBackend(),
      proofs: unknown[] = [];
    for (const candidate of candidates) {
      const candidateFiles = applyRepositoryCandidate(source.archive, candidate)
        .archive.files;
      const expected = repositoryMaterialDigest(candidateFiles);
      const args = repositoryVerificationCommand({
        baseline: source.baseline,
        candidate,
        object: { id: randomUUID(), checksum: source.baseline.archiveChecksum },
      });
      const command = CloudCommandSchema.parse({
        capability: 'cloud.process.execute',
        arguments: args,
        backend: cloudBackendV1,
        imageDigest: cloudToolchainImageV1,
        runtime: 'runsc',
        network: 'none',
      });
      const repositoryExecution = RepositoryExecutionProofSchema.parse({
        version: 1,
        profileId: repairProfileId,
        commandDigest: repositoryDigest(JSON.stringify(command)),
        baselineId: source.baseline.id,
        candidateChecksum: candidate.checksum,
        inputLimit: repositorySourceLimits.archiveBytes,
        tmpfsMiB: 64,
      });
      const attemptId = randomUUID();
      try {
        const result = await backend.execute(
          command,
          [
            {
              path: 'repository.json.gz',
              contentBase64: source.bytes.toString('base64'),
            },
          ],
          {
            attemptId,
            deadlineAt: new Date(Date.now() + 65000).toISOString(),
            maintainLease: async () => true,
            repositoryExecution,
          },
        );
        if (process.env.ALLRICE_REPOSITORY_NATIVE_EVIDENCE)
          writeFileSync(
            process.env.ALLRICE_REPOSITORY_NATIVE_EVIDENCE +
              '.attempt-' +
              attemptId +
              '.json',
            JSON.stringify(
              {
                baselineId: source.baseline.id,
                candidateChecksum: candidate.checksum,
                commandDigest: repositoryExecution.commandDigest,
                harnessChecksum: repairHarnessChecksum,
                result,
                assertionsVerified: false,
                scope:
                  'Original physical observation saved before parsing/QA assertions',
              },
              null,
              2,
            ) + '\n',
            { mode: 0o600 },
          );
        const report = readRepositoryVerification(
          result.output,
          source.baseline,
          candidate,
          {
            digest: expected,
            sourceBytes: candidateFiles.reduce((n, f) => n + f.sizeBytes, 0),
          },
        );
        expect(result.stopped).toBe(true);
        expect(result.repositoryIsolation).toMatchObject({
          parentUid: 0,
          candidateUid: 1001,
          commandDigest: repositoryExecution.commandDigest,
          capabilities: ['KILL', 'SETGID', 'SETUID'],
          readOnlyRoot: true,
          network: 'none',
        });
        expect(result.exitCode).toBe(candidate.revision === 0 ? 1 : 0);
        expect(result.reason).toBe(
          candidate.revision === 0 ? 'failed' : 'completed',
        );
        expect(report.failureKind).toBe(
          candidate.revision === 0 ? 'assertion_failed' : null,
        );
        expect(report.actualMaterialDigest).toBe(expected);
        expect(report.restoredDigest).toBe(source.baseline.sourceDigest);
        expect(report.harnessChecksum).toBe(repairHarnessChecksum);
        expect(report.monorepoDependenciesInstalled).toBe(false);
        if (candidate.revision) {
          expect(report.assertions.every((a) => a.passed)).toBe(true);
          expect(result.artifacts).toHaveLength(1);
          expect(
            JSON.parse(
              Buffer.from(
                result.artifacts[0]!.contentBase64,
                'base64',
              ).toString('utf8'),
            ),
          ).toEqual(report);
        } else {
          expect(
            report.assertions.filter((a) => !a.passed).length,
          ).toBeGreaterThan(0);
          expect(result.artifacts).toEqual([]);
        }
        proofs.push({
          attemptId,
          commandDigest: repositoryExecution.commandDigest,
          report,
          physical: {
            containerId: result.containerId,
            stopped: result.stopped,
            exitCode: result.exitCode,
            reason: result.reason,
            imageDigest: result.imageDigest,
            elapsedMs: result.elapsedMs,
          },
          modelGeneratedCandidate: false,
        });
      } finally {
        await backend.cleanup(attemptId, command);
        expect(await backend.inspect(attemptId)).toBeNull();
      }
    }
    if (process.env.ALLRICE_REPOSITORY_NATIVE_EVIDENCE)
      writeFileSync(
        process.env.ALLRICE_REPOSITORY_NATIVE_EVIDENCE,
        JSON.stringify(
          {
            passed: true,
            baseline: source.baseline,
            proofs,
            physicalCleanup: true,
            scope:
              'Full-source adapter/native profile; fixture candidate, no queue/model/Dev UI claim',
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
  }, 150000);
  it('attests protected root paths/signals and a cross-UID SIGKILL timeout without accepting candidate stdout as proof', async () => {
    const info = JSON.parse(
        readFileSync(process.env.ALLRICE_REPOSITORY_NATIVE_BASELINE!, 'utf8'),
      ),
      source = loadRepositoryBaseline(
        process.env.ALLRICE_REPOSITORY_NATIVE_CATALOG,
        info.id,
      ),
      backend = new CloudRunnerBackend();
    const probe = String.raw`
import fs from 'node:fs';
const denied=[];
for(const [id,fn] of [
 ['main-read',()=>fs.readFileSync('/tmp/work/main.mjs')],
 ['main-write',()=>fs.writeFileSync('/tmp/work/main.mjs','spoof')],
 ['main-chmod',()=>fs.chmodSync('/tmp/work/main.mjs',0o777)],
 ['input-read',()=>fs.readFileSync('/tmp/work/input/repository.json.gz')],
 ['oracle-read',()=>fs.readFileSync('/tmp/work/oracle')],
 ['report-write',()=>fs.writeFileSync('/tmp/work/output/verification.json','spoof')],
 ['parent-environ',()=>fs.readFileSync('/proc/'+process.ppid+'/environ')],
 ['parent-mem',()=>fs.openSync('/proc/'+process.ppid+'/mem','r')],
 ['parent-fd',()=>fs.openSync('/proc/'+process.ppid+'/fd/1','w')],
 ...['SIGTERM','SIGSTOP','SIGUSR1'].map(signal=>[signal,()=>process.kill(process.ppid,signal)])
]){let code=null;try{fn()}catch(e){code=e.code;}denied.push({id,code});}
process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups().filter(g=>g!==process.getgid()),identity:fs.readFileSync('/proc/self/status','utf8').split('\n').filter(v=>/^(Uid|Gid|Groups|Cap(Inh|Prm|Eff|Amb)):/.test(v)),denied}));
`;
    const script =
      "import fs from 'node:fs';import cp from 'node:child_process';\nconst probe=" +
      JSON.stringify(probe) +
      ';\n' +
      String.raw`
if(process.getuid()!==0)throw Error('parent');
fs.writeFileSync('/tmp/work/oracle','trusted',{mode:0o400});fs.chmodSync('/tmp/work',0o711);
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp'};
const child=cp.spawnSync('/usr/local/bin/node',['--input-type=module','--eval',probe],{uid:1001,gid:1001,env,timeout:10000,killSignal:'SIGKILL',maxBuffer:8192,stdio:['ignore','pipe','pipe']});
if(child.status!==0||child.error||child.signal)throw Error('child: '+child.stderr?.toString());
const report=JSON.parse(child.stdout.toString());console.log('REPOSITORY_NATIVE_BOUNDARY '+JSON.stringify(report));if(report.uid!==1001||report.gid!==1001||report.groups.length||report.denied.some(v=>!['EPERM','EACCES','ENOENT'].includes(v.code)))throw Error('boundary');
const start=Date.now();
const timed=cp.spawnSync('/usr/local/bin/node',['--input-type=module','--eval',"import cp from 'node:child_process';process.on('SIGTERM',()=>{});cp.spawn(process.execPath,['-e','while(true){}'],{detached:true,stdio:'ignore'}).unref();while(true){}"],{uid:1001,gid:1001,env,timeout:10000,killSignal:'SIGKILL',maxBuffer:8192,stdio:['ignore','pipe','pipe']});
if(timed.error?.code!=='ETIMEDOUT'||timed.signal!=='SIGKILL')throw Error('timeout');
console.log('REPOSITORY_NATIVE_ISOLATION '+JSON.stringify({...report,timeout:{signal:timed.signal,error:timed.error.code,elapsedMs:Date.now()-start}}));
`;
    const args = repositoryVerificationCommand({
      baseline: source.baseline,
      candidate: repositoryCandidate(0, []),
      object: { id: randomUUID(), checksum: source.baseline.archiveChecksum },
    });
    args.script = script;
    args.outputs = [];
    const command = CloudCommandSchema.parse({
        capability: 'cloud.process.execute',
        arguments: args,
        backend: cloudBackendV1,
        imageDigest: cloudToolchainImageV1,
        runtime: 'runsc',
        network: 'none',
      }),
      proof = RepositoryExecutionProofSchema.parse({
        version: 1,
        profileId: repairProfileId,
        commandDigest: repositoryDigest(JSON.stringify(command)),
        baselineId: source.baseline.id,
        candidateChecksum: repositoryCandidate(0, []).checksum,
        inputLimit: repositorySourceLimits.archiveBytes,
        tmpfsMiB: 64,
      }),
      attemptId = randomUUID();
    try {
      const result = await backend.execute(
        command,
        [
          {
            path: 'repository.json.gz',
            contentBase64: source.bytes.toString('base64'),
          },
        ],
        {
          attemptId,
          deadlineAt: new Date(Date.now() + 65000).toISOString(),
          maintainLease: async () => true,
          repositoryExecution: proof,
        },
      );
      const evidence = process.env.ALLRICE_REPOSITORY_NATIVE_EVIDENCE;
      if (evidence)
        writeFileSync(
          evidence + '.isolation-attempt-' + attemptId + '.json',
          JSON.stringify(
            {
              attemptId,
              proof,
              result,
              scope:
                'Trusted native diagnostic only; bypasses durable queue by design, no model/repair-task claim',
            },
            null,
            2,
          ) + '\n',
          { mode: 0o600 },
        );
      expect(result.exitCode, result.output).toBe(0);
      expect(result.reason).toBe('completed');
      expect(result.stopped).toBe(true);
      const line = result.output
        .split('\n')
        .find((v) => v.startsWith('REPOSITORY_NATIVE_ISOLATION '));
      expect(line).toBeDefined();
      const observed = JSON.parse(
        line!.slice('REPOSITORY_NATIVE_ISOLATION '.length),
      );
      expect(observed.groups).toEqual([]);
      expect(observed.denied).toHaveLength(12);
      expect(observed.timeout.signal).toBe('SIGKILL');
      expect(observed.timeout.elapsedMs).toBeGreaterThanOrEqual(9900);
      expect(observed.timeout.elapsedMs).toBeLessThan(15000);
      expect(
        observed.identity
          .filter((v: string) => /^Cap/.test(v))
          .every((v: string) => /:\s+0+$/.test(v)),
      ).toBe(true);
      expect(result.artifacts).toEqual([]);
    } finally {
      await backend.cleanup(attemptId, command);
      expect(await backend.inspect(attemptId)).toBeNull();
    }
  }, 120000);

  it('rejects the aggregate stdout spoof in the immutable parent before candidate code executes', async () => {
    const info = JSON.parse(
        readFileSync(process.env.ALLRICE_REPOSITORY_NATIVE_BASELINE!, 'utf8'),
      ),
      source = loadRepositoryBaseline(
        process.env.ALLRICE_REPOSITORY_NATIVE_CATALOG,
        info.id,
      ),
      file = source.archive.files.find((f) => f.path === repairProductPath)!;
    const spoof = String.raw`const {cases}=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));process.stdout.write(JSON.stringify({results:cases.map(c=>({id:c.id,text:c.exact??'[REDACTED]'}))}));process.exit(0);`;
    const candidate = repositoryCandidate(1, [
        {
          path: repairProductPath,
          beforeChecksum: file.checksum,
          afterBase64: Buffer.from(spoof).toString('base64'),
        },
      ]),
      args = repositoryVerificationCommand({
        baseline: source.baseline,
        candidate,
        object: { id: randomUUID(), checksum: source.baseline.archiveChecksum },
      }),
      command = CloudCommandSchema.parse({
        capability: 'cloud.process.execute',
        arguments: args,
        backend: cloudBackendV1,
        imageDigest: cloudToolchainImageV1,
        runtime: 'runsc',
        network: 'none',
      }),
      proof = RepositoryExecutionProofSchema.parse({
        version: 1,
        profileId: repairProfileId,
        commandDigest: repositoryDigest(JSON.stringify(command)),
        baselineId: source.baseline.id,
        candidateChecksum: candidate.checksum,
        inputLimit: repositorySourceLimits.archiveBytes,
        tmpfsMiB: 64,
      }),
      backend = new CloudRunnerBackend(),
      attemptId = randomUUID();
    try {
      const result = await backend.execute(
        command,
        [
          {
            path: 'repository.json.gz',
            contentBase64: source.bytes.toString('base64'),
          },
        ],
        {
          attemptId,
          deadlineAt: new Date(Date.now() + 65000).toISOString(),
          maintainLease: async () => true,
          repositoryExecution: proof,
        },
      );
      if (process.env.ALLRICE_REPOSITORY_NATIVE_EVIDENCE)
        writeFileSync(
          process.env.ALLRICE_REPOSITORY_NATIVE_EVIDENCE +
            '.spoof-attempt-' +
            attemptId +
            '.json',
          JSON.stringify({ attemptId, proof, result }, null, 2) + '\n',
          { mode: 0o600 },
        );
      expect(result.exitCode).not.toBe(0);
      expect(result.reason).toBe('failed');
      expect(result.output).toContain('REPOSITORY_REPAIR_TEMPLATE');
      expect(result.output).not.toContain('ALLRICE_REPOSITORY_VERIFICATION ');
      expect(result.artifacts).toEqual([]);
    } finally {
      await backend.cleanup(attemptId, command);
      expect(await backend.inspect(attemptId)).toBeNull();
    }
  }, 120000);
});
