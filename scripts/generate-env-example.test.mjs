import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { generateExample } from './generate-env-example.mjs';

const roots = [];
const script = fileURLToPath(
  new URL('./generate-env-example.mjs', import.meta.url),
);
const policy = () => ({
  examples: {},
  definitions: [],
  calls: {},
  exclude: {},
  audit: {},
});
function fixture(files, settings = policy()) {
  const root = mkdtempSync(join(tmpdir(), 'allrice-env-example-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'scripts/env-example-policy.yml'),
    JSON.stringify(settings),
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}
const cli = (root, args = [], extraEnvironment = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, ...extraEnvironment },
    encoding: 'utf8',
    timeout: 10000,
  });
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

test('source additions/deletions cause real check drift; generation repairs both', () => {
  const root = fixture({ 'apps/web/config.ts': 'process.env.ALLRICE_FIRST;' });
  expect(cli(root).status).toBe(0);
  expect(cli(root, ['--check']).status).toBe(0);
  writeFileSync(
    join(root, 'apps/web/config.ts'),
    'process.env.ALLRICE_FIRST; process.env.ALLRICE_ADDED;',
  );
  expect(cli(root, ['--check']).stderr).toContain('.env.example drift');
  expect(cli(root).status).toBe(0);
  expect(cli(root, ['--check']).status).toBe(0);
  expect(readFileSync(join(root, '.env.example'), 'utf8')).toContain(
    '# ALLRICE_ADDED=',
  );
  writeFileSync(join(root, 'apps/web/config.ts'), 'process.env.ALLRICE_ADDED;');
  expect(cli(root, ['--check']).status).not.toBe(0);
  expect(cli(root).status).toBe(0);
  expect(cli(root, ['--check']).status).toBe(0);
  expect(readFileSync(join(root, '.env.example'), 'utf8')).not.toContain(
    'ALLRICE_FIRST=',
  );
});

test('never executes source or copies source defaults, ambient values or env files', () => {
  const root = fixture({
    'apps/web/config.mjs':
      "throw Error('MUST_NOT_EXECUTE'); const value = process.env.ALLRICE_SECRET ?? 'SOURCE_PRIVATE_DEFAULT';",
    '.env': 'ALLRICE_SECRET=SYNTHETIC_DOTENV_CANARY',
    'shared.env': 'ALLRICE_SECRET=SYNTHETIC_SHARED_CANARY',
  });
  expect(
    cli(root, [], { ALLRICE_SECRET: 'AMBIENT_SECRET_CANARY' }).status,
  ).toBe(0);
  const generated = readFileSync(join(root, '.env.example'), 'utf8');
  expect(generated).toContain('# ALLRICE_SECRET=');
  expect(generated).not.toMatch(
    /MUST_NOT_EXECUTE|SOURCE_PRIVATE_DEFAULT|CANARY/,
  );
  expect(
    cli(root, ['--check'], { ALLRICE_SECRET: 'DIFFERENT_SECRET_CANARY' })
      .status,
  ).toBe(0);
});

test('uses lexical env bindings, literal indices and optional global process access', () => {
  const root = fixture({
    'packages/example/config.ts': `
    const env = process['env'];
    env.ALLRICE_ALIAS; process.env['ALLRICE_INDEX']; globalThis.process?.env?.ALLRICE_GLOBAL;
    function read(environment: NodeJS.ProcessEnv) { return environment.ALLRICE_TYPED; }
    function unrelated(env: Record<string, string>) { return env.NOT_AN_ENVIRONMENT; }
  `,
  });
  const generated = generateExample(root);
  expect(generated.published).toBe(4);
  for (const name of ['ALIAS', 'INDEX', 'GLOBAL', 'TYPED'])
    expect(generated.text).toContain(`# ALLRICE_${name}=`);
  expect(generated.text).not.toContain('NOT_AN_ENVIRONMENT=');
});

test('test/fixture/tool/child scopes are excluded; developer runtime helper is included', () => {
  const root = fixture({
    'apps/web/config.ts': 'process.env.ALLRICE_PUBLIC;',
    'apps/web/config.test.ts': 'process.env.ALLRICE_TEST_ONLY;',
    'packages/example/fixtures/input.ts': 'process.env.ALLRICE_FIXTURE_ONLY;',
    'apps/worker/test/host.mjs': 'process.env.ALLRICE_HOST_ONLY;',
    'apps/worker/dsh/child.mjs': 'process.env.ALLRICE_CHILD_IPC;',
    'scripts/deploy.mjs': 'process.env.ALLRICE_DEPLOY_TOOL;',
    'scripts/dev-environment.mjs': 'process.env.ALLRICE_DEV_SETTING;',
  });
  const generated = generateExample(root);
  expect(generated.files).toBe(2);
  expect(generated.published).toBe(2);
  expect(generated.text).toContain('# ALLRICE_DEV_SETTING=');
  expect(generated.text).not.toMatch(
    /ALLRICE_(TEST_ONLY|FIXTURE_ONLY|HOST_ONLY|CHILD_IPC|DEPLOY_TOOL)=/,
  );
});

test('internal controls require reasons and cannot become active safe examples', () => {
  const settings = policy();
  settings.exclude['^ALLRICE_INTERNAL$'] =
    'Internal process protocol, not deployment configuration.';
  const root = fixture(
    {
      'apps/web/config.ts':
        'process.env.ALLRICE_PUBLIC; process.env.ALLRICE_INTERNAL;',
    },
    settings,
  );
  const generated = generateExample(root, settings);
  expect(generated.omitted).toBe(1);
  expect(generated.text).not.toContain('ALLRICE_INTERNAL=');
  settings.examples.ALLRICE_INTERNAL = '1';
  expect(() => generateExample(root, settings)).toThrow(
    'Invalid/stale safe example',
  );
});

