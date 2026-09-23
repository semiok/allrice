import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
  workerPackage,
  profile,
  runtimePin,
  platformEmployeeContract,
  compatibility,
  adminCompatibilityAdapter,
  reuseDecisions,
] = await Promise.all([
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
  readFile(
    resolve(root, 'packages/contracts/src/platform-employees.ts'),
    'utf8',
  ),
  json('apps/worker/dsh/compatibility.json'),
  readFile(resolve(root, 'apps/dsh-admin/dsh-webui-compatibility.mjs'), 'utf8'),
  readFile(
    resolve(root, 'docs/architecture/dsh-reuse-and-replacement.md'),
    'utf8',
  ),
]);

const installedChannel = distribution.installedChannel ?? 'current';
assert(
  ['current', 'candidate'].includes(installedChannel),
  'invalid installed DSH channel',
);
const installed = distribution[installedChannel];
assert(installed, 'installed DSH generation is required');

assert(distribution.schemaVersion === 1, 'distribution schema must be v1');
assert(distribution.current, 'a current DSH generation is required');
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
  runtimePin.includes(`'${installed.version}'`) &&
    runtimePin.includes('PLATFORM_EMPLOYEE_DSH_DISTRIBUTION') &&
    platformEmployeeContract.includes(`'${installed.generation}'`),
  'runtime version guard must match the installed distribution',
);
assert(
  ledger.schemaVersion === 1 && Array.isArray(ledger.patches),
  'invalid patch ledger',
);
for (const patch of ledger.patches) {
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

const adminPrivateInterface = compatibility.privateInterfaces?.find(
  (entry) => entry.id === 'dsh-admin-webui-entrypoint',
);
assert(
  adminPrivateInterface?.upstreamInterface === '@deepseek-ai/dsh/lib/bin.js' &&
    adminPrivateInterface.adapter ===
      'apps/dsh-admin/dsh-webui-compatibility.mjs' &&
    adminPrivateInterface.overrideEnvironmentVariable === 'ALLRICE_DSH_COMMAND',
  'DSH Admin private WebUI entrypoint must be recorded in the compatibility manifest',
);
assert(
  ledger.patches.some(
    (patch) =>
      patch.id === 'dsh-admin-webui-private-entrypoint-v1' &&
      patch.upstreamVersion === installed.version &&
      patch.path === adminPrivateInterface.adapter,
  ),
  'DSH Admin private WebUI entrypoint must be recorded against the approved upstream',
);
assert(
  adminCompatibilityAdapter.includes('DSH_WEBUI_PRIVATE_ENTRYPOINT') &&
    adminCompatibilityAdapter.includes(
      `'${adminPrivateInterface.upstreamInterface}'`,
    ),
  'DSH Admin compatibility adapter must own the recorded private entrypoint',
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
  'legacy-tool-history',
  'legacy-question-adoption',
  'legacy-continuation-no-replay',
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

for (const [name, version] of Object.entries(
  workerPackage.dependencies ?? {},
)) {
  if (!name.startsWith('@deepseek-ai/dsh-')) continue;
  assert(
    version === installed.version,
    `${name} must be pinned to ${installed.version}`,
  );
}

const allowedProfilePackages = new Set(
  [
    'credentials-local',
    'authorization',
    'attachment-local',
    'llm-pi-ai',
    'llm-deepseek',
    'llm',
    'session',
    'session-title',
    'system-prompt',
    'tools',
    'agent',
    'invariants',
    'session/invariant',
    'agent/invariant',
    'scope/invariant',
    'agent-loop/invariant',
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
    installedChannel,
    generation: installed.generation,
    version: installed.version,
    patches: ledger.patches.length,
    candidate: distribution.candidate?.generation ?? null,
    rollback: distribution.rollback?.generation ?? null,
    wireProtocol: compatibility.wireProtocol,
    sessionFormat: compatibility.sessionFormat,
    goldenReplayScenarios: requiredReplayScenarios,
  }),
);
