import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [upstream, distribution, ledger, workerPackage, profile, runtimePin] =
  await Promise.all([
    json('apps/worker/dsh/upstream.json'),
    json('apps/worker/dsh/distribution.json'),
    json('apps/worker/dsh/patch-ledger.json'),
    json('apps/worker/package.json'),
    readFile(
      resolve(root, 'apps/worker/dsh/allrice-restricted.cordis.yml'),
      'utf8',
    ),
    readFile(
      resolve(root, 'apps/worker/src/harness/dsh-distribution.ts'),
      'utf8',
    ),
  ]);

assert(distribution.schemaVersion === 1, 'distribution schema must be v1');
assert(distribution.current, 'a current DSH generation is required');
assert(
  distribution.current.version === upstream.version,
  'current version must match upstream manifest',
);
assert(
  distribution.current.commit === upstream.commit,
  'current commit must match upstream manifest',
);
assert(
  distribution.current.sourceArchiveSha256 === upstream.sourceArchiveSha256,
  'current archive checksum must match upstream manifest',
);
assert(upstream.license === 'MIT', 'approved DSH distribution must be MIT');
assert(
  distribution.promotionPolicy?.automaticProductionPromotion === false,
  'DSH must never promote automatically to production',
);
assert(
  runtimePin.includes(`'${distribution.current.version}'`) &&
    runtimePin.includes(`'${distribution.current.generation}'`),
  'runtime version guard must match the approved current distribution',
);
assert(
  ledger.schemaVersion === 1 && Array.isArray(ledger.patches),
  'invalid patch ledger',
);
assert(
  ledger.patches.some(
    (patch) =>
      patch.id === 'allrice-jsonrpc-lifecycle-v1' &&
      patch.upstreamVersion === distribution.current.version,
  ),
  'AllRice protocol extension must be recorded against the approved upstream',
);
assert(
  !profile.includes('@deepseek-ai/dsh-sdk-jsonrpc-server'),
  'restricted profile must leave JSON-RPC ownership to the AllRice protocol adapter',
);

for (const [name, version] of Object.entries(
  workerPackage.dependencies ?? {},
)) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue;
  assert(
    version === distribution.current.version,
    `${name} must be pinned to ${distribution.current.version}`,
  );
}

for (const boundary of [
  'workspaceContext: false',
  'enabled: false',
  'toolBash: false',
  'toolJobs: false',
]) {
  assert(
    profile.includes(boundary),
    `restricted profile is missing ${boundary}`,
  );
}

console.log(
  JSON.stringify({
    status: 'ok',
    generation: distribution.current.generation,
    version: distribution.current.version,
    patches: ledger.patches.length,
    candidate: distribution.candidate?.generation ?? null,
    rollback: distribution.rollback?.generation ?? null,
  }),
);
