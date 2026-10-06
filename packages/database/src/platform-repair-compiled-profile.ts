import { repositoryDigest } from './platform-repository-source.ts';
import { compiledRepairProfileId } from './platform-repair-compiled-contracts.ts';

export const compiledRepairChildHarness = String.raw`
import {readFileSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const identity=readFileSync('/proc/self/status','utf8');
if(!/^Uid:\s+1001\s+1001\s+1001\s+1001$/m.test(identity)||!/^Gid:\s+1001\s+1001\s+1001\s+1001$/m.test(identity)||!/^Groups:\s*$/m.test(identity)||['CapInh','CapPrm','CapEff','CapAmb'].some(k=>!new RegExp('^'+k+':\\s+0+$','m').test(identity)))throw Error('REPOSITORY_CHILD_IDENTITY');
const input=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const entry=import.meta.resolve('@allrice/project-runtime');
if(realpathSync(fileURLToPath(entry))!==input.path)throw Error('REPOSITORY_COMPILED_ENTRY_CHANGED');
const {LocalCommandOutputFilter}=await import(entry);
const f=new LocalCommandOutputFilter(),b=Buffer.from(input.input);let text='';
if(input.split){text+=f.push(b.subarray(0,input.split));text+=f.push(b.subarray(input.split),true);}else text=f.push(b,true);
process.stdout.write(JSON.stringify({text,entry:input.path}));
`;

