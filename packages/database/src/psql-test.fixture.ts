/** Test-only psql execution and its own cancellable PostgreSQL connections. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

// Leave the default 5s Vitest deadline room for a snapshot and confirmed cleanup.
export const PSQL_TEST_STATEMENT_MS = 2_000;
const CASE_MS = 3_900;
const PROCESS_MS = 2_500;
const SNAPSHOT_MS = 250;
const SLOW_STEP_MS = 1_500;
const errorCode = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  'code' in error &&
  typeof error.code === 'string' &&
  /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : 'unknown';

type StopReason =
  | 'case_deadline'
  | 'process_deadline'
  | 'statement_timeout'
  | 'connect_timeout'
  | 'aborted';
export class PsqlTestDeadlineError extends Error {
  constructor(readonly reason: StopReason) {
    // Never include command arguments, script paths or stderr: a SQL rejection
    // assertion must not mistake a deadline for the expected script error.
    super(`psql_test_${reason}`);
  }
}

export function psqlTestUrl(
  value: string,
  schema: string,
  applicationName: string,
) {
  const url = new URL(value);
  url.searchParams.set(
    'options',
    `-csearch_path=${schema},public -cstatement_timeout=${PSQL_TEST_STATEMENT_MS}`,
  );
  url.searchParams.set('application_name', applicationName);
  url.searchParams.set('connect_timeout', '1');
  // libpq URI decoding does not translate form-encoded '+' into a space.
  // Limit normalization to the query so literal '+' in credentials survives.
  url.search = url.search.replaceAll('+', '%20');
  return url.toString();
}

export function runPsqlProcess(options: {
  command: string;
  args: string[];
  signal: AbortSignal;
  timeoutMs: number;
  beforeStop?: (error: PsqlTestDeadlineError) => Promise<void>;
  event?: (event: string, pid?: number, status?: number | null) => void;
}) {
  if (options.signal.aborted)
    return Promise.reject(new PsqlTestDeadlineError('aborted'));
  return new Promise<{ stdout: string; stderr: string; status: number | null }>(
    (resolve, reject) => {
      const env = { ...process.env };
      delete env.PGOPTIONS; // The URL is the only startup-options entry point.
      const child = spawn(options.command, options.args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      const kill = (signal: NodeJS.Signals) => {
        try {
          // The configured command may be a wrapper: kill its private process
          // group, including children holding stdio after the wrapper exits.
          if (process.platform !== 'win32' && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* Already gone; close still confirms execution ended. */
        }
      };
      let stdout = '',
        stderr = '';
      let failure: Error | undefined;
      let stopping: Promise<void> | undefined;
      const stop = (reason: StopReason) => {
        if (stopping) return;
        const error = new PsqlTestDeadlineError(reason);
        failure = error;
        stopping = (async () => {
          let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.resolve()
                .then(() => options.beforeStop?.(error))
                .catch(() => {}),
              new Promise<void>((resolve) => {
                diagnosticTimer = setTimeout(resolve, SNAPSHOT_MS);
              }),
            ]);
          } finally {
            clearTimeout(diagnosticTimer);
          }
          if (child.pid) {
            kill('SIGINT'); // psql forwards cancellation to its backend.
            await new Promise<void>((resolve) => {
              setTimeout(() => {
                kill('SIGKILL');
                resolve();
              }, 100);
            });
          }
        })();
      };
      const onAbort = () => stop('aborted');
      const timer = setTimeout(
        () => stop('process_deadline'),
        options.timeoutMs,
      );
      options.signal.addEventListener('abort', onAbort, { once: true });
      child.once('spawn', () => options.event?.('spawn', child.pid));
      child.once('exit', (status) =>
        options.event?.('exit', child.pid, status),
      );
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.once('error', (error) => {
        failure ??= Object.assign(new Error('psql_process_failed'), {
          code: errorCode(error),
        });
      });
      child.once('close', async (status) => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        await stopping;
        options.event?.('close', child.pid, status);
        if (failure) reject(failure);
        else if (
          status !== 0 &&
          /(?:^|\n)(?:psql: error: )?connection to server[^\r\n]* failed: timeout expired(?:\r?\n|$)/.test(
            stderr,
          )
        )
          reject(new PsqlTestDeadlineError('connect_timeout'));
        else if (
          /ERROR:\s*canceling statement due to statement timeout/.test(stderr)
        )
          reject(new PsqlTestDeadlineError('statement_timeout'));
        else resolve({ stdout, stderr, status });
      });
      // Also cover an abort between the initial check and listener registration.
      if (options.signal.aborted) onAbort();
    },
  );
}

