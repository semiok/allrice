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
      /* r1-exempt(own-text): 仅在新草稿识别平台自带固定引导，不判断用户意图或授权；未命中原文保留。 */ policy ===
        introduction ||
      /* r1-exempt(own-text): 仅规范化平台自带引导前缀并保留余文，不作授权或免确认；未命中原文保留。 */ (policy.startsWith(
        introduction,
      ) &&
        /\s/u.test(policy.charAt(introduction.length)))
    ) {
      return employeeIdentityPolicy + policy.slice(introduction.length);
    }
  }
  return policy;
}
