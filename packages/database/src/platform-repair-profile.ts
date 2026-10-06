import { CloudCommandInputSchema } from '@allrice/contracts';
import {
  RepositoryBaselineSchema,
  RepositoryCandidateSchema,
  RepositoryVerificationSchema,
  repairProfileId,
  repairProductPath,
  repositorySourceLimits,
  compiledRepairProfileId,
  CompiledDependencyDescriptorSchema,
  type CompiledDependencyDescriptor,
  type RepositoryBaseline,
  type RepositoryCandidate,
} from './platform-repair-contracts.ts';
import { repositoryDigest } from './platform-repository-source.ts';
import {
  repairSlotStart,
  repairSlotClose,
  repairSlotPattern,
  repairReplacementPattern,
} from './platform-repair-template.ts';
import {
  compiledRepairChildHarness,
  compiledRepositoryHarness,
  compiledHarnessChecksum,
} from './platform-repair-compiled-profile.ts';

// This immutable harness is outside the model's editable file set. A separate
// child loads the proposed module; assertions and material checks stay in the
// original parent. No pnpm installation or arbitrary host command is implied.
export const repairAssertionCases = [
  {
    id: 'quoted_double_space',
    input: 'password="synthetic phrase tail"\n',
    hidden: ['synthetic', 'phrase', 'tail'],
  },
  {
    id: 'quoted_single_space',
    input: "api_key='synthetic phrase tail'\n",
    hidden: ['synthetic', 'phrase', 'tail'],
  },
  {
    id: 'quoted_json_space',
    input: '{"refresh_token":"synthetic phrase tail"}\n',
    hidden: ['synthetic', 'phrase', 'tail'],
  },
  {
    id: 'quoted_escaped_quote',
    input: 'secret="synthetic\\" phrase tail"\n',
    hidden: ['synthetic', 'phrase', 'tail'],
  },
  {
    id: 'unquoted_credential',
    input: 'api_key=synthetic-hidden\n',
    hidden: ['synthetic-hidden'],
  },
  {
    id: 'bearer_credential',
    input: 'Authorization: Bearer synthetic-hidden-token\n',
    hidden: ['synthetic-hidden-token'],
  },
  {
    id: 'ordinary_utf8',
    input: '普通工作输出 中文\n',
    exact: '普通工作输出 中文\n',
  },
  {
    id: 'split_quoted_value',
    input: 'password="synthetic phrase tail"\n',
    hidden: ['synthetic', 'phrase', 'tail'],
    split: 15,
  },
] as const;
const childHarness = String.raw`
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const identity=readFileSync('/proc/self/status','utf8');
if(!/^Uid:\s+1001\s+1001\s+1001\s+1001$/m.test(identity)||!/^Gid:\s+1001\s+1001\s+1001\s+1001$/m.test(identity)||!/^Groups:\s*$/m.test(identity)||['CapInh','CapPrm','CapEff','CapAmb'].some(k=>!new RegExp('^'+k+':\\s+0+$','m').test(identity)))throw Error('REPOSITORY_CHILD_IDENTITY');
const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const source=readFileSync(input.path,'utf8');
const {LocalCommandOutputFilter}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const f=new LocalCommandOutputFilter(),b=Buffer.from(input.input);let text='';
if(input.split){text+=f.push(b.subarray(0,input.split));text+=f.push(b.subarray(input.split),true);}else text=f.push(b,true);
process.stdout.write(JSON.stringify({text}));
`;
const harness = String.raw`
import {readFileSync,writeFileSync,mkdirSync,chmodSync,readdirSync,lstatSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
const sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const sort=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
if(process.getuid()!==0||process.getgid()!==0)throw Error('REPOSITORY_PARENT_IDENTITY');
const root='/tmp/work/repository';
const packed=readFileSync('/tmp/work/input/repository.json.gz');
if(packed.length!==config.baseline.archiveBytes||packed.length>config.limits.archiveBytes||sha(packed)!==config.baseline.archiveChecksum)throw Error('REPOSITORY_ARCHIVE_CHANGED');
const value=JSON.parse(gunzipSync(packed,{maxOutputLength:config.limits.jsonBytes}).toString('utf8'));
if(value.version!==1||!Array.isArray(value.files)||value.files.length!==config.baseline.fileCount||value.files.length>config.limits.files)throw Error('REPOSITORY_SOURCE_CHANGED');
const files=value.files,seen=new Set();let total=0;
for(const f of files){
 const key=f.path?.normalize('NFC').toLowerCase();
 if(typeof f.path!=='string'||f.path.length>240||f.path!==f.path.normalize('NFC')||f.path.startsWith('/')||f.path.includes('\\')||/[:\x00-\x1f\x7f]/.test(f.path)||f.path.split('/').some(p=>!p||p==='.'||p==='..'||(/^(?:\.git|\.ssh|\.aws|\.gnupg|\.credentials(?:\..*)?|\.netrc|\.npmrc|\.env(?:\..*)?|id_rsa|id_ed25519)$/i.test(p)&&p!=='.env.example'&&!(p==='.npmrc'&&f.path==='.npmrc')))||seen.has(key)||!['100644','100755'].includes(f.mode))throw Error('REPOSITORY_PATH_UNSAFE');
 seen.add(key);const b=Buffer.from(f.contentBase64,'base64');total+=b.length;
 if(f.path==='.npmrc'&&b.toString('utf8').split('\n').some(line=>line.trim()&&!/^[#;]/.test(line.trim())&&!/^(engine-strict|strict-peer-dependencies|shared-workspace-lockfile|enable-pre-post-scripts|ignore-scripts)=(true|false)$/.test(line.trim())))throw Error('REPOSITORY_NPM_CONFIG_UNSAFE');
 if(b.toString('base64')!==f.contentBase64||b.length!==f.sizeBytes||b.length>config.limits.fileBytes||total>config.limits.totalBytes||sha(b)!==f.checksum)throw Error('REPOSITORY_SOURCE_CHANGED');
}
for(const key of seen)if(key.split('/').slice(0,-1).some((_,i,parts)=>seen.has(parts.slice(0,i+1).join('/'))))throw Error('REPOSITORY_PATH_UNSAFE');
const manifest=fs=>fs.map(({path,mode,sizeBytes,checksum})=>({path,mode,sizeBytes,checksum})).sort(sort);
const digest=fs=>sha(JSON.stringify(manifest(fs)));
const dependency=fs=>digest(fs.filter(f=>/(^|\/)(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|\.pnpmfile\.cjs|\.npmrc)$/.test(f.path)||f.path.startsWith('patches/')));
if(digest(files)!==config.baseline.sourceDigest||files.find(f=>f.path==='pnpm-lock.yaml')?.checksum!==config.baseline.rootLockChecksum||dependency(files)!==config.baseline.dependencyConfigurationDigest||total!==config.baseline.sourceBytes)throw Error('REPOSITORY_BASELINE_CHANGED');
mkdirSync(root,{mode:0o700});
for(const f of files){const p=root+'/'+f.path;mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true,mode:0o700});writeFileSync(p,Buffer.from(f.contentBase64,'base64'),{flag:'wx',mode:f.mode==='100755'?0o500:0o400});}
// Validate every actual restored file, not just the editable module. No links,
// extras or alias paths are accepted before or after the child executes.
const physical=()=>{const found=[],dirs=[''];while(dirs.length){const dir=dirs.pop();for(const name of readdirSync(root+(dir?'/'+dir:''))){const path=(dir?dir+'/':'')+name,p=root+'/'+path,s=lstatSync(p);if(s.isSymbolicLink())throw Error('REPOSITORY_COPY_CHANGED');if(s.isDirectory())dirs.push(path);else if(s.isFile()&&s.nlink===1){const b=readFileSync(p);found.push({path,mode:s.mode&0o111?'100755':'100644',sizeBytes:b.length,checksum:sha(b)});}else throw Error('REPOSITORY_COPY_CHANGED');}}if(found.length!==files.length)throw Error('REPOSITORY_COPY_CHANGED');return sha(JSON.stringify(found.sort(sort)));};
const restoredDigest=physical();if(restoredDigest!==config.baseline.sourceDigest)throw Error('REPOSITORY_COPY_CHANGED');
for(const patch of config.candidate.files){const f=files.find(f=>f.path===patch.path),b=Buffer.from(patch.afterBase64,'base64');
 if(patch.path!==config.productPath||!f||f.checksum!==patch.beforeChecksum||b.length>50000||!b.length||b.toString('base64')!==patch.afterBase64)throw Error('REPOSITORY_PATCH_CONFLICT');
 const original=Buffer.from(f.contentBase64,'base64').toString('utf8'),after=b.toString('utf8'),start=original.lastIndexOf(config.slot.start),end=original.indexOf(config.slot.close,start);
 if(start<0||end<start)throw Error('REPOSITORY_REPAIR_TEMPLATE');
 const prefix=original.slice(0,start),suffix=original.slice(end+config.slot.close.length);
 const match=after.startsWith(prefix)&&after.endsWith(suffix)&&new RegExp(config.slot.pattern).exec(after.slice(prefix.length,after.length-suffix.length));
 if(!match||!match[2].includes('g')||new Set(match[2]).size!==match[2].length||!new RegExp(config.slot.replacement).test(match[4])||!match[4].includes('[REDACTED]'))throw Error('REPOSITORY_REPAIR_TEMPLATE');
 new RegExp(match[1],match[2]);
 const p=root+'/'+patch.path;chmodSync(p,0o600);writeFileSync(p,b);chmodSync(p,0o400);Object.assign(f,{sizeBytes:b.length,checksum:sha(b),contentBase64:patch.afterBase64});
}
const candidateMaterialDigest=digest(files);if(physical()!==candidateMaterialDigest)throw Error('REPOSITORY_COPY_CHANGED');
// The compressed source no longer needs to occupy the finite sandbox disk.
unlinkSync('/tmp/work/input/repository.json.gz');
// Only traversal to the single immutable product file is granted. Other
// repository files, inputs, main and report paths remain root-only.
chmodSync('/tmp/work',0o711);chmodSync(root,0o711);
const parts=config.productPath.split('/');for(let i=1;i<parts.length;i++)chmodSync(root+'/'+parts.slice(0,i).join('/'),0o711);
chmodSync(root+'/'+config.productPath,0o444);
const childDeadline=Date.now()+10000,results=[];let valid=true;
for(const c of config.cases){
 const remaining=childDeadline-Date.now();if(remaining<=0){valid=false;break;}
 const child=spawnSync('/usr/local/bin/node',['--input-type=module','--eval',config.childHarness,Buffer.from(JSON.stringify({path:root+'/'+config.productPath,input:c.input,...(c.split?{split:c.split}:{})})).toString('base64')],{cwd:root,uid:1001,gid:1001,timeout:remaining,killSignal:'SIGKILL',maxBuffer:8192,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8',NODE_NO_WARNINGS:'1'}});
 let result=null;try{if(child.status===0&&!child.signal&&!child.error)result=JSON.parse(child.stdout.toString('utf8'));}catch{}
 if(!result||Object.keys(result).length!==1||typeof result.text!=='string'||Buffer.byteLength(result.text)>=8192){valid=false;break;}
 results.push(result.text);
}
const assertions=config.cases.map((c,i)=>({id:c.id,passed:valid&&results.length===config.cases.length&&(c.exact!==undefined?results[i]===c.exact:results[i].includes('[REDACTED]')&&c.hidden.every(part=>!results[i].includes(part)))}));
const actualMaterialDigest=physical();if(actualMaterialDigest!==candidateMaterialDigest)throw Error('REPOSITORY_COPY_CHANGED');
const passed=valid&&assertions.every(a=>a.passed),exitCode=passed?0:valid?1:3;
const report={version:1,baselineId:config.baseline.id,sourceSha:config.baseline.sourceSha,baselineSourceDigest:config.baseline.sourceDigest,restoredDigest,candidateChecksum:config.candidate.checksum,candidateMaterialDigest,actualMaterialDigest,rootLockChecksum:config.baseline.rootLockChecksum,dependencyConfigurationDigest:config.baseline.dependencyConfigurationDigest,profileId:config.profileId,harnessChecksum:config.harnessChecksum,dependencyMode:'runtime_builtins_only',monorepoDependenciesInstalled:false,nodeVersion:process.version,sourceFileCount:files.length,sourceBytes:files.reduce((n,f)=>n+f.sizeBytes,0),candidateIdentity:{uid:1001,gid:1001,capabilities:'none'},assertions,failureKind:passed?null:valid?'assertion_failed':'harness_error',exitCode};
console.log('ALLRICE_REPOSITORY_VERIFICATION '+JSON.stringify(report));
if(passed)writeFileSync('/tmp/work/output/verification.json',JSON.stringify(report)+'\n',{mode:0o600});
process.exitCode=exitCode;
`;
export const repairHarnessChecksum = repositoryDigest(
  JSON.stringify({
    harness,
    childHarness,
    cases: repairAssertionCases,
    slot: {
      start: repairSlotStart,
      close: repairSlotClose,
      pattern: repairSlotPattern,
      replacement: repairReplacementPattern,
    },
  }),
);
export function repositoryVerificationCommand(input: {
  baseline: RepositoryBaseline;
  candidate: RepositoryCandidate;
  object: { id: string; checksum: string };
  compiled?: {
    descriptor: CompiledDependencyDescriptor;
    object: { id: string; checksum: string };
  };
}) {
  const baseline = RepositoryBaselineSchema.parse(input.baseline),
    candidate = RepositoryCandidateSchema.parse(input.candidate);
  const config = {
    baseline,
    candidate,
    profileId: input.compiled ? compiledRepairProfileId : repairProfileId,
    productPath: repairProductPath,
    childHarness: input.compiled ? compiledRepairChildHarness : childHarness,
    slot: {
      start: repairSlotStart,
      close: repairSlotClose,
      pattern: repairSlotPattern,
      replacement: repairReplacementPattern,
    },
    cases: repairAssertionCases,
    harnessChecksum: repairHarnessChecksumFor(!!input.compiled),
    limits: repositorySourceLimits,
    // PostgreSQL jsonb reorders keys. Schema parsing produces the same ordered
    // descriptor for preparation, lease checks and recovery command digests.
    ...(input.compiled
      ? {
          compiled: CompiledDependencyDescriptorSchema.parse(
            input.compiled.descriptor,
          ),
        }
      : {}),
  };
  return CloudCommandInputSchema.parse({
    script:
      'const config=' +
      JSON.stringify(config) +
      ';\n' +
      (input.compiled ? compiledRepositoryHarness(harness) : harness),
    inputs: [
      {
        path: 'repository.json.gz',
        objectId: input.object.id,
        checksum: input.object.checksum,
      },
      ...(input.compiled
        ? [
            {
              path: 'dependencies.json.gz',
              objectId: input.compiled.object.id,
              checksum: input.compiled.object.checksum,
            },
          ]
        : []),
    ],
    outputs: [
      {
        path: 'verification.json',
        fileName: '仓库候选验证.json',
        format: 'json',
      },
    ],
    limits: {
      timeoutMs: 60000,
      outputBytes: 16384,
      artifactBytes: 16384,
      memoryMiB: 512,
      cpuMillis: 1000,
      pids: 64,
    },
  });
}
export function readRepositoryVerification(
  output: string,
  baseline: RepositoryBaseline,
  candidate: RepositoryCandidate,
  expectedMaterial: { digest: string; sourceBytes: number },
  compiled?: CompiledDependencyDescriptor,
) {
  const lines = output
    .split('\n')
    .filter((line) => line.startsWith('ALLRICE_REPOSITORY_VERIFICATION '));
  if (lines.length !== 1) throw Error('REPOSITORY_VERIFICATION_MISSING');
  const proof = RepositoryVerificationSchema.parse(
    JSON.parse(lines[0]!.slice('ALLRICE_REPOSITORY_VERIFICATION '.length)),
  );
  if (
    proof.baselineId !== baseline.id ||
    proof.sourceSha !== baseline.sourceSha ||
    proof.baselineSourceDigest !== baseline.sourceDigest ||
    proof.restoredDigest !== baseline.sourceDigest ||
    proof.rootLockChecksum !== baseline.rootLockChecksum ||
    proof.dependencyConfigurationDigest !==
      baseline.dependencyConfigurationDigest ||
    proof.candidateChecksum !== candidate.checksum ||
    proof.actualMaterialDigest !== proof.candidateMaterialDigest ||
    proof.actualMaterialDigest !== expectedMaterial.digest ||
    proof.sourceBytes !== expectedMaterial.sourceBytes ||
    proof.harnessChecksum !== repairHarnessChecksumFor(!!compiled) ||
    proof.version !== (compiled ? 2 : 1) ||
    proof.sourceFileCount !== baseline.fileCount ||
    proof.assertions.some((a, i) => a.id !== repairAssertionCases[i]!.id) ||
    (proof.exitCode === 0) !==
      (proof.failureKind === null && proof.assertions.every((a) => a.passed)) ||
    (proof.exitCode === 1) !==
      (proof.failureKind === 'assertion_failed' &&
        proof.assertions.some((a) => !a.passed)) ||
    (proof.exitCode === 3) !== (proof.failureKind === 'harness_error')
  )
    throw Error('REPOSITORY_VERIFICATION_CHANGED');
  if (
    compiled &&
    proof.version === 2 &&
    (proof.nodeVersion !== compiled.nodeVersion ||
      proof.compiled.timeoutMs !== compiled.timeoutMs ||
      proof.compiled.memoryMiB !== compiled.memoryMiB ||
      proof.compiled.compilerHeapMiB !== compiled.compilerHeapMiB ||
      proof.compiled.dependencyBundleChecksum !== compiled.bundleChecksum ||
      proof.compiled.dependencyMaterialDigest !== compiled.materialDigest ||
      proof.compiled.planDigest !== compiled.planDigest ||
      (proof.exitCode !== 3 &&
        proof.compiled.steps.some(
          (s) =>
            s.status !== 'passed' ||
            s.exitCode !== 0 ||
            s.signal !== null ||
            s.outputTruncated,
        )) ||
      proof.compiled.steps.some(
        (s, i) =>
          s.id !==
          ['dependencies', 'build_contracts', 'build_project_runtime'][i],
      ) ||
      proof.compiled.packages.some(
        (p, i) =>
          p.name !== ['@allrice/contracts', '@allrice/project-runtime'][i] ||
          (proof.exitCode !== 3 && p.fileCount === 0),
      ))
  )
    throw Error('REPOSITORY_COMPILED_VERIFICATION_CHANGED');
  return proof;
}
export function repairHarnessChecksumFor(compiled: boolean) {
  return compiled ? compiledHarnessChecksum(harness) : repairHarnessChecksum;
}
