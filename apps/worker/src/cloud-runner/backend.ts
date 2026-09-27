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
  CloudCommandInputSchema,
  type CloudCommandInput,
  type CloudCommand,
} from '@allrice/contracts';
import type { ExecutionDiagnosticEvent } from '@allrice/database';
import { officeSandboxImage } from '../office/runtime.js';

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
const slotOwnerLabel = 'xyz.bplabs.allrice.cloud.slot-owner';
const slotDeadlineLabel = 'xyz.bplabs.allrice.cloud.slot-deadline';
let watchdogAttestation: Promise<{ stdout: string }> | undefined;
let attestationExpires = 0;

function attestWatchdog() {
  // Coalesce concurrent probes, then cache at most two seconds. Continuous
  // polling must not keep extending a stale watchdog/pressure attestation.
  if (Date.now() >= attestationExpires) watchdogAttestation = undefined;
  if (!watchdogAttestation) {
    attestationExpires = Infinity;
    const executable =
      process.platform === 'darwin' ? '/usr/local/bin/colima' : '/usr/bin/sudo';
    const args =
      process.platform === 'darwin'
        ? [
            'ssh',
            '--profile',
            process.env.ALLRICE_CLOUD_PROFILE ?? 'allrice-cloud-b4',
            '--',
            'sudo',
            '/usr/local/lib/allrice-cloud/watchdog.py',
            '--attest',
          ]
        : ['-n', '/usr/local/lib/allrice-cloud/watchdog.py', '--attest'];
    watchdogAttestation = (async () => {
      // A busy VM can briefly delay its heartbeat or SSH probe. These are
      // read-only checks before any script starts, so retry them together;
      // never reuse a failed/expired attestation or replay tenant execution.
      for (let attempt = 0; ; attempt++) {
        try {
          return await promisify(execFile)(executable, args, {
            timeout: 15000,
            maxBuffer: 4096,
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir() },
          });
        } catch (error) {
          if (attempt >= 2) throw error;
          console.error(
            JSON.stringify({
              event: 'cloud_watchdog_probe_retry',
              attempt: attempt + 1,
            }),
          );
          await delay(250);
        }
      }
    })()
      .then((result) => {
        attestationExpires = Date.now() + 2000;
        return result;
      })
      .catch(() => {
        watchdogAttestation = undefined;
        attestationExpires = 0;
        throw new CloudRunnerError('CLOUD_WATCHDOG_UNAVAILABLE');
      });
  }
  return watchdogAttestation;
}
function configuredSocket() {
  return (
    process.env.ALLRICE_CLOUD_DOCKER_SOCKET ??
    join(
      homedir(),
      `.colima/${process.env.ALLRICE_CLOUD_PROFILE ?? 'allrice-cloud-b4'}/docker.sock`,
    )
  );
}
/** The sandbox never receives host env/credentials. Output is untrusted data,
 * not a command or proof of success; Docker's stopped/exit state is authoritative.
 * Bounded artifact bytes are retained in daemon logs until durable publication. */
