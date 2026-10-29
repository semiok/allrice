import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from 'node:fs';
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'allrice-collection-')));
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
        ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE: '$PWD/apps/worker/package.json',
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
  expect(plan.additions.db).toMatchObject([{ file: dbFile }]);
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
  expect(plan.additions['browser+db']).toMatchObject([
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
  expect(inventory(root).additions.browser).toMatchObject([
    { file: browserFile },
  ]);
});

it('rejects missing reports and disabled/skipped tests; records external skips as zero passes', () => {
  const entry = {
    file: dbFile,
    group: 'db',
    gates: ['ALLRICE_RUN_DB_INTEGRATION'],
    cases: [
      {
        title: 'SQL',
        line: 1,
        column: 1,
        group: 'db',
        gates: ['ALLRICE_RUN_DB_INTEGRATION'],
      },
      {
        title: 'physical',
        line: 2,
        column: 1,
        group: 'manual',
        gates: ['ALLRICE_RUN_DB_INTEGRATION', 'ALLRICE_RUN_CLOUD_INTEGRATION'],
      },
    ],
  };
  const report = (sql = 'passed', physical = 'pending') => ({
    testResults: [
      {
        name: resolve(dbFile),
        assertionResults: entry.cases.map((item, index) => ({
          title: item.title,
          fullName: 'DB ' + item.title,
          status: index ? physical : sql,
          location: { line: item.line, column: item.column },
        })),
      },
    ],
  });
  const enabled = { ALLRICE_RUN_DB_INTEGRATION: '1' };
  expect(() => audit([entry], { testResults: [] }, [dbFile], enabled)).toThrow(
    'Not collected',
  );
  expect(() => audit([entry], report('pending'), [dbFile], enabled)).toThrow(
    'Unexpected pending',
  );
  expect(() => audit([entry], report(), [dbFile], enabled, 'physical')).toThrow(
    'No executed passing tests',
  );
  expect(() => audit([entry], report(), [dbFile], {})).toThrow(
    'Explicit suite gate is disabled',
  );
  expect(() =>
    audit([entry], report(), [dbFile], { ALLRICE_RUN_DB_INTEGRATION: '0' }),
  ).toThrow('Explicit suite gate is disabled');
  expect(() =>
    audit([entry], report('passed', 'passed'), [dbFile], enabled),
  ).toThrow('Disabled case unexpectedly ran');
  const [result] = audit([entry], report(), [dbFile], enabled);
  expect(result.passed).toBe(1);
  expect(result.deferred).toEqual([
    { title: 'physical', group: 'manual', gates: entry.cases[1].gates },
  ]);
  expect(() =>
    audit([entry], report(), [dbFile], {
      ...enabled,
      ALLRICE_RUN_CLOUD_INTEGRATION: '1',
    }),
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

it('keeps PostgreSQL suite.each out of the ungated native inventory', () => {
  const root = fixture(
    {
      [dbFile]: `const suite = ${dbGate} ? describe.sequential : describe.skip; suite.each(['checkpoint', undefined] as const)('release %s',()=>{it('checks retention',()=>{});});`,
    },
    [{ run: 'pnpm test' }],
  );
  const plan = inventory(root);
  expect(plan.entries[0].group).toBe('db');
  expect(plan.entries[0].coveredBy).toEqual([]);
  expect(plan.additions.db).toMatchObject([{ file: dbFile }]);
});

it('does not let a nested subprocess variable shadow the registered database suite alias', () => {
  const root = fixture(
    {
      [dbFile]: `const run = ${dbGate} ? describe.sequential : describe.skip; run('recovery SQL',()=>{function recover(){const run=spawnSync('psql');return run.status;}it('uses the isolated database',()=>{});});`,
    },
    [{ run: 'pnpm test' }],
  );
  expect(inventory(root).entries[0].group).toBe('db');
  expect(inventory(root).additions.db).toMatchObject([{ file: dbFile }]);
});

it('accounts for actual parameterized external cases and rejects missing locations or enabled skips', () => {
  const root = runnableFixture({
    [dbFile]: `describe.skipIf(!(${dbGate}))('DB',()=>{
it('SQL',()=>{});
it.skipIf(!process.env.ALLRICE_RUN_CLOUD_INTEGRATION).each(['docx','xlsx'])('physical %s renderer',()=>{});
});`,
  });
  const run = execute(
    root,
    [
      '--',
      dbFile,
      '--maxWorkers=1',
      '--reporter=json',
      '--outputFile=raw.json',
    ],
    { ALLRICE_RUN_CLOUD_INTEGRATION: '' },
  );
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const plan = inventory(root),
    observed = JSON.parse(readFileSync(join(root, 'raw.json'), 'utf8'));
  const env = { ALLRICE_RUN_DB_INTEGRATION: '1' };
  const [result] = audit(
    plan.entries,
    observed,
    [dbFile],
    env,
    undefined,
    root,
  );
  expect(result.passed).toBe(1);
  expect(result.deferred.map((item) => item.title)).toEqual([
    'physical docx renderer',
    'physical xlsx renderer',
  ]);
  expect(result.deferred.every((item) => item.group === 'manual')).toBe(true);
  expect(() =>
    audit(
      plan.entries,
      observed,
      [dbFile],
      { ...env, ALLRICE_RUN_CLOUD_INTEGRATION: '1' },
      undefined,
      root,
    ),
  ).toThrow(/Unexpected (pending|skipped)/);
  const incomplete = globalThis.structuredClone(observed);
  incomplete.testResults[0].assertionResults =
    incomplete.testResults[0].assertionResults.filter(
      (test) => test.status === 'passed',
    );
  expect(() =>
    audit(plan.entries, incomplete, [dbFile], env, undefined, root),
  ).toThrow('Missing registered test');
});

function runnableFixture(files, oldSteps = []) {
  const root = fixture(files, oldSteps);
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    'export default {test:{globals:true,includeTaskLocation:true}};',
  );
  writeFileSync(
    join(root, 'scripts/ci-integration-tests.mjs'),
    readFileSync(resolve('scripts/ci-integration-tests.mjs')),
  );
  return root;
}
function execute(root, args, env = {}) {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts/ci-integration-tests.mjs'), 'run', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLRICE_RUN_DB_INTEGRATION: '1', ...env },
    },
  );
}

