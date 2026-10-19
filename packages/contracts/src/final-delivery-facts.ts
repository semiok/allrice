/** Private reader facts. Serialization does not grant authority or validate time. */
export interface FinalDeliveryFacts {
  scope: unknown;
  complete: boolean;
  authorization: string;
  now: string;
  ownedRunIds: readonly string[];
  explicitReferenceVersionIds: readonly string[];
  artifacts: readonly unknown[];
  checks: readonly unknown[];
  requirements: readonly unknown[];
  qualityReceipts?: readonly unknown[];
}

export const FINAL_DELIVERY_FACTS_VERSION = 1 as const;

/** Object keys are unordered; arrays inside individual facts retain their order. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw Error('final_delivery_non_json_fact');
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(record[key]))
        .join(',') +
      '}'
    );
  }
  throw Error('final_delivery_non_json_fact');
}

function factSet(values: readonly unknown[]): string {
  // Preserve duplicates/conflicts for the validator; never silently deduplicate.
  return '[' + values.map(canonical).sort().join(',') + ']';
}

/**
 * A versioned UTF-8 input for SHA256 in the private Worker and DB callers.
 * Excludes only the observation clock. Callers MUST independently recheck
 * current lease/authorization/retention at each transaction's commit boundary.
 * No Node crypto dependency is introduced into browser-facing contracts.
 */
export function serializeFinalDeliveryFacts(facts: FinalDeliveryFacts): string {
  return (
    '{' +
    [
      '"version":' + FINAL_DELIVERY_FACTS_VERSION,
      '"scope":' + canonical(facts.scope),
      '"complete":' + canonical(facts.complete),
      '"authorization":' + canonical(facts.authorization),
      '"ownedRunIds":' + factSet(facts.ownedRunIds),
      '"explicitReferenceVersionIds":' +
        factSet(facts.explicitReferenceVersionIds),
      '"artifacts":' + factSet(facts.artifacts),
      '"checks":' + factSet(facts.checks),
      '"requirements":' + factSet(facts.requirements),
      '"qualityReceipts":' + factSet(facts.qualityReceipts ?? []),
    ].join(',') +
    '}'
  );
}
