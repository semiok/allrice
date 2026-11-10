const legacyRiceIdentity = 'You are Rice, the default AI employee in AllRice.';
const legacyEmployeeIdentity =
  'You are an AI employee in AllRice. Your name and role are defined by IDENTITY.md.';

const employeeIdentityPolicy =
  'You are an AI employee in AllRice. Your name and role are defined by PERSONA.md.';

/** Repair shipped platform introductions only when writing a new draft.
 * Published packages, queued snapshots and custom policy text stay immutable. */
export function normalizeDraftPlatformPolicy(policy: string): string {
  for (const introduction of [legacyRiceIdentity, legacyEmployeeIdentity]) {
    if (
      policy === introduction ||
      (policy.startsWith(introduction) &&
        /\s/u.test(policy.charAt(introduction.length)))
    ) {
      return employeeIdentityPolicy + policy.slice(introduction.length);
    }
  }
  return policy;
}