it('registers the real native-once case-only module path gates as two scheduled cases', () => {
  const file = 'apps/worker/src/native-schedule-once.test.ts';
  const root = fixture({ [file]: readFileSync(resolve(file), 'utf8') }, [
    { run: 'pnpm test' },
  ]);
  const plan = inventory(root);
  expect(plan.entries.find((item) => item.file === file)).toBeDefined();
  expect(plan.additions.db.filter((item) => item.file === file)).toHaveLength(
    2,
  );
});

it('fails unsupported outer conditional and helper registration instead of accepting one ordinary pass', () => {
  const conditional = `it('ordinary',()=>{}); if (${dbGate}) { it('SQL',()=>{}); }`;
  const root = runnableFixture({ [dbFile]: conditional }, [
    { run: 'pnpm test' },
  ]);
  const run = spawnSync(
    process.execPath,
    [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '--root',
      root,
      '--config',
      join(root, 'vitest.config.mjs'),
      '--maxWorkers=1',
      '--reporter=json',
      '--outputFile=' + join(root, 'conditional.json'),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ALLRICE_RUN_DB_INTEGRATION: '' },
    },
  );
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const raw = JSON.parse(readFileSync(join(root, 'conditional.json'), 'utf8'));
  expect(raw.numPassedTests).toBe(1);
  expect(raw.testResults[0].assertionResults.map((test) => test.title)).toEqual(
    ['ordinary'],
  );
  for (const source of [
    `it('ordinary',()=>{}); if (${dbGate}) { it('SQL',()=>{}); }`,
    `it('ordinary',()=>{}); ${dbGate} && it('SQL',()=>{});`,
    `it('ordinary',()=>{}); function register(){it('SQL',()=>{});} register();`,
    `it['runIf'](${dbGate})('SQL',()=>{});`,
    `import * as checks from 'vitest'; it('ordinary',()=>{}); checks.it.runIf(${dbGate})('SQL',()=>{});`,
    `it.for(['SQL'])('SQL',()=>{});`,
  ]) {
    const root = fixture({ [dbFile]: source });
    expect(() => inventory(root)).toThrow('Unsupported registration');
  }
});

