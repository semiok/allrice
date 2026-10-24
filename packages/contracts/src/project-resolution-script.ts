import {
  ProjectDependencyResolveInputSchema,
  projectResolutionManifest,
  type ProjectDependencyResolveInput,
} from './project-dependency-resolution.ts';
import { projectToolReleases } from './project-tool-releases.ts';
import { cloudPlatform, cloudPlatforms } from './runtime-v2/cloud-platform.ts';

/** Fixed controller, not a model-provided script. Only package declarations are
 * interpolated as JSON. Managers never see user config, scripts, files or keys. */
const nodeResolver = String.raw`
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const work='/tmp/work/resolve';await fs.mkdir(work,{mode:0o700});
let phase='manager_download',diagnostics='',exitCode=1;
const safe=text=>text.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').replace(/(authorization|cookie|token|password)\s*[:=][^\n]*/ig,'$1=[redacted]').replace(/https:\/\/[^\s]+/g,s=>{try{const u=new URL(s);return u.origin+u.pathname}catch{return '[url]'}}).slice(-16384);
const run=(exe,args)=>new Promise((resolve,reject)=>{
 const p=spawn(exe,args,{cwd:work,env:{...process.env,HOME:work,TMPDIR:work,CI:'1',npm_config_userconfig:work+'/empty.conf',npm_config_globalconfig:work+'/empty.conf',npm_config_update_notifier:'false',COREPACK_ENABLE_NETWORK:'0'},stdio:['ignore','pipe','pipe']});
 for(const stream of [p.stdout,p.stderr])stream.on('data',b=>{diagnostics=safe(diagnostics+b.toString());});
 p.on('error',reject);p.on('close',(c,s)=>resolve(Number.isInteger(c)?c:128));
});
const write=async r=>{await fs.writeFile('/tmp/work/output/resolution.json',JSON.stringify({version:1,manager:'pnpm',phase,diagnostics:safe(diagnostics),...r}),{mode:0o600});process.exitCode=r.exitCode;};
try{
 const response=await fetch(plan.asset.url,{redirect:'error',signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw Error('PROJECT_RESOLUTION_DOWNLOAD_FAILED');
 const chunks=[];let n=0;for await(const b of response.body){n+=b.length;if(n>plan.asset.sizeBytes)throw Error('PROJECT_RESOLUTION_TOOL_INTEGRITY');chunks.push(b);}
 const bytes=Buffer.concat(chunks);if(bytes.length!==plan.asset.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==plan.asset.sha256)throw Error('PROJECT_RESOLUTION_TOOL_INTEGRITY');
 await fs.writeFile(work+'/manager.tgz',bytes,{mode:0o400});await fs.writeFile(work+'/empty.conf','');await fs.writeFile(work+'/package.json',plan.manifest.text);
 if(await run('/bin/tar',['-xzf',work+'/manager.tgz','-C',work]))throw Error('PROJECT_RESOLUTION_TOOL_INTEGRITY');
 phase='resolve';exitCode=await run('/usr/local/bin/node',[work+'/package/bin/pnpm.cjs','install','--lockfile-only','--ignore-scripts','--ignore-pnpmfile','--config.manage-package-manager-versions=false','--config.update-notifier=false','--config.registry=https://registry.npmjs.org','--network-concurrency=4','--reporter=append-only','--store-dir='+work+'/store']);
 if(exitCode)throw Error('PROJECT_RESOLUTION_PACKAGE_FAILED');
 phase='lock_validation';const lock=await fs.readFile(work+'/pnpm-lock.yaml','utf8');if(Buffer.byteLength(lock)>200000)throw Error('PROJECT_RESOLUTION_LIMIT');
 await write({status:'resolved',exitCode:0,lock});
}catch(e){diagnostics=safe(diagnostics+'\n'+String(e.name)+': '+String(e.message));const code=/^PROJECT_RESOLUTION_[A-Z_]+$/.test(e.message)?e.message:phase==='manager_download'?'PROJECT_RESOLUTION_DOWNLOAD_FAILED':'PROJECT_RESOLUTION_INTERNAL';await write({status:'failed',exitCode:Math.max(1,Math.min(exitCode,255)),errorCode:code});}
`;

