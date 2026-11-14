// MET-223: these platform publications are retired, even when an old immutable
// package survives as an instance's creation record. Names are not identities.
const retiredPlatformSkillIds = new Set([
  '7486aa1e-2495-4dd1-9eea-2ba4d65c761e',
  '4f94e92d-e065-4217-af0b-9c25d0802290',
  'd78b3556-821a-5550-bf13-d9dd84b9bbe0',
]);

export function assertCurrentPlatformSkillSources(
  skills: readonly { id: string }[],
) {
  if (skills.some((skill) => retiredPlatformSkillIds.has(skill.id)))
    throw Error('retired_platform_skill_source');
}
