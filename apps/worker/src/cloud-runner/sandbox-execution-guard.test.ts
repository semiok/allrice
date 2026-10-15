import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  cloudNetworkBudgetSupervisor,
  cloudBudgetSupervisor,
  cloudResolutionSupervisor,
} from './backend.js';

it('requires the exact sandbox envelope, a live private lease and current guard capability', () => {
  const result = JSON.parse(
    execFileSync(
      'python3',
      [
        '-B',
        '-c',
        String.raw`
import importlib.util,json,sys,copy,tempfile,os,types,hashlib,contextlib,io
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
scripts=json.load(sys.stdin);supervisors=scripts['regular'];resolver=scripts['resolver']
assert set(hashlib.sha256(x.encode()).hexdigest() for x in supervisors)==set(m.SANDBOX_SUPERVISORS)
assert {hashlib.sha256(resolver.encode()).hexdigest()}==set(m.RESOLUTION_SUPERVISORS)
now=1000000;attempt='00000000-0000-4000-8000-000000000001'
m.time.time=lambda:now/1000
c={'Config':{'Image':m.NODE_IMAGE,'User':'65532:65532','Entrypoint':['/usr/local/bin/node'],
 'Cmd':['--input-type=module','--eval',supervisors[0]],'Env':m.SANDBOX_IMAGE_ENV[m.NODE_IMAGE][:],
 'Labels':{m.ATTEMPT:attempt,m.DEADLINE:'1600000',m.SANDBOX:'v1',m.SANDBOX+'-limit':'600000',m.SANDBOX+'-started':str(now)}},
 'HostConfig':{'Runtime':'runsc','NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,
 'CapDrop':['ALL'],'CapAdd':[],'SecurityOpt':['no-new-privileges'],'Memory':256*1024**2,
 'MemorySwap':256*1024**2,'PidsLimit':64,'Tmpfs':{'/tmp':'rw,nosuid,nodev,noexec,size=32m,mode=1777'}},
 'Mounts':[{'Type':'tmpfs','Destination':'/tmp'}],'State':{'Running':True}}
# Unit fixture emulates root ownership only; actual root/VM enforcement has its own native acceptance.
real_fstat=os.fstat;owner=[0]
def fstat(fd):
 st=real_fstat(fd);return types.SimpleNamespace(st_uid=owner[0],st_mode=st.st_mode,st_size=st.st_size)
m.os.fstat=fstat
with tempfile.TemporaryDirectory() as tmp:
 m.SANDBOX_LEASES=tmp;m.STATE=tmp+'/heartbeat'
 path=tmp+'/'+attempt+'.json'
 lease={'kind':'sandbox-execution-v1','attempt':attempt,'hardDeadline':1600000,'expiresAt':now+5000}
 def save(data):
  with open(path,'w') as f:json.dump(data,f)
  os.chmod(path,0o600)
 save(lease)
 resolution=copy.deepcopy(c)
 resolution['Config']['Labels'].update({'xyz.bplabs.allrice.cloud.project-resolution':'v1','xyz.bplabs.allrice.cloud.network':'controlled-https-v1'})
 resolution['Config']['Cmd'][2]=resolver
 resolution['HostConfig']['Tmpfs']={'/tmp':'rw,nosuid,nodev,exec,size=256m,mode=1777'}
 resolved=[m.command_deadline_valid(resolution,now,1600000)]
 for obj,key,value in [('Labels','xyz.bplabs.allrice.cloud.project-resolution','unknown'),('Labels','xyz.bplabs.allrice.cloud.network','none'),
 ('Config','Cmd',c['Config']['Cmd']),('HostConfig','Tmpfs',{'/tmp':'rw,size=1024m'}),('HostConfig','Memory',1024**3),('HostConfig','CapAdd',['SYS_ADMIN'])]:
  x=copy.deepcopy(resolution);(x['Config']['Labels'] if obj=='Labels' else x[obj])[key]=value
  resolved.append(m.command_deadline_valid(x,now,1600000))
 # A tenant script cannot borrow the resolver executable temp directory.
 x=copy.deepcopy(c);x['HostConfig']['Tmpfs']=resolution['HostConfig']['Tmpfs'];resolved.append(m.command_deadline_valid(x,now,1600000))
 values=[m.command_deadline_valid(c,now,1600000)]
 x=copy.deepcopy(c);x['Config']['Cmd'][2]=supervisors[1];values.append(m.command_deadline_valid(x,now,1600000))
 x=copy.deepcopy(c);x['Config']['Image']=m.PYTHON_IMAGE;x['Config']['Env']=m.SANDBOX_IMAGE_ENV[m.PYTHON_IMAGE][:];values.append(m.command_deadline_valid(x,now,1600000))
 for obj,key,value in [('Config','Image','unknown'),('Config','User','0:0'),('Config','Cmd',['--eval','untrusted']),
 ('Config','Env',['TOKEN=synthetic']),('HostConfig','NetworkMode','bridge'),('HostConfig','Privileged',True),
 ('HostConfig','Binds',['/host:/tmp']),('HostConfig','CapAdd',['SYS_ADMIN']),('HostConfig','MemorySwap',1024**3),
 ('HostConfig','PidsLimit',65),('Labels',m.SANDBOX+'-limit','3600001'),('Labels',m.SANDBOX+'-started','0'),
 ('Labels',m.SERVICE,'project-v1')]:
  x=copy.deepcopy(c);(x['Config']['Labels'] if obj=='Labels' else x[obj])[key]=value
  values.append(m.command_deadline_valid(x,now,1600000))
 for env in [[],c['Config']['Env']+['TOKEN=synthetic'],c['Config']['Env']+['PATH=/untrusted'],m.SANDBOX_IMAGE_ENV[m.PYTHON_IMAGE]]:
  x=copy.deepcopy(c);x['Config']['Env']=env;values.append(m.command_deadline_valid(x,now,1600000))
 values.append(m.command_deadline_valid(c,now,1600001))
 for key,value in [('expiresAt',now),('expiresAt',now+5501),('hardDeadline',1600001),('attempt','other'),('kind','project-v1')]:
  save({**lease,key:value});values.append(m.command_deadline_valid(c,now,1600000))
 save(lease);owner[0]=501;values.append(m.command_deadline_valid(c,now,1600000));owner[0]=0
 os.chmod(path,0o644);values.append(m.command_deadline_valid(c,now,1600000));os.chmod(path,0o600)
 os.rename(path,path+'.original');os.symlink(path+'.original',path);values.append(m.command_deadline_valid(c,now,1600000))
 os.unlink(path);save(lease)
 # Neither a second service label nor an always-valid service ACK may bypass the sandbox validator.
 m.service_lease_valid=lambda *args:True;m.memory_available=lambda:2*1024**3
 x=copy.deepcopy(c);x['Config']['Labels'][m.SERVICE]='project-v1'
 killed=[]
 def call(method,path):
  if method=='POST':killed.append(path);return None
  if path.startswith('/containers/json?'):return [{'Id':'a'*64,'Created':1000}]
  return x
 m.call=call
 with contextlib.redirect_stdout(io.StringIO()):m.tick({'slots':4})
 old=m.live_sandbox_budget({});current=m.live_sandbox_budget({'sandboxExecution':m.sandbox_budget()})
 m.os.fstat=real_fstat
print(json.dumps({'values':values,'resolver':resolved,'mixedStopped':len(killed)==1,'old':old,'current':current}))
`,
        fileURLToPath(new URL('./watchdog.py', import.meta.url)),
      ],
      {
        input: JSON.stringify({
          regular: [cloudBudgetSupervisor, cloudNetworkBudgetSupervisor],
          resolver: cloudResolutionSupervisor,
        }),
        encoding: 'utf8',
      },
    ),
  );
  expect(result.values.slice(0, 3)).toEqual([true, true, true]);
  expect(result.values.slice(3).every((v: boolean) => v === false)).toBe(true);
  expect(result.mixedStopped).toBe(true);
  expect(result.resolver).toEqual([true, ...Array(7).fill(false)]);
  expect(result.old).toBeNull();
  expect(result.current).toEqual({
    version: 1,
    maximumTimeoutMs: 3600000,
    physicalLeaseMs: 5000,
  });
});
