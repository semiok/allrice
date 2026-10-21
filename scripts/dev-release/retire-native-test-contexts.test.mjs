import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const operator = fileURLToPath(
  new URL('./retire-native-test-contexts.mjs', import.meta.url),
);
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(
  /\/$/,
  '',
);
const paths = [];
const run = (args, url = 'postgres://a123@127.0.0.1:5432/allrice_dev') =>
  spawnSync(process.execPath, [operator, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url },
    timeout: 10_000,
  });
afterEach(() => {
  for (const p of paths.splice(0)) rmSync(p, { force: true, recursive: true });
});

describe('development-test retirement operator admission: no database calls', () => {
  it('is disabled without explicit arguments, even without database credentials', () => {
    const output = execFileSync(process.execPath, [operator], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(JSON.parse(output)).toMatchObject({
      disabled: true,
      databaseWritten: false,
    });
  });
  it.each([
    'postgres://user:do-not-print@remote.example.test/allrice_dev',
    'postgres://a123@127.0.0.1:5432/allrice',
    'postgres://a123@127.0.0.1:5432/allrice_dev?host=remote.example.test',
    'postgres://a123@127.0.0.1:5432/allrice_dev?options=-csearch_path=public',
  ])(
    'rejects a nonlocal, alternate or redirected database before importing it (%#)',
    (url) => {
      const result = run(
        ['--mode', 'apply', '--root', root, '--input', '/missing'],
        url,
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: 'NATIVE_RETIREMENT_LOCAL_DEV_ONLY',
      });
      expect(result.stderr).not.toContain('do-not-print');
    },
  );
  it('refuses a broadly readable approval input before database import', () => {
    const dir = realpathSync(
      mkdtempSync(join(tmpdir(), 'allrice-retirement-cli-')),
    );
    paths.push(dir);
    const input = join(dir, 'input.json');
    writeFileSync(input, '{}', { mode: 0o600 });
    chmodSync(input, 0o644);
    const result = run(['--mode', 'preview', '--root', root, '--input', input]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: 'NATIVE_RETIREMENT_PRIVATE_INPUT_REQUIRED',
    });
  });
});
