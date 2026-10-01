/** Trusted PID 1, shipped with Bridge. Tenant Python is a different UID in the
 * private VM, without network, host mounts or writable interpreter/checkers. */
export const localPythonSupervisor = String.raw`
import os, sys, json, time, subprocess, signal, selectors, hashlib, stat, shutil
ROOT='/tmp/work'
with open(ROOT+'/.allrice/config.json',encoding='utf-8') as f: config=json.load(f)
a=config['arguments']; limits=a['limits']; deadline=config['deadlineUnixMs']/1000
os.chmod(ROOT+'/.allrice',0o700)
for directory in ['input','output','cache']:
    os.makedirs(ROOT+'/'+directory,mode=0o755,exist_ok=True)
for current,dirs,files in os.walk(ROOT+'/input'):
    os.chmod(current,0o555)
    for name in files: os.chmod(current+'/'+name,0o444)
for directory in ['output','cache']:
    os.chown(ROOT+'/'+directory,65532,65532);os.chmod(ROOT+'/'+directory,0o700)
shutil.copytree('/opt/python/mplconfig',ROOT+'/cache/mpl')
for current,dirs,files in os.walk(ROOT+'/cache/mpl'):
    os.chown(current,65532,65532);os.chmod(current,0o700)
    for name in files:os.chown(current+'/'+name,65532,65532);os.chmod(current+'/'+name,0o600)
def demote():
    os.setgroups([]);os.setgid(65532);os.setuid(65532)
    with open('/proc/self/status') as f:
        status=dict((line.partition(':')[0],line.partition(':')[2].strip()) for line in f if ':' in line)
    if any(int(status.get(key,'1'),16)!=0 for key in ['CapEff','CapPrm','CapAmb']) or status.get('NoNewPrivs')!='1':
        raise PermissionError('TENANT_CAPABILITIES_NOT_DROPPED')
def kill_tenant():
    # This PID namespace contains only our supervisor and this attempt. Kill
    # detached children too, before any trusted checker reads tenant output.
    for name in os.listdir('/proc'):
        if not name.isdigit() or int(name)==os.getpid(): continue
        try:
            with open('/proc/'+name+'/status') as f: text=f.read()
            if '\nUid:\t65532\t' in text: os.kill(int(name),signal.SIGKILL)
        except (FileNotFoundError,ProcessLookupError): pass
    end=time.monotonic()+2
    while time.monotonic()<end:
        try:
            pid,_=os.waitpid(-1,os.WNOHANG)
            if pid==0:time.sleep(.01)
        except ChildProcessError: break
env={'PATH':'/opt/python/bin:/usr/bin:/bin','HOME':ROOT+'/cache','TMPDIR':ROOT+'/cache',
     'MPLBACKEND':'Agg','MPLCONFIGDIR':ROOT+'/cache/mpl','MATPLOTLIBRC':'/opt/python/mplconfig/matplotlibrc','LANG':'C.UTF-8',
     'PYTHONHASHSEED':'0','PYTHONDONTWRITEBYTECODE':'1'}
process=subprocess.Popen(['/opt/python/bin/python','-B',ROOT+'/main.py'],cwd=ROOT,env=env,
    stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
    start_new_session=True,preexec_fn=demote)
selector=selectors.DefaultSelector()
for stream,name in [(process.stdout,'stdout'),(process.stderr,'stderr')]:
    os.set_blocking(stream.fileno(),False);selector.register(stream,selectors.EVENT_READ,name)
captured={'stdout':bytearray(),'stderr':bytearray()};size=0;reason='exited';truncated=False
while selector.get_map() or process.poll() is None:
    if time.time()>=deadline:reason='timeout'
    if reason!='exited' and process.poll() is None:
        try:os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:pass
    for key,_ in selector.select(.05):
        chunk=os.read(key.fileobj.fileno(),8192)
        if not chunk:selector.unregister(key.fileobj);continue
        room=max(0,limits['outputBytes']-size);captured[key.data].extend(chunk[:room]);size+=len(chunk[:room])
        if len(chunk)>room:reason='output_limit';truncated=True
    if process.poll() is not None:kill_tenant()
exit_code=process.wait();kill_tenant()
artifacts=[];total=0
if reason=='exited' and exit_code==0:
    try:
        for output in a['outputs']:
            path=ROOT+'/output/'+output['path'];real=os.path.realpath(path)
            if real!=path or not real.startswith(ROOT+'/output/'):raise ValueError('ARTIFACT_PATH_CHANGED')
            info=os.lstat(path)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size<1:raise ValueError('ARTIFACT_INVALID')
            total+=info.st_size
            if total>limits['artifactBytes']:reason='artifact_limit';raise ValueError('ARTIFACT_LIMIT')
            os.chown(path,0,0);os.chmod(path,0o400)
            checker='/opt/allrice/check_office.py' if a['purpose']=='office' else '/opt/allrice/check_png.py' if output['format']=='png' else None
            validation='dsh_office' if a['purpose']=='office' else 'trusted_png' if output['format']=='png' else 'utf8'
            if checker:
                command=['/opt/python/bin/python','-I',checker]+([path] if a['purpose']=='office' else [])
                with open(path,'rb') as content:
                    checked=subprocess.run(command,stdin=content if a['purpose']!='office' else subprocess.DEVNULL,
                        stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=20,env={'PATH':env['PATH'],'LANG':'C.UTF-8'})
                if checked.returncode:raise ValueError('VALIDATOR_FAILED: '+checked.stdout[-4000:].decode('utf-8','replace'))
            else:
                with open(path,encoding='utf-8',errors='strict') as f:f.read()
            h=hashlib.sha256()
            with open(path,'rb') as f:
                for chunk in iter(lambda:f.read(65536),b''):h.update(chunk)
            artifacts.append(dict(output,sizeBytes=info.st_size,checksum='sha256:'+h.hexdigest(),validation=validation))
    except Exception as error:
        if reason=='exited':reason='validation_failed'
        exit_code=1;artifacts=[]
        message=('\n'+str(error))[-4000:].encode('utf-8','replace')
        captured['stderr'].extend(message[:max(0,limits['outputBytes']-size)])
result={'exitCode':max(0,min(255,exit_code if exit_code>=0 else 128-exit_code)), 'reason':reason,
        'stdout':captured['stdout'].decode('utf-8','replace'),'stderr':captured['stderr'].decode('utf-8','replace'),
        'truncated':truncated,'artifacts':artifacts}
temp=ROOT+'/.allrice/result.tmp'
with open(temp,'x',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
os.chmod(temp,0o400);os.replace(temp,ROOT+'/.allrice/result.json')
sys.exit(result['exitCode'])
`;
