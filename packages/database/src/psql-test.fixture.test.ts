import { describe, expect, it } from 'vitest';
import {
  PsqlTestDeadlineError,
  psqlTestUrl,
  runPsqlProcess,
} from './psql-test.fixture.ts';

describe('psql test process boundaries', () => {
  it('replaces URL options with one schema/statement deadline and explicit connect timeout', () => {
    const url = new URL(
      psqlTestUrl(
        'postgres://localhost/test?options=-cstatement_timeout%3D0&connect_timeout=60',
        'isolated',
        'test-psql',
      ),
    );
    expect(url.searchParams.getAll('options')).toEqual([
      '-csearch_path=isolated,public -cstatement_timeout=2000',
    ]);
    expect(url.searchParams.get('connect_timeout')).toBe('1');
    expect(url.searchParams.get('application_name')).toBe('test-psql');
  });

  it.each([
    ['deadline', 'fail'],
    ['abort', 'fail'],
    ['deadline', 'hang'],
  ] as const)(
    'waits for child close on %s when diagnostics %s',
    async (kind, diagnostic) => {
      const abort = new AbortController();
      let pid: number | undefined;
      let diagnosticCalls = 0;
      const work = runPsqlProcess({
        command: process.execPath,
        args: [
          '-e',
          'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); setInterval(() => {}, 1000)',
        ],
        signal: abort.signal,
        timeoutMs: 200,
        event: (event, child) => {
          if (event === 'spawn') {
            pid = child;
            if (kind === 'abort') abort.abort();
          }
        },
        beforeStop: async () => {
          diagnosticCalls++;
          if (diagnostic === 'hang') await new Promise<void>(() => {});
          throw new Error('diagnostic unavailable');
        },
      });
      await expect(work).rejects.toMatchObject({
        reason: kind === 'deadline' ? 'process_deadline' : 'aborted',
      });
      expect(diagnosticCalls).toBe(1);
      expect(pid).toBeTypeOf('number');
      expect(() => process.kill(pid!, 0)).toThrow();
    },
  );

  it('kills descendants holding stdio after the configured parent has exited', async () => {
    let exitedSuccessfully = false;
    const work = runPsqlProcess({
      command: process.execPath,
      args: [
        '-e',
        'const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); child.unref()',
      ],
      signal: new AbortController().signal,
      timeoutMs: 1_500,
      event: (event, _pid, status) => {
        if (event === 'exit' && status === 0) exitedSuccessfully = true;
      },
    });
    await expect(work).rejects.toMatchObject({ reason: 'process_deadline' });
    expect(exitedSuccessfully).toBe(true);
  });

  it('classifies the libpq connection timeout without exposing its address', async () => {
    const work = runPsqlProcess({
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write(`psql: error: connection to server at "db.test", port 5432 failed: timeout expired`); process.exitCode=2',
      ],
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    await expect(work).rejects.toMatchObject({ reason: 'connect_timeout' });
    await expect(work).rejects.not.toThrow(/db\.test|5432/);
  });

  it('keeps a statement timeout separate from a SQL rejection containing the script name', async () => {
    const work = runPsqlProcess({
      command: process.execPath,
      args: [
        '-e',
        'process.stderr.write("psql:/private/schedule-recover.sql:1: ERROR: canceling statement due to statement timeout\\n"); process.exitCode=3',
      ],
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    await expect(work).rejects.toBeInstanceOf(PsqlTestDeadlineError);
    await expect(work).rejects.toMatchObject({ reason: 'statement_timeout' });
    await expect(work).rejects.not.toThrow(/schedule-recover|private/);
  });
});
