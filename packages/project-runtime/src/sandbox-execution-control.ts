/** Only trusted adapters may stage this in the immutable supervisor config.
 * The hard deadline was frozen before preparation; private stdin is a separate
 * five-second liveness lease, never a grant to increase the execution budget. */
export interface SandboxExecutionControl {
  version: 1;
  attemptId: string;
  hardDeadlineAt: number;
}

/** Inlined inside trusted Node PID 1, before any tenant code is started.
 * `end` destroys the namespace. Tenant stdio is always a different pipe. */
export const nodeSandboxExecutionControl = String.raw`
function installSandboxExecutionControl(config) {
 const control=config.executionControl;
 if(!control)return;
 let sequence=0,pending='',deadline=config.deadlineUnixMs,lease=Date.now()+5000;
 const integer=n=>Number.isSafeInteger(n)&&n>=0;
 const fail=()=>end('lease_lost',124);
 if(control.version!==1||typeof control.attemptId!=='string'||!integer(control.hardDeadlineAt)||
    !integer(deadline)||deadline>Date.now()+3600000||deadline>control.hardDeadlineAt||
    control.hardDeadlineAt>Date.now()+3600000||deadline<=Date.now())return fail();
 const timer=setInterval(()=>{
   if(Date.now()>=deadline)end('timeout',124);
   else if(Date.now()>=lease)fail();
 },50);
 process.stdin.on('data',bytes=>{
  pending+=bytes.toString('utf8');
  if(Buffer.byteLength(pending)>16384)return fail();
  for(let at;(at=pending.indexOf('\n'))>=0;){
   const line=pending.slice(0,at);pending=pending.slice(at+1);
   try {
    const f=JSON.parse(line),now=Date.now();
    const networkReady=f.networkReady===true&&config.runtimeNetwork===true;
    if(now>=Math.min(lease,deadline)||f.type!=='execution_renew'||f.attemptId!==control.attemptId||
      Object.keys(f).sort().join(',')!==(networkReady?'attemptId,deadlineAt,leaseDeadlineAt,networkReady,sequence,type':'attemptId,deadlineAt,leaseDeadlineAt,sequence,type')||
      f.sequence!==sequence+1||!integer(f.sequence)||!integer(f.deadlineAt)||!integer(f.leaseDeadlineAt)||
      f.deadlineAt<deadline||f.deadlineAt>control.hardDeadlineAt||f.leaseDeadlineAt<=now||
      f.leaseDeadlineAt>now+5500||f.leaseDeadlineAt>f.deadlineAt)throw Error('control');
    sequence=f.sequence;deadline=f.deadlineAt;lease=f.leaseDeadlineAt;
    if(networkReady)config.runtimeNetworkReady=true;
   }catch{return fail();}
  }
 });
 process.stdin.once('end',fail);process.stdin.once('error',fail);
 process.once('exit',()=>clearInterval(timer));
}
`;

/** The watchdog runs independently of preparation/cache traversal. It never
 * reads tenant output or evaluates tenant JSON. Exit destroys detached children.
 * The deadline thread uses os._exit directly so a blocked output pipe cannot
 * prevent the stop. Only the trusted stdin reader can advance the local lease. */
export const pythonSandboxExecutionControl = String.raw`
def install_sandbox_execution_control(config):
    control=config.get('executionControl')
    if control is None:return
    import threading
    now=lambda:int(time.time()*1000)
    integer=lambda n:type(n) is int and 0<=n<=9007199254740991
    deadline=config.get('deadlineUnixMs');hard=control.get('hardDeadlineAt')
    if control.get('version')!=1 or type(control.get('attemptId')) is not str or not integer(deadline) or not integer(hard) or not now()<deadline<=hard<=now()+3600000:os._exit(124)
    state=[0,deadline,now()+5000]
    def watch():
        while True:
            if now()>=min(state[1],state[2]):os._exit(124)
            time.sleep(.05)
    def read_control():
        pending=b''
        try:
            while True:
                chunk=os.read(0,4096)
                if not chunk:os._exit(124)
                pending+=chunk
                if len(pending)>16384:os._exit(124)
                while b'\n' in pending:
                    line,pending=pending.split(b'\n',1);f=json.loads(line);t=now()
                    network_ready=type(f) is dict and f.get('networkReady') is True and config.get('runtimeNetwork') is True
                    keys=['type','attemptId','sequence','deadlineAt','leaseDeadlineAt']+(['networkReady'] if network_ready else [])
                    if type(f) is not dict or set(f)!=set(keys) or f['type']!='execution_renew' or f['attemptId']!=control['attemptId'] or not integer(f['sequence']) or f['sequence']!=state[0]+1 or not integer(f['deadlineAt']) or not integer(f['leaseDeadlineAt']) or t>=min(state[1],state[2]) or not state[1]<=f['deadlineAt']<=hard or not t<f['leaseDeadlineAt']<=min(t+5500,f['deadlineAt']):os._exit(124)
                    state[:]=[f['sequence'],f['deadlineAt'],f['leaseDeadlineAt']]
                    if network_ready:config['runtimeNetworkReady']=True
        except BaseException:os._exit(124)
    threading.Thread(target=watch,daemon=True).start()
    threading.Thread(target=read_control,daemon=True).start()
`;
