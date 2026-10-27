import assert from 'node:assert/strict';

/** One installed composition. */
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
  const candidate = select('upgradeCandidateGeneration', false);
  assert.ok(
    installed.frozenProfileAllowed && installed.sourceArchiveSha256,
    'installed generation must be pinned and allowed',
  );
  assert.equal(
    distribution.promotionPolicy.automaticProductionPromotion,
    false,
  );
  return {
    installed,
    candidate,
  };
}

export function renderDistributionFacts(distribution) {
  const facts = distributionFacts(distribution);
  const value = (name, data) =>
    `export const ${name} = ${JSON.stringify(data, null, 2)} as const;`;
  return [
    '// Generated from apps/worker/dsh/distribution.json; run pnpm dsh:generate.',
    value('DSH_INSTALLED_DISTRIBUTION', facts.installed),
    value('DSH_UPGRADE_CANDIDATE', facts.candidate),
    '',
  ].join('\n\n');
}