// V1: the original controller. A request without `architecture` (every request stored
// before targets existed) must regenerate it byte for byte, or its record stops verifying.
const pythonResolverV1 = String.raw`
import os,sys,json,hashlib,subprocess,urllib.request,tarfile,re
from packaging.tags import sys_tags
from packaging.utils import parse_wheel_filename,canonicalize_name
work='/tmp/work/resolve';os.mkdir(work,0o700)
phase='manager_download';diagnostics='';exit_code=1
def safe(text):
    text=re.sub(r'\x1b\[[0-9;]*[A-Za-z]','',text)
    text=re.sub(r'[\x00-\x08\x0b-\x1f\x7f]','',text)
    text=re.sub(r'(?i)(authorization|cookie|token|password)\s*[:=][^\n]*',r'\1=[redacted]',text)
    text=re.sub(r'https://[^\s]+',lambda m: re.sub(r'[?#].*','',m[0]).split('@')[-1] if '@' in m[0] else re.sub(r'[?#].*','',m[0]),text)
    return text[-16384:]
def download(url,limit):
    with urllib.request.urlopen(url,timeout=45) as response:
        data=response.read(limit+1)
        if len(data)>limit:raise RuntimeError('PROJECT_RESOLUTION_LIMIT')
        return data
def run(args):
    global diagnostics
    env={**os.environ,'HOME':work,'TMPDIR':work,'UV_PYTHON_DOWNLOADS':'never','UV_NO_CONFIG':'true','UV_CACHE_DIR':work+'/cache','UV_NO_PROGRESS':'true'}
    p=subprocess.Popen(args,cwd=work,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    while True:
        chunk=p.stdout.read(8192)
        if not chunk:break
        diagnostics=safe(diagnostics+chunk.decode('utf8','replace'))
    code=p.wait();return code if code>=0 else 128-code
def write(result):
    with open('/tmp/work/output/resolution.json','w',encoding='utf8') as f:json.dump(dict(version=1,manager='uv',phase=phase,diagnostics=safe(diagnostics),**result),f)
    sys.exit(result['exitCode'])
try:
    asset=plan['asset'];data=download(asset['url'],asset['sizeBytes'])
    if len(data)!=asset['sizeBytes'] or hashlib.sha256(data).hexdigest()!=asset['sha256']:raise RuntimeError('PROJECT_RESOLUTION_TOOL_INTEGRITY')
    archive=work+'/manager.tgz'
    with open(archive,'wb') as f:f.write(data)
    # Pinned distribution, not a tenant archive. Still reject links/traversal.
    with tarfile.open(archive) as tar:
        members=tar.getmembers()
        if any(m.issym() or m.islnk() or m.name.startswith('/') or '..' in m.name.split('/') or not(m.isdir() or m.isfile()) for m in members):raise RuntimeError('PROJECT_RESOLUTION_TOOL_INTEGRITY')
        tar.extractall(work, members=members, filter='data')
    uv=work+'/uv-x86_64-unknown-linux-gnu/uv'
    with open(work+'/requirements.in','w') as f:f.write(plan['manifest']['text'])
    phase='resolve';exit_code=run([uv,'pip','compile','requirements.in','--python','/opt/python/bin/python','--python-version','3.11','--python-platform','x86_64-unknown-linux-gnu','--only-binary',':all:','--generate-hashes','--no-annotate','--no-header','--default-index','https://pypi.org/simple','--output-file','resolved.txt'])
    if exit_code:raise RuntimeError('PROJECT_RESOLUTION_PACKAGE_FAILED')
    phase='lock_validation'
    with open(work+'/resolved.txt') as f:raw=f.read(200001)
    if len(raw.encode())>200000:raise RuntimeError('PROJECT_RESOLUTION_LIMIT')
    tags={tag:i for i,tag in enumerate(sys_tags())};wheels=[];lines=[]
    for line in re.sub(r'\\\r?\n\s*',' ',raw).splitlines():
        line=line.strip()
        if not line or line.startswith('#'):continue
        match=re.fullmatch(r'([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.!+_-]*)(\s+--hash=sha256:[a-f0-9]{64})+',line)
        if not match:raise RuntimeError('PROJECT_RESOLUTION_LOCK_UNSUPPORTED')
        name,version=match[1],match[2];hashes=set(re.findall(r'--hash=sha256:([a-f0-9]{64})',line))
        metadata=json.loads(download('https://pypi.org/pypi/'+name+'/'+version+'/json',2000000));candidates=[]
        for item in metadata.get('urls',[]):
            if item.get('packagetype')!='bdist_wheel' or item.get('yanked') or item.get('digests',{}).get('sha256') not in hashes:continue
            try:wheel_name,wheel_version,_,wheel_tags=parse_wheel_filename(item['filename'])
            except ValueError:continue
            matching=[tags[t] for t in wheel_tags if t in tags]
            if matching and canonicalize_name(wheel_name)==canonicalize_name(name) and str(wheel_version)==version:
                candidates.append((min(matching),item['filename'],item))
        if not candidates:raise RuntimeError('PROJECT_RESOLUTION_LOCK_UNSUPPORTED')
        item=min(candidates,key=lambda c:(c[0],c[1]))[2];checksum=item['digests']['sha256']
        wheels.append(dict(name=name,version=version,fileName=item['filename'],url=item['url'],sha256='sha256:'+checksum))
        if len(wheels)>128:raise RuntimeError('PROJECT_RESOLUTION_LIMIT')
        lines.append(name+'=='+version+' --hash=sha256:'+checksum)
    if not wheels:raise RuntimeError('PROJECT_RESOLUTION_LOCK_UNSUPPORTED')
    write(dict(status='resolved',exitCode=0,lock='\n'.join(lines)+'\n',wheels=wheels))
except Exception as error:
    diagnostics=safe(diagnostics+'\n'+type(error).__name__+': '+str(error))
    code=str(error) if re.fullmatch('PROJECT_RESOLUTION_[A-Z_]+',str(error)) else 'PROJECT_RESOLUTION_DOWNLOAD_FAILED' if phase=='manager_download' else 'PROJECT_RESOLUTION_INTERNAL'
    write(dict(status='failed',exitCode=max(1,min(exit_code,255)),errorCode=code))
`;
const replaceOnce = (text: string, from: string, to: string) => {
  if (text.split(from).length !== 2)
    throw Error(`project resolver template changed: ${from}`);
  return text.replace(from, to);
};
/** V2: the same controller resolving for a given CPU. uv still runs natively on the
 * server; the lock targets the CPU (same Python 3.11 and glibc base image) that will
 * install it, with every manylinux baseline that CPU defines, ordered as packaging does. */
