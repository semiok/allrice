import assert from 'node:assert/strict';

/** One installed composition; declared promotion is not a live-service receipt. */
export function distributionFacts(distribution) {
  assert.equal(
    distribution.schemaVersion,
    2,
    'DSH distribution schema must be v2',
  );
  const generations = distribution.generations;
  assert.ok(Array.isArray(generations) && generations.length > 0);
  const byId = new Map();
  for (const generation of generations) {
    assert.match(generation.generation, /^dsh-[a-z0-9.-]+$/);
    assert.match(generation.version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
    assert.match(generation.commit, /^[a-f0-9]{40}$/);
    assert.equal(
      generation.generation,
      `dsh-${generation.version}-${generation.commit.slice(0, 7)}`,
    );
    assert.equal(typeof generation.frozenProfileAllowed, 'boolean');
    if (generation.sourceArchiveSha256 !== null)
      assert.match(generation.sourceArchiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(generation.profile, 'allrice-restricted.cordis.yml');
    assert.ok(!byId.has(generation.generation), 'duplicate DSH generation');
    byId.set(generation.generation, generation);
  }
  const select = (pointer, required = true) => {
    const id = distribution[pointer];
    if (!required && id === null) return null;
    assert.ok(byId.has(id), `unknown DSH ${pointer}`);
    return byId.get(id);
  };
  const installed = select('installedGeneration');
  const promoted = select('declaredPromotedGeneration');
  const candidate = select('upgradeCandidateGeneration', false);
  const historicalDefault = select('missingFrozenGeneration');
  assert.ok(
    installed.frozenProfileAllowed && installed.sourceArchiveSha256,
    'installed generation must be pinned and allowed',
  );
  assert.ok(
    promoted.frozenProfileAllowed && historicalDefault.frozenProfileAllowed,
  );
  assert.equal(
    distribution.promotionPolicy.automaticProductionPromotion,
    false,
  );
  return {
    installed,
    promoted,
    candidate,
    historicalDefault,
    frozenGenerations: generations
      .filter((g) => g.frozenProfileAllowed)
      .map((g) => g.generation),
  };
}

export function renderDistributionFacts(distribution) {
  const facts = distributionFacts(distribution);
  const value = (name, data) =>
    `export const ${name} = ${JSON.stringify(data, null, 2)} as const;`;
  return [
    '// Generated from apps/worker/dsh/distribution.json; run pnpm dsh:generate.',
    '// Missing historical fields never follow a later installed-generation change.',
    value('DSH_INSTALLED_DISTRIBUTION', facts.installed),
    value('DSH_DECLARED_PROMOTED_DISTRIBUTION', facts.promoted),
    value('DSH_UPGRADE_CANDIDATE', facts.candidate),
    value('DSH_MISSING_FROZEN_GENERATION', facts.historicalDefault.generation),
    value('DSH_FROZEN_PROFILE_GENERATIONS', facts.frozenGenerations),
    '',
  ].join('\n\n');
}
