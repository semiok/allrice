import { parseDocument } from 'yaml';

/** Technical format inspection only. The public DSH Provider still owns
 * values, invocation semantics and body parsing; ordinary Skills skip this. */
export function assertWorkflowSkillFrontmatter(bytes: Uint8Array) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error('SKILL.md: expected valid UTF-8');
  }
  const lines = text.split('\n');
  const delimiter = (line: string) =>
    line.endsWith('\r') ? line.slice(0, -1) : line;
  const end = lines.findIndex(
    (line, index) => index > 0 && delimiter(line) === '---',
  );
  if (delimiter(lines[0]!) !== '---' || end < 0)
    throw new Error('SKILL.md: expected YAML frontmatter delimited by ---');
  const document = parseDocument(lines.slice(1, end).map(delimiter).join('\n'));
  if (document.errors.length)
    throw new Error(`SKILL.md: invalid YAML: ${document.errors[0]!.message}`);
  const value: unknown = document.toJS();
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('SKILL.md frontmatter: expected an object');
  const allowed = [
    'name',
    'description',
    'whenToUse',
    'metadata',
    'disable-model-invocation',
    'user-invocable',
  ];
  const unsupported = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  );
  if (unsupported.length)
    throw new Error(
      `SKILL.md frontmatter: unsupported fields: ${unsupported.join(', ')}`,
    );
}
