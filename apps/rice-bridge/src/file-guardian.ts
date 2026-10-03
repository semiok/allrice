import { spawn } from 'node:child_process';
import { inspectFixedFileGuardian } from './file-guardian-resources.js';

export class FileGuardianError extends Error {
  constructor(
    readonly code: string,
    readonly unknown = false,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

export type FileGuardianControls = {
  signal?: AbortSignal;
  authorize?: () => Promise<boolean>;
};

/** Fixed Darwin openat primitive. No shell, user executable, network or format parser. */
export async function invokeFileGuardian(
  request: Record<string, unknown>,
  controls: FileGuardianControls = {},
  executable = inspectFixedFileGuardian(),
): Promise<unknown> {
  const line = JSON.stringify(request) + '\n';
  if (Buffer.byteLength(line) > 16 * 1024)
    throw new FileGuardianError('FILE_REQUEST_LIMIT');
  if (
    controls.signal?.aborted ||
    (controls.authorize && !(await controls.authorize()))
  )
    throw new FileGuardianError('FILE_CANCELED');
  // Authorization can await I/O; an abort during that await must not spawn.
  if (controls.signal?.aborted) throw new FileGuardianError('FILE_CANCELED');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      detached: true,
    });
    let total = 0,
      stopped = false,
      checking = false;
    const chunks: Buffer[] = [];
    const readOnly = request.mode === 'survey' || request.mode === 'read';
    const mutation = !readOnly;
    const maximumOutputBytes = request.mode === 'read' ? 12_100_001 : 512_001;
    const stop = () => {
      stopped = true;
      child.stdin.destroy();
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    };
    controls.signal?.addEventListener('abort', stop, { once: true });
    if (controls.signal?.aborted) stop();
    const timeout = setTimeout(stop, 30_000);
    // EOF means authority loss to the primitive. Empty frames renew liveness only.
    const heartbeat = setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      void (async () => {
        if (
          controls.signal?.aborted ||
          (controls.authorize && !(await controls.authorize()))
        )
          stop();
        else if (!child.stdin.destroyed) child.stdin.write('\n');
      })()
        .catch(stop)
        .finally(() => {
          checking = false;
        });
    }, 400);
    child.stdout.on('data', (bytes: Buffer) => {
      total += bytes.length;
      if (total > maximumOutputBytes) stop();
      else chunks.push(bytes);
    });
    child.stderr.resume(); // Never return native paths or unbounded stderr to the model.
    child.stdin.on('error', () => {});
    let spawnError = false;
    child.once('error', () => {
      spawnError = true;
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      controls.signal?.removeEventListener('abort', stop);
      if (stopped || spawnError) {
        reject(
          new FileGuardianError(
            stopped ? 'FILE_CANCELED_OR_LIMIT' : 'FILE_PRIMITIVE_FAILED',
            mutation && !spawnError,
          ),
        );
        return;
      }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.error?.code)
          throw new FileGuardianError(
            String(result.error.code),
            result.status === 'unknown',
            request.mode === 'read' ? undefined : result,
          );
        if (code !== 0)
          throw new FileGuardianError(
            'FILE_PRIMITIVE_FAILED',
            mutation,
            request.mode === 'read' ? undefined : result,
          );
        resolve(result);
      } catch (error) {
        reject(
          error instanceof FileGuardianError
            ? error
            : new FileGuardianError('FILE_RESULT_UNKNOWN', mutation),
        );
      }
    });
    child.stdin.write(line);
  });
}
