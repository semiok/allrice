import { request } from 'node:http';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Duplex } from 'node:stream';
import {
  cloudToolchainImageV1,
  CloudCommandSchema,
  type CloudCommand,
} from '@allrice/contracts';

export class CloudRunnerError extends Error {}
export type CloudRunResult = {
  containerId: string;
  exitCode: number | null;
  stopped: boolean;
  reason:
    | 'completed'
    | 'canceled'
    | 'deadline'
    | 'output_limit'
    | 'oom'
    | 'failed'
    | 'unknown';
  output: string;
  artifacts: { path: string; contentBase64: string }[];
  elapsedMs: number;
};
type Container = {
  Id: string;
  Config: { Labels: Record<string, string> };
  HostConfig: { Runtime: string };
  State: {
    Running: boolean;
    ExitCode: number;
    OOMKilled: boolean;
    Status: string;
  };
};
const attemptLabel = 'xyz.bplabs.allrice.cloud.attempt';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** The sandbox never receives host env/credentials. Output is untrusted data,
 * not a command or proof of success; Docker's stopped/exit state is authoritative.
 * Bounded artifact bytes are retained in daemon logs until durable publication. */
export const cloudSupervisor = String.raw`
import fs from 'node:fs'; import cp from 'node:child_process';
const input=await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{text+=chunk;if(text.length>4_000_000)process.exit(126);const end=text.indexOf('\n');if(end>=0){process.stdin.pause();try{resolve(JSON.parse(text.slice(0,end)))}catch(e){reject(e)}}});setTimeout(()=>process.exit(124),65000).unref()});
fs.mkdirSync('/tmp/work/input',{recursive:true}); fs.mkdirSync('/tmp/work/output');
for(const file of input.files){ const p='/tmp/work/input/'+file.path; fs.mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true}); fs.writeFileSync(p,Buffer.from(file.contentBase64,'base64'),{mode:0o400}); }
fs.writeFileSync('/tmp/work/main.mjs',input.script,{mode:0o400});
const child=cp.spawn('/usr/local/bin/node',['/tmp/work/main.mjs'],{cwd:'/tmp/work',env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:'/tmp/work',TMPDIR:'/tmp'},stdio:['ignore','pipe','pipe']});
let bytes=0,overflow=false;
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{ bytes+=chunk.length; if(bytes>input.outputBytes){overflow=true; child.kill('SIGKILL');}else console.log(JSON.stringify({type:'output',data:chunk.toString('base64')})); });
const timer=setTimeout(()=>{child.kill('SIGKILL');process.exit(124)},Math.max(1,input.deadline-Date.now()));
child.on('error',()=>process.exit(125));
child.on('close',code=>{try{ let total=0; if(!overflow&&code===0)for(const file of input.outputs){ const p='/tmp/work/output/'+file.path; const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>input.artifactBytes)throw Error('artifact');const real=fs.realpathSync(p);if(!real.startsWith('/tmp/work/output/'))throw Error('path');const b=fs.readFileSync(p);total+=b.length;if(total>input.artifactBytes)throw Error('limit');console.log(JSON.stringify({type:'artifact',path:file.path,data:b.toString('base64')})); } clearTimeout(timer); process.exit(overflow?122:(code??125));}catch{process.exit(123)}});
`;

function redact(text: string) {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[REDACTED]',
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      '$1[REDACTED]',
    );
}

