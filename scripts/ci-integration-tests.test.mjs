import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { auditInstances, inventory } from './ci-integration-tests.mjs';

const roots = [];
const db = 'packages/database/src/new.integration.test.ts';
const gate = "process.env.ALLRICE_RUN_DB_INTEGRATION === '1'";
const manual = 'manual:ALLRICE_RUN_CLOUD_INTEGRATION';
const other = 'manual:ALLRICE_OFFICE_PREVIEW_DIR';
const script = resolve('scripts/ci-integration-tests.mjs');
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture(files, options = {}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'allrice-native-collection-')),
  );
  roots.push(root);
  const save = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const resources = {
    native: [],
    manual: [],
    db: ['ALLRICE_RUN_DB_INTEGRATION'],
    browser: ['ALLRICE_RUN_BROWSER_INTEGRATION'],
    'browser+db': [
      'ALLRICE_RUN_DB_INTEGRATION',
      'ALLRICE_RUN_BROWSER_INTEGRATION',
    ],
  };
  const tags = Object.fromEntries(
    [manual, other].map((name) => [
      name,
      {
        reason: 'Actual external physical fixture',
        command: 'pnpm exec vitest run {file} --maxWorkers=2',
      },
    ]),
  );
  save(
    'scripts/ci-manual-environments.yml',
    stringify({
      resources,
      rules: { db: ['packages/database/'], browser: ['apps/web/'] },
      files: options.files ?? {},
      extra: {},
      tags,
    }),
  );
  const steps = [
    {
      name: 'native',
      run: 'node scripts/ci-integration-tests.mjs run native --',
    },
    ...(options.steps ?? []),
    ...['db', 'browser', 'browser+db'].map((group) => ({
      name: group,
      run: `node scripts/ci-integration-tests.mjs run ${group} --`,
      env: {
        ALLRICE_RUN_DB_INTEGRATION: 1,
        ALLRICE_RUN_BROWSER_INTEGRATION: 1,
      },
    })),
  ];
  save('.github/workflows/ci.yml', stringify({ jobs: { tests: { steps } } }));
  save('package.json', '{"private":true,"type":"module"}');
  save('scripts/ci-integration-tests.mjs', readFileSync(script));
  save(
    'vitest.config.mjs',
    `import {testTags} from './scripts/ci-integration-tests.mjs'; export default {test:{tags:testTags(),${options.config ?? ''}}};`,
  );
  for (const [file, source] of Object.entries(files)) save(file, source);
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'fixture',
  ]);
  return root;
}
function execute(root, group, args = [], env = {}) {
  return spawnSync(
    process.execPath,
    [
      join(root, 'scripts/ci-integration-tests.mjs'),
      'run',
      ...(group ? [group] : []),
      '--',
      '--maxWorkers=1',
      ...args,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ALLRICE_RUN_DB_INTEGRATION: '',
        ALLRICE_RUN_CLOUD_INTEGRATION: '',
        ALLRICE_OFFICE_PREVIEW_DIR: '',
        ...env,
      },
    },
  );
}
function receipts(root) {
  const base = join(root, '.local/integration-collection');
  return readdirSync(base).map((name) => {
    const directory = join(base, name);
    return {
      directory,
      ...JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')),
    };
  });
}
const instances = (receipt) =>
  JSON.parse(
    readFileSync(join(receipt.directory, 'batch.json.instances.json'), 'utf8'),
  );

it('discovers tracked conventional and declared nonstandard files; plans only complete, resource-ready commands', () => {
  const unusual = 'apps/worker/plain.test.ts';
  const root = fixture(
    { [db]: 'it("SQL",()=>{});', [unusual]: 'it("ordinary",()=>{});' },
    {
      files: { db: [unusual] },
      steps: [
        {
          run: `node scripts/ci-integration-tests.mjs run -- ${db} -t 'first'`,
          env: { ALLRICE_RUN_DB_INTEGRATION: 1 },
        },
        {
          run: `node scripts/ci-integration-tests.mjs run -- ${unusual}`,
          env: { ALLRICE_RUN_DB_INTEGRATION: 0 },
        },
      ],
    },
  );
  const plan = inventory(root);
  expect(plan.additions.db).toEqual([unusual, db]);
  expect(plan.entries.every((entry) => !entry.plannedBy.length)).toBe(true);
  const covered = fixture(
    { [db]: '' },
    {
      steps: [
        {
          name: 'complete DB',
          run: 'node scripts/ci-integration-tests.mjs run -- packages/database/src',
          env: { ALLRICE_RUN_DB_INTEGRATION: 1 },
        },
      ],
    },
  );
  expect(inventory(covered).additions.db).toEqual([]);
}, 30_000);

