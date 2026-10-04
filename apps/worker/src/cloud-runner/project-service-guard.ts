import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

/** One trusted VM pipe owns the physical five-second lease. Project code
 * cannot reach this file or ingress. EOF/crash never extends the lease. */
export async function openCloudProjectServiceGuard(
  attempt: string,
  hardDeadlineAt: string,
) {
  if (!/^[a-f0-9-]{36}$/.test(attempt)) throw Error('CLOUD_SERVICE_IDENTITY');
  const deadline = Date.parse(hardDeadlineAt);
  if (
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + 3_600_000
  )
    throw Error('CLOUD_SERVICE_DEADLINE');
  const fixed = [
    '/usr/local/lib/allrice-cloud/watchdog.py',
    '--project-service-lease',
    attempt,
    String(deadline),
  ];
  const child = spawn(
    process.platform === 'darwin' ? '/usr/local/bin/colima' : '/usr/bin/sudo',
    process.platform === 'darwin'
      ? [
          'ssh',
          '--profile',
          process.env.ALLRICE_CLOUD_PROFILE ?? 'allrice-cloud-b4',
          '--',
          'sudo',
          ...fixed,
        ]
      : ['-n', ...fixed],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir() },
    },
  );
  let sequence = 0,
    closed = false,
    bytes = 0;
  const pending = new Map<
    number,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    closed = true;
    for (const ack of pending.values()) {
      clearTimeout(ack.timer);
      ack.reject(Error('CLOUD_SERVICE_GUARD_LOST'));
    }
    pending.clear();
    child.stdin.destroy();
  };
  child.once('error', fail);
  child.once('exit', fail);
  child.stderr.on('data', (b: Buffer) => {
    bytes += b.length;
    if (bytes > 4096) child.kill();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      if (line.length > 1024) throw Error();
      const frame = JSON.parse(line),
        ack = pending.get(frame.sequence);
      if (!ack || frame.ready !== true) throw Error();
      clearTimeout(ack.timer);
      pending.delete(frame.sequence);
      ack.resolve();
    } catch {
      fail();
      child.kill();
    }
  });
  const wait = (index: number, timeout: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(index);
        reject(Error('CLOUD_SERVICE_GUARD_TIMEOUT'));
        fail();
        child.kill();
      }, timeout);
      pending.set(index, { resolve, reject, timer });
    });
  await wait(-1, 15_000);
  return {
    async renew(expiresAt: number) {
      if (closed) throw Error('CLOUD_SERVICE_GUARD_LOST');
      const index = sequence++,
        ack = wait(index, 2500);
      child.stdin.write(
        JSON.stringify({
          sequence: index,
          expiresAt: Math.min(expiresAt, deadline, Date.now() + 5000),
        }) + '\n',
        (error) => {
          if (error) fail();
        },
      );
      await ack;
    },
    close() {
      fail();
      lines.close();
      child.kill('SIGTERM');
    },
  };
}
