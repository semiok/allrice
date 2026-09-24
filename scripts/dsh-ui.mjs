import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const ledgerPath = join(root, 'apps/web/app/dsh-upstream/upstream.json');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    source: { type: 'string' },
    commit: { type: 'string' },
    version: { type: 'string' },
  },
});
const mode = positionals[0] ?? 'verify';
assert(['verify', 'sync'].includes(mode), 'Use verify or sync');
const syncing = mode === 'sync';
assert(
  !syncing || values.source,
  'sync requires --source <official git checkout>',
);
const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
const manifest = JSON.parse(
  await readFile(join(root, 'apps/web/package.json'), 'utf8'),
);
const require = createRequire(join(root, 'apps/web/package.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = values.source && resolve(values.source);
const git = (args, cwd = source) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });
const upstream = (commit, path) => git(['show', `${commit}:${path}`]);
const staged = await mkdtemp(join(tmpdir(), 'allrice-dsh-ui-'));
const writes = new Map();
const probes = [];
let count = 0;
try {
  for (const group of ledger.componentSets) {
    assert.equal(group.license, 'MIT');
    const commit = values.commit ?? group.commit;
    const version = values.version ?? group.version;
    if (source) {
      assert.equal(
        git(['rev-parse', `${commit}^{commit}`]).trim(),
        commit,
        'Use a full official commit SHA',
      );
      assert.equal(
        JSON.parse(
          upstream(commit, 'packages/client/ui-workspace/package.json'),
        ).version,
        version,
        'Version must match the official source',
      );
      if (!syncing)
        assert.equal(
          commit,
          group.commit,
          'verify must use the recorded source',
        );
    }
    for (const file of group.files) {
      const current = await readFile(join(root, file.target));
      assert.equal(
        hash(current),
        file.sha256,
        `Unrecorded local change: ${file.target}`,
      );
      if (file.patch) {
        const patch = await readFile(join(root, file.patch));
        assert.equal(
          hash(patch),
          file.patchSha256,
          `Patch drift: ${file.patch}`,
        );
      }
      if (source) {
        const original = upstream(commit, file.source);
        if (!syncing)
          assert.equal(
            hash(original),
            file.upstreamSha256,
            `Source drift: ${file.source}`,
          );
        const patchText =
          file.patch && (await readFile(join(root, file.patch), 'utf8'));
        const patchPath = patchText?.match(/^\+\+\+ b\/(.+)$/m)?.[1];
        const target = join(staged, patchPath ?? file.source);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, original);
        if (file.patch)
          git(['apply', '--whitespace=nowarn', join(root, file.patch)], staged);
        const adapted = await readFile(target);
        if (syncing) {
          file.upstreamSha256 = hash(original);
          file.sha256 = hash(adapted);
          writes.set(join(root, file.target), adapted);
        } else
          assert.equal(
            hash(adapted),
            file.sha256,
            `Patch does not reproduce ${file.target}`,
          );
      }
      count++;
    }
    for (const excerpt of group.excerpts ?? []) {
      assert.equal(
        hash(await readFile(join(root, excerpt.target))),
        excerpt.sha256,
        `Excerpt drift: ${excerpt.target}`,
      );
      if (source) {
        const text = upstream(commit, excerpt.source);
        const parsed = ts.createSourceFile(
          excerpt.source,
          text,
          ts.ScriptTarget.Latest,
          true,
        );
        const node = parsed.statements.find(
          (node) =>
            ts.isFunctionDeclaration(node) &&
            node.name?.text === excerpt.symbol,
        );
        assert(node, `Missing native symbol: ${excerpt.symbol}`);
        assert.equal(
          hash(node.getText(parsed)),
          excerpt.upstreamSymbolSha256,
          `Native excerpt changed; review ${excerpt.symbol} before syncing`,
        );
        assert(
          text.includes(excerpt.requiredDeclaration),
          `Native excerpt dependency changed: ${excerpt.requiredDeclaration}`,
        );
      }
      count++;
    }
    for (const pkg of group.packages ?? []) {
      const packagePath = require.resolve(`${pkg.name}/package.json`);
      const installed = JSON.parse(await readFile(packagePath, 'utf8'));
      const expected =
        syncing && source
          ? JSON.parse(
              upstream(
                commit,
                `${installed.repository.directory}/package.json`,
              ),
            ).version
          : pkg.version;
      assert.equal(
        installed.version,
        expected,
        `Install the reviewed ${pkg.name}@${expected} first`,
      );
      assert.equal(
        manifest.dependencies[pkg.name],
        expected,
        `Pin ${pkg.name} exactly`,
      );
      if (syncing) pkg.version = expected;
      if (pkg.exports?.length)
        probes.push(
          `import { ${pkg.exports.join(', ')} } from '${pkg.name}'; console.log(${pkg.exports.join(', ')});`,
        );
      for (const asset of pkg.assets ?? []) {
        const digest = hash(
          await readFile(join(dirname(packagePath), asset.path)),
        );
        if (syncing) asset.sha256 = digest;
        else
          assert.equal(
            digest,
            asset.sha256,
            `Published asset drift: ${pkg.name}/${asset.path}`,
          );
      }
    }
    if (syncing) {
      group.commit = commit;
      group.version = version;
    }
  }
  // Resolve actual public exports through the browser bundler, including CSS/fonts.
  // This is an import check; the CI Chromium suites verify mounted behavior.
  const { build } = createRequire(require.resolve('tsx'))('esbuild');
  await build({
    stdin: { contents: probes.join('\n'), resolveDir: join(root, 'apps/web') },
    bundle: true,
    write: false,
    outdir: staged,
    platform: 'browser',
    format: 'esm',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
    logLevel: 'error',
  });
  // All patches, source symbols and installed package checks pass before any write.
  if (syncing) {
    for (const [path, bytes] of writes) await writeFile(path, bytes);
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2) + '\n');
  }
  console.info(
    JSON.stringify({
      status: 'ok',
      mode,
      files: count,
      sourceReplay: !!source,
      components: ledger.componentSets.map(({ id, version, commit }) => ({
        id,
        version,
        commit,
      })),
    }),
  );
} finally {
  await rm(staged, { recursive: true, force: true });
}
