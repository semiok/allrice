import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
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
import { afterEach, beforeEach, test as it } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { stringify } from 'yaml';
import { auditInstances, inventory } from './ci-integration-tests.mjs';

const roots = [];
let activeSignal;
beforeEach((context) => {
  activeSignal = context.signal;
});
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
    'manual-db': ['ALLRICE_RUN_DB_INTEGRATION'],
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
        command: `${name.slice(7)}=1 pnpm exec vitest run {file} --maxWorkers=2`,
      },
    ]),
  );
  save(
    'scripts/ci-manual-environments.yml',
    stringify({
      resources,
      rules: { db: ['packages/database/'], browser: ['apps/web/'] },
      files: options.files ?? {},
      extra: options.extra ?? {},
      tags: { ...tags, ...options.tags },
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
async function execute(root, group, args = [], env = {}, timeout = 20000) {
  const child = spawn(
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
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ALLRICE_RUN_DB_INTEGRATION: '',
        ALLRICE_RUN_CLOUD_INTEGRATION: '',
        ALLRICE_OFFICE_PREVIEW_DIR: '',
        ...env,
      },
    },
  );
  let stdout = '',
    stderr = '',
    timedOut = false;
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  const stop = () => {
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeout);
  const signal = activeSignal;
  const interrupt = () => {
    stop();
    process.exit(130);
  };
  const terminate = () => {
    stop();
    process.exit(143);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  signal.addEventListener('abort', stop, { once: true });
  try {
    const [status, signal] = await once(child, 'close');
    return { status, signal, stdout, stderr, timedOut, pid: child.pid };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    stop();
  }
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

it(
  'discovers tracked conventional and declared nonstandard files; plans only complete, resource-ready commands',
  { timeout: 30_000 },
  async () => {
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
    assert.deepEqual(plan.additions.db, [unusual, db]);
    assert.equal(
      plan.entries.every((entry) => !entry.plannedBy.length),
      true,
    );
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
    assert.deepEqual(inventory(covered).additions.db, []);
  },
);

it(
  'rejects unclassified candidates, nonexistent declarations and conflicting assignments',
  { timeout: 30_000 },
  async () => {
    assert.throws(
      () => inventory(fixture({ 'unknown/new.integration.test.ts': '' })),
      new RegExp('Unclassified'),
    );
    assert.throws(
      () => inventory(fixture({}, { files: { db: [db] } })),
      new RegExp('Missing or conflicting'),
    );
    assert.throws(
      () =>
        inventory(
          fixture({ [db]: '' }, { files: { db: [db], browser: [db] } }),
        ),
      new RegExp('Missing or conflicting'),
    );
    assert.throws(
      () =>
        inventory(fixture({}, { extra: { ALLRICE_RUN_DB_INTEGRATION: [db] } })),
      new RegExp('Missing resource prerequisite file'),
    );
  },
);

it(
  'uses one real run for dynamic each/map/loops; a native ordinary instance never satisfies whole-file DB responsibility',
  { timeout: 30_000 },
  async () => {
    const root = fixture({
      [db]: `import {it} from 'vitest';
const modes = ${gate} ? ['ordinary','SQL'] : ['ordinary'];
it.each(modes)('%s',()=>{});
for (const name of ['loop-a','loop-b']) it(name,()=>{});
it.each(['x','y'].map(x=>[x]))('mapped %s',()=>{});`,
    });
    const native = await execute(root, 'native');
    assert.equal(native.status, 0, native.stdout + native.stderr);
    const first = receipts(root)[0];
    const ordinary = instances(first).instances;
    assert.equal(ordinary.length, 5);
    assert.equal(
      ordinary.every((item) => !item.responsible),
      true,
    );
    const full = await execute(root, 'db', ['--outputFile=original.json'], {
      ALLRICE_RUN_DB_INTEGRATION: '1',
    });
    assert.equal(full.status, 0, full.stdout + full.stderr);
    const second = receipts(root).find(
      (receipt) => receipt.directory !== first.directory,
    );
    assert.equal(instances(second).instances.length, 6);
    assert.equal(
      instances(second).instances.every(
        (item) => item.responsible && item.state === 'passed',
      ),
      true,
    );
    const original = readFileSync(join(root, second.report), 'utf8');
    assert.equal(
      readFileSync(join(second.directory, 'vitest.json'), 'utf8'),
      original,
    );
    const raw = JSON.parse(original);
    assert.equal(raw.numPassedTests, 6);
    assert.equal(
      raw.testResults[0].assertionResults.some((item) =>
        Object.hasOwn(item, 'id'),
      ),
      false,
    );
    assert.equal(
      new Set(instances(second).instances.map((item) => item.id)).size,
      6,
    );
    assert.equal(
      (
        await execute(root, 'db', ['--outputFile=original.json'], {
          ALLRICE_RUN_DB_INTEGRATION: '1',
        })
      ).status,
      1,
    );
    assert.equal(readFileSync(join(root, 'original.json'), 'utf8'), original);
    assert.ok(
      receipts(root)
        .find((receipt) => !receipt.complete)
        .error.includes('Original report already exists'),
    );
  },
);

it(
  'keeps ordinary SQL automatic and parameterized external leaves manual, including inherited suite tags',
  { timeout: 30_000 },
  async () => {
    const root = fixture({
      [db]: `import {describe,it} from 'vitest';
describe.runIf(${gate})('DB',()=>{
it('same name',()=>{});
describe.skipIf(!process.env.ALLRICE_RUN_CLOUD_INTEGRATION)('physical',{tags:['${manual}']},()=>{
it.each(['docx','xlsx'])('same name %s',()=>{throw Error('external prerequisite is absent');});
});
});`,
    });
    const run = await execute(root, 'db', [], {
      ALLRICE_RUN_DB_INTEGRATION: '1',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const receipt = receipts(root)[0];
    assert.partialDeepStrictEqual(receipt.counts, {
      passed: 1,
      skipped: 2,
      pending: 0,
    });
    const physical = instances(receipt).instances.filter((item) => item.manual);
    assert.equal(physical.length, 2);
    assert.equal(
      physical.every((item) => item.disposition === 'manual'),
      true,
    );
    assert.equal(
      physical.every(
        (item) =>
          item.command.includes('ALLRICE_RUN_DB_INTEGRATION=1') &&
          item.command.includes('ALLRICE_RUN_CLOUD_INTEGRATION=1'),
      ),
      true,
    );
  },
);

it(
  'accepts all-manual files with independent gates as zero passes instead of taking a gate intersection',
  { timeout: 30_000 },
  async () => {
    const root = fixture(
      {
        [db]: `import {it} from 'vitest';
it.skipIf(!process.env.ALLRICE_RUN_CLOUD_INTEGRATION)('cloud',{tags:['${manual}']},()=>{});
it.skipIf(!process.env.ALLRICE_OFFICE_PREVIEW_DIR)('office',{tags:['${other}']},()=>{});`,
      },
      { files: { 'manual-db': [db] } },
    );
    const run = await execute(root, 'native');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const receipt = receipts(root)[0];
    assert.partialDeepStrictEqual(receipt.counts, { passed: 0, skipped: 2 });
    assert.equal(
      instances(receipt).instances.every(
        (item) => item.manual && !item.responsible,
      ),
      true,
    );
  },
);

it(
  'rejects a visible unclassified native skip, enabled resource skip and unknown native tag',
  { timeout: 30_000 },
  async () => {
    for (const [source, env] of [
      [`it.skip('ordinary',()=>{});`, {}],
      [`it.skip('SQL',()=>{});`, { ALLRICE_RUN_DB_INTEGRATION: '1' }],
      [`it.skip('unknown',{tags:['manual:UNKNOWN']},()=>{});`, {}],
    ]) {
      const root = fixture({ [db]: `import {it} from 'vitest'; ${source}` });
      const run = await execute(root, null, [db], env);
      if (!env.ALLRICE_RUN_DB_INTEGRATION && !source.includes('UNKNOWN')) {
        // Use an undeclared-resource ordinary file for the native-skip branch.
        const ordinary = 'apps/worker/ordinary.test.ts';
        const otherRoot = fixture(
          { [ordinary]: `import {it} from 'vitest'; ${source}` },
          { files: { native: [ordinary] } },
        );
        assert.equal((await execute(otherRoot, 'native')).status, 1);
      } else assert.equal(run.status, 1, run.stdout + run.stderr);
    }
  },
);

it(
  'cannot wash away a missing parameter instance, missing result callback, module or unhandled error',
  { timeout: 30_000 },
  async () => {
    const root = fixture({
      [db]: `import {it} from 'vitest'; it.each(['a','b'])('%s',()=>{});`,
    });
    const run = await execute(root, 'db', [], {
      ALLRICE_RUN_DB_INTEGRATION: '1',
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
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
    const module = {
      file: db,
      ended: true,
      state: 'passed',
      errors: [],
      tests,
    };
    const audit = (mods, events = results, errors = []) =>
      auditInstances(batch, collected, events, mods, errors, 'passed');
    assert.ok(
      audit([{ ...module, tests: tests.slice(0, 1) }])
        .errors.join()
        .includes('Missing/changed instance'),
    );
    assert.ok(
      audit([module], { [tests[0].id]: ['passed'] })
        .errors.join()
        .includes('Missing case result event'),
    );
    assert.ok(
      audit([]).errors.join().includes('Missing/empty/unfinished module'),
    );
    assert.ok(
      audit([module], results, ['unhandled rejection'])
        .errors.join()
        .includes('unhandled rejection'),
    );
  },
);

it(
  'retains distinct original raw reports and failure receipts when a batch fails or never produces JSON',
  { timeout: 30_000 },
  async () => {
    const root = fixture({
      [db]: `import {it} from 'vitest'; it('fails',()=>{throw Error('original failure');});`,
    });
    const failed = await execute(root, 'db', [], {
      ALLRICE_RUN_DB_INTEGRATION: '1',
    });
    assert.equal(failed.status, 1);
    const first = receipts(root)[0];
    assert.equal(first.complete, false);
    assert.equal(
      JSON.parse(readFileSync(first.report, 'utf8')).numFailedTests,
      1,
    );
    const missing = await execute(root, 'db', ['--config=absent.config.mjs'], {
      ALLRICE_RUN_DB_INTEGRATION: '1',
    });
    assert.equal(missing.status, 1);
    const all = receipts(root);
    assert.equal(all.length, 2);
    assert.equal(
      all.every((receipt) => !receipt.complete && receipt.exitCode === 1),
      true,
    );
    assert.equal(
      JSON.parse(readFileSync(first.report, 'utf8')).numFailedTests,
      1,
    );
    const stuck = fixture({
      [db]: `import {it} from 'vitest'; import {writeFileSync} from 'node:fs'; writeFileSync('worker.pid',String(process.pid)); it('waits',()=>new Promise(()=>{}));`,
    });
    const stopped = await execute(
      stuck,
      'db',
      ['--testTimeout=60000'],
      { ALLRICE_RUN_DB_INTEGRATION: '1' },
      5000,
    );
    assert.equal(stopped.timedOut, true);
    assert.equal(stopped.signal, 'SIGKILL');
    assert.equal(
      Number(readFileSync(join(stuck, 'worker.pid'), 'utf8')) > 0,
      true,
    );
    assert.equal(receipts(stuck)[0].complete, false);
  },
);

it(
  'rejects a responsible file omitted by Vitest despite another passing file and records filtered runs as partial',
  { timeout: 30_000 },
  async () => {
    const omitted = 'packages/database/src/omitted.integration.test.ts';
    const root = fixture(
      {
        [db]: `import {it} from 'vitest'; it('selected',()=>{}); it('other',()=>{});`,
        [omitted]: `import {it} from 'vitest'; it('missing',()=>{});`,
      },
      { config: "exclude:['**/omitted.integration.test.ts']" },
    );
    const run = await execute(root, 'db', [], {
      ALLRICE_RUN_DB_INTEGRATION: '1',
    });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.ok(
      receipts(root)[0].error.includes('Missing/empty/unfinished module'),
    );
    const partial = await execute(root, null, [db, '-t', 'selected'], {
      ALLRICE_RUN_DB_INTEGRATION: '1',
    });
    assert.equal(partial.status, 0, partial.stdout + partial.stderr);
    const second = receipts(root).find((receipt) => receipt.complete);
    assert.equal(
      instances(second).instances.every((item) => !item.responsible),
      true,
    );
    assert.equal(
      instances(second).instances.find((item) => item.state === 'skipped')
        .disposition,
      'filtered',
    );
  },
);

it(
  'classifies visible platform skips using declared OS support and rejects a skip on the supported platform',
  { timeout: 30_000 },
  async () => {
    const file = 'apps/worker/platform.test.ts';
    for (const supported of [false, true]) {
      const root = fixture(
        {
          [file]:
            "import {it} from 'vitest'; it.skip('platform',{tags:['platform:fixture']},()=>{});",
        },
        {
          files: { native: [file] },
          tags: {
            'platform:fixture': {
              platforms: [
                supported
                  ? process.platform
                  : process.platform === 'darwin'
                    ? 'linux'
                    : 'darwin',
              ],
              reason: 'Exact fixture platform prerequisite',
              command: 'pnpm exec vitest run {file} --maxWorkers=2',
            },
          },
        },
      );
      const run = await execute(root, 'native');
      assert.equal(run.status, supported ? 1 : 0, run.stdout + run.stderr);
      if (!supported)
        assert.equal(
          instances(receipts(root)[0]).instances[0].disposition,
          'manual',
        );
    }
  },
);
