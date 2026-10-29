import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { audit, inventory } from './ci-integration-tests.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const dbFile = 'packages/database/src/new.integration.test.ts';
const browserFile = 'apps/web/new.browser.test.ts';
const dbGate = "process.env.ALLRICE_RUN_DB_INTEGRATION === '1'";
function fixture(files, oldSteps = []) {
  const root = mkdtempSync(join(tmpdir(), 'allrice-collection-'));
  roots.push(root);
  const save = (file, value) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), value);
  };
  const steps = [
    ...oldSteps,
    ...['db', 'browser', 'browser+db'].map((group) => ({
      run: `node scripts/ci-integration-tests.mjs run ${group} -- --maxWorkers=1`,
      env: {
        ALLRICE_RUN_DB_INTEGRATION: 1,
        ALLRICE_RUN_BROWSER_INTEGRATION: 1,
      },
    })),
  ];
  save('.github/workflows/ci.yml', stringify({ jobs: { test: { steps } } }));
  save(
    'scripts/ci-manual-environments.yml',
    stringify({
      ALLRICE_RUN_CLOUD_INTEGRATION: {
        reason: 'Physical runsc VM',
        command: 'ALLRICE_RUN_CLOUD_INTEGRATION=1 pnpm exec vitest run {file}',
      },
    }),
  );
  for (const [file, value] of Object.entries(files)) save(file, value);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture',
  ]);
  return root;
}

it('collects a newly added DB file without a CI filename and rejects disabled directory coverage', () => {
  const source = `const enabled = ${dbGate}; const suite = enabled ? describe.sequential : describe.skip; suite('database', () => { it('persists', () => {}); });`;
  const root = fixture({ [dbFile]: source }, [
    {
      run: 'pnpm exec vitest run packages/database/src',
      env: { ALLRICE_RUN_DB_INTEGRATION: 0 },
    },
  ]);
  const plan = inventory(root);
  expect(plan.entries[0].group).toBe('db');
  expect(plan.entries[0].coveredBy).toEqual([]);
  expect(plan.additions.db).toEqual([{ file: dbFile }]);
});

it('recognizes enabled directory collection and does not mistake fixture strings for switches', () => {
  const root = fixture(
    {
      [dbFile]: `describe.skipIf(!(${dbGate})).sequential('DB', () => { it('writes', () => { const fixture = 'process.env.ALLRICE_RUN_CLOUD_INTEGRATION'; }); });`,
    },
    [
      {
        run: 'pnpm exec vitest run packages/database/src',
        env: { ALLRICE_RUN_DB_INTEGRATION: 1 },
      },
    ],
  );
  expect(inventory(root).additions.db).toEqual([]);
  expect(inventory(root).entries[0].gates).toEqual([
    'ALLRICE_RUN_DB_INTEGRATION',
  ]);
});

it('separates real external whole-file and partial cases from automatic browser cases', () => {
  const root = fixture({
    [dbFile]: `describe.skipIf(!(${dbGate}))('DB', () => { it('SQL',()=>{}); it.skipIf(process.env.ALLRICE_RUN_CLOUD_INTEGRATION !== '1')('physical',()=>{}); it.runIf(process.env.ALLRICE_RUN_BROWSER_INTEGRATION === '1')('DOM',()=>{}); });`,
    [browserFile]: `it.skipIf(process.env.ALLRICE_RUN_CLOUD_INTEGRATION !== '1')('physical-only',()=>{});`,
  });
  const plan = inventory(root);
  expect(plan.entries.find((entry) => entry.file === browserFile).group).toBe(
    'manual',
  );
  expect(plan.additions['browser+db']).toEqual([
    { file: dbFile, title: 'DOM' },
  ]);
  expect(
    plan.entries
      .find((entry) => entry.file === dbFile)
      .cases.find((item) => item.title === 'physical').group,
  ).toBe('manual');
  expect(
    plan.entries.find((entry) => entry.file === dbFile).manualCommands[0]
      .command,
  ).toContain('ALLRICE_RUN_DB_INTEGRATION=1');
  expect(
    plan.entries.find((entry) => entry.file === dbFile).manualCommands[0]
      .command,
  ).toContain('ALLRICE_RUN_CLOUD_INTEGRATION=1');
});

