import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
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
  auditSources: {},
});
function fixture(files, settings = policy()) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'allrice-env-example-')),
  );
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const id of Object.keys(settings.audit)) {
    const file = id.split('#')[0];
    settings.auditSources[file] = createHash('sha256')
      .update(files[file])
      .digest('hex');
  }
  writeFileSync(
    join(root, 'scripts/env-example-policy.yml'),
    JSON.stringify(settings),
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}
// Explicit approval of synthetic fixture bytes only; the product has no refresh command.
function approveFixtureSource(root, settings, file) {
  settings.auditSources[file] = createHash('sha256')
    .update(readFileSync(join(root, file)))
    .digest('hex');
  writeFileSync(
    join(root, 'scripts/env-example-policy.yml'),
    JSON.stringify(settings),
  );
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
  writeFileSync(
    join(root, 'apps/web/config.ts'),
    'declare function required(name: string): string; function read(dynamicName: string) { return required(dynamicName); }',
  );
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
  expect(() => generateExample(root)).toThrow('Stale source audit');
  approveFixtureSource(root, settings, 'apps/web/config.ts');
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

test('same-count real desktop allowlist changes invalidate source approval before writing', () => {
  const file = 'apps/rice-bridge/src/desktop-update.ts';
  const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const settings = policy();
  settings.audit[file + '#environment[key]'] =
    'Reviewed OS allowlist, no inferred application keys.';
  const root = fixture({ [file]: source }, settings);
  expect(cli(root).status).toBe(0);
  expect(generateExample(root).audits[file + '#environment[key]']).toBe(2);
  const original = readFileSync(join(root, '.env.example'), 'utf8');
  const changed = source.replace(
    "'LC_ALL']",
    "'LC_ALL', 'ALLRICE_NEW_CONFIGURATION']",
  );
  expect(changed).not.toBe(source);
  writeFileSync(join(root, file), changed);
  for (const args of [['--check'], []]) {
    const result = cli(root, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stale source audit: ' + file);
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe(original);
  }
});

test('same-count embedded payload changes invalidate approval without any binding escape', () => {
  const file = 'packages/example/child.ts';
  const settings = policy();
  settings.audit[file + '#embedded'] =
    'Reviewed embedded child, outside root config.';
  const root = fixture(
    { [file]: "export const child = 'process.env.ALLRICE_OLD';" },
    settings,
  );
  expect(cli(root).status).toBe(0);
  const original = readFileSync(join(root, '.env.example'), 'utf8');
  writeFileSync(
    join(root, file),
    "export const child = 'process.env.ALLRICE_NEW';",
  );
  const result = cli(root, ['--check']);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Stale source audit');
  expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe(original);
  settings.audit[file + '#embedded'] =
    'Explicitly re-reviewed changed synthetic payload.';
  approveFixtureSource(root, settings, file);
  expect(cli(root, ['--check']).stderr).toContain('.env.example drift');
  expect(cli(root).status).toBe(0);
  expect(cli(root, ['--check']).status).toBe(0);
});

test('known env values cannot escape through spread, shorthand, calls, return or export', () => {
  const file = 'apps/web/config.ts';
  const baseline = 'const env = process.env; env.ALLRICE_BASELINE;';
  const root = fixture({ [file]: baseline }); // No opaque audit/hash can mask P2-2.
  expect(cli(root).status).toBe(0);
  const original = readFileSync(join(root, '.env.example'), 'utf8');
  for (const escape of [
    'const copied = {...env}; copied.ALLRICE_HIDDEN;',
    'const copied = {env}; copied.env.ALLRICE_HIDDEN;',
    'Object.assign({}, env);',
    'consume(env);',
    'function copied() { return env; }',
    'export {env};',
  ]) {
    writeFileSync(join(root, file), baseline + escape);
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Unaudited environment access: ' + file + '#whole',
    );
    expect(result.stderr).not.toContain('Stale source audit');
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe(original);
  }
});

test('canonical default process bindings work; local process/globalThis shadows do not leak names', () => {
  const root = fixture({
    'apps/web/config.ts': `
    import runtimeProcess from 'node:process';
    runtimeProcess.env.ALLRICE_IMPORTED;
    globalThis.process?.env?.ALLRICE_GLOBAL;
    function local(process: {env: Record<string,string>}, globalThis: {process: {env: Record<string,string>}}) {
      return [process.env.NOT_A_SETTING, globalThis.process.env.NOT_A_SETTING_EITHER];
    }
  `,
  });
  const result = generateExample(root);
  expect(result.published).toBe(2);
  expect(result.text).toContain('# ALLRICE_IMPORTED=');
  expect(result.text).not.toContain('NOT_A_SETTING');
});

test('unsupported process import and re-export variations fail independently of source hashes', () => {
  const file = 'apps/web/config.ts';
  const root = fixture({ [file]: 'export const baseline = {};' });
  expect(cli(root).status).toBe(0);
  const original = readFileSync(join(root, '.env.example'), 'utf8');
  for (const source of [
    "import {env as deployment} from 'node:process'; deployment.ALLRICE_HIDDEN;",
    "import {env} from 'process'; env.ALLRICE_HIDDEN;",
    "import * as deployment from 'node:process'; deployment.env.ALLRICE_HIDDEN;",
    "import {default as deployment} from 'process'; deployment.env.ALLRICE_HIDDEN;",
    "import deployment = require('node:process'); deployment.env.ALLRICE_HIDDEN;",
    "export {env as deployment} from 'node:process';",
    "const deployment = await import('node:process'); deployment.env.ALLRICE_HIDDEN;",
    "const deployment = require('process'); deployment.env.ALLRICE_HIDDEN;",
  ]) {
    writeFileSync(join(root, file), source);
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unsupported (?:dynamic )?process import/);
    expect(result.stderr).not.toContain('Stale source audit');
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe(original);
  }
});

