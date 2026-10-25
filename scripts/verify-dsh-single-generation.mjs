import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// AllRice runs exactly one DSH generation. An upgrade replaces every
// @deepseek-ai/dsh package at once; nothing keeps an older copy alive, and no
// DSH package is patched in place (extensions go through public seams).
const isDsh = (name) =>
  name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');

function check(condition, message) {
  if (!condition) throw new Error(`DSH single generation: ${message}`);
}

/** Split `@scope/name@version` (or a bare name) at the version separator. */
function spec(value) {
  const at = value.lastIndexOf('@');
  return at > 0
    ? { name: value.slice(0, at), version: value.slice(at + 1) }
    : { name: value, version: null };
}

function checkDependencies(dependencies, version, label) {
  for (const [name, value] of Object.entries(dependencies ?? {}))
    if (isDsh(name))
      check(String(value) === version, `${label} pins ${name}@${value}`);
}

export async function verifyDshSingleGeneration({
  root,
  workspace,
  lock,
  version,
}) {
  const packages = new Set();
  for (const key of Object.keys(lock.packages ?? {})) {
    const entry = spec(key);
    if (!isDsh(entry.name)) continue;
    check(entry.version === version, `lockfile resolves ${key}`);
    packages.add(entry.name);
  }
  check(packages.size > 0, 'lockfile resolves no DSH package');

  for (const [importer, data] of Object.entries(lock.importers ?? {}))
    for (const section of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ])
      for (const [name, info] of Object.entries(data[section] ?? {}))
        if (isDsh(name))
          check(
            info.specifier === version,
            `${importer} declares ${name}@${info.specifier}`,
          );

  for (const [key, extension] of Object.entries(
    workspace.packageExtensions ?? {},
  )) {
    const target = spec(key);
    if (isDsh(target.name))
      check(target.version === version, `packageExtensions targets ${key}`);
    for (const section of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
      checkDependencies(extension[section], version, `extension ${key}`);
  }

  for (const [selector, value] of Object.entries(workspace.overrides ?? {})) {
    const path = selector.split('>').map(spec);
    for (const part of path)
      if (isDsh(part.name))
        check(
          part.version === null || part.version === version,
          `override selector ${selector}`,
        );
    if (isDsh(path.at(-1).name))
      check(String(value) === version, `override ${selector} -> ${value}`);
  }

  for (const [label, patched] of [
    ['workspace', workspace.patchedDependencies],
    ['lockfile', lock.patchedDependencies],
  ])
    for (const key of Object.keys(patched ?? {}))
      check(!isDsh(spec(key).name), `${label} patches ${key}`);
  const files = (await readdir(resolve(root, 'patches'))).filter((name) =>
    name.startsWith('@deepseek-ai__dsh'),
  );
  check(files.length === 0, `patch files remain: ${files.join(', ')}`);

  return { dshPackages: packages.size, dshVersion: version };
}
