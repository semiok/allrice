/** Trusted staging manifests are produced outside the container. Reassembly
 * verifies actual bytes before pnpm/uv or any project code may see an archive. */
export const nodeProjectArchiveAssembly = String.raw`
async function assembleArchives(){
 if(a.assemblies?.length){
  try{await mkdir(root+'/.allrice/archives',{mode:0o755});}catch(e){if(e.code!=='EEXIST')throw e;}
  const directory=await lstat(root+'/.allrice/archives');if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('archive directory invalid');
 }
 for(const file of a.assemblies||[]){
  if(!/^\.allrice\/archives\/[A-Za-z0-9._+-]+$/.test(file.path)||!Number.isSafeInteger(file.size)||file.size<1||file.size>64000000||!Array.isArray(file.parts)||!file.parts.length||file.parts.length>4||!/^[a-f0-9]{64}$/.test(file.checksum))throw Error('archive manifest invalid');
  const hash=createHash('sha256');let size=0;
  const target=await open(root+'/'+file.path,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o444);
  try{for(const part of file.parts){
   if(!/^\.allrice\/staging\/\d+-\d+\.part$/.test(part))throw Error('archive manifest invalid');
   const source=await open(root+'/'+part,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK);
   try{const stat=await source.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>20000000)throw Error('archive chunk invalid');
    const buffer=Buffer.alloc(1048576);let count=0;
    for(;;){const {bytesRead}=await source.read(buffer);if(!bytesRead)break;const bytes=buffer.subarray(0,bytesRead);size+=bytesRead;count+=bytesRead;if(size>file.size)throw Error('archive size mismatch');hash.update(bytes);let written=0;while(written<bytes.length){const next=await target.write(bytes,written,bytes.length-written);if(!next.bytesWritten)throw Error('archive write failed');written+=next.bytesWritten;}}
    if(count!==stat.size)throw Error('archive chunk changed');
   }finally{await source.close();}
  }}finally{await target.close();}
  if(size!==file.size||hash.digest('hex')!==file.checksum)throw Error('archive integrity mismatch');
  for(const part of file.parts)await unlink(root+'/'+part);
 }
}
`;

export const pythonProjectArchiveAssembly = String.raw`
def assemble_archives():
    if a.get('assemblies'):
        try:os.mkdir(ROOT+'/.allrice/archives',0o755)
        except FileExistsError:pass
        directory=os.lstat(ROOT+'/.allrice/archives')
        if not stat.S_ISDIR(directory.st_mode):raise RuntimeError('archive directory invalid')
    for entry in a.get('assemblies',[]):
        if not re.fullmatch(r'\.allrice/archives/[A-Za-z0-9._+-]+',entry['path']) or not isinstance(entry['size'],int) or not 0<entry['size']<=64000000 or not isinstance(entry['parts'],list) or not 0<len(entry['parts'])<=4 or not re.fullmatch(r'[a-f0-9]{64}',entry['checksum']):raise RuntimeError('archive manifest invalid')
        digest=hashlib.sha256();size=0
        target=os.open(ROOT+'/'+entry['path'],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444)
        with os.fdopen(target,'wb') as output:
            for part in entry['parts']:
                if not re.fullmatch(r'\.allrice/staging/\d+-\d+\.part',part):raise RuntimeError('archive manifest invalid')
                source=os.open(ROOT+'/'+part,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                with os.fdopen(source,'rb') as stream:
                    st=os.fstat(stream.fileno())
                    if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_size>20000000:raise RuntimeError('archive chunk invalid')
                    count=0
                    while True:
                        chunk=stream.read(1048576)
                        if not chunk:break
                        size+=len(chunk);count+=len(chunk)
                        if size>entry['size']:raise RuntimeError('archive size mismatch')
                        digest.update(chunk);output.write(chunk)
                    if count!=st.st_size:raise RuntimeError('archive chunk changed')
        if size!=entry['size'] or digest.hexdigest()!=entry['checksum']:raise RuntimeError('archive integrity mismatch')
        for part in entry['parts']:os.unlink(ROOT+'/'+part)
`;
