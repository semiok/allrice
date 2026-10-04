/** Project code and package scripts run below the immutable PID 1 supervisor.
 * Manager archives are release-pinned; all dependency archives were hash checked
 * outside this container. Neither install nor project code has a network.
 */
export const nodeProjectSupervisor = String.raw`
import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdir,chown,chmod,readdir,lstat,open,realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { constants } from 'node:os';
import { createHash } from 'node:crypto';
const root='/tmp/work',bootDeadline=Number(process.argv[1]||0);
// Cloud's bounded tmpfs work volume is mounted at start. Wait for the final trusted staging marker.
if(bootDeadline>0)for(;;){try{if(await readFile(root+'/.allrice/staging-ready','utf8')==='ready')break;}catch(e){if(e.code!=='ENOENT')throw e;}if(Date.now()>=bootDeadline)process.exit(124);await new Promise(r=>setTimeout(r,20));}
const a=JSON.parse(await readFile(root+'/.allrice/config.json','utf8'));
let finished=false,size=0,frames=0,installation='failed';
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n');
const end=(reason,code)=>{if(finished)return;finished=true;emit({type:'exit',reason,code,installation});process.stdout.write('',()=>process.exit(code));setTimeout(()=>process.exit(code),100).unref();};
let cacheChecking=false;
async function checkCache(){let total=0,count=0;const dirs=['/cache'];while(dirs.length){const dir=dirs.pop();for(const e of await readdir(dir,{withFileTypes:true})){if(++count>20000)throw Error('cache limit');const p=dir+'/'+e.name;if(e.isDirectory())dirs.push(p);else if(e.isFile())total+=(await lstat(p)).size;if(total>128000000)throw Error('cache limit');}}}
const cacheTimer=setInterval(()=>{if(cacheChecking||finished)return;cacheChecking=true;void checkCache().catch(()=>end('cache_limit',123)).finally(()=>cacheChecking=false);},500);cacheTimer.unref();
const timer=setTimeout(()=>end(a.deadlineReason||'timeout',124),Math.max(0,a.deadlineUnixMs-Date.now()));
const run=(exe,args,tenant=true)=>new Promise(resolve=>{
 const p=spawn(exe,args,{cwd:root+'/project/'+(a.command.path==='.'?'':a.command.path),uid:tenant?1000:0,gid:tenant?1000:0,stdio:['ignore','pipe','pipe'],
 env:{PATH:root+'/tools/package/bin:/usr/local/bin:/usr/bin:/bin',HOME:root+'/home',TMPDIR:root+'/tmp',LANG:'C.UTF-8',CI:'1',
 npm_config_userconfig:root+'/.allrice/empty.conf',npm_config_globalconfig:root+'/.allrice/empty.conf',npm_config_update_notifier:'false',COREPACK_ENABLE_NETWORK:'0',PNPM_HOME:root+'/home/pnpm'}});
 for(const s of ['stdout','stderr'])p[s].on('data',b=>{const keep=b.subarray(0,Math.max(0,a.command.limits.outputBytes-size));size+=b.length;if(keep.length&&frames++<254)emit({type:s,data:keep.toString('base64')});if(size>a.command.limits.outputBytes||frames>=254)end('output_limit',122);});
 p.once('error',()=>end('supervisor_failed',125));let drain;
 p.once('exit',()=>{drain=setTimeout(()=>end('output_limit',125),250);});
 p.once('close',(c,s)=>{clearTimeout(drain);resolve(Number.isInteger(c)?c:128+(constants.signals[s]||0));});
});
async function ownership(path){await chown(path,1000,1000);await chmod(path,0o700);for(const e of await readdir(path,{withFileTypes:true})){const p=path+'/'+e.name;if(e.isDirectory())await ownership(p);else{await chown(p,1000,1000);await chmod(p,0o600);}}}
async function collect(){let total=0;for(const f of a.command.outputs||[]){
 const p=root+'/project/'+f.path,parts=f.path.split('/');
 // Hold each actual directory while traversing. O_NOFOLLOW on a full path
 // alone would leave ancestors open to a tenant rename/symlink race.
 const directoryFlags=fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW;
 let directory=await open(root+'/project',directoryFlags),h;
 try{
  for(const part of parts.slice(0,-1)){const next=await open('/proc/self/fd/'+directory.fd+'/'+part,directoryFlags);await directory.close();directory=next;}
  h=await open('/proc/self/fd/'+directory.fd+'/'+parts.at(-1),fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);
  if(await realpath('/proc/self/fd/'+h.fd)!==p)throw Error('PROJECT_OUTPUT_UNSAFE');
  const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.size>100000-total)throw Error('PROJECT_OUTPUT_LIMIT');
  const chunks=[];let size=0;for(;;){const part=Buffer.alloc(Math.min(16384,s.size+1-size));if(!part.length)break;const {bytesRead}=await h.read(part,0,part.length,null);if(!bytesRead)break;chunks.push(part.subarray(0,bytesRead));size+=bytesRead;}
  const b=Buffer.concat(chunks),after=await h.stat();total+=b.length;
  if(total>100000||b.length!==s.size||after.size!==s.size||after.mtimeMs!==s.mtimeMs||await realpath('/proc/self/fd/'+h.fd)!==p)throw Error('PROJECT_OUTPUT_CHANGED');
  emit({type:'artifact',path:f.path,data:b.toString('base64'),sizeBytes:b.length,checksum:'sha256:'+createHash('sha256').update(b).digest('hex')});
 }finally{await h?.close();await directory.close();}
}}

try{
 await checkCache();
 for(const dir of ['project','home','tmp','tools'])await mkdir(root+'/'+dir,{recursive:true,mode:0o755});
 const manifest=[];
 for(const f of a.command.files){const b=await readFile(root+'/project/'+f.path),sha256='sha256:'+createHash('sha256').update(b).digest('hex');if(sha256!==f.sha256)throw Error('project source changed');manifest.push({path:f.path,sha256});}
 const sourceDigest='sha256:'+createHash('sha256').update(JSON.stringify(manifest)).digest('hex');if(sourceDigest!==a.command.projectPreparation.sourceDigest)throw Error('project source changed');
 emit({type:'source_verified',sourceDigest});
 await ownership(root+'/project');await ownership(root+'/home');await ownership(root+'/tmp');
 await mkdir('/cache/pnpm',{recursive:true,mode:0o700});await chown('/cache/pnpm',1000,1000);
 // Extraction is of a fixed release archive, never a source-provided tar.
 if(await run('/bin/tar',['-xzf',root+'/.allrice/manager.tar.gz','-C',root+'/tools'],false))throw Error('manager extraction');
 const pnpm=root+'/tools/package/bin/pnpm.cjs',flags=['--store-dir=/cache/pnpm','--offline','--ignore-pnpmfile','--config.manage-package-manager-versions=false','--config.verify-store-integrity=true'];
 const s=a.command.projectPreparation;
 emit({type:'stage',stage:'preparing'});
 await writeFile(root+'/project/'+s.lockPath,await readFile(root+'/.allrice/pnpm-install-lock'));
 const installed=await run('/usr/local/bin/node',[pnpm,'install','--frozen-lockfile','--package-import-method=copy',s.scripts==='disabled'?'--ignore-scripts':'--ignore-scripts=false',...flags]);
 // Restore with tenant privileges, never as root after lifecycle scripts.
 const restored=await run('/usr/local/bin/node',['-e',"const fs=require('node:fs'),crypto=require('node:crypto');const b=fs.readFileSync('/tmp/work/.allrice/pnpm-original-lock');const h=fs.openSync('pnpm-lock.yaml',fs.constants.O_WRONLY|fs.constants.O_TRUNC|fs.constants.O_NOFOLLOW);try{fs.writeFileSync(h,b);}finally{fs.closeSync(h);}if('sha256:'+crypto.createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex')!=="+JSON.stringify(s.lockChecksum)+")process.exit(125);"]);
 if(installed||restored){clearTimeout(timer);end(restored?'supervisor_failed':'exited',restored||installed);}
 if(!finished){await checkCache();installation='succeeded';emit({type:'stage',stage:'running'});const c=await run(a.command.executable,a.command.args);await checkCache();if(c===0&&!finished)await collect();clearTimeout(timer);end('exited',c);}
}catch(e){emit({type:'stderr',data:Buffer.from(String(e?.message||'project failure').slice(0,200)).toString('base64')});clearTimeout(timer);end(e?.message==='cache limit'?'cache_limit':'supervisor_failed',e?.message==='cache limit'?123:125);}
`;