export class CloudRunnerBackend {
  constructor(
    readonly socketPath = join(
      homedir(),
      '.colima/allrice-cloud-b4/docker.sock',
    ),
  ) {
    if (socketPath !== join(homedir(), '.colima/allrice-cloud-b4/docker.sock'))
      throw new CloudRunnerError('CLOUD_DEDICATED_BACKEND_REQUIRED');
  }
  async call(method: string, path: string, body?: unknown): Promise<Buffer> {
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if ((bytes?.length ?? 0) > 6_000_000)
      throw new CloudRunnerError('CLOUD_INPUT_LIMIT');
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: `/v1.45${path}`,
          method,
          headers: bytes
            ? {
                'Content-Type': 'application/json',
                'Content-Length': bytes.length,
              }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 8_000_000)
              req.destroy(new CloudRunnerError('CLOUD_RESPONSE_LIMIT'));
            else chunks.push(chunk);
          });
          res.once('error', reject);
          res.once('end', () =>
            res.statusCode && res.statusCode >= 200 && res.statusCode < 300
              ? resolve(Buffer.concat(chunks))
              : reject(new CloudRunnerError(`CLOUD_DAEMON_${res.statusCode}`)),
          );
        },
      );
      const timer = setTimeout(
        () => req.destroy(new CloudRunnerError('CLOUD_DAEMON_TIMEOUT')),
        15_000,
      );
      req.once('close', () => clearTimeout(timer));
      req.once('error', reject);
      req.end(bytes);
    });
  }
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const data = await this.call(method, path, body);
    return data.length ? (JSON.parse(data.toString()) as T) : (null as T);
  }
  async preflight() {
    const stat = await lstat(await realpath(this.socketPath));
    if (!stat.isSocket() || stat.uid !== process.getuid?.())
      throw new CloudRunnerError('CLOUD_UNSAFE_SOCKET');
    const info = await this.json<{
      OSType: string;
      Architecture: string;
      CgroupVersion: string;
      MemoryLimit: boolean;
      SwapLimit: boolean;
      PidsLimit: boolean;
      CpuCfsQuota: boolean;
      SecurityOptions: string[];
      Runtimes: Record<string, { path: string }>;
    }>('GET', '/info');
    if (
      info.OSType !== 'linux' ||
      !['x86_64', 'amd64'].includes(info.Architecture) ||
      info.CgroupVersion !== '2' ||
      !info.MemoryLimit ||
      !info.SwapLimit ||
      !info.PidsLimit ||
      !info.CpuCfsQuota ||
      !info.SecurityOptions.some((v) => v.startsWith('name=seccomp')) ||
      info.Runtimes.runsc?.path !== '/usr/local/bin/runsc'
    )
      throw new CloudRunnerError('CLOUD_GVISOR_UNAVAILABLE');
    const image = await this.json<{
      Id: string;
      Os: string;
      Architecture: string;
    }>('GET', `/images/${cloudToolchainImageV1}/json`);
    if (
      image.Id !== cloudToolchainImageV1 ||
      image.Os !== 'linux' ||
      image.Architecture !== 'amd64'
    )
      throw new CloudRunnerError('CLOUD_TOOLCHAIN_CHANGED');
    // This is fixed trusted infrastructure attestation, never tenant-selected CLI.
    // The independent VM watchdog bounds execution even if Worker dies or the
    // tenant SIGSTOPs its in-container parent. No host credentials are copied in.
    const { stdout } = await promisify(execFile)(
      '/usr/local/bin/colima',
      [
        'ssh',
        '--profile',
        'allrice-cloud-b4',
        '--',
        'sudo',
        '/usr/local/lib/allrice-cloud/watchdog.py',
        '--attest',
      ],
      {
        timeout: 5000,
        maxBuffer: 4096,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir() },
      },
    );
    const attestation = JSON.parse(stdout);
    if (
      attestation.ready !== true ||
      attestation.runtimeChecksum !==
        '1a4995a70b3c8b7d36f55d7d2dc6d15185ebe420de653b1a330b42d36c0e6b4a'
    )
      throw new CloudRunnerError('CLOUD_WATCHDOG_UNAVAILABLE');
    return {
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      architecture: 'amd64',
      imageDigest: image.Id,
    } as const;
  }
  private async attachInput(containerId: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.socketPath,
        path: `/v1.45/containers/${containerId}/attach?stream=1&stdin=1&stdout=0&stderr=0`,
        method: 'POST',
        headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
      });
      const timer = setTimeout(
        () => req.destroy(new CloudRunnerError('CLOUD_STDIN_TIMEOUT')),
        5000,
      );
      req.once('upgrade', (_res, socket) => {
        clearTimeout(timer);
        socket.on('error', () => {});
        resolve(socket);
      });
      req.once('response', (res) => {
        clearTimeout(timer);
        res.resume();
        reject(new CloudRunnerError('CLOUD_STDIN_UNAVAILABLE'));
      });
      req.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.end();
    });
  }
  async inspect(attemptId: string): Promise<Container | null> {
    if (!uuid.test(attemptId))
      throw new CloudRunnerError('CLOUD_INVALID_ATTEMPT');
    try {
      const c = await this.json<Container>(
        'GET',
        `/containers/allrice-cloud-${attemptId}/json`,
      );
      if (
        c.Config.Labels[attemptLabel] !== attemptId ||
        c.HostConfig.Runtime !== 'runsc'
      )
        throw new CloudRunnerError('CLOUD_CONTAINER_IDENTITY_CHANGED');
      return c;
    } catch (e) {
      if (e instanceof Error && e.message === 'CLOUD_DAEMON_404') return null;
      throw e;
    }
  }
  async cleanup(attemptId: string) {
    const c = await this.inspect(attemptId);
    if (!c) return;
    if (c.State.Running) throw new CloudRunnerError('CLOUD_NOT_STOPPED');
    await this.call('DELETE', `/containers/${c.Id}?v=true`);
    if (await this.inspect(attemptId))
      throw new CloudRunnerError('CLOUD_CLEANUP_UNCONFIRMED');
  }
  async stop(attemptId: string) {
    const c = await this.inspect(attemptId);
    if (!c) return false;
    if (c.State.Running)
      await this.call('POST', `/containers/${c.Id}/kill?signal=KILL`).catch(
        async (e) => {
          if ((await this.inspect(attemptId))?.State.Running) throw e;
        },
      );
    return (await this.inspect(attemptId))?.State.Running === false;
  }
  async collect(
    attemptId: string,
    command: CloudCommand,
    startedAt: number,
    reason: CloudRunResult['reason'] = 'completed',
  ): Promise<CloudRunResult> {
    const c = await this.inspect(attemptId);
    if (!c || c.State.Running)
      throw new CloudRunnerError('CLOUD_RESULT_UNKNOWN');
    const raw = await this.call(
      'GET',
      `/containers/${c.Id}/logs?stdout=1&stderr=1&follow=0`,
    );
    let at = 0,
      text = '';
    while (at < raw.length) {
      if (at + 8 > raw.length || ![1, 2].includes(raw[at]!))
        throw new CloudRunnerError('CLOUD_LOG_INVALID');
      const n = raw.readUInt32BE(at + 4);
      at += 8;
      if (n > 8_000_000 || at + n > raw.length)
        throw new CloudRunnerError('CLOUD_LOG_INVALID');
      text += raw.subarray(at, at + n).toString();
      at += n;
    }
    const output: Buffer[] = [];
    const artifacts: CloudRunResult['artifacts'] = [];
    let size = 0,
      artifactSize = 0;
    for (const line of text.split('\n').filter(Boolean)) {
      let v;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (v.type === 'output' && typeof v.data === 'string') {
        const b = Buffer.from(v.data, 'base64');
        size += b.length;
        if (size <= command.arguments.limits.outputBytes) output.push(b);
      }
      if (
        v.type === 'artifact' &&
        typeof v.path === 'string' &&
        typeof v.data === 'string'
      ) {
        if (
          !command.arguments.outputs.some((o) => o.path === v.path) ||
          artifacts.some((a) => a.path === v.path)
        )
          throw new CloudRunnerError('CLOUD_ARTIFACT_INVALID');
        artifactSize += Buffer.byteLength(v.data, 'base64');
        if (artifactSize > command.arguments.limits.artifactBytes)
          throw new CloudRunnerError('CLOUD_ARTIFACT_LIMIT');
        artifacts.push({ path: v.path, contentBase64: v.data });
      }
    }
    if (c.State.OOMKilled) reason = 'oom';
    else if (
      c.State.ExitCode === 122 ||
      size > command.arguments.limits.outputBytes
    )
      reason = 'output_limit';
    else if (c.State.ExitCode === 124) reason = 'deadline';
    else if (c.State.ExitCode !== 0 && reason === 'completed')
      reason = 'failed';
    if (
      reason === 'completed' &&
      artifacts.length !== command.arguments.outputs.length
    )
      reason = 'failed';
    return {
      containerId: c.Id,
      exitCode: c.State.ExitCode,
      stopped: true,
      reason,
      output: redact(Buffer.concat(output).toString()),
      artifacts: reason === 'completed' ? artifacts : [],
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
  }
  async execute(
    commandInput: CloudCommand,
    files: { path: string; contentBase64: string }[],
    options: {
      attemptId: string;
      deadlineAt: string;
      signal?: AbortSignal;
      maintainLease: () => Promise<boolean>;
      onCreated?: (id: string) => Promise<void>;
    },
  ): Promise<CloudRunResult> {
    const command = CloudCommandSchema.parse(commandInput),
      { attemptId } = options,
      startedAt = Date.now();
    if (!uuid.test(attemptId))
      throw new CloudRunnerError('CLOUD_INVALID_ATTEMPT');
    await this.preflight();
    if (await this.inspect(attemptId))
      throw new CloudRunnerError('CLOUD_RECOVERY_REQUIRED');
    let size = 0;
    for (const f of files) {
      const input = command.arguments.inputs.find((i) => i.path === f.path);
      const b = Buffer.from(f.contentBase64, 'base64');
      size += b.length;
      if (
        !input ||
        `sha256:${createHash('sha256').update(b).digest('hex')}` !==
          input.checksum
      )
        throw new CloudRunnerError('CLOUD_INPUT_CHANGED');
    }
    if (
      files.length !== command.arguments.inputs.length ||
      new Set(files.map((f) => f.path)).size !== files.length ||
      size > 2_000_000
    )
      throw new CloudRunnerError('CLOUD_INPUT_LIMIT');
    const deadline = Math.min(
      Date.parse(options.deadlineAt),
      startedAt + command.arguments.limits.timeoutMs,
    );
    if (
      !Number.isFinite(deadline) ||
      deadline <= Date.now() + 250 ||
      options.signal?.aborted ||
      !(await options.maintainLease())
    )
      throw new CloudRunnerError('CLOUD_EXECUTION_REVOKED');
    const limits = command.arguments.limits;
    const encoded =
      JSON.stringify({
        files,
        script: command.arguments.script,
        outputs: command.arguments.outputs,
        artifactBytes: limits.artifactBytes,
        outputBytes: limits.outputBytes,
        deadline,
      }) + '\n';
    const c = await this.json<{ Id: string }>(
      'POST',
      `/containers/create?name=allrice-cloud-${attemptId}`,
      {
        Image: cloudToolchainImageV1,
        Entrypoint: ['/usr/local/bin/node'],
        Cmd: ['--input-type=module', '--eval', cloudSupervisor],
        User: '65532:65532',
        WorkingDir: '/tmp',
        OpenStdin: true,
        StdinOnce: false,
        Tty: false,
        Env: [],
        Labels: {
          [attemptLabel]: attemptId,
          'xyz.bplabs.allrice.backend': 'cloud-gvisor-v1',
          'xyz.bplabs.allrice.cloud.deadline': String(deadline),
        },
        HostConfig: {
          Runtime: 'runsc',
          NetworkMode: 'none',
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          PidsLimit: limits.pids,
          Memory: limits.memoryMiB * 1024 * 1024,
          MemorySwap: limits.memoryMiB * 1024 * 1024,
          CpuPeriod: 100_000,
          CpuQuota: limits.cpuMillis * 100,
          Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=32m,mode=1777' },
          ShmSize: 8 * 1024 * 1024,
          LogConfig: {
            Type: 'json-file',
            Config: { 'max-size': '8m', 'max-file': '1' },
          },
          RestartPolicy: { Name: 'no' },
          AutoRemove: false,
          Ulimits: [
            { Name: 'nofile', Soft: 128, Hard: 128 },
            { Name: 'core', Soft: 0, Hard: 0 },
          ],
        },
      },
    );
    if (!/^[a-f0-9]{64}$/.test(c.Id))
      throw new CloudRunnerError('CLOUD_INVALID_CONTAINER');
    await options.onCreated?.(c.Id);
    if (options.signal?.aborted || !(await options.maintainLease()))
      throw new CloudRunnerError('CLOUD_EXECUTION_REVOKED');
    const stdin = await this.attachInput(c.Id);
    try {
      await this.call('POST', `/containers/${c.Id}/start`);
      await new Promise<void>((resolve, reject) =>
        stdin.write(encoded, (error) => (error ? reject(error) : resolve())),
      );
      let reason: CloudRunResult['reason'] = 'completed';
      while ((await this.inspect(attemptId))?.State.Running) {
        if (options.signal?.aborted) {
          reason = 'canceled';
          await this.stop(attemptId);
          break;
        }
        if (Date.now() >= deadline) {
          reason = 'deadline';
          await this.stop(attemptId);
          break;
        }
        let valid = false;
        try {
          valid = await options.maintainLease();
        } catch {
          /* An unreachable authority never extends execution. */
        }
        if (!valid) {
          reason = 'canceled';
          await this.stop(attemptId);
          break;
        }
        await delay(150);
      }
      return this.collect(attemptId, command, startedAt, reason);
    } finally {
      stdin.destroy();
    }
  }
}
