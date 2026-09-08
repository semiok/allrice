/** Fixed trusted PID1: finite service + explicit fd3 requests, never PTY or
 * stdout prompt guessing. Lease messages cannot extend the approved hard limit. */
export const localServiceSupervisor = String.raw`
import { spawn } from 'node:child_process';
import { mkdir, writeFile, chown, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { get } from 'node:http';

const chunks=Number(process.env.ALLRICE_INPUT_PARTS);
if(!Number.isInteger(chunks)||chunks<1||chunks>32) process.exit(125);
const bundle=JSON.parse(Buffer.from(Array.from({length:chunks},(_,i)=>process.env['ALLRICE_INPUT_'+i]||'').join(''),'base64').toString('utf8'));
const config=bundle.command.background;
let finished=false, eventSequence=1, controlSequence=0, requestSequence=0;
let pending=null, inputClosed=false, child=null, bytes=0, outputFrames=0;
let ready=false, leaseDeadline=Math.min(bundle.hardDeadlineMs,Date.now()+5000), protocol='';
let requestTimer, readinessTimer, probeTimer;
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n');
const event=e=>emit({type:'service',event:{processId:bundle.processId,attemptId:bundle.attemptId,sequence:eventSequence++,...e}});
const end=(reason,code)=>{
  if(finished) return; finished=true;
  clearTimeout(requestTimer); clearTimeout(readinessTimer);clearTimeout(probeTimer);
  emit({type:'exit',reason,code});
  process.stdout.write('',()=>process.exit(code));
  setTimeout(()=>process.exit(code),100).unref();
};
const leaseTimer=setInterval(()=>{
  if(Date.now()>=bundle.hardDeadlineMs) end('timeout',124);
  else if(Date.now()>=leaseDeadline) end('lease_lost',125);
},100);
process.stdin.on('end',()=>end('lease_lost',125));
process.stdin.on('error',()=>end('lease_lost',125));
let controlText='', controlQueue=Promise.resolve();
const applyControl=async frame=>{
  if(finished) return;
  if(frame.attemptId!==bundle.attemptId||frame.sequence!==controlSequence||!Number.isInteger(frame.sequence)) throw Error('control sequence');
  controlSequence++;
  if(frame.type==='renew') {
    if(!Number.isFinite(frame.leaseDeadlineMs)||frame.leaseDeadlineMs<=Date.now()||frame.leaseDeadlineMs>bundle.hardDeadlineMs||frame.leaseDeadlineMs>Date.now()+5500) throw Error('lease');
    leaseDeadline=frame.leaseDeadlineMs;
  } else if(frame.type==='stop') {
    end(frame.reason==='lease_lost'?'lease_lost':'canceled',125); return;
  } else if(frame.type==='input') {
    const i=frame.input;
    if(!pending||inputClosed||!i||i.requestId!==pending.requestId||i.sequence!==pending.sequence||i.expiresAt!==pending.expiresAt||Date.parse(i.expiresAt)<=Date.now()||typeof i.text!=='string'||Buffer.byteLength(i.text)>pending.maxBytes||i.text.includes('\0')||!['text','eof'].includes(i.kind)||(i.kind==='eof'&&i.text!=='')) throw Error('input');
    const digest='sha256:'+createHash('sha256').update(JSON.stringify({kind:i.kind,text:i.text})).digest('hex');
    if(i.digest!==digest) throw Error('digest');
    clearTimeout(requestTimer);
    await new Promise((resolve,reject)=>{
      const done=error=>error?reject(error):resolve();
      if(i.kind==='eof') {inputClosed=true;child.stdin.end(done);}
      else child.stdin.write(i.text,done);
    });
    pending=null;
    event({type:'input_delivered',inputId:i.inputId,requestId:i.requestId,inputSequence:i.sequence,digest:i.digest,kind:i.kind});
  } else throw Error('control');
  emit({type:'control_ack',sequence:frame.sequence});
};
process.stdin.on('data',chunk=>{
  controlText+=chunk.toString('utf8');
  if(Buffer.byteLength(controlText)>32768) {end('input_protocol_error',125);return;}
  let at;
  while((at=controlText.indexOf('\n'))>=0) {
    const line=controlText.slice(0,at);controlText=controlText.slice(at+1);
    if(Buffer.byteLength(line)>16384) {end('input_protocol_error',125);return;}
    controlQueue=controlQueue.then(()=>applyControl(JSON.parse(line))).catch(()=>end('input_protocol_error',125));
  }
});

const probe=()=>new Promise(resolve=>{
  if(config.readiness.kind==='tcp') {
    const socket=connect({host:'127.0.0.1',port:config.readiness.port});
    socket.setTimeout(300);socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});
  } else {
    const request=get({host:'127.0.0.1',port:config.readiness.port,path:config.readiness.path,agent:false},response=>{
      const ok=response.statusCode>=200&&response.statusCode<300;
      response.destroy();resolve(ok);
    });
    request.setTimeout(300,()=>{request.destroy();resolve(false);});request.once('error',()=>resolve(false));
  }
});
const pollReady=async()=>{
  if(finished||ready) return;
  if(await probe()) {if(finished)return;ready=true;clearTimeout(readinessTimer);event({type:'ready',port:config.readiness.port,visibility:'container_only'});}
  else probeTimer=setTimeout(pollReady,100);
};
try {
  if(!config||bundle.hardDeadlineMs<=Date.now()) throw Error('service');
  // The port is container-only. Never choose an alternative approved port.
  const free=await new Promise(resolve=>{
    const server=createServer();server.once('error',()=>resolve(false));
    server.listen(config.readiness.port,'127.0.0.1',()=>server.close(()=>resolve(true)));
  });
  if(!free) {end('port_conflict',125);} else {
    const dirs=new Set(['/workspace']);
    for(const file of bundle.files) {
      if(!file.path||file.path.startsWith('/')||file.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('path');
      const target='/workspace/'+file.path;await mkdir(dirname(target),{recursive:true,mode:0o755});
      await writeFile(target,Buffer.from(file.content,'base64'),{flag:'wx',mode:0o600});await chown(target,1000,1000);
      let dir=dirname(target);while(dir.startsWith('/workspace')) {dirs.add(dir);dir=dirname(dir);}
    }
    for(const dir of dirs)await chown(dir,1000,1000);
    for(const name of ['user','global'])await writeFile('/tmp/allrice-npm-'+name+'.conf','',{flag:'wx',mode:0o444});
    const oomCount=async()=>Number((await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill (\d+)$/m)?.[1]||0);
    const beforeOom=await oomCount();
    child=spawn(bundle.command.executable,bundle.command.args,{
      cwd:bundle.command.path==='.'?'/workspace':'/workspace/'+bundle.command.path,
      uid:1000,gid:1000,detached:false,stdio:['pipe','pipe','pipe','pipe'],
      env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8',CI:'1',ALLRICE_INPUT_REQUEST_FD:'3',
        npm_config_offline:'true',npm_config_cache:'/tmp/npm-cache',npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false',npm_config_userconfig:'/tmp/allrice-npm-user.conf',npm_config_globalconfig:'/tmp/allrice-npm-global.conf'},
    });
    child.stdin.on('error',()=>end('input_protocol_error',125));
    let portConflict=false;
    for(const stream of ['stdout','stderr'])child[stream].on('data',chunk=>{
      if(stream==='stderr'&&chunk.toString('utf8').includes('EADDRINUSE'))portConflict=true;
      const kept=chunk.subarray(0,Math.max(0,bundle.command.limits.outputBytes-bytes));bytes+=chunk.length;
      if(kept.length&&outputFrames<254){outputFrames++;emit({type:stream,data:kept.toString('base64')});}
      if(bytes>bundle.command.limits.outputBytes||outputFrames>=254)end('output_limit',122);
    });
    child.stdio[3].on('data',chunk=>{
      if(config.stdin.mode!=='requests-v1'||inputClosed) {end('input_protocol_error',125);return;}
      protocol+=chunk.toString('utf8');if(Buffer.byteLength(protocol)>2048){end('input_protocol_error',125);return;}
      let index;
      while((index=protocol.indexOf('\n'))>=0){
        const line=protocol.slice(0,index);protocol=protocol.slice(index+1);
        // A program may request the next input as soon as it reads the previous
        // bytes. Serialize that request after the current pipe delivery/ACK.
        controlQueue=controlQueue.then(()=>{
        try{
          const value=JSON.parse(line);
          if(pending||requestSequence>=config.stdin.maxRequests||Object.keys(value).some(k=>!['type','prompt'].includes(k))||value.type!=='input.request'||typeof value.prompt!=='string'||!value.prompt.trim()||value.prompt.length>500)throw Error('request');
          pending={requestId:randomUUID(),sequence:requestSequence++,prompt:value.prompt,expiresAt:new Date(Math.min(bundle.hardDeadlineMs,Date.now()+config.stdin.requestTimeoutMs)).toISOString(),maxBytes:config.stdin.maxBytes};
          event({type:'input_request',request:pending});
          requestTimer=setTimeout(()=>end('input_expired',125),Math.max(0,Date.parse(pending.expiresAt)-Date.now()));
        }catch{end('input_protocol_error',125);}
        });
      }
    });
    child.once('error',()=>end('supervisor_failed',125));
    child.once('exit',async(code)=>{
      clearInterval(leaseTimer);
      // Bounded drain, then PID1 exits and the whole container's process tree ends.
      setTimeout(async()=>{try{end((await oomCount())>beforeOom?'memory_limit':portConflict?'port_conflict':'exited',Number.isInteger(code)?code:125);}catch{end('supervisor_failed',125);}},100);
    });
    readinessTimer=setTimeout(()=>end('readiness_timeout',125),Math.min(config.readiness.timeoutMs,bundle.hardDeadlineMs-Date.now()));
    void pollReady();
  }
}catch{end('supervisor_failed',125);}
`;
