import { isAbsolute, posix } from 'node:path';
import { PersonVmError } from './contract.ts';

/** Host configuration only. The returned local DSH credential is never SaaS identity. */
export type PersonVmNativeWebAuthRequest = Readonly<{
  dshHome: string;
  nonce: string;
  origin: string;
  timeoutMs: number;
}>;
export type PersonVmNativeWebAuth = Readonly<{ authenticatedUrl: string }>;

export function nativeWebAuthArtifact(request: PersonVmNativeWebAuthRequest) {
  let origin: URL;
  try {
    origin = new URL(request.origin);
  } catch {
    throw new PersonVmError('PROVIDER_FAILED');
  }
  if (
    !isAbsolute(request.dshHome) ||
    request.dshHome === '/' ||
    posix.normalize(request.dshHome) !== request.dshHome ||
    request.dshHome.includes('\0') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      request.nonce,
    ) ||
    origin.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(origin.hostname) ||
    !origin.port ||
    origin.href !== `${origin.origin}/` ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0
  )
    throw new PersonVmError('PROVIDER_FAILED');
  // rc.2 BrowserAuth encodes 32 random bytes as unpadded base64url (43 bytes).
  const maxBytes =
    Buffer.byteLength(
      JSON.stringify({
        v: 1,
        nonce: request.nonce,
        authenticatedUrl: `${origin.origin}/?token=${'a'.repeat(43)}`,
      }),
    ) + 1;
  return Object.freeze({
    path: `${request.dshHome}/native-web/auth-${request.nonce}.json`,
    maxBytes,
  });
}

export function parseNativeWebAuth(
  text: string,
  request: PersonVmNativeWebAuthRequest,
): PersonVmNativeWebAuth {
  const { maxBytes } = nativeWebAuthArtifact(request);
  try {
    if (Buffer.byteLength(text) > maxBytes) throw new Error();
    const value = JSON.parse(text) as {
      v?: unknown;
      nonce?: unknown;
      authenticatedUrl?: unknown;
    };
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'authenticatedUrl,nonce,v' ||
      value.v !== 1 ||
      value.nonce !== request.nonce ||
      typeof value.authenticatedUrl !== 'string'
    )
      throw new Error();
    const url = new URL(value.authenticatedUrl);
    if (
      url.origin !== new URL(request.origin).origin ||
      url.pathname !== '/' ||
      url.hash ||
      url.username ||
      url.password ||
      [...url.searchParams.keys()].join(',') !== 'token' ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('token') ?? '')
    )
      throw new Error();
    return Object.freeze({ authenticatedUrl: url.href });
  } catch {
    throw new PersonVmError('PROVIDER_FAILED');
  } // Never retain secret input in errors.
}

/** Fixed short read, not an executor or a long-lived stdio transport. Watch before
 * checking so atomic publication cannot be lost; all reads have a strict byte cap. */
export const NATIVE_WEB_AUTH_READER = `
const fs=require('node:fs'),p=require('node:path');
const [file,limit]=process.argv.slice(1),max=Number(limit);
let done=false;
const watcher=fs.watch(p.dirname(file),read);
function read(){
 if(done)return;
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.size>max)throw Error('invalid artifact');
  const bytes=Buffer.alloc(max+1),n=fs.readSync(fd,bytes,0,max+1,0);
  if(n>max)throw Error('invalid artifact');
  done=true;watcher.close();process.stdout.write(bytes.subarray(0,n));
 }catch(e){if(e.code!=='ENOENT'){done=true;watcher.close();process.exitCode=1;}}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
read();
`;
