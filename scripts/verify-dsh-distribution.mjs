import { distributionFacts } from './dsh-distribution-facts.mjs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  readImporterManifests,
  verifyDshSingleGeneration,
} from './verify-dsh-single-generation.mjs';

const root = resolve(import.meta.dirname, '..');

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [
  upstream,
  distribution,
  ledger,
  profile,
  runtimePin,
  platformEmployeeContract,
  compatibility,
  reuseDecisions,
  workspace,
  lockText,
] = await Promise.all([
  json('apps/worker/dsh/upstream.json'),
  json('apps/worker/dsh/distribution.json'),
  json('apps/worker/dsh/patch-ledger.json'),
  readFile(
    resolve(root, 'apps/worker/dsh/allrice-restricted.cordis.yml'),
    'utf8',
  ),
  readFile(
    resolve(root, 'apps/worker/src/harness/dsh-distribution.ts'),
    'utf8',
  ),
  readFile(
    resolve(root, 'packages/contracts/src/platform-employees.ts'),
    'utf8',
  ),
  json('apps/worker/dsh/compatibility.json'),
  readFile(
    resolve(root, 'docs/architecture/dsh-reuse-and-replacement.md'),
    'utf8',
  ),
  readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8').then(parse),
  readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8'),
]);
const lock = parse(lockText);

const { installed, promoted, candidate } = distributionFacts(distribution);

assert(
  installed.version === upstream.version,
  'installed version must match upstream manifest',
);
assert(
  installed.commit === upstream.commit,
  'installed commit must match upstream manifest',
);
assert(
  installed.sourceArchiveSha256 === upstream.sourceArchiveSha256,
  'installed archive checksum must match upstream manifest',
);
assert(upstream.license === 'MIT', 'approved DSH distribution must be MIT');
assert(
  distribution.promotionPolicy?.automaticProductionPromotion === false,
  'DSH must never promote automatically to production',
);
assert(
  runtimePin.includes('DSH_INSTALLED_DISTRIBUTION.version') &&
    runtimePin.includes('DSH_INSTALLED_DISTRIBUTION.generation') &&
    platformEmployeeContract.includes(
      'DSH_INSTALLED_DISTRIBUTION.generation',
    ) &&
    platformEmployeeContract.includes(
      '.default(DSH_MISSING_FROZEN_GENERATION)',
    ),
  'runtime version guard must match the installed distribution',
);
assert(
  ledger.schemaVersion === 2 &&
    Array.isArray(ledger.patches) &&
    Object.keys(ledger).sort().join(',') === 'patches,schemaVersion',
  'invalid patch ledger',
);
const generationInventory = await verifyDshSingleGeneration({
  root,
  workspace,
  lock,
  lockText,
  manifests: await readImporterManifests(root, lock),
  version: installed.version,
});
const ledgerIds = new Set();
for (const patch of ledger.patches) {
  assert(
    typeof patch.id === 'string' && patch.id && !ledgerIds.has(patch.id),
    `missing or duplicate ledger ID ${patch.id}`,
  );
  ledgerIds.add(patch.id);
  const path = String(patch.path ?? '');
  const inRepository =
    path !== '' &&
    !isAbsolute(path) &&
    posix.normalize(path) === path &&
    !path.startsWith('../') &&
    !path.startsWith('patches/') &&
    !path.split('/').includes('node_modules');
  assert(
    patch.upstreamVersion === installed.version &&
      patch.kind === 'protocol-extension' &&
      inRepository &&
      (await stat(resolve(root, path)).then(
        (entry) => entry.isFile(),
        () => false,
      )),
    `ledger entry ${patch.id} must be an extension of the installed DSH in an AllRice source file`,
  );
  assert(
    reuseDecisions.includes(`\`${patch.id}\``),
    `DSH reuse decisions are missing patch ${patch.id}`,
  );
}
assert(
  ledger.patches.some(
    (patch) =>
      patch.id === 'allrice-jsonrpc-lifecycle-v1' &&
      patch.upstreamVersion === installed.version,
  ),
  'AllRice protocol extension must be recorded against the approved upstream',
);
assert(
  !profile.includes('@deepseek-ai/dsh-sdk-jsonrpc-server'),
  'restricted profile must leave JSON-RPC ownership to the AllRice protocol adapter',
);

assert(
  compatibility.schemaVersion === 1 && compatibility.harness === 'dsh',
  'invalid DSH compatibility manifest',
);
assert(
  compatibility.runtimeProfile ===
    'apps/worker/dsh/allrice-restricted.cordis.yml',
  'compatibility manifest must point at the governed runtime profile',
);
assert(
  compatibility.sessionFormat.endsWith(`@${installed.version}`),
  'session format must be recorded against the approved DSH version',
);
assert(
  compatibility.productionSkillSources?.length === 1 &&
    compatibility.productionSkillSources[0] === 'allrice-published-runtime' &&
    compatibility.excludedSkillSources?.includes(
      'dsh-repository-development-skills',
    ),
  'production Skill sources must exclude DSH repository development Skills',
);

