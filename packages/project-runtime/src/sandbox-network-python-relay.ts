/** Fixed standard-library helper for the managed Python image. Like the Node
 * helper it listens only on container loopback and moves bytes over private
 * Docker exec stdio. It never resolves or connects to an external destination;
 * the shared host-side SandboxNetworkSession retains all network authority. */
export const sandboxNetworkPythonRelay = String.raw`
import asyncio,base64,json,math,os,re,stat,sys,time

def runtime_ready():
    if len(sys.argv)<4 or sys.argv[3]!='project-runtime-v1':return True
    fd=None
    try:
        for path in ['/tmp/work','/tmp/work/.allrice']:
            s=os.lstat(path)
            if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:return False
        fd=os.open('/tmp/work/.allrice/network-runtime-ready',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_nlink!=1 or s.st_size!=5 or s.st_mode&0o222:return False
        return os.read(fd,6)==b'ready'
    except OSError:return False
    finally:
        if fd is not None:os.close(fd)

class Relay:
    def __init__(self,output):
        self.output=output
        self.peers={}
        self.sequence=0
        self.stopped=asyncio.Event()
        self.tasks=set()

    def task(self,coroutine):
        task=asyncio.create_task(coroutine)
        self.tasks.add(task)
        def finished(task):
            self.tasks.discard(task)
            if not task.cancelled() and task.exception() is not None:self.stopped.set()
        task.add_done_callback(finished)

    def send(self,value):
        if self.stopped.is_set():return
        if self.output.transport.get_write_buffer_size()>1048576:
            self.stopped.set()
            return
        self.output.write((json.dumps(value,separators=(',',':'))+'\n').encode('ascii'))

    def close(self,id):
        peer=self.peers.pop(id,None)
        if peer is None:return
        peer['writer'].transport.abort()
        for key in ['opened','ack']:
            future=peer.get(key)
            if future is not None and not future.done():future.cancel()
        self.send({'type':'close','id':id})

    async def reject(self,id,code):
        peer=self.peers.get(id)
        if peer is None:return
        status='403 Forbidden' if code in ['SANDBOX_NETWORK_DENIED','SANDBOX_NETWORK_PROTOCOL'] else '502 Bad Gateway'
        try:
            peer['writer'].write(('HTTP/1.1 '+status+'\r\nContent-Length: 0\r\nConnection: close\r\n\r\n').encode('ascii'))
            await peer['writer'].drain()
        except (OSError,ConnectionError):pass
        finally:self.close(id)

    async def forward(self,id,data):
        peer=self.peers.get(id)
        if peer is None:return
        # Exactly one unacknowledged frame per socket, shared with the Node
        # protocol. Reading pauses until that frame has reached the host.
        for offset in range(0,len(data),16384):
            if self.peers.get(id) is not peer:return
            peer['ack']=asyncio.get_running_loop().create_future()
            self.send({'type':'data','id':id,'data':base64.b64encode(data[offset:offset+16384]).decode('ascii')})
            await peer['ack']
            peer['ack']=None

    async def accepted(self,reader,writer):
        if len(self.peers)>=32 or self.sequence>=10000 or self.stopped.is_set():
            writer.close()
            return
        self.sequence+=1
        id=str(self.sequence)
        peer={'reader':reader,'writer':writer,'state':'header','opened':None,'ack':None,'writing':False,'remote_end':False}
        self.peers[id]=peer
        try:
            if not runtime_ready():
                await self.reject(id,'SANDBOX_NETWORK_DENIED')
                return
            try:header=await reader.readuntil(b'\r\n\r\n')
            except (asyncio.LimitOverrunError,asyncio.IncompleteReadError):return
            if len(header)>8192:return
            lines=header[:-4].split(b'\r\n')
            match=re.fullmatch(rb'CONNECT ([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):443 HTTP/1\.[01]',lines[0])
            if match is None or any(re.fullmatch(rb"[!#$%&'*+.^_\x60|~a-zA-Z0-9-]+:[\x20-\x7e]*",line) is None for line in lines[1:]):
                await self.reject(id,'SANDBOX_NETWORK_PROTOCOL')
                return
            peer['state']='opening'
            peer['opened']=asyncio.get_running_loop().create_future()
            self.send({'type':'open','id':id,'hostname':match[1].decode('ascii')})
            await peer['opened']
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            await writer.drain()
            while self.peers.get(id) is peer and not self.stopped.is_set():
                data=await reader.read(65536)
                if not data:
                    self.send({'type':'end','id':id})
                    return
                await self.forward(id,data)
        except (OSError,ConnectionError):pass
        finally:self.close(id)

    async def deliver(self,id,peer,data):
        try:
            peer['writer'].write(data)
            await peer['writer'].drain()
            if self.peers.get(id) is peer:
                peer['writing']=False
                self.send({'type':'ack','id':id})
                if peer['remote_end']:peer['writer'].write_eof()
        except (OSError,ConnectionError):self.close(id)

    async def control(self,reader):
        try:
            while not self.stopped.is_set():
                line=await reader.readline()
                if not line:return
                if len(line)>50000 or not line.endswith(b'\n'):raise ValueError('frame')
                value=json.loads(line)
                if not isinstance(value,dict) or not isinstance(value.get('id'),str):raise ValueError('frame')
                id=value['id'];peer=self.peers.get(id)
                if peer is None:continue
                kind=value.get('type')
                if kind=='opened' and peer['state']=='opening':
                    peer['state']='stream';peer['opened'].set_result(None)
                elif kind=='ack' and peer.get('ack') is not None and not peer['ack'].done():peer['ack'].set_result(None)
                elif kind=='data' and peer['state']=='stream' and not peer['writing'] and not peer['remote_end']:
                    text=value.get('data')
                    if not isinstance(text,str) or len(text)>21848:raise ValueError('data')
                    data=base64.b64decode(text,validate=True)
                    if not data or len(data)>16384 or base64.b64encode(data).decode('ascii')!=text:raise ValueError('data')
                    peer['writing']=True;self.task(self.deliver(id,peer,data))
                elif kind=='end' and peer['state']=='stream' and not peer['remote_end']:
                    peer['remote_end']=True
                    if not peer['writing']:peer['writer'].write_eof()
                elif kind=='error' and peer['state']=='opening':
                    peer['state']='rejecting';self.task(self.reject(id,value.get('code')))
                elif kind in ['close','error']:self.close(id)
                else:raise ValueError('frame')
        except (OSError,ValueError,UnicodeError,asyncio.LimitOverrunError):pass
        finally:self.stopped.set()

async def main(port,deadline):
    loop=asyncio.get_running_loop()
    reader=asyncio.StreamReader(limit=50000)
    input_transport,_=await loop.connect_read_pipe(lambda:asyncio.StreamReaderProtocol(reader),sys.stdin.buffer)
    output_transport,protocol=await loop.connect_write_pipe(asyncio.streams.FlowControlMixin,sys.stdout.buffer)
    output=asyncio.StreamWriter(output_transport,protocol,None,loop)
    relay=Relay(output)
    timer=loop.call_later(max(0,(deadline-time.time()*1000)/1000),relay.stopped.set)
    server=None
    try:
        server=await asyncio.start_server(lambda r,w:relay.task(relay.accepted(r,w)),'127.0.0.1',port,limit=8192)
        relay.send({'type':'ready'})
        relay.task(relay.control(reader))
        await relay.stopped.wait()
    finally:
        relay.stopped.set();timer.cancel()
        # Stop accepted sockets before waiting for server closure. Newer Python
        # versions also wait for active connections; the opposite order would
        # retain them after authority/control loss.
        if server is not None:server.close()
        for id in list(relay.peers):relay.close(id)
        tasks=list(relay.tasks)
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        if server is not None:await server.wait_closed()
        input_transport.close();output.close()

try:
    port=int(sys.argv[1]);deadline=float(sys.argv[2]);now=time.time()*1000
    if not 1024<=port<=65535 or not math.isfinite(deadline) or not now<deadline<=now+3600000:raise ValueError('arguments')
    asyncio.run(main(port,deadline))
except (ValueError,OSError,IndexError):sys.exit(1)
`;