const compilation = String.raw`
const specification=config.compiled,dependencies='/tmp/work/dependencies',generated='/tmp/work/compiled';
if(process.version!==specification.nodeVersion)throw Error('REPOSITORY_COMPILED_NODE_CHANGED');
let dependencyBytes=readFileSync('/tmp/work/input/dependencies.json.gz');
if(dependencyBytes.length!==specification.bundleBytes||sha(dependencyBytes)!==specification.bundleChecksum)throw Error('REPOSITORY_DEPENDENCIES_CHANGED');
let bundle=JSON.parse(gunzipSync(dependencyBytes,{maxOutputLength:18_000_000}).toString('utf8'));
const dependencyManifest=fs=>fs.map(({path,sizeBytes,checksum})=>({path,sizeBytes,checksum})).sort(sort);
const depDigest=fs=>sha(JSON.stringify(dependencyManifest(fs)));
const expectedPaths=['manager.tgz',...specification.packages.map((_,i)=>'archives/'+i+'.tgz'),'workspace/package.json','workspace/pnpm-lock.yaml','workspace/pnpm-workspace.yaml'];
if(bundle.version!==1||bundle.profileId!==config.profileId||bundle.rootLockChecksum!==config.baseline.rootLockChecksum||bundle.dependencyConfigurationDigest!==config.baseline.dependencyConfigurationDigest||bundle.files?.length!==11||new Set(bundle.files.map(f=>f.path)).size!==11||bundle.files.some(f=>!expectedPaths.includes(f.path))||depDigest(bundle.files)!==specification.materialDigest||depDigest(bundle.files.filter(f=>f.path.startsWith('workspace/')))!==specification.planDigest)throw Error('REPOSITORY_DEPENDENCIES_CHANGED');
mkdirSync(dependencies,{mode:0o755});mkdirSync(generated,{mode:0o755});
for(const f of bundle.files){const b=Buffer.from(f.contentBase64,'base64');if(b.toString('base64')!==f.contentBase64||b.length!==f.sizeBytes||sha(b)!==f.checksum)throw Error('REPOSITORY_DEPENDENCIES_CHANGED');const p=dependencies+'/'+f.path;mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true,mode:0o755});writeFileSync(p,b,{flag:'wx',mode:0o444});}
unlinkSync('/tmp/work/input/dependencies.json.gz');
for(const f of bundle.files)delete f.contentBase64;dependencyBytes=null;global.gc();
mkdirSync(dependencies+'/tools',{mode:0o755});
if(sha(readFileSync(dependencies+'/manager.tgz'))!==specification.manager.checksum)throw Error('REPOSITORY_COMPILED_MANAGER_CHANGED');
const extract=spawnSync('/bin/tar',['-xzf',dependencies+'/manager.tgz','-C',dependencies+'/tools'],{timeout:5000,maxBuffer:8192});if(extract.status!==0||extract.signal||extract.error)throw Error('REPOSITORY_COMPILED_MANAGER_EXTRACT');
const projected=[];
const copy=(path,b)=>{const p=generated+'/'+path;mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true,mode:0o755});writeFileSync(p,b,{flag:'wx',mode:0o444});projected.push({path,sizeBytes:b.length,checksum:sha(b)});};
for(const f of bundle.files.filter(f=>f.path.startsWith('workspace/')))copy(f.path.slice(10),readFileSync(dependencies+'/'+f.path));
for(const f of files.filter(f=>f.path==='tsconfig.base.json'||/^(?:packages\/(?:contracts|project-runtime)\/(?:src\/|package\.json$|tsconfig(?:\.build)?\.json$))/.test(f.path)))copy(f.path,readFileSync(root+'/'+f.path));
bundle=null;global.gc();
for(const p of [generated,generated+'/packages/contracts',generated+'/packages/project-runtime'])chmodSync(p,0o777);
for(const p of ['home','tmp','store']){mkdirSync(dependencies+'/'+p,{mode:0o777});chmodSync(dependencies+'/'+p,0o777);}
writeFileSync(dependencies+'/empty.conf','',{mode:0o444});
chmodSync('/tmp/work',0o711);
const pnpm=dependencies+'/tools/package/bin/pnpm.cjs',tsc=generated+'/node_modules/typescript/bin/tsc';
const compileDeadline=Date.now()+Math.max(1000,specification.timeoutMs-30000),steps=[];
const trustedIdentity="const fs=require('node:fs');const s=fs.readFileSync('/proc/self/status','utf8');if(!/^Uid:\\s+1002\\s+1002\\s+1002\\s+1002$/m.test(s)||!/^Gid:\\s+1002\\s+1002\\s+1002\\s+1002$/m.test(s)||!/^Groups:\\s*$/m.test(s)||['CapInh','CapPrm','CapEff','CapAmb'].some(k=>!new RegExp('^'+k+':\\\\s+0+$','m').test(s)))process.exit(126);";
const compilerEnv={NODE_OPTIONS:'--max-old-space-size='+specification.compilerHeapMiB,PATH:'/usr/local/bin:/usr/bin:/bin',HOME:dependencies+'/home',TMPDIR:dependencies+'/tmp',LANG:'C.UTF-8',CI:'1',COREPACK_ENABLE_NETWORK:'0',npm_config_userconfig:dependencies+'/empty.conf',npm_config_globalconfig:dependencies+'/empty.conf',npm_config_update_notifier:'false'};
const probeTimeout=()=>{const remaining=compileDeadline-Date.now();if(remaining<=0)throw Error('REPOSITORY_COMPILED_PROBE_DEADLINE');return Math.min(10000,remaining);};
const probeError=(label,child)=>{if(child.error?.code==='ETIMEDOUT')throw Error(label+'_TIMEOUT');if(child.error||child.signal||child.status!==0)throw Error(label+'_FAILED_'+(child.error?.code??child.signal??child.status));};
const identityCheck=spawnSync('/usr/local/bin/node',['-e',trustedIdentity],{uid:1002,gid:1002,cwd:generated,env:compilerEnv,timeout:probeTimeout(),maxBuffer:8192});probeError('REPOSITORY_COMPILER_IDENTITY',identityCheck);
const fixedSteps=[{id:'dependencies',cwd:'.',originalScript:null,argv:[pnpm,'install','--frozen-lockfile','--offline','--ignore-scripts','--ignore-pnpmfile','--config.manage-package-manager-versions=false','--config.verify-store-integrity=true','--package-import-method=hardlink','--store-dir='+dependencies+'/store']},{id:'build_contracts',cwd:'packages/contracts',originalScript:'tsc -p tsconfig.build.json',argv:[tsc,'-p','tsconfig.build.json']},{id:'build_project_runtime',cwd:'packages/project-runtime',originalScript:'tsc -p tsconfig.build.json',argv:[tsc,'-p','tsconfig.build.json']}];
let buildValid=true;
for(const spec of fixedSteps){
 if(spec.originalScript&&JSON.parse(readFileSync(generated+'/'+spec.cwd+'/package.json','utf8')).scripts?.build!==spec.originalScript)throw Error('REPOSITORY_COMPILED_PLAN_CHANGED');
 const started=Date.now(),remaining=compileDeadline-started;
 const child=buildValid&&remaining>0?spawnSync('/usr/local/bin/node',spec.argv,{uid:1002,gid:1002,cwd:generated+(spec.cwd==='.'?'':'/'+spec.cwd),env:compilerEnv,timeout:Math.max(1,remaining),killSignal:'SIGKILL',maxBuffer:65536,stdio:['ignore','pipe','pipe']}):null;
 const output=Buffer.concat([child?.stdout??Buffer.alloc(0),child?.stderr??Buffer.alloc(0)]),passed=child?.status===0&&!child.signal&&!child.error;
 steps.push({...spec,argv:['/usr/local/bin/node',...spec.argv],exitCode:child?.status??null,signal:child?.signal??null,elapsedMs:Date.now()-started,outputDigest:sha(output),outputBytes:Math.min(output.length,65536),outputTruncated:output.length>65536||!!child?.error,status:child?(passed?'passed':'failed'):'not_run'});
 if(!passed)buildValid=false;
}
// Installation/build use UID1002; code under verification uses UID1001. Seal
// root-owned parents and reject other-writable descendants before candidate code.
const visibilityScript="const fs=require('node:fs');for(const base of process.argv.slice(1)){const dirs=[base];while(dirs.length){const dir=dirs.pop(),s=fs.lstatSync(dir);if(s.uid===1002)fs.chmodSync(dir,0o755);for(const name of fs.readdirSync(dir)){const p=dir+'/'+name,t=fs.lstatSync(p);if(t.isDirectory())dirs.push(p);else if(t.isFile()&&t.uid===1002)fs.chmodSync(p,0o644);}}}";
const visible=spawnSync('/usr/local/bin/node',['-e',visibilityScript,generated,dependencies+'/home',dependencies+'/tmp',dependencies+'/store'],{uid:1002,gid:1002,cwd:generated,env:compilerEnv,timeout:5000,maxBuffer:8192});if(visible.status!==0)throw Error('REPOSITORY_COMPILED_VISIBILITY');
for(const base of [dependencies]){const dirs=[base];while(dirs.length){const p=dirs.pop(),s=lstatSync(p);if(s.uid===0)chmodSync(p,0o555);if((lstatSync(p).mode&0o022)!==0)throw Error('REPOSITORY_COMPILED_WRITABLE');for(const name of readdirSync(p)){const file=p+'/'+name,t=lstatSync(file);if(t.isDirectory())dirs.push(file);else if(t.isFile()&&(t.mode&0o022)!==0)throw Error('REPOSITORY_COMPILED_WRITABLE');else if(t.isSymbolicLink()){const target=realpathSync(file);if(!target.startsWith(dependencies+'/')&&target!==generated&&!target.startsWith(generated+'/'))throw Error('REPOSITORY_COMPILED_LINK');}}}}
const generationManifest=()=>{const found=[],dirs=[''];while(dirs.length){const dir=dirs.pop(),p=generated+(dir?'/'+dir:'');const ds=lstatSync(p);if(ds.uid===0)chmodSync(p,0o555);if((lstatSync(p).mode&0o022)!==0)throw Error('REPOSITORY_COMPILED_WRITABLE');for(const name of readdirSync(p)){const path=(dir?dir+'/':'')+name,file=generated+'/'+path,s=lstatSync(file);if(s.isSymbolicLink()){const resolved=realpathSync(file);if(!resolved.startsWith(generated+'/'))throw Error('REPOSITORY_COMPILED_LINK');found.push({path,type:'link',target:resolved.slice(generated.length+1)});}else if(s.isDirectory())dirs.push(path);else if(s.isFile()){if((s.mode&0o022)!==0||s.uid===1001)throw Error('REPOSITORY_COMPILED_WRITABLE');const b=readFileSync(file);found.push({path,type:'file',sizeBytes:b.length,checksum:sha(b)});}else throw Error('REPOSITORY_COMPILED_FILE');if(found.length>12000)throw Error('REPOSITORY_COMPILED_LIMIT');}}return found.sort(sort);};
const generatedFiles=generationManifest();
if(projected.some(f=>!generatedFiles.some(actual=>actual.path===f.path&&actual.type==='file'&&actual.checksum===f.checksum&&actual.sizeBytes===f.sizeBytes)))throw Error('REPOSITORY_COMPILED_SOURCE_CHANGED');
const managerVersion=spawnSync('/usr/local/bin/node',[pnpm,'--version'],{uid:1002,gid:1002,cwd:generated,env:compilerEnv,timeout:probeTimeout(),maxBuffer:8192});probeError('REPOSITORY_COMPILED_MANAGER',managerVersion);if(managerVersion.stdout.toString('utf8').trim()!=='10.33.3')throw Error('REPOSITORY_COMPILED_MANAGER_CHANGED');
if(buildValid&&JSON.parse(readFileSync(generated+'/node_modules/typescript/package.json','utf8')).version!=='5.9.3')throw Error('REPOSITORY_COMPILED_COMPILER_CHANGED');
const compiledPackages=['contracts','project-runtime'].map((p)=>{const prefix='packages/'+p+'/dist/',entries=generatedFiles.filter(f=>f.path.startsWith(prefix)&&f.type==='file').map(({path,sizeBytes,checksum})=>({path,sizeBytes,checksum}));if(buildValid&&!entries.some(f=>f.path===prefix+'index.js'))throw Error('REPOSITORY_COMPILED_DIST_MISSING');return {name:'@allrice/'+p,digest:depDigest(entries),fileCount:entries.length,sizeBytes:entries.reduce((n,f)=>n+f.sizeBytes,0)};});
const workBytes=()=>{const dirs=['/tmp/work'],seen=new Set();let bytes=0;while(dirs.length){const dir=dirs.pop();for(const name of readdirSync(dir)){const p=dir+'/'+name,s=lstatSync(p);if(s.isDirectory())dirs.push(p);else if(s.isFile()&&!seen.has(s.dev+':'+s.ino)){seen.add(s.dev+':'+s.ino);bytes+=s.size;}}}return bytes;};
const compiled={dependencyBundleChecksum:specification.bundleChecksum,dependencyMaterialDigest:specification.materialDigest,planDigest:specification.planDigest,managerVersion:'10.33.3',compilerVersion:'5.9.3',compilerIdentity:{uid:1002,gid:1002,capabilities:'none'},steps,packages:compiledPackages,productionEntry:'packages/project-runtime/dist/index.js',executionTarget:'production_package_export',timeoutMs:specification.timeoutMs,memoryMiB:specification.memoryMiB,compilerHeapMiB:specification.compilerHeapMiB,generatedTreeDigest:sha(JSON.stringify(generatedFiles)),sourceProjectionDigest:depDigest(projected),workBytesAfterBuild:workBytes(),offline:true,lifecycleScripts:'disabled',wholeWorkspaceDependenciesInstalled:false};
`;

