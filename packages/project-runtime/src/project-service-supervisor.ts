/** Extends the existing immutable Node project supervisor. No installer or
 * executable permission is added; only its approved child gets a finite lease. */
export const projectServiceSupervisor = String.raw`
const service=a.command.background?.projectService;
let serviceSequence=1,controlSequence=0,serviceDigest=null,serviceFiles=[],serviceReady=false;
let leaseDeadline=Math.min(a.deadlineUnixMs,Date.now()+5000),serviceChild;
const serviceId=process.env.ALLRICE_SERVICE_ID,attemptId=process.env.ALLRICE_SERVICE_ATTEMPT;
const serviceEvent=e=>emit({type:'service',event:{processId:serviceId,attemptId,sequence:serviceSequence++,...e}});
const serviceTimer=service?setInterval(()=>{if(Date.now()>=leaseDeadline)end('lease_lost',125);},100):null;
let controlText='',controlQueue=Promise.resolve();
const directoryFlags=fsConstants.O_RDONLY|fsConstants.O_DIRECTORY|fsConstants.O_NOFOLLOW;
async function sourceFile(path,action){
 const parts=path.split('/');if(!path||parts.some(p=>!p||p==='.'||p==='..')||path.startsWith('/')||/[\\\0]/.test(path))throw Error('source path');
 let dir=await open(root+'/project',directoryFlags);
 try{for(const part of parts.slice(0,-1)){let next;try{next=await open('/proc/self/fd/'+dir.fd+'/'+part,directoryFlags);}catch(e){if(e.code!=='ENOENT')throw e;await mkdir('/proc/self/fd/'+dir.fd+'/'+part,{mode:0o700});next=await open('/proc/self/fd/'+dir.fd+'/'+part,directoryFlags);await next.chown(1000,1000);}await dir.close();dir=next;}
  if(await realpath('/proc/self/fd/'+dir.fd)!==root+'/project'+(parts.length>1?'/'+parts.slice(0,-1).join('/') :''))throw Error('source directory changed');
  await action('/proc/self/fd/'+dir.fd+'/'+parts.at(-1));
 }finally{await dir.close();}
}
async function applySource(frame){
 if(!serviceReady||leaseDeadline<=Date.now()||!/^([a-f0-9]{8}-){1}[a-f0-9-]{27}$/.test(frame.updateId)||!/^sha256:[a-f0-9]{64}$/.test(frame.checksum))throw Error('source update');
 const bytes=await readFile(root+'/.allrice/source-'+frame.updateId+'.json');
 if(bytes.length>500000||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==frame.checksum)throw Error('source digest');
 const u=JSON.parse(bytes.toString('utf8'));if(u.updateId!==frame.updateId||u.expectedDigest!==serviceDigest||u.snapshot.projectId!==a.command.projectPreparation.projectId||!Array.isArray(u.snapshot.files)||u.snapshot.files.length>64)throw Error('source identity');
 const manifest=[],paths=new Set();let total=0;
 for(const f of u.snapshot.files){if(paths.has(f.path))throw Error('source duplicate');paths.add(f.path);const b=Buffer.from(f.contentBase64,'base64');total+=b.length;if(total>256000||b.length!==f.sizeBytes||b.toString('base64')!==f.contentBase64||'sha256:'+createHash('sha256').update(b).digest('hex')!==f.sha256)throw Error('source bytes');manifest.push({path:f.path,sha256:f.sha256});}
 if('sha256:'+createHash('sha256').update(JSON.stringify(manifest)).digest('hex')!==u.snapshot.sourceDigest)throw Error('source manifest');
 const sensitive=p=>/(^|\/)(package\.json|pnpm-lock\.yaml|\.npmrc|\.pnpmfile\.cjs|(?:vite|next)\.config\.[a-z]+)$/.test(p);
 for(const f of [...serviceFiles,...manifest])if(sensitive(f.path)&&serviceFiles.find(v=>v.path===f.path)?.sha256!==manifest.find(v=>v.path===f.path)?.sha256)throw Error('source dependency changed');
 for(const f of serviceFiles)await sourceFile(f.path,async p=>{const h=await open(p,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);try{const s=await h.stat();if(!s.isFile()||s.nlink!==1||s.size>256000||'sha256:'+createHash('sha256').update(await h.readFile()).digest('hex')!==f.sha256)throw Error('source changed');}finally{await h.close();}});
 for(const f of u.snapshot.files){if(serviceFiles.find(old=>old.path===f.path)?.sha256===f.sha256)continue;await sourceFile(f.path,async p=>{
  const temporary=p+'.allrice-'+frame.updateId,h=await open(temporary,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
  try{await h.writeFile(Buffer.from(f.contentBase64,'base64'));await h.chown(1000,1000);}finally{await h.close();}
  await rename(temporary,p);
 });}
 for(const f of serviceFiles)if(!paths.has(f.path))await sourceFile(f.path,p=>unlink(p));
 serviceFiles=manifest;serviceDigest=u.snapshot.sourceDigest;
 emit({type:'source_applied',updateId:u.updateId,sourceDigest:serviceDigest});
}
if(service){
 process.stdin.on('end',()=>end('lease_lost',125));process.stdin.on('error',()=>end('lease_lost',125));
 process.stdin.on('data',b=>{
  controlText+=b.toString('utf8');if(Buffer.byteLength(controlText)>32768){end('supervisor_failed',125);return;}
  let at;while((at=controlText.indexOf('\n'))>=0){const line=controlText.slice(0,at);controlText=controlText.slice(at+1);
   controlQueue=controlQueue.then(async()=>{
    if(finished)return;if(Date.now()>=a.deadlineUnixMs){end('timeout',124);return;}
    const f=JSON.parse(line);if(f.attemptId!==attemptId||f.sequence!==controlSequence++)throw Error('control sequence');
    if(f.type==='renew'){if(!Number.isFinite(f.leaseDeadlineMs)||f.leaseDeadlineMs<=Date.now()||f.leaseDeadlineMs>a.deadlineUnixMs||f.leaseDeadlineMs>Date.now()+5500)throw Error('lease');leaseDeadline=f.leaseDeadlineMs;}
    else if(f.type==='stop'){end(f.reason==='lease_lost'?'lease_lost':'canceled',125);return;}
    else if(f.type==='source')await applySource(f);else throw Error('control');
    emit({type:'control_ack',sequence:f.sequence});
   }).catch(()=>end('supervisor_failed',125));
  }
 });
}
async function projectServiceStarted(child){
 serviceChild=child;serviceFiles=a.command.files;serviceDigest=a.command.projectPreparation.sourceDigest;
 const until=Math.min(a.deadlineUnixMs,Date.now()+service.readinessTimeoutMs);
 // SPA dev servers use Accept to decide whether '/' falls back to index.html.
 // Match a standard browser/fetch request while still requiring actual 2xx.
 // First-request compilation can take longer than a socket idle timeout. Bound
 // each request by the remaining absolute readiness budget, including responses
 // that keep sending bytes; retry only after an actual connection/HTTP failure.
 const probe=()=>new Promise(resolve=>{
  let settled=false,timer;
  const settle=ok=>{if(settled)return;settled=true;clearTimeout(timer);req.destroy();resolve(ok);};
  const req=httpGet({host:'127.0.0.1',port:service.port,path:service.path,headers:{accept:'*/*'},agent:false},res=>{const ok=res.statusCode>=200&&res.statusCode<300;res.destroy();settle(ok);});
  timer=setTimeout(()=>settle(false),Math.max(1,until-Date.now()));req.once('error',()=>settle(false));
 });
 while(!finished&&!serviceReady){
  if(Date.now()>=until){end('readiness_timeout',125);return;}
  if(await probe()){if(finished)return;if(Date.now()>=until){end('readiness_timeout',125);return;}serviceReady=true;serviceEvent({type:'ready',port:service.port,visibility:'container_only'});return;}
  if(Date.now()>=until){end('readiness_timeout',125);return;}await new Promise(r=>setTimeout(r,Math.min(100,until-Date.now())));
 }
}
`;
