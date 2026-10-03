/** Project code and package scripts run below the immutable PID 1 supervisor.
 * Manager archives are release-pinned; all dependency archives were hash checked
 * outside this container. Neither install nor project code has a network.
 */
export const nodeProjectSupervisor = String.raw`
import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdir,chown,chmod,readdir } from 'node:fs/promises';
import { constants } from 'node:os';
const root='/tmp/work',a=JSON.parse(await readFile(root+'/.allrice/config.json','utf8'));
let finished=false,size=0,frames=0,installation='failed';
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n');
const end=(reason,code)=>{if(finished)return;finished=true;emit({type:'exit',reason,code,installation});process.stdout.write('',()=>process.exit(code));setTimeout(()=>process.exit(code),100).unref();};
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
try{
 for(const dir of ['project','home','tmp','tools'])await mkdir(root+'/'+dir,{recursive:true,mode:0o755});
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
 if(!finished){installation='succeeded';emit({type:'stage',stage:'running'});const c=await run(a.command.executable,a.command.args);clearTimeout(timer);end('exited',c);}
}catch{clearTimeout(timer);end('supervisor_failed',125);}
`;

export const pythonProjectSupervisor = String.raw`
import os,sys,json,time,subprocess,selectors,base64,signal,stat
ROOT='/tmp/work'
with open(ROOT+'/.allrice/config.json',encoding='utf-8') as f:a=json.load(f)
command=a['command'];installation='failed';size=0;frames=0;finished=False
def emit(e):print(json.dumps(e),flush=True)
def end(reason,code):
    emit(dict(type='exit',reason=reason,code=code,installation=installation));sys.stdout.flush();os._exit(code)
def demote():
    os.setgroups([]);os.setgid(1000);os.setuid(1000)
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
    while selector.get_map() or p.poll() is None:
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
    code=p.wait();return code if code>=0 else 128-code
try:
    for directory in ['project','home','tmp','tools']:os.makedirs(ROOT+'/'+directory,mode=0o755,exist_ok=True)
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
    c=run(ROOT+'/project/'+('' if command['path']=='.' else command['path']+'/')+'.venv/bin/python',command['args']);end('exited',c)
except Exception as e:
    emit(dict(type='stderr',data=base64.b64encode(str(e).encode()).decode()));end('supervisor_failed',125)
`;
