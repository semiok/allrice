/** Public-source syntax shared by admission and transport. No credentials or IO. */
export type PersonalSkillGitHubLocation = {
  owner: string;
  repo: string;
  kind: 'repository' | 'tree' | 'blob';
  tail: string[];
};

export function parsePersonalSkillGitHubUrl(
  value: string,
): PersonalSkillGitHubLocation {
  const invalid = (): never => {
    throw Error('personal_skill_github_url_invalid');
  };
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    value.trim() !== value
  )
    return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\')
  )
    return invalid();
  // URL normalizes dot segments. Check the original spelling before using it.
  const original = value
    .slice(value.indexOf('://') + 3)
    .replace(/^[^/]+\/?/u, '')
    .replace(/\/$/u, '');
  let parts: string[];
  try {
    parts = original.split('/').map(decodeURIComponent);
  } catch {
    return invalid();
  }
  if (
    parts.some(
      (part) =>
        !part ||
        part.length > 512 ||
        part === '.' ||
        part === '..' ||
        // eslint-disable-next-line no-control-regex -- Reject decoded control bytes before constructing a public URL.
        /[/\\:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
          part,
        ),
    )
  )
    return invalid();
  const [owner, repo, kind, ...tail] = parts;
  if (
    !owner ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(owner) ||
    !repo ||
    !/^[A-Za-z0-9_.-]{1,100}$/u.test(repo)
  )
    return invalid();
  if (parts.length === 2) return { owner, repo, kind: 'repository', tail: [] };
  if (
    (kind !== 'tree' && kind !== 'blob') ||
    !tail.length ||
    (kind === 'blob' && (tail.length < 2 || tail.at(-1) !== 'SKILL.md'))
  )
    return invalid();
  return { owner, repo, kind, tail };
}