test('real integerSetting aliases are refused even after explicit fixture source re-approval', () => {
  const file = 'apps/worker/src/index.ts';
  const actual = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const helper = actual.slice(
    actual.indexOf('function integerSetting('),
    actual.indexOf('\nconst readinessIntervalMs'),
  );
  expect(helper).toContain('Number(process.env[name] ?? fallback)');
  const baseline = helper + "\nintegerSetting('ALLRICE_BASELINE', 1, 0, 10);\n";
  const settings = policy();
  settings.calls[file + '#integerSetting'] = 0;
  settings.audit[file + '#process.env[name]'] =
    'Reviewed literal integerSetting caller.';
  const root = fixture({ [file]: baseline }, settings);
  expect(cli(root).status).toBe(0);
  const original = readFileSync(join(root, '.env.example'), 'utf8');
  for (const escape of [
    "const readInteger = integerSetting; readInteger('ALLRICE_NEW_INTEGER', 2, 0, 10);",
    'const copied = {integerSetting};',
    'consume(integerSetting);',
    'export {integerSetting};',
  ]) {
    writeFileSync(join(root, file), baseline + escape);
    // Bypass P2-1 deliberately: P2-2 must still reject the reference itself.
    approveFixtureSource(root, settings, file);
    const result = cli(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Unsupported helper escape: ' + file + '#integerSetting',
    );
    expect(result.stderr).not.toContain('Stale source audit');
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe(original);
  }
});

test('registered helper import aliases are refused, and opaque source hash metadata cannot go stale', () => {
  const file = 'apps/web/config.ts';
  const settings = policy();
  settings.calls['*#runtimeFeatureEnabled'] = 0;
  const root = fixture(
    {
      [file]:
        "import {runtimeFeatureEnabled} from '@allrice/contracts'; runtimeFeatureEnabled('ALLRICE_FEATURE');",
    },
    settings,
  );
  expect(cli(root).status).toBe(0);
  writeFileSync(
    join(root, file),
    "import {runtimeFeatureEnabled as feature} from '@allrice/contracts'; feature('ALLRICE_FEATURE');",
  );
  expect(cli(root).stderr).toContain('Unsupported helper import alias');
  const stale = policy();
  stale.auditSources[file] = '0'.repeat(64);
  expect(() => generateExample(root, stale)).toThrow(
    'Stale environment metadata',
  );
});
