import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// AllRice runs exactly one DSH generation. An upgrade replaces every
// @deepseek-ai/dsh package at once; nothing keeps an older copy alive, and no
// DSH package is patched in place (extensions go through public seams).
const isDsh = (name) =>
  name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
const sections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** Split `name@version(peers)` after the name, so a scoped name or a tarball
 * URL that itself contains `@` never shifts the separator. */
function reference(value) {
  const text = String(value);
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  if (at <= 0) return { name: text, version: null };
  const rest = text.slice(at + 1);
  const peers = rest.indexOf('(');
  return {
    name: text.slice(0, at),
    version: peers < 0 ? rest : rest.slice(0, peers),
  };
}

/** A resolved dependency value: `1.2.3(peers)`, an alias
 * `@scope/name@1.2.3(peers)`, or a non-registry source such as `link:`. */
function resolved(name, value) {
  const text = String(value);
  if (/^\d/.test(text)) return { name, version: text.split('(')[0] };
  const target = reference(text);
  return target.version === null || /^[a-z]+:/.test(text)
    ? { name, version: text }
    : target;
}

/** The package an npm alias (`npm:@scope/name@range`) installs, if any. */
function aliasTarget(value) {
  const text = String(value);
  return text.startsWith('npm:') ? reference(text.slice(4)).name : null;
}

async function packageName(directory) {
  try {
    return JSON.parse(
      await readFile(resolve(directory, 'package.json'), 'utf8'),
    ).name;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function patchFiles(root) {
  try {
    return (await readdir(resolve(root, 'patches'))).filter((name) =>
      name.startsWith('@deepseek-ai__dsh'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function verifyDshSingleGeneration({
  root,
  workspace,
  lock,
  lockText,
  manifests,
  version,
}) {
  const problems = [];
  const check = (condition, message) => {
    if (!condition) problems.push(message);
  };
  const checkResolved = (name, value, label) => {
    const target = resolved(name, value);
    if (isDsh(name) || isDsh(target.name))
      check(
        target.name === name && target.version === version,
        `${label} resolves ${name} to ${value}`,
      );
  };
  const checkOverrides = (overrides, label) => {
    for (const [selector, value] of Object.entries(overrides ?? {})) {
      const path = selector.split('>').map(reference);
      for (const part of path)
        if (isDsh(part.name))
          check(
            part.version === null || part.version === version,
            `${label} selector ${selector}`,
          );
      if (isDsh(path.at(-1).name))
        check(String(value) === version, `${label} ${selector} -> ${value}`);
    }
  };

  // Any `@deepseek-ai/dsh…@version` written anywhere in the lockfile data.
  const lockData = String(lockText ?? '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  for (const match of lockData.matchAll(
    /@deepseek-ai\/dsh(?:-[a-z0-9-]+)?@([^\s'"():,>]+)/g,
  ))
    check(match[1] === version, `lockfile mentions ${match[0]}`);

  const packages = new Set();
  for (const [key, info] of Object.entries(lock.packages ?? {})) {
    const entry = reference(key);
    if (!isDsh(entry.name)) continue;
    // pnpm prefers an entry's own version and tarball over its key.
    const tarball = info?.resolution?.tarball;
    check(
      entry.version === version &&
        (info?.version === undefined || info.version === version) &&
        (tarball === undefined || String(tarball).endsWith(`-${version}.tgz`)),
      `lockfile resolves ${key}`,
    );
    packages.add(entry.name);
  }
  check(packages.size > 0, 'lockfile resolves no DSH package');

  for (const [key, snapshot] of Object.entries(lock.snapshots ?? {})) {
    const entry = reference(key);
    if (isDsh(entry.name))
      check(entry.version === version, `lockfile snapshot ${key}`);
    for (const section of sections)
      for (const [name, value] of Object.entries(snapshot?.[section] ?? {}))
        checkResolved(name, value, `snapshot ${key}`);
  }

  for (const [importer, data] of Object.entries(lock.importers ?? {}))
    for (const section of sections)
      for (const [name, info] of Object.entries(data?.[section] ?? {})) {
        const target = resolved(name, info.version);
        // A local directory may hold a DSH package under another name.
        const local = /^(?:link|file):/.exec(String(info.version));
        if (local && !isDsh(name)) {
          const linked = await packageName(
            resolve(root, importer, String(info.version).slice(5)),
          );
          check(!isDsh(linked ?? ''), `${importer} links ${name} to ${linked}`);
        }
        if (!isDsh(name) && !isDsh(target.name)) continue;
        check(
          info.specifier === version,
          `${importer} declares ${name}@${info.specifier}`,
        );
        checkResolved(name, info.version, importer);
      }

  // Read the declarations themselves, so the gate does not depend on an
  // earlier frozen install having proved them equal to the lockfile.
  for (const [importer, manifest] of Object.entries(manifests ?? {})) {
    check(
      !isDsh(manifest?.name ?? ''),
      `${importer} is a workspace package named ${manifest?.name}`,
    );
    for (const section of sections)
      for (const [name, value] of Object.entries(manifest?.[section] ?? {}))
        if (isDsh(name) || isDsh(aliasTarget(value) ?? ''))
          check(
            isDsh(name) && value === version,
            `${importer}/package.json ${section} ${name}@${value}`,
          );
  }

  for (const [key, extension] of Object.entries(
    workspace.packageExtensions ?? {},
  )) {
    const target = reference(key);
    if (isDsh(target.name))
      check(target.version === version, `packageExtensions targets ${key}`);
    for (const section of sections)
      for (const [name, value] of Object.entries(extension?.[section] ?? {}))
        if (isDsh(name))
          check(
            String(value) === version,
            `extension ${key} pins ${name}@${value}`,
          );
  }

  // The lockfile records every override in effect, wherever it was declared.
  checkOverrides(workspace.overrides, 'override');
  checkOverrides(lock.overrides, 'lockfile override');

  for (const [label, patched] of [
    ['workspace', workspace.patchedDependencies],
    ['lockfile', lock.patchedDependencies],
  ])
    for (const key of Object.keys(patched ?? {}))
      check(!isDsh(reference(key).name), `${label} patches ${key}`);
  const files = await patchFiles(root);
  check(files.length === 0, `patch files remain: ${files.join(', ')}`);

  if (problems.length)
    throw new Error(
      `DSH single generation: every @deepseek-ai/dsh package must be exactly ${version} ` +
        '(apps/worker/dsh/upstream.json), declared under its own name, with no DSH patch. ' +
        'An upgrade bumps all of them in one change; see docs/operations/dsh-upstream-governance.md.\n- ' +
        problems.join('\n- '),
    );
  return { dshPackages: packages.size, dshVersion: version };
}

/** Workspace package manifests keyed by lockfile importer path. */
export async function readImporterManifests(root, lock) {
  const entries = await Promise.all(
    Object.keys(lock.importers ?? {}).map(async (importer) => [
      importer,
      JSON.parse(
        await readFile(resolve(root, importer, 'package.json'), 'utf8'),
      ),
    ]),
  );
  return Object.fromEntries(entries);
}
