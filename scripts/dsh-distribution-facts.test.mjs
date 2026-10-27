import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { distributionFacts } from './dsh-distribution-facts.mjs';

const source = JSON.parse(
  readFileSync(
    new URL('../apps/worker/dsh/distribution.json', import.meta.url),
    'utf8',
  ),
);

describe('authoritative DSH distribution facts', () => {
  it('reads the reviewed installed generation', () => {
    const facts = distributionFacts(source);
    expect(facts.installed.version).toBe('0.2.1-rc.2');
    expect(facts.candidate.version).toBe('0.2.1-rc.2');
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