// Private DSH subpaths are exceptions to the public-seam rule. Every one that
// production code imports is listed with its owner, and nothing listed is stale.
// Matches static and dynamic imports, re-exports and require/require.resolve.
const privateImport =
  /(?:\bfrom|\bimport|\brequire(?:\.resolve)?)\s*\(?\s*(['"`])(@deepseek-ai\/dsh[a-z0-9-]*\/(?:internal|lib|src|dist)(?:\/[^'"`]*)?)\1/g;
async function* productionSources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !['node_modules', 'dist', '.next', 'test', 'fixtures'].includes(
          entry.name,
        )
      )
        yield* productionSources(path);
    } else if (
      /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name)
    )
      yield path;
  }
}
const importedPrivate = new Map();
for (const top of ['apps', 'packages', 'scripts'])
  for await (const file of productionSources(resolve(root, top)))
    for (const match of (await readFile(file, 'utf8')).matchAll(privateImport))
      importedPrivate.set(`${match[2]} ${relative(root, file)}`, match[2]);
const declaredPrivate = new Set(
  (compatibility.privateInterfaces ?? []).map((entry) => {
    assert(
      entry.upstreamVersion === installed.version &&
        ledgerIds.has(entry.ledgerId),
      `private DSH interface ${entry.id} must be owned by a ledger entry of the installed DSH`,
    );
    return `${entry.upstreamInterface} ${entry.adapter}`;
  }),
);
assert(
  [...importedPrivate.keys()].every((key) => declaredPrivate.has(key)) &&
    [...declaredPrivate].every((key) => importedPrivate.has(key)),
  `private DSH imports must match compatibility.json privateInterfaces: ${[
    ...importedPrivate.keys(),
  ].join(', ')}`,
);

const requiredReplayScenarios = [
  'ordinary-chat',
  'search',
  'skill',
  'tool',
  'attachment',
  'cancel',
  'recovery',
  'compaction',
  'legacy-official-migration',
  'legacy-format-refusal',
  'durable-question-restart',
  'native-progress-decision',
];
const replayById = new Map(
  (compatibility.goldenReplay ?? []).map((scenario) => [scenario.id, scenario]),
);
for (const scenarioId of requiredReplayScenarios) {
  const scenario = replayById.get(scenarioId);
  assert(scenario, `Golden Replay is missing ${scenarioId}`);
  const source = await readFile(resolve(root, scenario.testFile), 'utf8');
  assert(
    source.includes(scenario.testName),
    `Golden Replay ${scenarioId} points at a missing test`,
  );
}

for (const pluginId of compatibility.configurationTree ?? []) {
  assert(
    profile.includes(`- id: ${pluginId}`),
    `recorded DSH configuration is missing ${pluginId}`,
  );
}

const allowedProfilePackages = new Set(
  [
    'credentials-local',
    'authorization',
    'attachment-local',
    'llm-pi-ai',
    'llm-deepseek-api-key',
    'llm',
    'session',
    'session-title',
    'system-prompt',
    'tools',
    'agent',
    'fs-local',
    'working-directory',
    'agent-loop',
    'skill',
    'tool-skill',
    'session-persistence-jsonl',
    'session-checkpoint-policy',
    'llm-retry',
    'tool-call-timeout-policy',
    'repeat-tool-reminder',
    'user-questions',
    'tool-ask-user',
    'tool-todo',
    'session-projection',
    'token-meter',
    'compaction-tool-result-pruner',
    'compaction-basic',
  ].map((name) => `@deepseek-ai/dsh-${name}`),
);
allowedProfilePackages.add('@deepseek-ai/cordis-plugin-timer');
for (const match of profile.matchAll(/^\s+name: '([^']+)'$/gm)) {
  assert(
    allowedProfilePackages.has(match[1]),
    `unapproved restricted plugin: ${match[1]}`,
  );
}
assert(
  profile.includes('agents: []'),
  'the restricted loop must not create automatic agents',
);

console.log(
  JSON.stringify({
    status: 'ok',
    installedGeneration: installed.generation,
    declaredPromotedGeneration: promoted.generation,
    generation: installed.generation,
    version: installed.version,
    ...generationInventory,
    candidate: candidate?.generation ?? null,
    rollback: null,
    wireProtocol: compatibility.wireProtocol,
    sessionFormat: compatibility.sessionFormat,
    goldenReplayScenarios: requiredReplayScenarios,
    goldenReplayExecution: 'not-run-by-this-command',
  }),
);