it('rejects unclassified candidates, nonexistent declarations and conflicting assignments', () => {
  expect(() =>
    inventory(fixture({ 'unknown/new.integration.test.ts': '' })),
  ).toThrow('Unclassified');
  expect(() => inventory(fixture({}, { files: { db: [db] } }))).toThrow(
    'Missing or conflicting',
  );
  expect(() =>
    inventory(fixture({ [db]: '' }, { files: { db: [db], browser: [db] } })),
  ).toThrow('Missing or conflicting');
}, 30_000);

it('uses one real run for dynamic each/map/loops; a native ordinary instance never satisfies whole-file DB responsibility', () => {
  const root = fixture({
    [db]: `import {it} from 'vitest';
const modes = ${gate} ? ['ordinary','SQL'] : ['ordinary'];
it.each(modes)('%s',()=>{});
for (const name of ['loop-a','loop-b']) it(name,()=>{});
it.each(['x','y'].map(x=>[x]))('mapped %s',()=>{});`,
  });
  const native = execute(root, 'native');
  expect(native.status, native.stdout + native.stderr).toBe(0);
  const first = receipts(root)[0];
  const ordinary = instances(first).instances;
  expect(ordinary).toHaveLength(5);
  expect(ordinary.every((item) => !item.responsible)).toBe(true);
  const full = execute(root, 'db', [], { ALLRICE_RUN_DB_INTEGRATION: '1' });
  expect(full.status, full.stdout + full.stderr).toBe(0);
  const second = receipts(root).find(
    (receipt) => receipt.directory !== first.directory,
  );
  expect(instances(second).instances).toHaveLength(6);
  expect(
    instances(second).instances.every(
      (item) => item.responsible && item.state === 'passed',
    ),
  ).toBe(true);
  const raw = JSON.parse(readFileSync(second.report, 'utf8'));
  expect(raw.numPassedTests).toBe(6);
  expect(
    raw.testResults[0].assertionResults.some((item) =>
      Object.hasOwn(item, 'id'),
    ),
  ).toBe(false);
  expect(new Set(instances(second).instances.map((item) => item.id)).size).toBe(
    6,
  );
}, 30_000);

