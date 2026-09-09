import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  LocalPreviewTargetSchema,
  localPreviewUrlAllowed,
  localPreviewOrigin,
  type LocalPreviewTarget,
  type LocalPreviewErrorCode,
} from '@allrice/contracts';
import type { LocalCommandRunner } from './local-command-runner.js';

export class LocalPreviewError extends Error {
  constructor(readonly code: LocalPreviewErrorCode) {
    super(code);
  }
}
const maximumBody = 1_000_000;
export type LocalPreviewResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
};
export type LocalPreviewRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
};

/** Fixed trusted program; input comes over attach stdin, never argv/Env.
 * Only connects to the exact approved port in the existing service container.
 * It cannot resolve a hostname, follow redirects, open a host port or spawn. */
const relayProgram = String.raw`
const http=require('node:http');
let input=Buffer.alloc(0),accepted=false,sent=false;
const fail=()=>{if(!sent){sent=true;process.stdout.write(JSON.stringify({error:'request_unconfirmed'})+'\n',()=>process.exit(2));}};
const timer=setTimeout(fail,4500);
process.stdin.on('data',chunk=>{
  if(accepted)return;
  input=Buffer.concat([input,chunk]);
  if(input.length>1500000){fail();return;}
  const at=input.indexOf(10);if(at<0)return;
  accepted=true;process.stdin.pause();
  try {
    if(at!==input.length-1)throw Error();
    const value=JSON.parse(input.subarray(0,at).toString('utf8'));input.fill(0);
    if(!Number.isInteger(value.port)||value.port<1024||value.port>65535||
      !['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(value.method)||
      typeof value.path!=='string'||!value.path.startsWith('/')||value.path.length>4096||/[\r\n\0]/.test(value.path))throw Error();
    const body=Buffer.from(value.body,'base64');if(body.length>1000000)throw Error();
    const req=http.request({host:'127.0.0.1',port:value.port,path:value.path,method:value.method,
      headers:{...value.headers,'content-length':String(body.length),'connection':'close','accept-encoding':'identity'}},res=>{
      const chunks=[];let size=0;
      res.on('data',part=>{size+=part.length;if(size>1000000){res.destroy();fail();}else chunks.push(part);});
      res.on('error',fail);
      res.on('end',()=>{if(sent)return;sent=true;clearTimeout(timer);
        const output=Buffer.concat(chunks);process.stdout.write(JSON.stringify({nonce:value.nonce,status:res.statusCode,headers:res.rawHeaders,body:output.toString('base64')})+'\n',()=>{output.fill(0);process.exit(0);});});
    });
    req.on('error',fail);req.setTimeout(4000,()=>{req.destroy();fail();});req.end(body,()=>body.fill(0));
  }catch{fail();}
});
process.stdin.on('end',()=>{if(!accepted)fail();});
process.stdin.on('error',fail);
`;

