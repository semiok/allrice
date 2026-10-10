import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runPreflight } from './preflight.mjs';

describe('local submission preflight', () => {
  it('collects multiple real command failures and still executes later checks once', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'allrice-preflight-'));
    try {
      const result = runPreflight({
        cwd,
        command: process.execPath,
        log: () => {},
        steps: [
          { id: 'first-failure', args: ['-e', 'process.exit(2)'] },
          { id: 'second-failure', args: ['-e', 'process.exit(3)'] },
          {
            id: 'later-check',
            args: [
              '-e',
              "require('node:fs').appendFileSync('executed.txt', 'once')",
            ],
          },
        ],
      });
      expect(result.passed).toBe(false);
      expect(result.results.map((r) => [r.id, r.exitCode])).toEqual([
        ['first-failure', 2],
        ['second-failure', 3],
        ['later-check', 0],
      ]);
      expect(readFileSync(join(cwd, 'executed.txt'), 'utf8')).toBe('once');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('never accepts missing executables, interrupted commands or an empty plan', () => {
    const failed = runPreflight({
      command: '/allrice-preflight-no-such-executable',
      steps: [{ id: 'cannot-start', args: [] }],
      log: () => {},
    });
    expect(failed.passed).toBe(false);
    expect(failed.results[0].executionFailed).toBe(true);
    expect(
      runPreflight({
        steps: [{ id: 'interrupted', args: [] }],
        execute: () => ({ status: null, signal: 'SIGTERM' }),
        log: () => {},
      }).passed,
    ).toBe(false);
    expect(runPreflight({ steps: [], log: () => {} }).passed).toBe(false);
  });

  it('prints a no-execution plan and explicitly omits the build in quick mode', () => {
    const plan = execFileSync(
      process.execPath,
      [new URL('./preflight.mjs', import.meta.url).pathname, '--plan'],
      { encoding: 'utf8' },
    );
    expect(plan).toContain('types:');
    expect(plan).toContain('production-build:');
    expect(plan).toContain('Plan only; no checks have run.');
    const quick = execFileSync(
      process.execPath,
      [
        new URL('./preflight.mjs', import.meta.url).pathname,
        '--plan',
        '--quick',
      ],
      { encoding: 'utf8' },
    );
    expect(quick).not.toContain('production-build:');
    expect(quick).toContain('types:');
  });
});