/** Explicit stable insertion points share the v1 material restore and oracle.
 * v1 harness bytes/hash remain unchanged for historical records/evidence. */
export function compiledRepositoryHarness(sourceHarness: string) {
  const start = sourceHarness.indexOf(
      '// Only traversal to the single immutable product file',
    ),
    end = sourceHarness.indexOf(
      'const childDeadline=Date.now()+10000,results=[];let valid=true;',
      start,
    );
  if (start < 0 || end < start) throw Error('REPOSITORY_COMPILED_TEMPLATE');
  let value =
    sourceHarness.slice(0, start) + compilation + sourceHarness.slice(end);
  const replace = (before: string, after: string) => {
    if (value.split(before).length !== 2)
      throw Error('REPOSITORY_COMPILED_TEMPLATE');
    value = value.replace(before, after);
  };
  replace(
    "readdirSync,lstatSync,unlinkSync} from 'node:fs'",
    "readdirSync,lstatSync,unlinkSync,realpathSync} from 'node:fs'",
  );
  replace(
    "const packed=readFileSync('/tmp/work/input/repository.json.gz');",
    "let packed=readFileSync('/tmp/work/input/repository.json.gz');",
  );
  replace(
    'const value=JSON.parse(gunzipSync(packed,',
    'let value=JSON.parse(gunzipSync(packed,',
  );
  replace(
    "unlinkSync('/tmp/work/input/repository.json.gz');",
    "unlinkSync('/tmp/work/input/repository.json.gz');\nif(typeof global.gc!=='function')throw Error('REPOSITORY_GC_REQUIRED');for(const f of files)delete f.contentBase64;packed=null;value=null;global.gc();",
  );
  replace('let valid=true;', 'let valid=buildValid;');
  // Loading the real production export includes its contracts/dependencies.
  // Keep a bounded group of the same eight cases inside the independently
  // enforced five-minute operation; v1's source-only ten seconds stay intact.
  replace(
    'const childDeadline=Date.now()+10000,results=[];',
    'const childDeadline=Date.now()+60000,results=[];',
  );
  replace(
    'for(const c of config.cases){',
    'for(const c of buildValid?config.cases:[]){',
  );
  replace(
    "{path:root+'/'+config.productPath,input:c.input",
    "{path:generated+'/packages/project-runtime/dist/index.js',input:c.input",
  );
  replace(
    '{cwd:root,uid:1001',
    "{cwd:generated+'/packages/project-runtime',uid:1001",
  );
  replace(
    'Object.keys(result).length!==1',
    "Object.keys(result).length!==2||result.entry!==generated+'/packages/project-runtime/dist/index.js'",
  );
  replace(
    'const actualMaterialDigest=physical();',
    "if(sha(JSON.stringify(generationManifest()))!==compiled.generatedTreeDigest)throw Error('REPOSITORY_COMPILED_DIST_CHANGED');\nconst actualMaterialDigest=physical();",
  );
  replace('const report={version:1,', 'const report={version:2,compiled,');
  replace(
    "dependencyMode:'runtime_builtins_only'",
    "dependencyMode:'pnpm_frozen_two_packages'",
  );
  // A completed source/dependency restore can retain large native allocator RSS
  // even after GC. Replace only the trusted root process before compiling. The
  // handoff contains bounded verified manifests, never model-supplied code;
  // UID1001/1002 cannot read or modify either root-owned stage file.
  const handoff = value.indexOf('for(const p of [generated,');
  const physicalStart = value.indexOf('const physical=()=>');
  const physicalEnd = value.indexOf('\nconst restoredDigest=physical();');
  if (handoff < 0 || physicalStart < 0 || physicalEnd < physicalStart)
    throw Error('REPOSITORY_COMPILED_TEMPLATE');
  const helpers = value.slice(0, value.indexOf('let packed=readFileSync('));
  const stage =
    helpers +
    "const state=JSON.parse(readFileSync('/tmp/work/compiled-context.json','utf8'));unlinkSync('/tmp/work/compiled-context.json');\n" +
    'const {files,restoredDigest,candidateMaterialDigest,projected}=state;\n' +
    value.slice(physicalStart, physicalEnd) +
    "\nconst specification=config.compiled,dependencies='/tmp/work/dependencies',generated='/tmp/work/compiled';\n" +
    'const dependencyManifest=fs=>fs.map(({path,sizeBytes,checksum})=>({path,sizeBytes,checksum})).sort(sort);const depDigest=fs=>sha(JSON.stringify(dependencyManifest(fs)));\n' +
    value.slice(handoff);
  return (
    value.slice(0, handoff) +
    "writeFileSync('/tmp/work/compiled-context.json',JSON.stringify({files,restoredDigest,candidateMaterialDigest,projected}),{flag:'wx',mode:0o400});\n" +
    "writeFileSync('/tmp/work/compiled-stage.mjs','const config='+JSON.stringify(config)+';\\n'+" +
    JSON.stringify(stage) +
    ",{flag:'wx',mode:0o400});\n" +
    "if(typeof process.execve!=='function')throw Error('REPOSITORY_STAGE_REPLACE_UNAVAILABLE');\n" +
    "process.execve('/usr/local/bin/node',['/usr/local/bin/node','/tmp/work/compiled-stage.mjs'],{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/work',TMPDIR:'/tmp',LANG:'C.UTF-8'});\n"
  );
}
export function compiledHarnessChecksum(sourceHarness: string) {
  return repositoryDigest(
    compiledRepairProfileId +
      '\n' +
      compiledRepositoryHarness(sourceHarness) +
      '\n' +
      compiledRepairChildHarness,
  );
}
