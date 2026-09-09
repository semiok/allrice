import { localMcpWireProgram } from './local-mcp-protocol.js';

/** Trusted PID1 in the existing Linux VM container only. User MCP code is a
 * different UID, receives only its own protocol pipe and cannot renew leases. */
export const localMcpSupervisor = String.raw`
import { spawn } from 'node:child_process';
import { mkdir, writeFile, chown, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const chunks=Number(process.env.ALLRICE_INPUT_PARTS);
if(!Number.isInteger(chunks)||chunks<1||chunks>32)process.exit(125);
const bundle=JSON.parse(Buffer.from(Array.from({length:chunks},(_,i)=>process.env['ALLRICE_INPUT_'+i]||'').join(''),'base64').toString('utf8'));
const input=bundle.input,args=input.arguments;
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const hash=value=>'sha256:'+createHash('sha256').update(canonical(value)).digest('hex');
let finished=false, started=false, ready=false, called=false, phase='starting', controlSequence=0;
let child=null,peer=null,credential=null,tools=null,toolResult=null;
let stderrBytes=0,stderrFrames=0,leaseDeadline=Math.min(bundle.hardDeadlineMs,Date.now()+5000);
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const event=value=>emit({type:'mcp',attemptId:bundle.attemptId,...value});
const setPhase=value=>{phase=value;event({event:'phase',phase});};
const end=(reason,code=125)=>{
  if(finished)return;finished=true;
  if(Date.now()>=bundle.hardDeadlineMs&&['lease_lost','canceled','protocol_error'].includes(reason)){reason='timeout';code=124;}
  peer?.close();credential=null;
  event({event:'exit',phase,reason,callAttempted:called,code});
  process.stdout.write('',()=>process.exit(code));setTimeout(()=>process.exit(code),100).unref();
};
setInterval(()=>{
  if(Date.now()>=bundle.hardDeadlineMs)end('timeout',124);
  else if(Date.now()>=leaseDeadline)end('lease_lost');
},100);
process.stdin.on('end',()=>end('lease_lost'));
process.stdin.on('error',()=>end('lease_lost'));

${localMcpWireProgram}

const startServer=async()=>{
  try{
    const dirs=new Set(['/workspace']);
    for(const file of bundle.files){
      if(!file.path||file.path.startsWith('/')||file.path.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('path');
      const target='/workspace/'+file.path;await mkdir(dirname(target),{recursive:true,mode:0o755});
      await writeFile(target,Buffer.from(file.content,'base64'),{flag:'wx',mode:0o600});await chown(target,1000,1000);
      let d=dirname(target);while(d.startsWith('/workspace')){dirs.add(d);d=dirname(d);}
    }
    for(const d of dirs)await chown(d,1000,1000);
    if(finished||Date.now()>=leaseDeadline){end('lease_lost');return;}
    const cwd=args.path==='.'?'/workspace':'/workspace/'+args.path;
    const beforeOom=Number((await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill (\d+)$/m)?.[1]||0);
    child=spawn('/usr/local/bin/node',[cwd+'/'+args.source.entrypoint],{
      cwd,uid:1000,gid:1000,detached:false,stdio:['pipe','pipe','pipe'],
      env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C.UTF-8',CI:'1',
        ...(credential===null?{}:{ALLRICE_MCP_TOKEN:credential})},
    });
    // Raw stderr is never logged; only a bounded opaque diagnostic count is
    // emitted. This avoids secrets split across chunks and encoded payloads.
    child.stderr.on('data',chunk=>{
      stderrBytes+=chunk.length;
      if(stderrBytes>16384||++stderrFrames>64){end('output_limit',122);return;}
    });
    child.once('error',()=>end('process_failed'));
    child.once('exit',async()=>{
      if(finished)return;
      try{
        const oom=Number((await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill (\d+)$/m)?.[1]||0);
        end(oom>beforeOom?'memory_limit':'process_failed');
      }catch{end('process_failed');}
    });
    peer=makePeer(child,reason=>end(reason),credential);
    setPhase('initializing');
    const initialized=await peer.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'allrice-local-mcp',version:'1'}});
    if(!initialized||initialized.protocolVersion!=='2025-11-25'||!initialized.capabilities||
      !initialized.capabilities.tools||typeof initialized.capabilities.tools!=='object'||Array.isArray(initialized.capabilities.tools))throw Error('capability');
    await peer.initialized();
    setPhase('discovering');tools=[];let cursor;const cursors=new Set();
    for(let page=0;page<8;page++){
      const listed=await peer.request('tools/list',cursor?{cursor}:{});
      if(!listed||!Array.isArray(listed.tools))throw Error('tools');
      for(const tool of listed.tools){
        if(!tool||typeof tool.name!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)||tools.some(t=>t.name===tool.name))throw Error('tool');
        tools.push({name:tool.name,description:tool.description??'',inputSchema:tool.inputSchema,outputSchema:tool.outputSchema??null});
      }
      if(tools.length>32||Buffer.byteLength(JSON.stringify(tools))>131072){end('output_limit',122);return;}
      if(listed.nextCursor===undefined){cursor=undefined;break;}
      if(typeof listed.nextCursor!=='string'||!listed.nextCursor||listed.nextCursor.length>1024||cursors.has(listed.nextCursor)||page===7)throw Error('cursor');
      cursor=listed.nextCursor;cursors.add(cursor);
    }
    if(finished)return;
    ready=true;setPhase('ready');event({event:'ready',tools});
  }catch{if(!finished)end('protocol_error');}
};
const call=async frame=>{
  try{
    if(!ready||called||input.capability!=='local.mcp.call'||frame.requestId!==bundle.attemptId||
      frame.digest!==hash({tool:args.tool.name,arguments:args.toolArguments}))throw Error('call');
    const actual=tools.find(tool=>tool.name===args.tool.name);
    if(!actual||hash(actual)!==args.tool.digest){end('schema_changed');return;}
    called=true;setPhase('calling');
    const returned=await peer.request('tools/call',{name:args.tool.name,arguments:args.toolArguments});
    if(finished)return;
    if(!returned||typeof returned!=='object'||Array.isArray(returned)||Buffer.byteLength(JSON.stringify(returned))>65536)throw Error('result');
    toolResult=returned;setPhase('completed');event({event:'result',toolResult});end('completed',0);
  }catch{if(!finished)end('protocol_error');}
};
let control=Buffer.alloc(0);
process.stdin.on('data',chunk=>{
  control=Buffer.concat([control,chunk]);
  let at;
  while((at=control.indexOf(10))>=0){
    const line=control.subarray(0,at);control=control.subarray(at+1);
    if(line.length>16384){end('protocol_error');return;}
    try{
      const frame=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));
      if(finished)return;
      if(Date.now()>=bundle.hardDeadlineMs){end('timeout',124);return;}
      if(Date.now()>=leaseDeadline){end('lease_lost');return;}
      if(frame.attemptId!==bundle.attemptId||frame.sequence!==controlSequence++)throw Error('control');
      if(frame.type==='renew'){
        if(!Number.isFinite(frame.leaseDeadlineMs)||frame.leaseDeadlineMs<=Date.now()||frame.leaseDeadlineMs>bundle.hardDeadlineMs||frame.leaseDeadlineMs>Date.now()+5500)throw Error('lease');
        leaseDeadline=frame.leaseDeadlineMs;
      }else if(frame.type==='start'){
        if(started||!(args.credential===null?frame.credential===null:typeof frame.credential==='string'&&/^[\x21-\x7e]{8,4096}$/.test(frame.credential)))throw Error('start');
        started=true;credential=frame.credential;void startServer();
      }else if(frame.type==='call'){
        if(!ready||called)throw Error('call');void call(frame);
      }else if(frame.type==='finish'){
        if(!ready||input.capability!=='local.mcp.discover')throw Error('finish');
        emit({type:'control_ack',sequence:frame.sequence});
        setPhase('completed');end('completed',0);return;
      }else if(frame.type==='stop'){emit({type:'control_ack',sequence:frame.sequence});end(frame.reason==='lease_lost'?'lease_lost':'canceled');return;}
      else throw Error('control');
      emit({type:'control_ack',sequence:frame.sequence});
    }catch{end('protocol_error');return;}
  }
  if(control.length>16384)end('protocol_error');
});
`;
