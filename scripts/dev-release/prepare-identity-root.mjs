import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export async function resolveServiceBuildRoot(directory, home = homedir()) {
  const root = await realpath(resolve(directory));
  const directRelease = ['allrice-dev-releases', 'allrice-worktrees'].some(
    (parent) => dirname(root) === join(home, parent),
  );
  const taskRoot = dirname(root);
  // Keep the same task-name grammar as scripts/m1/qa-instance.
  const qaRelease =
    basename(root) === 'release' &&
    dirname(taskRoot) === join(home, 'allrice-qa') &&
    /^[a-z0-9][a-z0-9-]{0,30}$/.test(basename(taskRoot));
  if (!directRelease && !qaRelease) throw Error('DEV_BUILD_ROOT_NOT_ALLOWED');
  return root;
}
