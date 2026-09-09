import { createHash } from 'node:crypto';
import {
  canonicalRuntimeBridgeJson,
  localMcpLimits,
  McpDiscoveredToolSchema,
  RuntimeLocalMcpToolResultSchema,
  type McpDiscoveredTool,
  type RuntimeLocalMcpSource,
} from '@allrice/contracts';

export class LocalMcpError extends Error {
  constructor(
    readonly code:
      | 'LOCAL_MCP_SOURCE_CHANGED'
      | 'LOCAL_MCP_INPUT_DENIED'
      | 'LOCAL_MCP_CREDENTIAL_UNAVAILABLE'
      | 'LOCAL_MCP_CREDENTIAL_MISMATCH'
      | 'LOCAL_MCP_CREDENTIAL_REVOKED'
      | 'LOCAL_MCP_CREDENTIAL_REVISION_EXISTS'
      | 'LOCAL_MCP_SETTINGS_UNAVAILABLE'
      | 'LOCAL_MCP_SANDBOX_REQUIRED'
      | 'LOCAL_MCP_DISABLED'
      | 'LOCAL_MCP_REVOKED'
      | 'LOCAL_MCP_UNAVAILABLE'
      | 'LOCAL_MCP_PROTOCOL'
      | 'LOCAL_MCP_LIMIT'
      | 'LOCAL_MCP_SCHEMA_CHANGED'
      | 'LOCAL_MCP_UNKNOWN',
  ) {
    super(code);
  }
}
export function localMcpDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalRuntimeBridgeJson(value)).digest('hex')}`;
}
export function localMcpSourceDigest(
  source: Omit<RuntimeLocalMcpSource, 'digest'>,
): string {
  return localMcpDigest({
    name: source.name,
    version: source.version,
    entrypoint: source.entrypoint,
    files: source.files,
  });
}
export function localMcpToolDigest(tool: McpDiscoveredTool): string {
  return localMcpDigest({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  });
}
export function normalizeLocalMcpTools(value: unknown): McpDiscoveredTool[] {
  if (!Array.isArray(value) || value.length > localMcpLimits.tools)
    throw new LocalMcpError('LOCAL_MCP_LIMIT');
  try {
    const tools = value.map((tool) => McpDiscoveredToolSchema.parse(tool));
    if (
      new Set(tools.map((tool) => tool.name)).size !== tools.length ||
      Buffer.byteLength(JSON.stringify(tools)) > localMcpLimits.discoveryBytes
    )
      throw new LocalMcpError('LOCAL_MCP_LIMIT');
    return tools;
  } catch {
    throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
  }
}
export function parseLocalMcpResult(value: unknown) {
  const result = RuntimeLocalMcpToolResultSchema.safeParse(value);
  if (!result.success) throw new LocalMcpError('LOCAL_MCP_PROTOCOL');
  return result.data;
}

/** This reviewed code runs only inside trusted PID1. It never spawns a host
 * process. Strict newline JSON-RPC is deliberately a bounded protocol subset. */
export const localMcpWireProgram = String.raw`
const makePeer=(child, onFailure, credential)=>{
  let pending=Buffer.alloc(0), messages=0, nextId=1, total=0, closed=false;
  const requests=new Map();
  const rejectAll=()=>{for(const p of requests.values()){clearTimeout(p.timer);p.reject(Error('protocol'));}requests.clear();};
  const fail=reason=>{if(closed)return;closed=true;rejectAll();onFailure(reason);};
  const write=message=>new Promise((resolve,reject)=>{
    const line=JSON.stringify(message)+'\n';
    if(Buffer.byteLength(line)>65536||closed){reject(Error('protocol'));return;}
    const timer=setTimeout(()=>{fail('protocol_error');reject(Error('protocol'));},2000);
    child.stdin.write(line,error=>{clearTimeout(timer);error?reject(Error('protocol')):resolve();});
  });
  child.stdin.on('error',()=>fail('protocol_error'));
  child.stdout.on('data',chunk=>{
    total+=chunk.length;
    if(total>262144){fail('output_limit');return;}
    pending=Buffer.concat([pending,chunk]);
    let at;
    while((at=pending.indexOf(10))>=0){
      const bytes=pending.subarray(0,at);pending=pending.subarray(at+1);
      if(bytes.length>65536||++messages>64){fail('output_limit');return;}
      try{
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        // Never store/forward the configured credential, even in server replies.
        if(credential&&text.includes(credential))throw Error('credential');
        const message=JSON.parse(text);
        if(credential){
          const stack=[message];let visited=0;
          while(stack.length){
            if(++visited>4096)throw Error('structure');
            const value=stack.pop();
            if(typeof value==='string'&&value.includes(credential))throw Error('credential');
            if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
              if(key.includes(credential))throw Error('credential');stack.push(item);
            }
          }
        }
        if(!message||Array.isArray(message)||message.jsonrpc!=='2.0')throw Error('message');
        if(typeof message.method==='string'){
          if(Object.hasOwn(message,'id')){
            if(!['string','number'].includes(typeof message.id))throw Error('id');
            void write({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Unsupported client capability'}}).catch(()=>fail('protocol_error'));
          }else if(message.method==='notifications/tools/list_changed')fail('schema_changed');
          else if(!['notifications/message','notifications/progress'].includes(message.method))throw Error('notification');
          continue;
        }
        const request=requests.get(message.id);
        if(!request||Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw Error('response');
        clearTimeout(request.timer);requests.delete(message.id);
        if(Object.hasOwn(message,'error'))request.reject(Error('remote_error'));
        else request.resolve(message.result);
      }catch{fail('protocol_error');return;}
    }
    if(pending.length>65536)fail('output_limit');
  });
  child.stdout.on('end',()=>fail('process_failed'));
  child.stdout.on('error',()=>fail('process_failed'));
  return {
    request:async(method,params)=>{
      if(!['initialize','tools/list','tools/call'].includes(method)||requests.size||closed)throw Error('protocol');
      const id=nextId++;
      const result=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{requests.delete(id);reject(Error('timeout'));fail('timeout');},10000);
        requests.set(id,{resolve,reject,timer});
      });
      // Attach rejection before awaiting write to avoid unhandled rejection.
      void result.catch(()=>{});
      try{await write({jsonrpc:'2.0',id,method,params});return await result;}
      catch{fail('protocol_error');throw Error('protocol');}
    },
    initialized:()=>write({jsonrpc:'2.0',method:'notifications/initialized'}),
    close:()=>{closed=true;rejectAll();child.stdin.end();},
  };
};
`;