export const pythonProjectSupervisor = String.raw`
import os,sys,json,time,subprocess,selectors,base64,signal,stat,hashlib
ROOT='/tmp/work'
bootDeadline=int(sys.argv[1]) if len(sys.argv)>1 else 0
while bootDeadline:
    try:
        with open(ROOT+'/.allrice/staging-ready',encoding='utf-8') as ready:
            if ready.read()=='ready':break
    except FileNotFoundError:pass
    if time.time()*1000>=bootDeadline:os._exit(124)
    time.sleep(.02)
with open(ROOT+'/.allrice/config.json',encoding='utf-8') as f:a=json.load(f)
command=a['command'];installation='failed';size=0;frames=0;finished=False
def emit(e):print(json.dumps(e),flush=True)
def end(reason,code):
    emit(dict(type='exit',reason=reason,code=code,installation=installation));sys.stdout.flush();os._exit(code)
def check_cache():
    total=0;count=0;dirs=['/cache']
    while dirs:
        with os.scandir(dirs.pop()) as entries:
            for entry in entries:
                count+=1
                if count>20000:end('cache_limit',123)
                if entry.is_dir(follow_symlinks=False):dirs.append(entry.path)
                elif entry.is_file(follow_symlinks=False):total+=entry.stat(follow_symlinks=False).st_size
                if total>128000000:end('cache_limit',123)
def demote():
    os.setgroups([]);os.setgid(1000);os.setuid(1000)
def collect():
    total=0
    for f in command.get('outputs',[]):
        fd=os.open(ROOT+'/project',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            parts=f['path'].split('/')
            for part in parts[:-1]:
                nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=nextfd
            output=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            try:
                s=os.fstat(output)
                if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>100000-total:raise RuntimeError('PROJECT_OUTPUT_LIMIT')
                with os.fdopen(os.dup(output),'rb') as stream:b=stream.read(100001-total)
                after=os.fstat(output);total+=len(b)
                if total>100000 or len(b)!=s.st_size or after.st_size!=s.st_size or after.st_mtime_ns!=s.st_mtime_ns:raise RuntimeError('PROJECT_OUTPUT_CHANGED')
                emit(dict(type='artifact',path=f['path'],data=base64.b64encode(b).decode(),sizeBytes=len(b),checksum='sha256:'+hashlib.sha256(b).hexdigest()))
            finally:os.close(output)
        finally:os.close(fd)
def own(path):
    os.chown(path,1000,1000);os.chmod(path,0o700)
    for current,dirs,files in os.walk(path):
        for name in dirs+files:
            p=current+'/'+name;os.chown(p,1000,1000);os.chmod(p,0o700 if os.path.isdir(p) else 0o600)
env=dict(PATH='/opt/python/bin:/usr/bin:/bin',HOME=ROOT+'/home',TMPDIR=ROOT+'/tmp',LANG='C.UTF-8',CI='1',
    UV_CACHE_DIR='/cache/uv',UV_PYTHON_DOWNLOADS='never',UV_NO_CONFIG='true',UV_OFFLINE='true',PYTHONDONTWRITEBYTECODE='1')
def run(exe,args,tenant=True):
    global size,frames
    p=subprocess.Popen([exe]+args,cwd=ROOT+'/project/'+('' if command['path']=='.' else command['path']),env=env,stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=demote if tenant else None)
    selector=selectors.DefaultSelector()
    for stream,name in [(p.stdout,'stdout'),(p.stderr,'stderr')]:os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ,name)
    next_cache=0
    while selector.get_map() or p.poll() is None:
        if time.monotonic()>=next_cache:check_cache();next_cache=time.monotonic()+.5
        if time.time()*1000>=a['deadlineUnixMs']:end(a.get('deadlineReason','timeout'),124)
        for key,_ in selector.select(.05):
            chunk=os.read(key.fileobj.fileno(),8192)
            if not chunk:selector.unregister(key.fileobj);continue
            keep=chunk[:max(0,command['limits']['outputBytes']-size)];size+=len(chunk)
            if keep and frames<254:frames+=1;emit(dict(type=key.data,data=base64.b64encode(keep).decode()))
            if size>command['limits']['outputBytes'] or frames>=254:end('output_limit',122)
        if p.poll() is not None and selector.get_map():
            # Descendants cannot keep PID 1 waiting beyond the operation budget.
            try:os.killpg(p.pid,signal.SIGKILL)
            except ProcessLookupError:pass
    code=p.wait();check_cache();return code if code>=0 else 128-code
try:
    check_cache()
    for directory in ['project','home','tmp','tools']:os.makedirs(ROOT+'/'+directory,mode=0o755,exist_ok=True)
    manifest=[]
    for f in command['files']:
        with open(ROOT+'/project/'+f['path'],'rb') as source:checksum='sha256:'+hashlib.sha256(source.read()).hexdigest()
        if checksum!=f['sha256']:raise RuntimeError('project source changed')
        manifest.append(dict(path=f['path'],sha256=checksum))
    sourceDigest='sha256:'+hashlib.sha256(json.dumps(manifest,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    if sourceDigest!=command['projectPreparation']['sourceDigest']:raise RuntimeError('project source changed')
    emit(dict(type='source_verified',sourceDigest=sourceDigest))
    for directory in ['project','home','tmp']:own(ROOT+'/'+directory)
    os.makedirs('/cache/uv',mode=0o700,exist_ok=True);os.chown('/cache/uv',1000,1000)
    if run('/bin/tar',['-xzf',ROOT+'/.allrice/manager.tar.gz','-C',ROOT+'/tools','--strip-components=1'],False):raise RuntimeError('manager extraction')
    uv=ROOT+'/tools/uv';emit(dict(type='stage',stage='preparing'))
    for args in [
        ['venv','.venv','--python','/opt/python/bin/python','--offline','--no-python-downloads','--no-config'],
        ['pip','sync','requirements.lock','--python','.venv/bin/python','--no-index','--find-links',ROOT+'/.allrice/archives','--require-hashes','--only-binary',':all:','--offline','--no-config'],
    ]:
        c=run(uv,args)
        if c:end('exited',c)
    installation='succeeded';emit(dict(type='stage',stage='running'))
    c=run(ROOT+'/project/'+('' if command['path']=='.' else command['path']+'/')+'.venv/bin/python',command['args'])
    if c==0:collect()
    end('exited',c)
except Exception as e:
    emit(dict(type='stderr',data=base64.b64encode(str(e).encode()).decode()));end('supervisor_failed',125)
`;