it('keeps ordinary SQL automatic and parameterized external leaves manual, including inherited suite tags', () => {
  const root = fixture({
    [db]: `import {describe,it} from 'vitest';
describe.runIf(${gate})('DB',()=>{
it('same name',()=>{});
describe.skipIf(!process.env.ALLRICE_RUN_CLOUD_INTEGRATION)('physical',{tags:['${manual}']},()=>{
it.each(['docx','xlsx'])('same name %s',()=>{throw Error('external prerequisite is absent');});
});
});`,
  });
  const run = execute(root, 'db', [], { ALLRICE_RUN_DB_INTEGRATION: '1' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = receipts(root)[0];
  expect(receipt.counts).toMatchObject({ passed: 1, skipped: 2, pending: 0 });
  const physical = instances(receipt).instances.filter((item) => item.manual);
  expect(physical).toHaveLength(2);
  expect(physical.every((item) => item.disposition === 'manual')).toBe(true);
}, 30_000);

it('accepts all-manual files with independent gates as zero passes instead of taking a gate intersection', () => {
  const root = fixture(
    {
      [db]: `import {it} from 'vitest';
it.skipIf(!process.env.ALLRICE_RUN_CLOUD_INTEGRATION)('cloud',{tags:['${manual}']},()=>{});
it.skipIf(!process.env.ALLRICE_OFFICE_PREVIEW_DIR)('office',{tags:['${other}']},()=>{});`,
    },
    { files: { manual: [db] } },
  );
  const run = execute(root, 'native');
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = receipts(root)[0];
  expect(receipt.counts).toMatchObject({ passed: 0, skipped: 2 });
  expect(
    instances(receipt).instances.every(
      (item) => item.manual && !item.responsible,
    ),
  ).toBe(true);
}, 30_000);

it('rejects a visible unclassified native skip, enabled resource skip and unknown native tag', () => {
  for (const [source, env] of [
    [`it.skip('ordinary',()=>{});`, {}],
    [`it.skip('SQL',()=>{});`, { ALLRICE_RUN_DB_INTEGRATION: '1' }],
    [`it.skip('unknown',{tags:['manual:UNKNOWN']},()=>{});`, {}],
  ]) {
    const root = fixture({ [db]: `import {it} from 'vitest'; ${source}` });
    const run = execute(root, null, [db], env);
    if (!env.ALLRICE_RUN_DB_INTEGRATION && !source.includes('UNKNOWN')) {
      // Use an undeclared-resource ordinary file for the native-skip branch.
      const ordinary = 'apps/worker/ordinary.test.ts';
      const otherRoot = fixture(
        { [ordinary]: `import {it} from 'vitest'; ${source}` },
        { files: { native: [ordinary] } },
      );
      expect(execute(otherRoot, 'native').status).toBe(1);
    } else expect(run.status, run.stdout + run.stderr).toBe(1);
  }
}, 30_000);

it('cannot wash away a missing parameter instance, missing result callback, module or unhandled error', () => {
  const root = fixture({
    [db]: `import {it} from 'vitest'; it.each(['a','b'])('%s',()=>{});`,
  });
  const run = execute(root, 'db', [], { ALLRICE_RUN_DB_INTEGRATION: '1' });
  expect(run.status, run.stdout + run.stderr).toBe(0);
  const receipt = receipts(root)[0];
  const batch = JSON.parse(
    readFileSync(join(receipt.directory, 'batch.json'), 'utf8'),
  );
  const tests = instances(receipt).instances;
  const collected = {
    [db]: tests.map(({ id, name, tags, location }) => ({
      id,
      name,
      tags,
      location,
    })),
  };
  const results = Object.fromEntries(
    tests.map((test) => [test.id, ['passed']]),
  );
  const module = { file: db, ended: true, state: 'passed', errors: [], tests };
  const audit = (mods, events = results, errors = []) =>
    auditInstances(batch, collected, events, mods, errors, 'passed');
  expect(
    audit([{ ...module, tests: tests.slice(0, 1) }]).errors.join(),
  ).toMatch('Missing/changed instance');
  expect(audit([module], { [tests[0].id]: ['passed'] }).errors.join()).toMatch(
    'Missing case result event',
  );
  expect(audit([]).errors.join()).toMatch('Missing/empty/unfinished module');
  expect(
    audit([module], results, ['unhandled rejection']).errors.join(),
  ).toMatch('unhandled rejection');
}, 30_000);

it('retains distinct original raw reports and failure receipts when a batch fails or never produces JSON', () => {
  const root = fixture({
    [db]: `import {it} from 'vitest'; it('fails',()=>{throw Error('original failure');});`,
  });
  const failed = execute(root, 'db', [], { ALLRICE_RUN_DB_INTEGRATION: '1' });
  expect(failed.status).toBe(1);
  const first = receipts(root)[0];
  expect(first.complete).toBe(false);
  expect(JSON.parse(readFileSync(first.report, 'utf8')).numFailedTests).toBe(1);
  const missing = execute(root, 'db', ['--config=absent.config.mjs'], {
    ALLRICE_RUN_DB_INTEGRATION: '1',
  });
  expect(missing.status).toBe(1);
  const all = receipts(root);
  expect(all).toHaveLength(2);
  expect(
    all.every((receipt) => !receipt.complete && receipt.exitCode === 1),
  ).toBe(true);
  expect(JSON.parse(readFileSync(first.report, 'utf8')).numFailedTests).toBe(1);
}, 30_000);

it('rejects a responsible file omitted by Vitest despite another passing file and records filtered runs as partial', () => {
  const omitted = 'packages/database/src/omitted.integration.test.ts';
  const root = fixture(
    {
      [db]: `import {it} from 'vitest'; it('selected',()=>{}); it('other',()=>{});`,
      [omitted]: `import {it} from 'vitest'; it('missing',()=>{});`,
    },
    { config: "exclude:['**/omitted.integration.test.ts']" },
  );
  const run = execute(root, 'db', [], { ALLRICE_RUN_DB_INTEGRATION: '1' });
  expect(run.status, run.stdout + run.stderr).toBe(1);
  expect(receipts(root)[0].error).toMatch('Missing/empty/unfinished module');
  const partial = execute(root, null, [db, '-t', 'selected'], {
    ALLRICE_RUN_DB_INTEGRATION: '1',
  });
  expect(partial.status, partial.stdout + partial.stderr).toBe(0);
  const second = receipts(root).find((receipt) => receipt.complete);
  expect(instances(second).instances.every((item) => !item.responsible)).toBe(
    true,
  );
  expect(
    instances(second).instances.find((item) => item.state === 'skipped')
      .disposition,
  ).toBe('filtered');
}, 30_000);
