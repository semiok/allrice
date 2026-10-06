import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('VM physical command deadlines', () => {
  it('counts compiler memory as two units without reporting units as physical containers', () => {
    const source = fileURLToPath(new URL('./watchdog.py', import.meta.url));
    const result = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          String.raw`
import importlib.util,json,sys,tempfile,contextlib,io
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.time.time=lambda:1000
m.memory_available=lambda:2*1024**3
m.command_deadline_valid=lambda *args:True
results=[]
for memories,slots in [([768,512],3),([768,512],2),([768,768],3),([768,768],4),([512,512],2)]:
 items=[{'Id':format(i+1,'064x'),'Created':999+i} for i in range(len(memories))]
 containers={item['Id']:{'State':{'Running':True},'Config':{'Labels':{m.ATTEMPT:'00000000-0000-4000-8000-000000000001',m.DEADLINE:'1050000'}},'HostConfig':{'Runtime':'runsc','NetworkMode':'none','Memory':memories[i]*1024**2}} for i,item in enumerate(items)}
 killed=[]
 def call(method,path):
  if method=='POST':killed.append(path.split('/')[2]);return None
  if path.startswith('/containers/json?'):return items
  return containers[path.split('/')[2]]
 m.call=call
 with tempfile.TemporaryDirectory() as tmp:
  m.STATE=tmp+'/heartbeat.json'
  with contextlib.redirect_stdout(io.StringIO()):m.tick({'slots':slots})
  with open(m.STATE) as f:heartbeat=json.load(f)
 results.append({'killed':[int(x,16) for x in killed],'running':heartbeat['running']})
print(json.dumps(results))
`,
          source,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(result).toEqual([
      { killed: [], running: 2 },
      { killed: [2], running: 2 },
      { killed: [2], running: 2 },
      { killed: [], running: 2 },
      { killed: [], running: 2 },
    ]);
  });
  it('an active old guard cannot attest compiler support just because the file on disk was replaced', () => {
    const source = fileURLToPath(new URL('./watchdog.py', import.meta.url));
    const result = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          String.raw`
import importlib.util,json,sys
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
old={'at':1,'running':0,'availableBytes':1000000000}
current={**old,'repositoryCompiled':m.compiled_budget()}
changed={**current,'repositoryCompiled':{**m.compiled_budget(),'maximumTimeoutMs':3600000}}
print(json.dumps([m.live_compiled_budget(h) for h in [old,current,changed]]))
`,
          source,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(result).toEqual([
      null,
      {
        profileId: 'allrice.output-redaction.compiled.v1',
        timeoutStepMs: 300000,
        maximumTimeoutMs: 1800000,
        memoryMiB: 768,
      },
      null,
    ]);
  });
  it('keeps ordinary work at 65 seconds and admits only bounded frozen compiler increments', () => {
    const source = fileURLToPath(new URL('./watchdog.py', import.meta.url));
    const result = JSON.parse(
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          String.raw`
import importlib.util,json,sys,copy
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
c={'Config':{'Image':m.NODE_IMAGE,'User':'0:0','Labels':{
 'xyz.bplabs.allrice.cloud.kind':'repository','xyz.bplabs.allrice.repository.profile':m.COMPILED_PROFILE,
 'xyz.bplabs.allrice.repository.timeout':'300000','xyz.bplabs.allrice.repository.input-limit':'23000000',
 'xyz.bplabs.allrice.repository.command':'sha256:'+'a'*64,'xyz.bplabs.allrice.repository.dependency':'sha256:'+'b'*64}},
 'HostConfig':{'Runtime':'runsc','NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,
 'CapDrop':['ALL'],'CapAdd':['SETUID','SETGID','KILL'],'SecurityOpt':['no-new-privileges'],
 'Memory':768*1024**2,'MemorySwap':768*1024**2,'PidsLimit':64,
 'Tmpfs':{'/tmp':'rw,nosuid,nodev,noexec,size=128m,mode=1777'}},'Mounts':[]}
created=1000000
ordinary=copy.deepcopy(c);ordinary['Config']['Labels']={}
values=[bool(m.command_deadline_valid(ordinary,created,created+d)) for d in [65000,65001,300000]]
for timeout in [300000,600000,1800000,60000,301000,2100000]:
 x=copy.deepcopy(c);x['Config']['Labels']['xyz.bplabs.allrice.repository.timeout']=str(timeout)
 values.append(bool(m.command_deadline_valid(x,created,created+timeout)))
values.append(bool(m.command_deadline_valid(c,created,created+301001)))
for path,key,value in [('Config','User','1001:1001'),('Config','Image','untrusted'),('HostConfig','Memory',1024*1024**2),('HostConfig','Privileged',True),('HostConfig','Binds',['/host:/tmp']),('HostConfig','Tmpfs',{'/tmp':'rw,size=128m'}),('HostConfig','CapAdd',['SYS_ADMIN']),('Labels','xyz.bplabs.allrice.cloud.kind','script'),('Labels','xyz.bplabs.allrice.repository.timeout','3e5'),('Labels','xyz.bplabs.allrice.repository.dependency','unknown')]:
 x=copy.deepcopy(c);target=x['Config']['Labels'] if path=='Labels' else x[path];target[key]=value
 values.append(bool(m.command_deadline_valid(x,created,created+300000)))
print(json.dumps(values))
`,
          source,
        ],
        { encoding: 'utf8' },
      ),
    );
    expect(result).toEqual([
      true,
      false,
      false,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      ...Array(10).fill(false),
    ]);
  });
});