/** At most one real HTTP request; an unknown write is never replayed. */
export class LocalPreviewRelay {
  private active = 0;
  constructor(private readonly runner: LocalCommandRunner) {}
  async fetch(
    raw: LocalPreviewTarget,
    input: LocalPreviewRequest,
    options: {
      assertCurrent: () => Promise<{ expiresAt: string }>;
      signal?: AbortSignal;
    },
  ): Promise<LocalPreviewResponse> {
    const target = LocalPreviewTargetSchema.parse(raw);
    if (this.active >= 4)
      throw new LocalPreviewError('LOCAL_PREVIEW_OUTPUT_LIMIT');
    if (
      !localPreviewUrlAllowed(target, input.url) ||
      !['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(
        input.method,
      ) ||
      (input.body?.length ?? 0) > maximumBody ||
      target.imageDigest !== this.runner.config.imageDigest
    )
      throw new LocalPreviewError('LOCAL_PREVIEW_REQUEST_INVALID');
    this.active++;
    try {
      await this.runner.preflight();
      const lease = await options.assertCurrent();
      const remaining =
        Math.min(
          Date.parse(target.hardDeadlineAt),
          Date.parse(lease.expiresAt),
          Date.now() + 5000,
        ) - Date.now();
      if (
        remaining < 500 ||
        !Number.isFinite(remaining) ||
        options.signal?.aborted
      )
        throw new LocalPreviewError('LOCAL_PREVIEW_LEASE_LOST');
      const container = await this.runner.api.json<{
        Id: string;
        Config: { Image: string; Labels: Record<string, string> };
        State: { Running: boolean };
        HostConfig: {
          NetworkMode: string;
          Binds: unknown;
          PortBindings: unknown;
          ReadonlyRootfs: boolean;
        };
      }>('GET', `/containers/${target.containerId}/json`, undefined, 2000);
      if (
        container.Id !== target.containerId ||
        container.Config.Image !== target.imageDigest ||
        container.Config.Labels['xyz.bplabs.allrice.attempt'] !==
          target.attemptId ||
        container.Config.Labels['xyz.bplabs.allrice.service'] !==
          target.processId ||
        container.Config.Labels['xyz.bplabs.allrice.backend'] !==
          'local-vm-container-v1' ||
        !container.State.Running ||
        container.HostConfig.NetworkMode !== 'none' ||
        !container.HostConfig.ReadonlyRootfs ||
        (Array.isArray(container.HostConfig.Binds) &&
          container.HostConfig.Binds.length > 0) ||
        (container.HostConfig.PortBindings &&
          Object.keys(container.HostConfig.PortBindings).length > 0)
      )
        throw new LocalPreviewError('LOCAL_PREVIEW_TARGET_DENIED');
      const headers: Record<string, string> = {
        host: new URL(localPreviewOrigin(target.endpointId)).host,
      };
      for (const name of [
        'accept',
        'accept-language',
        'content-type',
        'origin',
        'referer',
      ]) {
        const value = input.headers[name];
        if (value === undefined) continue;
        if (value.length > 8192 || /[\r\n\0]/.test(value))
          throw new LocalPreviewError('LOCAL_PREVIEW_REQUEST_INVALID');
        if (
          (name === 'origin' || name === 'referer') &&
          !localPreviewUrlAllowed(target, value)
        )
          throw new LocalPreviewError('LOCAL_PREVIEW_NETWORK_DENIED');
        headers[name] = value;
      }
      const created = await this.runner.api.json<{ Id: string }>(
        'POST',
        `/containers/${target.containerId}/exec`,
        {
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
          Privileged: false,
          User: '1000:1000',
          WorkingDir: '/tmp',
          Cmd: ['/usr/local/bin/node', '--eval', relayProgram],
        },
        2000,
      );
      if (!/^[a-f0-9]{64}$/.test(created.Id))
        throw new LocalPreviewError('LOCAL_PREVIEW_UNKNOWN');
      const fresh = await options.assertCurrent();
      const until = Math.min(
        Date.parse(target.hardDeadlineAt),
        Date.parse(fresh.expiresAt),
        Date.now() + 5000,
      );
      if (until <= Date.now() + 250 || options.signal?.aborted)
        throw new LocalPreviewError('LOCAL_PREVIEW_LEASE_LOST');
      const parsed = new URL(input.url),
        nonce = randomUUID();
      const wire = Buffer.from(
        JSON.stringify({
          nonce,
          port: target.port,
          path: parsed.pathname + parsed.search,
          method: input.method,
          headers,
          body: (input.body ?? Buffer.alloc(0)).toString('base64'),
        }) + '\n',
      );
      let output: Buffer;
      try {
        output = await this.execute(created.Id, wire, until, options.signal);
      } finally {
        wire.fill(0);
      }
      try {
        const response = JSON.parse(output.toString('utf8')) as {
          nonce: string;
          status: number;
          headers: string[];
          body: string;
        };
        if (
          response.nonce !== nonce ||
          !Number.isInteger(response.status) ||
          response.status < 200 ||
          response.status > 599 ||
          !Array.isArray(response.headers) ||
          response.headers.length % 2 ||
          response.headers.length > 200 ||
          typeof response.body !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            response.body,
          )
        )
          throw new LocalPreviewError('LOCAL_PREVIEW_UNKNOWN');
        const bytes = Buffer.from(response.body, 'base64');
        if (bytes.length > maximumBody)
          throw new LocalPreviewError('LOCAL_PREVIEW_OUTPUT_LIMIT');
        const safeHeaders: Record<string, string> = {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          // Preserve the dedicated origin for same-origin form POSTs. Chrome
          // can serialize Origin as "null" under no-referrer; that must not be
          // mistaken for permission to accept an opaque/foreign origin.
          'referrer-policy': 'same-origin',
        };
        for (let i = 0; i < response.headers.length; i += 2) {
          const name = response.headers[i]?.toLowerCase(),
            value = response.headers[i + 1];
          if (
            typeof name !== 'string' ||
            typeof value !== 'string' ||
            value.length > 8192 ||
            /[\r\n\0]/.test(value)
          )
            throw new LocalPreviewError('LOCAL_PREVIEW_UNKNOWN');
          if (name === 'content-encoding' && value.toLowerCase() !== 'identity')
            throw new LocalPreviewError('LOCAL_PREVIEW_OUTPUT_LIMIT');
          if (
            [
              'content-type',
              'content-language',
              'content-disposition',
              'etag',
              'last-modified',
            ].includes(name)
          )
            safeHeaders[name] = value;
          // Redirect remains inside the exact dedicated virtual origin; never
          // follow or transform a project-provided external/loopback URL.
          if (name === 'location') {
            const redirect = new URL(value, input.url).href;
            if (!localPreviewUrlAllowed(target, redirect))
              throw new LocalPreviewError('LOCAL_PREVIEW_NETWORK_DENIED');
            safeHeaders.location = redirect;
          }
        }
        // This first preview has no login persistence, cookie relay or service
        // worker support. Main SaaS cookies/Authorization are never forwarded.
        await options.assertCurrent();
        return { status: response.status, headers: safeHeaders, body: bytes };
      } finally {
        output.fill(0);
      }
    } finally {
      this.active--;
    }
  }
  private execute(
    id: string,
    input: Buffer,
    until: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let socket: Duplex | undefined,
        buffer = Buffer.alloc(0),
        total = 0,
        done = false;
      const chunks: Buffer[] = [];
      const finish = (error?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          socket?.destroy();
          req.destroy();
          for (const b of chunks) b.fill(0);
          reject(new LocalPreviewError('LOCAL_PREVIEW_UNKNOWN'));
        } else if (buffer.length)
          reject(new LocalPreviewError('LOCAL_PREVIEW_UNKNOWN'));
        else resolve(Buffer.concat(chunks));
      };
      const abort = () => finish(new Error());
      const req = request({
        socketPath: this.runner.config.socketPath,
        path: `/v1.45/exec/${id}/start`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'Upgrade',
          upgrade: 'tcp',
        },
      });
      const timer = setTimeout(abort, Math.max(1, until - Date.now()));
      signal?.addEventListener('abort', abort, { once: true });
      const receive = (chunk: Buffer) => {
        total += chunk.length;
        if (total > 1_500_000) {
          abort();
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 8) {
          const size = buffer.readUInt32BE(4);
          if (
            buffer[0] !== 1 ||
            buffer.readUIntBE(1, 3) !== 0 ||
            size > 1_400_000
          ) {
            abort();
            return;
          }
          if (buffer.length < 8 + size) return;
          chunks.push(Buffer.from(buffer.subarray(8, 8 + size)));
          buffer = buffer.subarray(8 + size);
        }
      };
      req.once('upgrade', (res, stream, head) => {
        if (res.statusCode !== 101) {
          stream.destroy();
          abort();
          return;
        }
        socket = stream;
        stream.on('data', receive);
        stream.once('end', () => finish());
        stream.once('error', abort);
        if (head.length) receive(head);
        if (!done)
          stream.write(input, (error) => {
            if (error) abort();
          });
      });
      req.once('response', (res) => {
        res.destroy();
        abort();
      });
      req.once('error', abort);
      if (signal?.aborted) {
        abort();
        return;
      }
      req.end(JSON.stringify({ Detach: false, Tty: false }));
    });
  }
}
