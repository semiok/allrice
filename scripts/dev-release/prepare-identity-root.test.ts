import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resolveServiceBuildRoot } from './prepare-identity-root.mjs';

let directory: string;
let home: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'qa-build-root-')));
  home = join(directory, 'home');
  await mkdir(home);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each([
  'allrice-dev-releases/203d4532',
  'allrice-worktrees/met-218-qa-build-identity',
  'allrice-qa/met-218-check/release',
  `allrice-qa/${'a'.repeat(31)}/release`,
])(
  'accepts the existing release roots and canonical QA root %s',
  async (path) => {
    const root = join(home, path);
    await mkdir(root, { recursive: true });
    expect(await resolveServiceBuildRoot(root, home)).toBe(root);
  },
);

it.each([
  'allrice-dev-releases/203d4532/nested',
  'allrice-worktrees/task/nested',
  'allrice-qa/met-218-check',
  'allrice-qa/release',
  'allrice-qa/met-218-check/other',
  'allrice-qa/met-218-check/nested/release',
  'allrice-qa/Task/release',
  'allrice-qa/-task/release',
  'allrice-qa/task_name/release',
  `allrice-qa/${'a'.repeat(32)}/release`,
  'uncontrolled/task/release',
])(
  'rejects roots outside the supported directory and task boundaries: %s',
  async (path) => {
    const root = join(home, path);
    await mkdir(root, { recursive: true });
    await expect(resolveServiceBuildRoot(root, home)).rejects.toThrow(
      'DEV_BUILD_ROOT_NOT_ALLOWED',
    );
  },
);

it.each(['task', 'release'])(
  'rejects a QA %s symlink escaping the controlled roots',
  async (level) => {
    const outside = join(directory, 'outside');
    const task = join(home, 'allrice-qa/met-218-check');
    const root = join(task, 'release');
    await mkdir(join(outside, 'release'), { recursive: true });
    if (level === 'task') {
      await mkdir(join(home, 'allrice-qa'));
      await symlink(outside, task);
    } else {
      await mkdir(task, { recursive: true });
      await symlink(join(outside, 'release'), root);
    }
    await expect(resolveServiceBuildRoot(root, home)).rejects.toThrow(
      'DEV_BUILD_ROOT_NOT_ALLOWED',
    );
  },
);
