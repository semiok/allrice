import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  nodeProjectSupervisor,
  pythonProjectSupervisor,
} from '@allrice/project-runtime';

it('grants a project budget only to the exact isolated supervisor with a live private lease', () => {
  const result = JSON.parse(
    execFileSync(
      'python3',
      [
        '-B',
        '-c',
        String.raw`
import importlib.util,json,sys,hashlib,copy,tempfile,os,types
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
scripts=json.load(sys.stdin)
assert m.PROJECT_SUPERVISORS == {m.NODE_IMAGE:hashlib.sha256(scripts['node'].encode()).hexdigest(),m.PYTHON_IMAGE:hashlib.sha256(scripts['python'].encode()).hexdigest()}
now=1000000;attempt='00000000-0000-4000-8000-000000000001';cache='a'*64
m.time.time=lambda:now/1000
real_fstat=os.fstat
def fstat(fd):
 st=real_fstat(fd);return types.SimpleNamespace(st_uid=0,st_mode=st.st_mode,st_size=st.st_size)
m.os.fstat=fstat
c={'Config':{'Image':m.NODE_IMAGE,'User':'0:0','Entrypoint':['/usr/local/bin/node'],
 'Cmd':['--input-type=module','--eval',scripts['node'],'1600000'],'Env':m.SANDBOX_IMAGE_ENV[m.NODE_IMAGE][:],
 'Labels':{m.ATTEMPT:attempt,m.DEADLINE:'1600000',m.SANDBOX:'v1',m.SANDBOX+'-limit':'600000',m.SANDBOX+'-started':str(now-100000),
 'xyz.bplabs.allrice.cloud.kind':'project','xyz.bplabs.allrice.project.image':m.NODE_IMAGE,
 'xyz.bplabs.allrice.project.cache':'sha256:'+cache,'xyz.bplabs.allrice.project.payload':'b'*64}},
 'HostConfig':{'Runtime':'runsc','NetworkMode':'none','ReadonlyRootfs':True,'Privileged':False,
 'CapDrop':['ALL'],'CapAdd':['CHOWN','FOWNER','DAC_OVERRIDE','SETUID','SETGID','KILL'],'SecurityOpt':['no-new-privileges'],
 'Memory':256*1024**2,'MemorySwap':256*1024**2,'PidsLimit':64,'CpuPeriod':100000,'CpuQuota':100000,'Tmpfs':{'/tmp':'rw,nosuid,nodev,noexec,size=32m,mode=1777'}},
 'Mounts':[{'Type':'volume','Destination':'/tmp/work','Name':'allrice-project-work-'+attempt,'RW':True},
 {'Type':'volume','Destination':'/cache','Name':'allrice-project-cache-'+cache,'RW':True}]}
# Preparation consumed 100 seconds: the remaining ceiling must include it.
c['Config']['Labels'][m.DEADLINE]='1500000';c['Config']['Cmd'][3]='1500000'
with tempfile.TemporaryDirectory() as tmp:
 m.SANDBOX_LEASES=tmp;path=tmp+'/'+attempt+'.json'
 def save(expiry=now+5000):
  with open(path,'w') as f:json.dump({'kind':'sandbox-execution-v1','attempt':attempt,'hardDeadline':1500000,'expiresAt':expiry},f)
  os.chmod(path,0o600)
 save()
 valid=lambda x:m.command_deadline_valid(x,now,1500000)
 values=[valid(c)]
 python=copy.deepcopy(c);python['Config'].update(Image=m.PYTHON_IMAGE,Entrypoint=['/opt/python/bin/python'],Cmd=['-I','-c',scripts['python'],'1500000'],Env=m.SANDBOX_IMAGE_ENV[m.PYTHON_IMAGE][:]);python['Config']['Labels']['xyz.bplabs.allrice.project.image']=m.PYTHON_IMAGE
 values.append(valid(python))
 web=copy.deepcopy(c);web['Config']['Labels']['xyz.bplabs.allrice.project.profile']='web-development';web['HostConfig'].update(Memory=1536*1024**2,MemorySwap=1536*1024**2,PidsLimit=128);values.append(valid(web))
 network=copy.deepcopy(c);network['Config']['Labels'].update({'xyz.bplabs.allrice.cloud.network':'controlled-https-v1','xyz.bplabs.allrice.cloud.network-policy':'sha256:'+'c'*64});values.append(valid(network))
 denied=[]
 for obj,key,value in [('Config','Cmd',['--input-type=module','--eval','tenant code','1500000']),('Config','Env',c['Config']['Env']+['TOKEN=secret']),
 ('Config','User','1000:1000'),('HostConfig','NetworkMode','bridge'),('HostConfig','CapAdd',['SYS_ADMIN']),('HostConfig','Devices',[{}]),
 ('HostConfig','Binds',['/host:/tmp']),('HostConfig','Memory',1536*1024**2),('HostConfig','PidsLimit',128),('HostConfig','SecurityOpt',['no-new-privileges','seccomp=unconfined']),
 ('HostConfig','CpuPeriod',200000),('HostConfig','CpuQuota',-1),('HostConfig','CpuQuota',200000),
 ('Labels',m.SERVICE,'project-v1'),('Labels','xyz.bplabs.allrice.project.profile','unbounded'),('Labels','xyz.bplabs.allrice.project.cache','sha256:'+'d'*64),
 ('Labels','xyz.bplabs.allrice.cloud.network','controlled-https-v1'),('Labels','xyz.bplabs.allrice.cloud.project-resolution','v1'),
 ('Labels',m.SANDBOX+'-started',str(now+2000))]:
  x=copy.deepcopy(c);(x['Config']['Labels'] if obj=='Labels' else x[obj])[key]=value;denied.append(valid(x))
 for edit in [lambda x:x['Mounts'].append({'Type':'bind','Destination':'/host','Name':'/host','RW':True}),
 lambda x:x['Mounts'][0].update(RW=False),lambda x:x['Mounts'][1].update(Name='another-cache')]:
  x=copy.deepcopy(c);edit(x);denied.append(valid(x))
 x=copy.deepcopy(python);x['Config']['Labels']['xyz.bplabs.allrice.project.profile']='web-development';denied.append(valid(x))
 save(now);denied.append(valid(c));save(now+5501);denied.append(valid(c))
 save();os.chmod(path,0o644);denied.append(valid(c))
 m.os.fstat=real_fstat
print(json.dumps({'valid':values,'denied':denied}))
`,
        fileURLToPath(new URL('./watchdog.py', import.meta.url)),
      ],
      {
        input: JSON.stringify({
          node: nodeProjectSupervisor,
          python: pythonProjectSupervisor,
        }),
        encoding: 'utf8',
      },
    ),
  );
  expect(result.valid).toEqual([true, true, true, true]);
  expect(result.denied).toHaveLength(26);
  expect(result.denied.every((value: boolean) => value === false)).toBe(true);
});
