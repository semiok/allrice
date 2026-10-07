import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, posix, relative } from 'node:path';

const dshKey = (value) => value.startsWith('@deepseek-ai/dsh-');
function check(condition, message) {
  if (!condition) throw new Error(`DSH physical patch: ${message}`);
}
function sameKeys(actual, expected, label) {
  check(
    actual.length === expected.length &&
      [...actual]
        .sort()
        .every((key, index) => key === [...expected].sort()[index]),
    `${label} inventory differs from the physical ledger`,
  );
}

// The responsibility ledger includes adapters as well as upstream patches.
// Count and verify upstream DSH patch files separately. Other package patches
// (for example Next) have their own governance and are outside this inventory.
export async function verifyDshPhysicalPatches({
  root,
  ledger,
  workspace,
  lock,
  upstreamVersion,
}) {
  check(
    Array.isArray(ledger.physicalPatches),
    'physical mappings are required',
  );
  check(Array.isArray(ledger.patches), 'responsibility entries are required');
  const responsibilities = new Map();
  for (const entry of ledger.patches) {
    check(
      typeof entry.id === 'string' &&
        entry.id.length &&
        !responsibilities.has(entry.id),
      `missing or duplicate responsibility ID ${entry.id}`,
    );
    responsibilities.set(entry.id, entry);
  }
  const workspacePatches = workspace.patchedDependencies ?? {};
  const lockPatches = lock.patchedDependencies ?? {};
  const mappings = new Map(),
    paths = new Set();
  const patchesRoot = await realpath(resolve(root, 'patches'));
  for (const mapping of ledger.physicalPatches) {
    check(
      typeof mapping.package === 'string' &&
        /^@deepseek-ai\/dsh-[a-z0-9-]+$/.test(mapping.package),
      `invalid package ${mapping.package}`,
    );
    check(
      mapping.version === upstreamVersion,
      `version drift for ${mapping.package}`,
    );
    const key = `${mapping.package}@${mapping.version}`;
    check(!mappings.has(key), `duplicate or conflicting mapping ${key}`);
    check(
      typeof mapping.path === 'string' &&
        mapping.path.startsWith('patches/') &&
        mapping.path.endsWith('.patch') &&
        !mapping.path.includes('\\') &&
        posix.normalize(mapping.path) === mapping.path,
      `invalid repository path for ${key}`,
    );
    check(
      !paths.has(mapping.path),
      `conflicting file ownership ${mapping.path}`,
    );
    const owner = responsibilities.get(mapping.responsibilityId);
    check(owner, `unknown responsibility ${mapping.responsibilityId}`);
    check(
      owner.upstreamVersion === upstreamVersion,
      `responsibility version drift for ${key}`,
    );
    check(
      workspacePatches[key] === mapping.path,
      `workspace package/path drift for ${key}`,
    );
    check(
      lockPatches[key]?.path === mapping.path,
      `lock package/path drift for ${key}`,
    );
    check(
      /^[a-f0-9]{64}$/.test(lockPatches[key]?.hash ?? ''),
      `missing lock digest for ${key}`,
    );
    const actualPath = await realpath(resolve(root, mapping.path));
    const inside = relative(patchesRoot, actualPath);
    check(
      inside && !inside.startsWith('..') && !posix.isAbsolute(inside),
      `patch escapes repository for ${key}`,
    );
    const digest = createHash('sha256')
      .update(await readFile(actualPath))
      .digest('hex');
    check(
      digest === lockPatches[key].hash,
      `physical bytes do not match lock digest for ${key}`,
    );
    mappings.set(key, mapping);
    paths.add(mapping.path);
  }
  const keys = [...mappings.keys()];
  sameKeys(Object.keys(workspacePatches).filter(dshKey), keys, 'workspace');
  sameKeys(Object.keys(lockPatches).filter(dshKey), keys, 'lock');
  const files = (await readdir(resolve(root, 'patches')))
    .filter(
      (name) =>
        name.startsWith('@deepseek-ai__dsh-') && name.endsWith('.patch'),
    )
    .map((name) => `patches/${name}`);
  sameKeys(files, [...paths], 'files');
  for (const owner of responsibilities.values()) {
    if (
      owner.kind === 'upstream-source-patch' ||
      owner.path?.startsWith('patches/@deepseek-ai__dsh-')
    ) {
      check(
        [...mappings.values()].some(
          (mapping) =>
            mapping.responsibilityId === owner.id &&
            mapping.path === owner.path,
        ),
        `unmapped responsibility path ${owner.id}`,
      );
    }
  }
  return {
    physicalPatchCount: mappings.size,
    ledgerEntryCount: responsibilities.size,
  };
}
