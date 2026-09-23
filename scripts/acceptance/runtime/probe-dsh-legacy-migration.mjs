/** Read-only candidate format probe. Install the candidate outside the workspace
 * lockfile, then pass its package root; refusal is a nonzero promotion blocker. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert(process.argv[2], 'Pass the isolated candidate package directory');
const candidateRequire = createRequire(
  resolve(process.argv[2], 'package.json'),
);
const packageName = '@deepseek-ai/dsh-session-format-catalog';
const entry = candidateRequire.resolve(packageName);
const packageJson = JSON.parse(
  await readFile(
    candidateRequire.resolve(`${packageName}/package.json`),
    'utf8',
  ),
);
const { sessionFormatCatalog } = await import(pathToFileURL(entry).href);
const fixtureRoot = resolve(
  import.meta.dirname,
  '../../../apps/worker/src/harness/fixtures/dsh-legacy-v0',
);
const manifest = JSON.parse(
  await readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8'),
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const formatPackages = {};
for (const suffix of [
  'session',
  'session-format',
  'session-format-catalog',
  'session-format-v0-to-v1',
  'session-format-v1-to-v2',
  'session-format-v2-to-v3',
]) {
  const name = `@deepseek-ai/dsh-${suffix}`;
  const metadata = JSON.parse(
    await readFile(candidateRequire.resolve(`${name}/package.json`), 'utf8'),
  );
  assert.equal(metadata.version, packageJson.version, `${name} version drift`);
  formatPackages[name] = metadata.version;
}
const results = [];
for (const fixture of manifest.files) {
  const path = resolve(fixtureRoot, fixture.file);
  const before = await readFile(path);
  assert.equal(sha256(before), fixture.sha256);
  const [header, ...rows] = before
    .toString()
    .trim()
    .split('\n')
    .map(JSON.parse);
  const admission = sessionFormatCatalog.readHeader(header);
  try {
    const restore = sessionFormatCatalog.createRestore(header, {
      recovery: 'strict',
      validation: 'current',
    });
    for (const row of rows) restore.decodeRow(row);
    const migrated = restore.finish();
    results.push({
      file: fixture.file,
      sourceSha256: fixture.sha256,
      admission: admission.status,
      status: 'migrated',
      targetVersion: migrated.header.version,
      events: migrated.events.length,
    });
  } catch (error) {
    results.push({
      file: fixture.file,
      sourceSha256: fixture.sha256,
      admission: admission.status,
      status: 'refused',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  assert.equal(sha256(await readFile(path)), fixture.sha256);
}
console.log(
  JSON.stringify(
    {
      package: packageName,
      version: packageJson.version,
      catalogEntrySha256: sha256(await readFile(entry)),
      formatPackages,
      targetFormat: sessionFormatCatalog.currentVersion,
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => result.status !== 'migrated'))
  process.exitCode = 1;