test('known literal declarations/field definitions and named helper arguments supply names', () => {
  const settings = policy();
  settings.definitions = [
    'packages/example/config.ts#flags',
    'packages/example/config.ts#passwordEnvironmentVariable',
  ];
  settings.calls['packages/example/config.ts#required'] = 0;
  settings.audit['packages/example/config.ts#process.env[name]'] =
    'The named helper callers are literal; no arbitrary evaluation.';
  const root = fixture(
    {
      'packages/example/config.ts': `
    const flags = { enabled: ['ALLRICE_TABLE'], timeout: { env: 'ALLRICE_LIMIT', default: 100 } } as const;
    const portal = { passwordEnvironmentVariable: 'ALLRICE_PASSWORD' };
    function required(name: string) { return process.env[name]; }
    required('ALLRICE_HELPER');
  `,
    },
    settings,
  );
  const generated = generateExample(root);
  expect(generated.published).toBe(4);
  for (const name of ['TABLE', 'LIMIT', 'PASSWORD', 'HELPER'])
    expect(generated.text).toContain(`# ALLRICE_${name}=`);
  expect(generated.audits['packages/example/config.ts#process.env[name]']).toBe(
    1,
  );
});

test('computed declarations and non-literal helper arguments fail closed', () => {
  const settings = policy();
  settings.definitions = ['apps/web/config.ts#flags'];
  const root = fixture(
    {
      'apps/web/config.ts': "const flags = ['ALLRICE_FIRST', ...dynamicFlags];",
    },
    settings,
  );
  expect(() => generateExample(root)).toThrow('Non-literal declaration');
  settings.definitions = [];
  settings.calls['apps/web/config.ts#required'] = 0;
  writeFileSync(join(root, 'apps/web/config.ts'), 'required(dynamicName);');
  expect(() => generateExample(root, settings)).toThrow(
    'Non-literal environment argument',
  );
});

test('new dynamic/whole/embedded reads are never silently ignored', () => {
  const root = fixture({ 'apps/web/config.ts': 'process.env[dynamicName];' });
  expect(() => generateExample(root)).toThrow('Unaudited environment access');
  writeFileSync(
    join(root, 'apps/web/config.ts'),
    'const env = process.env; const alias = env; alias.ALLRICE_HIDDEN;',
  );
  expect(() => generateExample(root)).toThrow('config.ts#alias');
  writeFileSync(
    join(root, 'apps/web/config.ts'),
    'const proc = process; proc.env.ALLRICE_HIDDEN;',
  );
  expect(() => generateExample(root)).toThrow('config.ts#alias');
  writeFileSync(
    join(root, 'apps/web/config.ts'),
    'const child = {...process.env};',
  );
  expect(() => generateExample(root)).toThrow('config.ts#whole');
  writeFileSync(
    join(root, 'apps/web/config.ts'),
    'const child = `process.env.CHILD_KEY`;',
  );
  expect(() => generateExample(root)).toThrow('config.ts#embedded');
});

test('opaque audit instance changes alter the generated receipt digest', () => {
  const settings = policy();
  settings.audit['apps/web/config.ts#env[name]'] =
    'Unresolved parameter domain, outside complete coverage.';
  const root = fixture(
    {
      'apps/web/config.ts':
        'function read(env = process.env, name) { return env[name]; }',
    },
    settings,
  );
  const original = generateExample(root);
  expect(original.audits['apps/web/config.ts#env[name]']).toBe(1);
  expect(original.text).toContain('outside complete coverage');
  expect(original.text).toContain('scripts/env-example-policy.yml');
  writeFileSync(
    join(root, 'apps/web/config.ts'),
    'function read(env = process.env, name) { return env[name] || env[name]; }',
  );
  const changed = generateExample(root);
  expect(changed.audits['apps/web/config.ts#env[name]']).toBe(2);
  expect(changed.text).not.toBe(original.text);
});

test('stale safe examples, source selectors, audits and exclusions require correction', () => {
  const root = fixture({
    'apps/web/config.ts': 'process.env.ALLRICE_CURRENT;',
  });
  for (const settings of [
    { ...policy(), examples: { ALLRICE_REMOVED: '' } },
    { ...policy(), definitions: ['apps/web/config.ts#removed'] },
    { ...policy(), calls: { 'apps/web/config.ts#removed': 0 } },
    {
      ...policy(),
      audit: { 'apps/web/config.ts#removed': 'Previously reviewed.' },
    },
    { ...policy(), exclude: { '^ALLRICE_REMOVED$': 'Internal.' } },
  ])
    expect(() => generateExample(root, settings)).toThrow(/stale/i);
});

test('generation is deterministic, deduplicates shared reads and preserves reviewed safe values', () => {
  const settings = policy();
  settings.examples.ALLRICE_LOCAL = 'http://localhost:3000';
  const root = fixture(
    {
      'apps/web/config.ts':
        'process.env.ALLRICE_LOCAL; process.env.ALLRICE_SHARED;',
      'packages/example/config.mjs': 'process.env.ALLRICE_SHARED;',
    },
    settings,
  );
  const first = generateExample(root);
  expect(generateExample(root).text).toBe(first.text);
  expect(first.published).toBe(2);
  expect(first.text).toContain('ALLRICE_LOCAL=http://localhost:3000');
  expect(first.text.match(/^# ALLRICE_SHARED=$/gm)).toHaveLength(1);
});
