import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import {
  PersonalSkillDefinitionSchema,
  personalSkillLimits,
} from '@allrice/contracts';
import { PersonalSkillError, skillBytesChecksum } from '@allrice/database';

/** The upstream parser sees only this owned file. No default/project roots,
 * watchers, archive paths, scripts, symlinks or dependency installation. */
export async function parsePersonalSkill(bytes: Uint8Array) {
  if (!bytes.byteLength || bytes.byteLength > personalSkillLimits.sourceBytes)
    throw new PersonalSkillError('source_invalid');
  let originalText: string;
  try {
    originalText = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new PersonalSkillError('source_invalid');
  }
  if (originalText.includes('\0'))
    throw new PersonalSkillError('source_invalid');
  const root = await mkdtemp(join(tmpdir(), 'allrice-personal-skill-'));
  const control = new AbortController();
  const provider = new FileSystemSkillProvider(
    new Context(),
    { signal: control.signal, invalidate() {} },
    {
      customSkillDirs: [root],
      dshHome: root,
      agentsHome: root,
      includeDefaultRoots: false,
      watch: false,
    },
  );
  try {
    await mkdir(join(root, 'imported'));
    await writeFile(join(root, 'imported', 'SKILL.md'), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    const options = { cwd: root, signal: control.signal };
    const candidates = await provider.list(options);
    if (!Array.isArray(candidates) || candidates.length !== 1)
      throw new PersonalSkillError('source_invalid');
    const skill = await provider.get(candidates[0]!, options);
    if (!skill) throw new PersonalSkillError('source_invalid');
    const definition = PersonalSkillDefinitionSchema.parse({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      checksum: skillBytesChecksum(skill.content),
      invocation: skill.invocation,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
      ...(skill.metadata ? { metadata: skill.metadata } : {}),
    });
    return { originalText, definition };
  } finally {
    control.abort();
    await provider.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
