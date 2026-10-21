import { spawn } from 'node:child_process';

export interface OwnedStopProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitConfirmed: true;
  interrupted: 'aborted' | 'timeout' | 'output_limit' | 'process_error' | null;
}

/** A deadline without an observed exit is an unknown result, never completion. */
export class OwnedStopProcessExitUnconfirmed extends Error {
  readonly exitConfirmed = false;
  constructor(readonly pid: number | undefined) {
    super('OWNED_PROCESS_EXIT_UNCONFIRMED');
  }
}

/** Only the child returned by this spawn is signalled. No PID/name discovery,
 * process-group kill, shell, or global VM authority. timeoutMs includes both
 * the TERM grace and the KILL/exit observation grace. */
export function runOwnedStopProcess(
  binary: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    maxBuffer?: number;
  },
): Promise<OwnedStopProcessResult> {
  options.signal?.throwIfAborted();
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    throw new RangeError('OWNED_PROCESS_DEADLINE_REQUIRED');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const grace = Math.min(1_000, options.timeoutMs / 3);
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      settled = false,
      exited = false;
    let exitCode: number | null = null,
      signal: NodeJS.Signals | null = null;
    let interrupted: OwnedStopProcessResult['interrupted'] = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let abortDeadline: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(terminate);
      clearTimeout(escalation);
      clearTimeout(abortDeadline);
      clearTimeout(drain);
      options.signal?.removeEventListener('abort', abort);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = () => {
      if (settled || !exited) return;
      settled = true;
      cleanup();
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
        exitConfirmed: true,
        interrupted,
      });
    };
    const unknown = () => {
      if (settled) return;
      if (exited) return finish();
      settled = true;
      cleanup();
      // The caller must retain recovery state. Releasing Node's handle is not
      // a claim that the process (or the VM it controls) has exited.
      child.unref();
      reject(new OwnedStopProcessExitUnconfirmed(child.pid));
    };
    const interrupt = (
      reason: NonNullable<OwnedStopProcessResult['interrupted']>,
    ) => {
      if (settled || exited || interrupted) return;
      interrupted = reason;
      clearTimeout(terminate);
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        if (!exited && !settled) child.kill('SIGKILL');
      }, grace);
      // Cancellation/output overflow need not wait for the full start budget.
      abortDeadline = setTimeout(unknown, grace * 2);
    };
    const abort = () => interrupt('aborted');
    const terminate = setTimeout(
      () => interrupt('timeout'),
      options.timeoutMs - grace * 2,
    );
    const deadline = setTimeout(unknown, options.timeoutMs);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBuffer ?? 65_536)) interrupt('output_limit');
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdout.once('error', () => interrupt('process_error'));
    child.stderr.once('error', () => interrupt('process_error'));
    child.once('error', (error) => {
      if (settled) return;
      // Failed spawn has no owned process to wait for. Errors after spawn do
      // not prove exit; keep observing/escalating that exact child instead.
      if (child.pid === undefined) {
        settled = true;
        cleanup();
        reject(error);
      } else interrupt('process_error');
    });
    child.once('exit', (code, receivedSignal) => {
      exited = true;
      exitCode = code;
      signal = receivedSignal;
      clearTimeout(escalation);
      clearTimeout(abortDeadline);
      // A descendant may keep an inherited pipe open after the CLI exits.
      // Observe the real exit, allow bounded output drain, then close our pipe.
      drain = setTimeout(finish, 100);
    });
    child.once('close', finish);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