it('fails collection when a new registration switch has no classified environment', () => {
  const root = fixture({
    [dbFile]: `describe.skipIf(process.env.ALLRICE_RUN_UNKNOWN !== '1')('new',()=>{});`,
  });
  expect(() => inventory(root)).toThrow('Unclassified test gate');
});

it('does not count a name-filtered browser step as whole-file execution', () => {
  const root = fixture(
    {
      [browserFile]: `describe.skipIf(process.env.ALLRICE_RUN_BROWSER_INTEGRATION !== '1')('browser',()=>{it('first',()=>{});it('second',()=>{});});`,
    },
    [
      {
        run: `pnpm exec vitest run ${browserFile} -t 'first'`,
        env: { ALLRICE_RUN_BROWSER_INTEGRATION: 1 },
      },
    ],
  );
  expect(inventory(root).additions.browser).toEqual([{ file: browserFile }]);
});

it('rejects missing reports and disabled/skipped tests; records external skips as zero passes', () => {
  const entry = {
    file: dbFile,
    group: 'db',
    gates: ['ALLRICE_RUN_DB_INTEGRATION'],
    cases: [
      {
        title: 'physical',
        group: 'manual',
        gates: ['ALLRICE_RUN_CLOUD_INTEGRATION'],
      },
    ],
  };
  const report = (...tests) => ({
    testResults: [
      {
        name: resolve(dbFile),
        assertionResults: tests.map(([title, status]) => ({
          title,
          fullName: 'DB ' + title,
          status,
        })),
      },
    ],
  });
  const enabled = { ALLRICE_RUN_DB_INTEGRATION: '1' };
  expect(() => audit([entry], { testResults: [] }, [dbFile], enabled)).toThrow(
    'Not collected',
  );
  expect(() =>
    audit([entry], report(['SQL', 'pending']), [dbFile], enabled),
  ).toThrow('Unexpected pending');
  expect(() =>
    audit([entry], report(['physical', 'pending']), [dbFile], enabled),
  ).toThrow('No executed passing tests');
  expect(() => audit([entry], report(['SQL', 'passed']), [dbFile], {})).toThrow(
    'Explicit suite gate is disabled',
  );
  const [result] = audit(
    [entry],
    report(['SQL', 'passed'], ['physical', 'pending']),
    [dbFile],
    enabled,
  );
  expect(result.passed).toBe(1);
  expect(result.deferred).toEqual([
    {
      title: 'physical',
      group: 'manual',
      gates: ['ALLRICE_RUN_CLOUD_INTEGRATION'],
    },
  ]);
  expect(() =>
    audit(
      [entry],
      report(['SQL', 'passed'], ['physical', 'pending']),
      [dbFile],
      { ...enabled, ALLRICE_RUN_CLOUD_INTEGRATION: '1' },
    ),
  ).toThrow('Unexpected pending');
});

it('rejects a wholly skipped explicit file while exposing separately covered directory skips', () => {
  const entry = {
    file: dbFile,
    group: 'db',
    gates: ['ALLRICE_RUN_DB_INTEGRATION'],
    cases: [],
    coveredBy: ['other DB step'],
  };
  const report = {
    testResults: [
      {
        name: resolve(dbFile),
        assertionResults: [
          { title: 'SQL', fullName: 'DB SQL', status: 'pending' },
        ],
      },
    ],
  };
  expect(() => audit([entry], report, [dbFile], {})).toThrow(
    'Explicit suite gate is disabled',
  );
  expect(audit([entry], report, ['packages/database/src'], {})).toEqual([
    {
      file: dbFile,
      passed: 0,
      deferred: [{ group: 'db', gates: ['ALLRICE_RUN_DB_INTEGRATION'] }],
    },
  ]);
});