export const cloudSupervisor = String.raw`
import fs from 'node:fs'; import cp from 'node:child_process';
// Drain the pipe before exiting: Office artifacts can exceed one pipe buffer.
const finish=code=>process.stdout.write('',()=>process.exit(code));
const input=await new Promise((resolve,reject)=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{text+=chunk;if(text.length>32_000_000)process.exit(126);const end=text.indexOf('\n');if(end>=0){process.stdin.pause();try{resolve(JSON.parse(text.slice(0,end)))}catch(e){reject(e)}}});setTimeout(()=>process.exit(124),65000).unref()});
fs.mkdirSync('/tmp/work/input',{recursive:true}); fs.mkdirSync('/tmp/work/output');
for(const file of input.files){ const p='/tmp/work/input/'+file.path; fs.mkdirSync(p.slice(0,p.lastIndexOf('/')),{recursive:true}); fs.writeFileSync(p,Buffer.from(file.contentBase64,'base64'),{mode:0o400}); }
const main=input.office?'/tmp/work/main.py':'/tmp/work/main.mjs';
fs.writeFileSync(main,input.script,{mode:0o400});
const child=cp.spawn(input.office?'/opt/office/bin/python':'/usr/local/bin/node',[main],{cwd:'/tmp/work',env:{PATH:'/opt/office/bin:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',HOME:'/tmp/work',TMPDIR:'/tmp',PYTHONDONTWRITEBYTECODE:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'},stdio:['ignore','pipe','pipe']});
let bytes=0,overflow=false;
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{ bytes+=chunk.length; if(bytes>input.outputBytes){overflow=true; child.kill('SIGKILL');}else console.log(JSON.stringify({type:'output',data:chunk.toString('base64')})); });
const timer=setTimeout(()=>{child.kill('SIGKILL');process.exit(124)},Math.max(1,input.deadline-Date.now()));
child.on('error',()=>process.exit(125));
child.on('close',(code,signal)=>{try{
  if(code!==0)console.log(JSON.stringify({type:'output',data:Buffer.from('Script exited: code='+code+' signal='+(signal??'none')+'\n').toString('base64')}));
  let total=0;
  if(!overflow&&code===0)for(const file of input.outputs){
    const p='/tmp/work/output/'+file.path, s=fs.lstatSync(p);
    if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>input.artifactBytes)throw Error('artifact');
    if(!fs.realpathSync(p).startsWith('/tmp/work/output/'))throw Error('path');
    if(input.office){
      const check=cp.spawnSync('/opt/office/bin/python',['/opt/dsh-office/scripts/check_office.py',p],{timeout:Math.max(1,input.deadline-Date.now()),maxBuffer:input.outputBytes,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONDONTWRITEBYTECODE:'1'}});
      const report=Buffer.concat([check.stdout??Buffer.alloc(0),check.stderr??Buffer.alloc(0)]);
      console.log(JSON.stringify({type:'output',data:report.subarray(0,input.outputBytes-bytes).toString('base64')}));
      bytes+=report.length;
      if(check.status!==0||bytes>input.outputBytes)throw Error('office_check: exitCode='+check.status+' signal='+(check.signal??'none')+' error='+(check.error?.code??'none'));
    }
    const b=fs.readFileSync(p);total+=b.length;if(total>input.artifactBytes)throw Error('limit');
    console.log(JSON.stringify({type:'artifact',path:file.path,data:b.toString('base64')}));
  }
  clearTimeout(timer);finish(overflow?122:(code??125));
}catch(error){clearTimeout(timer);console.log(JSON.stringify({type:'output',data:Buffer.from('Sandbox output validation failed: '+String(error.message).slice(0,1000)+'\n').toString('base64')}));finish(123)}});
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
  constructor(readonly socketPath = configuredSocket()) {
    if (socketPath !== configuredSocket() || !socketPath.startsWith('/'))
      throw new CloudRunnerError('CLOUD_DEDICATED_BACKEND_REQUIRED');
  }
  async call(method: string, path: string, body?: unknown): Promise<Buffer> {
    const bytes =
      body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if ((bytes?.length ?? 0) > 32_000_000)
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
            if (size > 12_000_000)
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
  async preflight(imageDigest = cloudToolchainImageV1) {
    if (![cloudToolchainImageV1, officeSandboxImage].includes(imageDigest))
      throw new CloudRunnerError('CLOUD_TOOLCHAIN_CHANGED');
    const stat = await lstat(await realpath(this.socketPath));
    if (
      !stat.isSocket() ||
      (stat.uid !== process.getuid?.() &&
        !(
          process.platform === 'linux' &&
          stat.uid === 0 &&
          process.env.ALLRICE_CLOUD_DOCKER_SOCKET === this.socketPath
        ))
    )
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
    }>('GET', `/images/${imageDigest}/json`);
    if (
      image.Id !== imageDigest ||
      image.Os !== 'linux' ||
      image.Architecture !== 'amd64'
    )
      throw new CloudRunnerError('CLOUD_TOOLCHAIN_CHANGED');
    // This is fixed trusted infrastructure attestation, never tenant-selected CLI.
    // The independent VM watchdog bounds execution even if Worker dies or the
    // tenant SIGSTOPs its in-container parent. No host credentials are copied in.
    const { stdout } = await attestWatchdog();
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
  async capacity() {
    const { stdout } = await attestWatchdog();
    const report = JSON.parse(stdout);
    const c = report.capacity;
    if (
      !report.ready ||
      c?.version !== 2 ||
      !Number.isInteger(c.slots) ||
      c.slots < 0 ||
      c.slots > 32 ||
      typeof c.backendId !== 'string' ||
      !Number.isFinite(report.availableBytes)
    )
      throw new CloudRunnerError('CLOUD_CAPACITY_UNAVAILABLE');
    return { ...c, availableBytes: report.availableBytes } as {
      slots: number;
      backendId: string;
      availableBytes: number;
    };
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
    command: Pick<CloudCommand, 'arguments'>,
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
      if (n > 12_000_000 || at + n > raw.length)
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
      isTurn?: () => Promise<boolean>;
      observe?: (event: ExecutionDiagnosticEvent) => Promise<void>;
    },
  ): Promise<CloudRunResult> {
    const command = CloudCommandSchema.parse(commandInput);
    return this.executeScript(command.arguments, files, options, false);
  }

  /** Managed Office export reuses the same isolated execution lifecycle. Its
   * only effect is returned document bytes; the existing export broker owns
   * file authorization/publication. No cloud grant or host shell is exposed. */
  async executeOffice(
    args: CloudCommandInput,
    files: { path: string; contentBase64: string }[],
    options: Parameters<CloudRunnerBackend['execute']>[2],
  ) {
    const parsed = CloudCommandInputSchema.parse(args);
    parsed.limits.artifactBytes = 8_000_000;
    return this.executeScript(parsed, files, options, true);
  }

  private async executeScript(
    args: CloudCommandInput,
    files: { path: string; contentBase64: string }[],
    options: Parameters<CloudRunnerBackend['execute']>[2],
    office: boolean,
  ): Promise<CloudRunResult> {
    const queuedAt = Date.now();
    await options.observe?.({ stage: 'queued', reason: 'sandbox_capacity' });
    let reservation:
      | { release: () => Promise<void>; valid: () => Promise<boolean> }
      | undefined;
    try {
      reservation = await this.acquireSlot(
        options,
        office ? officeSandboxImage : cloudToolchainImageV1,
        (args.limits.memoryMiB + 128) * 1024 ** 2,
      );
      await options.observe?.({
        stage: 'acquired',
        waitMs: Date.now() - queuedAt,
      });
      const result = await this.executeAdmittedScript(
        args,
        files,
        {
          ...options,
          maintainLease: async () =>
            (await reservation!.valid()) && options.maintainLease(),
        },
        office,
      );
      await options.observe?.({
        stage:
          result.reason === 'completed'
            ? 'completed'
            : result.reason === 'canceled'
              ? 'canceled'
              : result.reason === 'unknown'
                ? 'unknown'
                : 'failed',
        elapsedMs: result.elapsedMs,
        ...(result.reason === 'completed' ? {} : { errorCode: result.reason }),
      });
      return result;
    } catch (error) {
      await options
        .observe?.({
          stage: options.signal?.aborted ? 'canceled' : 'failed',
          errorCode:
            error instanceof CloudRunnerError
              ? error.message
              : 'CLOUD_EXECUTION_ERROR',
        })
        .catch(() => undefined);
      throw error;
    } finally {
      // Uncertain/live executions keep their reservation until physically stopped.
      if (
        reservation &&
        !(await this.inspect(options.attemptId))?.State.Running
      )
        await reservation.release();
    }
  }

  /** Docker names are atomic across Worker processes and databases sharing this
   * dedicated VM. Stopped containers reserve the watchdog's detected slots;
   * they never execute code. Expired reservations need physical stop evidence. */
  private async acquireSlot(
    options: Parameters<CloudRunnerBackend['execute']>[2],
    imageDigest: string,
    minimumMemoryBytes: number,
  ) {
    if (!uuid.test(options.attemptId))
      throw new CloudRunnerError('CLOUD_INVALID_ATTEMPT');
    const deadline = Date.parse(options.deadlineAt);
    let lastReason = '';
    while (Number.isFinite(deadline) && Date.now() < deadline) {
      if (options.signal?.aborted || !(await options.maintainLease()))
        throw new CloudRunnerError('CLOUD_EXECUTION_REVOKED');
      const capacity = await this.capacity();
      if (capacity.slots === 0)
        throw new CloudRunnerError('CLOUD_NODE_RESOURCES_INSUFFICIENT');
      const reason =
        capacity.availableBytes < minimumMemoryBytes
          ? 'memory_pressure'
          : options.isTurn && !(await options.isTurn())
            ? 'fair_queue'
            : 'sandbox_capacity';
      if (reason !== lastReason) {
        await options.observe?.({
          stage: 'waiting',
          reason,
          backendId: capacity.backendId,
          capacity: capacity.slots,
        });
        lastReason = reason;
      }
      if (reason !== 'sandbox_capacity') {
        await delay(500);
        continue;
      }
      for (let slot = 0; slot < capacity.slots; slot++) {
        const name = `allrice-cloud-slot-${slot}`;
        try {
          const c = await this.json<{ Id: string }>(
            'POST',
            `/containers/create?name=${name}`,
            {
              Image: imageDigest,
              Entrypoint: ['/usr/local/bin/node'],
              Cmd: ['--version'],
              NetworkDisabled: true,
              Labels: {
                [slotOwnerLabel]: options.attemptId,
                [slotDeadlineLabel]: String(
                  Math.min(deadline, Date.now() + 90_000),
                ),
              },
              HostConfig: {
                NetworkMode: 'none',
                ReadonlyRootfs: true,
                AutoRemove: false,
              },
            },
          );
          if (!/^[a-f0-9]{64}$/.test(c.Id))
            throw new CloudRunnerError('CLOUD_INVALID_CONTAINER');
          return {
            release: async () => {
              await this.call('DELETE', `/containers/${c.Id}?v=true`).catch(
                (error) => {
                  if (
                    !(error instanceof CloudRunnerError) ||
                    error.message !== 'CLOUD_DAEMON_404'
                  )
                    throw error;
                },
              );
            },
            valid: async () => {
              try {
                return (
                  (
                    await this.json<{ Id: string }>(
                      'GET',
                      `/containers/${name}/json`,
                    )
                  ).Id === c.Id
                );
              } catch (error) {
                if (
                  error instanceof CloudRunnerError &&
                  error.message === 'CLOUD_DAEMON_404'
                )
                  return false;
                throw error;
              }
            },
          };
        } catch (error) {
          if (
            !(error instanceof CloudRunnerError) ||
            error.message !== 'CLOUD_DAEMON_409'
          )
            throw error;
        }
        let existing: Container;
        try {
          existing = await this.json<Container>(
            'GET',
            `/containers/${name}/json`,
          );
        } catch (error) {
          if (
            error instanceof CloudRunnerError &&
            error.message === 'CLOUD_DAEMON_404'
          )
            continue;
          throw error;
        }
        const owner = existing.Config.Labels[slotOwnerLabel];
        const expires = Number(existing.Config.Labels[slotDeadlineLabel]);
        if (
          owner &&
          uuid.test(owner) &&
          Number.isFinite(expires) &&
          expires <= Date.now() &&
          !existing.State.Running
        ) {
          const abandoned = await this.inspect(owner);
          if (abandoned?.State.Running) continue;
          if (abandoned?.State.Status === 'created') {
            // Delete a never-started attempt before reclaiming its slot. Docker
            // serializes delete/start: a delayed old Worker must get 404, not
            // start after our final ownership check. Never delete exited
            // attempts here: their logs may still be needed for recovery.
            try {
              await this.call('DELETE', `/containers/${abandoned.Id}?v=true`);
            } catch (error) {
              if (
                error instanceof CloudRunnerError &&
                error.message === 'CLOUD_DAEMON_409'
              )
                continue;
              if (
                !(error instanceof CloudRunnerError) ||
                error.message !== 'CLOUD_DAEMON_404'
              )
                throw error;
            }
          }
          await this.call('DELETE', `/containers/${existing.Id}?v=true`).catch(
            (error) => {
              if (
                !(error instanceof CloudRunnerError) ||
                error.message !== 'CLOUD_DAEMON_404'
              )
                throw error;
            },
          );
        }
      }
      await delay(500);
    }
    throw new CloudRunnerError('CLOUD_CAPACITY_WAIT_TIMEOUT');
  }

  protected async executeAdmittedScript(
    args: CloudCommandInput,
    files: { path: string; contentBase64: string }[],
    options: Parameters<CloudRunnerBackend['execute']>[2],
    office: boolean,
  ): Promise<CloudRunResult> {
    const command = { arguments: args },
      { attemptId } = options,
      startedAt = Date.now();
    if (!uuid.test(attemptId))
      throw new CloudRunnerError('CLOUD_INVALID_ATTEMPT');
    const imageDigest = office ? officeSandboxImage : cloudToolchainImageV1;
    await this.preflight(imageDigest);
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
      size > (office ? 20_000_000 : 2_000_000)
    )
      throw new CloudRunnerError('CLOUD_INPUT_LIMIT');
    const deadline = Math.min(
      Date.parse(options.deadlineAt),
      Date.now() + command.arguments.limits.timeoutMs,
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
        office,
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
        Image: imageDigest,
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
          Tmpfs: {
            '/tmp': `rw,nosuid,nodev,noexec,size=${office ? 96 : 32}m,mode=1777`,
          },
          ShmSize: 8 * 1024 * 1024,
          LogConfig: {
            Type: 'json-file',
            Config: { 'max-size': office ? '12m' : '8m', 'max-file': '1' },
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
      await options.observe?.({
        stage: 'executing',
        containerId: c.Id,
        startupMs: Date.now() - startedAt,
      });
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
