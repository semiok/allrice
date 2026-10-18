import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  distributionFacts,
  renderDistributionFacts,
} from './dsh-distribution-facts.mjs';

const source = JSON.parse(
  readFileSync(
    new URL('../apps/worker/dsh/distribution.json', import.meta.url),
    'utf8',
  ),
);

describe('authoritative DSH distribution facts', () => {
  it('separates the reviewed installed generation from declared production promotion', () => {
    const facts = distributionFacts(source);
    expect(facts.installed.version).toBe('0.2.1-rc.2');
    expect(facts.promoted.version).toBe('0.1.1-rc.2');
    expect(facts.candidate.version).toBe('0.2.1-rc.2');
    expect(facts.frozenGenerations).toContain(facts.installed.generation);
  });

  it('cannot silently install an evaluation-only composition', () => {
    const next = globalThis.structuredClone(source);
    const candidate = next.generations.find(
      (g) => g.generation === next.upgradeCandidateGeneration,
    );
    candidate.frozenProfileAllowed = false;
    candidate.sourceArchiveSha256 = null;
    next.installedGeneration = next.upgradeCandidateGeneration;
    expect(() => distributionFacts(next)).toThrow(
      'installed generation must be pinned and allowed',
    );
  });

  it('keeps missing historical fields on their original generation after an approved upgrade', () => {
    const next = globalThis.structuredClone(source);
    const candidate = next.generations.find(
      (g) => g.generation === next.upgradeCandidateGeneration,
    );
    candidate.frozenProfileAllowed = true;
    candidate.sourceArchiveSha256 = 'a'.repeat(64); // Synthetic future reviewed archive, not an upstream assertion.
    next.installedGeneration = candidate.generation;
    const facts = distributionFacts(next);
    expect(facts.installed.generation).toBe(candidate.generation);
    expect(facts.historicalDefault.generation).toBe(
      source.missingFrozenGeneration,
    );
    expect(facts.historicalDefault.generation).not.toBe(
      facts.installed.generation,
    );
    expect(renderDistributionFacts(next)).toContain(
      `"${source.missingFrozenGeneration}" as const`,
    );
  });

  it('rejects duplicate identities, unknown pointers and automatic promotion', () => {
    const duplicate = globalThis.structuredClone(source);
    duplicate.generations.push(duplicate.generations[0]);
    expect(() => distributionFacts(duplicate)).toThrow(
      'duplicate DSH generation',
    );
    const unknown = globalThis.structuredClone(source);
    unknown.installedGeneration = 'dsh-unknown';
    expect(() => distributionFacts(unknown)).toThrow(
      'unknown DSH installedGeneration',
    );
    const automatic = globalThis.structuredClone(source);
    automatic.promotionPolicy.automaticProductionPromotion = true;
    expect(() => distributionFacts(automatic)).toThrow();
  });
});