export type PsqlWaitSnapshot = {
  sampledAtMs: number;
  schema: string;
  stage: string;
  unavailable?: true;
  errorCode?: string;
  activity?: {
    pid: number;
    application_name: string;
    state: string;
    wait_event_type: string | null;
    wait_event: string | null;
    blockers: number[];
  }[];
  locks?: {
    pid: number;
    locktype: string;
    mode: string;
    granted: boolean;
    relation: number | null;
    transactionid: string | null;
  }[];
};

export function createPsqlTestFixture(
  value: string,
  schema: string,
  signal: AbortSignal,
) {
  const id = randomUUID().slice(0, 8);
  const applications = [`${schema}:db:${id}`, `${schema}:psql:${id}`];
  const url = psqlTestUrl(value, schema, applications[1]!);
  const db = postgres(psqlTestUrl(value, schema, applications[0]!), {
    max: 1,
    onnotice: () => {},
    connect_timeout: 1,
  });
  const controller = new AbortController();
  const started = performance.now();
  const trace: {
    stage: string;
    atMs: number;
    durationMs?: number;
    pid?: number;
    status?: number | null;
  }[] = [];
  const mark = (
    stage: string,
    extra: { durationMs?: number; pid?: number; status?: number | null } = {},
  ) =>
    trace.push({
      stage,
      atMs: Math.round(performance.now() - started),
      ...extra,
    });
  let snapshot: PsqlWaitSnapshot | undefined;
  let slowSnapshot: PsqlWaitSnapshot | undefined;
  let activeStage = 'initializing';
  let sampling: Promise<void> | undefined;
  let failure: PsqlTestDeadlineError | undefined;
  let interruption: Promise<void> | undefined;
  let captureBeforeStop: Promise<void> | undefined;
  let cleanupConfirmed: boolean | undefined;
  const children = new Set<Promise<unknown>>();

  async function inspect<T>(
    work: (control: postgres.Sql) => PromiseLike<T>,
  ): Promise<T> {
    const control = postgres(value, {
      max: 1,
      onnotice: () => {},
      connect_timeout: 1,
      connection: {
        application_name: `${schema}:diagnostic`,
        statement_timeout: 200,
      },
    });
    const timer = setTimeout(() => {
      void control.end({ timeout: 0 }).catch(() => {});
    }, SNAPSHOT_MS);
    try {
      return await work(control);
    } finally {
      clearTimeout(timer);
      await control.end({ timeout: 0 });
    }
  }
  function sample(stage: string, slow = false) {
    return (sampling ??= (async () => {
      const sampledAtMs = Math.round(performance.now() - started);
      try {
        const [row] = await inspect(
          (control) => control<
            {
              snapshot: Omit<
                PsqlWaitSnapshot,
                'sampledAtMs' | 'schema' | 'stage'
              >;
            }[]
          >`
          with recursive relevant(pid) as (
            select pid from pg_stat_activity where datname=current_database()
              and application_name=any(${[schema, ...applications]}::text[]) and pid<>pg_backend_pid()
            union
            select unnest(pg_blocking_pids(pid)) from relevant
          )
          select jsonb_build_object(
            'activity', (select coalesce(jsonb_agg(jsonb_build_object(
              'pid', a.pid, 'application_name', case when a.application_name=any(${[schema, ...applications]}::text[])
                then a.application_name else '[blocker]' end,
              'state', a.state, 'wait_event_type', a.wait_event_type, 'wait_event', a.wait_event,
              'blockers', pg_blocking_pids(a.pid))), '[]'::jsonb)
              from pg_stat_activity a join relevant r using(pid)),
            'locks', (select coalesce(jsonb_agg(jsonb_build_object(
              'pid', l.pid, 'locktype', l.locktype, 'mode', l.mode, 'granted', l.granted,
              'relation', l.relation, 'transactionid', l.transactionid::text)), '[]'::jsonb)
              from pg_locks l join relevant r using(pid))
          ) snapshot`,
        );
        snapshot = { sampledAtMs, schema, stage, ...row!.snapshot };
      } catch (error) {
        snapshot = {
          sampledAtMs,
          schema,
          stage,
          unavailable: true,
          errorCode: errorCode(error),
        };
      }
      if (slow) slowSnapshot = snapshot;
    })().finally(() => {
      sampling = undefined;
    }));
  }
  function prepareStop(error: PsqlTestDeadlineError) {
    failure ??= error;
    return (captureBeforeStop ??= sample(`${activeStage}.cancel`));
  }
  function interrupt(error: PsqlTestDeadlineError) {
    if (interruption) return interruption;
    interruption = (async () => {
      await prepareStop(error); // Observe the waiter before killing either owned session.
      controller.abort();
      // Raw process promises cannot wait on step.catch / this interruption. No
      // psql can establish a new backend after we confirm database cleanup.
      await Promise.allSettled([...children]);
      await db.end({ timeout: 0 }).catch(() => {
        cleanupConfirmed = false;
      });
      try {
        const absent = await inspect(async (control) => {
          await control`select pg_terminate_backend(pid, 100) from pg_stat_activity
            where datname=current_database() and application_name=any(${applications}::text[])
              and pid<>pg_backend_pid()`;
          const [row] = await control<{ absent: boolean }[]>`
            select not exists(select 1 from pg_stat_activity where datname=current_database()
              and application_name=any(${applications}::text[])) absent`;
          return row!.absent;
        });
        cleanupConfirmed = cleanupConfirmed !== false && absent;
      } catch {
        cleanupConfirmed = false;
      }
      mark('cancel', {});
    })();
    return interruption;
  }
  const onAbort = () => {
    void interrupt(new PsqlTestDeadlineError('aborted'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    void interrupt(new PsqlTestDeadlineError('case_deadline'));
  }, CASE_MS);
  if (signal.aborted) onAbort();

  async function step<T>(
    stage: string,
    work: () => PromiseLike<T>,
  ): Promise<T> {
    if (failure) {
      await interruption;
      throw failure;
    }
    const begin = performance.now();
    activeStage = stage;
    slowSnapshot = undefined;
    mark(`${stage}.start`);
    const slow = setTimeout(() => {
      void sample(stage, true);
    }, SLOW_STEP_MS);
    try {
      const result = await work();
      if (failure) {
        await interruption;
        throw failure;
      }
      return result;
    } catch (error) {
      if (error instanceof PsqlTestDeadlineError) await interrupt(error);
      // postgres.js 3.4.9 connectTimedOut emits this exact code; connection
      // refusal, reset and other network failures retain their original kind.
      else if (errorCode(error) === 'CONNECT_TIMEOUT')
        await interrupt(new PsqlTestDeadlineError('connect_timeout'));
      else if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '57014'
      )
        await interrupt(new PsqlTestDeadlineError('statement_timeout'));
      if (failure) {
        await interruption;
        throw failure;
      }
      throw error;
    } finally {
      clearTimeout(slow);
      mark(`${stage}.end`, {
        durationMs: Math.round(performance.now() - begin),
      });
    }
  }
  return {
    db,
    url,
    applications,
    trace,
    get snapshot() {
      return slowSnapshot ?? snapshot;
    },
    get cleanupConfirmed() {
      return cleanupConfirmed;
    },
    step,
    psql(
      stage: string,
      args: string[],
      options: { signal?: AbortSignal; timeoutMs?: number } = {},
    ) {
      return step(stage, () => {
        const raw = runPsqlProcess({
          command: process.env.ALLRICE_TEST_PSQL ?? 'psql',
          args: [url, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args],
          signal: options.signal
            ? AbortSignal.any([controller.signal, options.signal])
            : controller.signal,
          timeoutMs: options.timeoutMs ?? PROCESS_MS,
          beforeStop: prepareStop,
          event: (event, pid, status) => {
            mark(`${stage}.${event}`, { pid, status });
          },
        });
        children.add(raw);
        void raw.finally(() => children.delete(raw)).catch(() => {});
        return raw;
      });
    },
    async close() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (children.size) await interrupt(new PsqlTestDeadlineError('aborted'));
      await interruption;
      await Promise.allSettled([...children]);
      await sampling;
      try {
        await db.end({ timeout: 0.2 });
      } catch (error) {
        if (!failure) throw error;
        cleanupConfirmed = false;
      }
      if (failure)
        console.error(
          'psql test timeout',
          JSON.stringify({
            reason: failure.reason,
            trace,
            snapshot: slowSnapshot ?? snapshot,
            finalSnapshot: snapshot,
            cleanupConfirmed,
          }),
        );
    },
  };
}
