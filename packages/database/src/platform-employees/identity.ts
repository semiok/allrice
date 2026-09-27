const legacyRiceIdentity = 'You are Rice, the default AI employee in AllRice.';

const employeeIdentityPolicy =
  'You are an AI employee in AllRice. Your name and role are defined by IDENTITY.md.';

/** Repair the shipped Rice template only when writing a new draft.
 * Published packages, queued snapshots and custom policy text stay immutable. */
export function normalizeDraftPlatformPolicy(policy: string): string {
  if (
    policy === legacyRiceIdentity ||
    (policy.startsWith(legacyRiceIdentity) &&
      /\s/u.test(policy.charAt(legacyRiceIdentity.length)))
  ) {
    return employeeIdentityPolicy + policy.slice(legacyRiceIdentity.length);
  }
  return policy;
}
