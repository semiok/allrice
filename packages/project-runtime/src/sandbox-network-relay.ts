/** Runs as an independent trusted Docker exec in the already isolated task.
 * The only listener is container loopback. All outbound bytes travel over this
 * exec's private stdin/stdout; network:none stays enforced by the runtime. */
export const sandboxNetworkRelay = String.raw`
const net=require('node:net');
const port=Number(process.argv[1]), deadline=Number(process.argv[2]);
const projectRuntime=process.argv[3]==='project-runtime-v1';
function runtimeReady(){
 if(!projectRuntime)return true;
 const fs=require('node:fs');let fd;
 try{
  for(const path of ['/tmp/work','/tmp/work/.allrice']){const s=fs.lstatSync(path);if(!s.isDirectory()||s.uid!==0||(s.mode&0o022)!==0)return false;}
  fd=fs.openSync('/tmp/work/.allrice/network-runtime-ready',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==0||s.nlink!==1||s.size!==5||(s.mode&0o222)!==0)return false;
  return fs.readFileSync(fd,'utf8')==='ready';
 }catch{return false;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
const connections=new Map();let sequence=0,buffer='',stopped=false;
const send=value=>{if(stopped)return;const line=JSON.stringify(value)+'\n';if(process.stdout.writableLength>1048576)return stop();process.stdout.write(line)};
function close(id){const c=connections.get(id);if(!c)return;connections.delete(id);c.socket.destroy();send({type:'close',id})}
// A rejected CONNECT needs a complete HTTP response. Abrupt EOF makes some
// proxy clients reconnect after their caller already handled the failure.
function reject(id,code){const c=connections.get(id);if(!c)return;connections.delete(id);const status=code==='SANDBOX_NETWORK_DENIED'||code==='SANDBOX_NETWORK_PROTOCOL'?'403 Forbidden':'502 Bad Gateway';c.socket.end('HTTP/1.1 '+status+'\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',()=>c.socket.destroy());send({type:'close',id})}
function stop(){if(stopped)return;stopped=true;for(const c of connections.values())c.socket.destroy();connections.clear();server.close();process.exit(0)}
function forward(id,bytes){const c=connections.get(id);if(!c||c.pending||bytes.length>65536)return close(id);c.pending=bytes;c.socket.pause();next(id)}
function next(id){const c=connections.get(id);if(!c||c.waiting||!c.pending)return;const chunk=c.pending.subarray(0,16384);c.pending=c.pending.subarray(chunk.length);c.waiting=true;send({type:'data',id,data:chunk.toString('base64')})}
const server=net.createServer(socket=>{
 if(connections.size>=32||sequence>=10000||stopped){socket.destroy();return}
 if(!runtimeReady()){socket.on('error',()=>{});socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',()=>socket.destroy());return}
 const id=String(++sequence),c={socket,header:Buffer.alloc(0),state:'header',pending:null,waiting:false};connections.set(id,c);
 socket.on('error',()=>close(id));socket.on('close',()=>close(id));socket.on('end',()=>send({type:'end',id}));
 socket.on('data',bytes=>{
  if(c.state==='stream')return forward(id,bytes);
  if(c.state!=='header')return close(id);
  c.header=Buffer.concat([c.header,bytes]);if(c.header.length>8192)return close(id);
  const end=c.header.indexOf('\r\n\r\n');if(end<0)return;
  const lines=c.header.subarray(0,end).toString('ascii').split('\r\n');
  const match=/^CONNECT ([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):443 HTTP\/1\.[01]$/.exec(lines[0]);
  if(!match||lines.slice(1).some(v=>! /^[!#$%&'*+.^_\x60|~a-zA-Z0-9-]+:[\x20-\x7e]*$/.test(v))){socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return}
  c.head=c.header.subarray(end+4);c.header=null;c.state='opening';socket.pause();send({type:'open',id,hostname:match[1]});
 });
});
process.stdin.setEncoding('utf8');process.stdin.on('data',text=>{
 buffer+=text;if(buffer.length>262144)return stop();
 let end;while((end=buffer.indexOf('\n'))>=0){if(end>50000)return stop();let value;try{value=JSON.parse(buffer.slice(0,end))}catch{return stop()}buffer=buffer.slice(end+1);
  const c=connections.get(value.id);if(!c)continue;
  if(value.type==='opened'&&c.state==='opening'){c.state='stream';c.socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(c.head.length)forward(value.id,c.head);else c.socket.resume();delete c.head}
  else if(value.type==='ack'&&c.waiting){c.waiting=false;if(c.pending.length)next(value.id);else{c.pending=null;c.socket.resume()}}
  else if(value.type==='data'&&typeof value.data==='string'&&value.data.length<=21848){const bytes=Buffer.from(value.data,'base64');if(bytes.toString('base64')!==value.data||!bytes.length)return stop();c.socket.write(bytes,()=>send({type:'ack',id:value.id}))}
  else if(value.type==='end')c.socket.end();
  else if(value.type==='error'&&c.state==='opening')reject(value.id,value.code);
  else if(value.type==='close'||value.type==='error')close(value.id);
  else return stop();
 }
});
process.stdin.once('end',stop);process.stdin.once('error',stop);process.stdout.once('error',stop);server.once('error',stop);
if(!Number.isInteger(port)||port<1024||port>65535||!Number.isFinite(deadline)||deadline<=Date.now()||deadline>Date.now()+3600000)process.exit(1);
setTimeout(stop,deadline-Date.now()).unref();
server.listen(port,'127.0.0.1',()=>send({type:'ready'}));
`;