const pythonResolverForTarget = (
  [
    [
      'from packaging.tags import sys_tags',
      'from packaging.tags import compatible_tags,cpython_tags',
    ],
    [
      "    uv=work+'/uv-x86_64-unknown-linux-gnu/uv'",
      [
        "    uv=work+'/'+plan['uvDirectory']+'/uv'",
        "    arch=plan['target']['machine'];glibc=int(os.confstr('CS_GNU_LIBC_VERSION').split('.')[-1])",
        "    legacy={17:'manylinux2014',12:'manylinux2010',5:'manylinux1'};platforms=[]",
        "    for minor in range(glibc,(5 if arch=='x86_64' else 17)-1,-1):",
        "        platforms.append('manylinux_2_%d_%s'%(minor,arch))",
        "        if minor in legacy:platforms.append(legacy[minor]+'_'+arch)",
        "    platforms.append('linux_'+arch);target_platform='%s-manylinux_2_%d'%(arch,glibc)",
      ].join('\n'),
    ],
    [
      "'--python-platform','x86_64-unknown-linux-gnu'",
      "'--python-platform',target_platform",
    ],
    [
      '    tags={tag:i for i,tag in enumerate(sys_tags())};wheels=[];lines=[]',
      '    tags={tag:i for i,tag in enumerate([*cpython_tags(platforms=platforms),*compatible_tags(platforms=platforms)])};wheels=[];lines=[]',
    ],
  ] as const
).reduce((text, [from, to]) => replaceOnce(text, from, to), pythonResolverV1);

export function projectResolutionScript(input: ProjectDependencyResolveInput) {
  const args = ProjectDependencyResolveInputSchema.parse(input);
  const manifest = projectResolutionManifest(args);
  if (args.manager === 'pnpm')
    return `const plan=${JSON.stringify({ manifest, asset: projectToolReleases.pnpm })};\n${nodeResolver}`;
  const asset = projectToolReleases.uv[cloudPlatform.architecture];
  if (!args.architecture) {
    // V1 bytes: identical to the approved amd64 controller; arm64 swaps in the native
    // platform for both the uv build and the wheels.
    const resolver = pythonResolverV1.replaceAll(
      cloudPlatforms.amd64.pythonPlatform,
      cloudPlatform.pythonPlatform,
    );
    return `import json\nplan=json.loads(${JSON.stringify(JSON.stringify({ manifest, asset }))})\n${resolver}`;
  }
  const plan = {
    manifest,
    asset,
    uvDirectory: `uv-${cloudPlatform.pythonPlatform}`,
    target: {
      machine: cloudPlatforms[args.architecture].pythonPlatform.split('-')[0],
    },
  };
  return `import json\nplan=json.loads(${JSON.stringify(JSON.stringify(plan))})\n${pythonResolverForTarget}`;
}

export function projectResolutionCloudArguments(
  input: ProjectDependencyResolveInput,
) {
  const args = ProjectDependencyResolveInputSchema.parse(input);
  return {
    ...(args.manager === 'uv' ? { language: 'python' as const } : {}),
    script: projectResolutionScript(args),
    inputs: [],
    outputs: [
      {
        path: 'resolution.json',
        fileName: 'dependency-resolution.json',
        format: 'json' as const,
      },
    ],
    execution: { version: 1 as const, kind: 'install' as const },
    network: {
      mode: 'controlled_https' as const,
      origins:
        args.manager === 'pnpm'
          ? ['https://registry.npmjs.org']
          : [
              'https://github.com',
              'https://release-assets.githubusercontent.com',
              'https://pypi.org',
              'https://files.pythonhosted.org',
            ],
    },
    limits: {
      timeoutMs: 60000,
      outputBytes: 32768,
      artifactBytes: 512000,
      memoryMiB: 512,
      cpuMillis: 1000,
      pids: 64 as const,
    },
  };
}