it('verifies every expected registration against actual Vitest locations, including each and loop names', () => {
  const source = `it('ordinary',()=>{});
it.each(['a','b'])(
  'parameter %s',()=>{});
for (const name of ['x','y']) {
  it(\`generated \${name}\`,()=>{});
}
it.runIf(${dbGate})('SQL',()=>{});
`;
  const root = runnableFixture({ [dbFile]: source }, [{ run: 'pnpm test' }]);
  const run = execute(root, [
    '--',
    dbFile,
    '--maxWorkers=1',
    '--reporter=json',
    '--outputFile=raw.json',
  ]);
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const report = JSON.parse(readFileSync(join(root, 'raw.json'), 'utf8'));
  const entry = inventory(root).entries[0];
  const env = { ALLRICE_RUN_DB_INTEGRATION: '1' };
  expect(audit([entry], report, [dbFile], env, undefined, root)[0].passed).toBe(
    6,
  );
  const incomplete = globalThis.structuredClone(report);
  incomplete.testResults[0].assertionResults =
    incomplete.testResults[0].assertionResults.filter(
      (test) => test.title !== 'SQL',
    );
  expect(() =>
    audit([entry], incomplete, [dbFile], env, undefined, root),
  ).toThrow('Missing registered test');
});

it('uses actual suite ancestry when SQL and an external child have the same case name', () => {
  const root = runnableFixture({
    [dbFile]: `describe.runIf(${dbGate})('DB',()=>{
  it('same name',()=>{});
  describe.runIf(process.env.ALLRICE_RUN_CLOUD_INTEGRATION === '1')('physical',()=>{
    it('same name',()=>{throw Error('physical fixture must stay deferred');});
  });
});`,
  });
  const entry = inventory(root).entries[0];
  expect(entry.group).toBe('db');
  expect(entry.cases.map((item) => item.group)).toEqual(['db', 'manual']);
  const run = execute(root, [
    '--',
    dbFile,
    '--maxWorkers=1',
    '--reporter=json',
    '--outputFile=raw.json',
  ]);
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = JSON.parse(
    readFileSync(join(root, 'raw.json.collection.json'), 'utf8'),
  );
  expect(receipt.evidence[0].passed).toBe(1);
  expect(receipt.evidence[0].deferred).toHaveLength(1);
  expect(receipt.evidence[0].deferred[0].group).toBe('manual');
});

it('retains both real whole/cases raw reports and collection receipts with a separate summary', () => {
  const mixed = 'apps/worker/src/mixed.integration.test.ts';
  const root = runnableFixture(
    {
      [dbFile]: `describe.runIf(${dbGate})('DB',()=>{
it('whole SQL',()=>{});
});`,
      [mixed]: `it('ordinary',()=>{});
it.runIf(${dbGate})('conditional SQL',()=>{});`,
    },
    [{ run: 'pnpm test' }],
  );
  const run = execute(root, [
    'db',
    '--',
    '--maxWorkers=1',
    '--reporter=json',
    '--outputFile=vitest-auto.json',
  ]);
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const paths = ['vitest-auto-whole.json', 'vitest-auto-cases.json'];
  for (const path of paths) {
    expect(existsSync(join(root, path)), path).toBe(true);
    expect(existsSync(join(root, path + '.collection.json'))).toBe(true);
  }
  const whole = JSON.parse(readFileSync(join(root, paths[0]), 'utf8'));
  const cases = JSON.parse(readFileSync(join(root, paths[1]), 'utf8'));
  expect(whole.testResults.map((test) => test.name)).toEqual([
    join(root, dbFile),
  ]);
  expect(cases.testResults.map((test) => test.name)).toEqual([
    join(root, mixed),
  ]);
  expect(cases.numPassedTests).toBe(1);
  expect(cases.numPendingTests).toBe(1);
  const summary = JSON.parse(
    readFileSync(join(root, 'vitest-auto.json.summary.json'), 'utf8'),
  );
  expect(summary.batches.map((batch) => batch.report)).toEqual(paths);
  expect(existsSync(join(root, 'vitest-auto.json'))).toBe(false);
});
