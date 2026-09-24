import type postgres from 'postgres';
import { z } from 'zod';

/** The synchronized catalog owns replacement metadata, never employee snapshots. */
export async function platformSkillReplacements(
  sql: postgres.Sql | postgres.TransactionSql,
) {
  const [row] = await sql<{ skills: unknown }[]>`
    select value->'skills' as skills from allrice_runtime_metadata
    where key='platform-content-catalog'
  `;
  const skills = z
    .array(
      z.object({
        id: z.uuid(),
        replaces: z.array(z.uuid()).optional(),
      }),
    )
    .parse(row?.skills ?? []);
  return new Map(skills.map((skill) => [skill.id, skill.replaces ?? []]));
}
