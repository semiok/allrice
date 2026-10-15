import type { z } from 'zod';
import type { EmployeeProfileChatInputSchema } from '@allrice/contracts';

/** Conservative admission for this small, low-impact command surface. An
 * ambiguous request is clarified in chat; retrieved text is never authority. */
export function explicitEmployeeProfileIntent(
  text: string,
  patch: z.infer<typeof EmployeeProfileChatInputSchema>,
) {
  if (!text.trim() || text.length > 2_000) return false;
  const clauses = text
    .trim()
    .split(/[。；;！!\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const requested: { name?: string; expressionStyle?: string } = {};
  const unquote = (s: string) => s.replace(/^[“「"']|[”」"']$/g, '').trim();
  const styleNames = {
    concise: ['简洁', '简短', '精简', 'concise'],
    structured: ['结构化', '条理清晰', '分点', 'structured'],
    exploratory: ['探索式', '探索性', 'exploratory'],
  };
  // An explicit save clause qualifies the same preference request. It cannot
  // supply a preference by itself or authorize an unrelated task/other scope.
  const persistenceClause =
    /^(?:请)?(?:保存为|设为|设置为)(?:我(?:自己)?的)?(?:长期(?:默认)?|默认)(?:表达|回答|回复)(?:偏好|方式|风格)[。.]?$/u;
  let savePreference = false;
  for (const original of clauses) {
    let clause = original;
    const separator = Math.max(
      clause.lastIndexOf('，'),
      clause.lastIndexOf(','),
    );
    if (persistenceClause.test(clause.slice(separator + 1).trim())) {
      savePreference = true;
      clause = separator < 0 ? '' : clause.slice(0, separator).trim();
      if (!clause) continue;
    }
    const match =
      clause.match(
        /^(?:请)?(?:(?:以后|今后|从现在起)[，,\s]*)?(?:把你的(?:名字|名称)改(?:为|成)|将你的(?:名字|名称)改(?:为|成)|(?:给你|把你|将你)?改名(?:为|叫)|(?:以后|今后)叫你|你(?:以后|今后)叫)[：:\s]*(.+?)[。.]?$/u,
      ) ??
      clause.match(
        /^(?:please )?(?:rename yourself to|from now on (?:your name is|call yourself))\s+(.+?)\.?$/i,
      );
    if (match) {
      const name = unquote(match[1]!);
      if (
        !name ||
        /[\n\r<>]/.test(name) ||
        (requested.name && requested.name !== name)
      )
        return false;
      requested.name = name;
      continue;
    }
    const styleMatch =
      clause.match(
        /^(?:请)?(?:以后|今后|从现在起|长期|默认)[，,\s]*(?:(?:你的|你)?(?:回答|回复|表达)(?:方式|风格)?[，,\s]*)?(?:默认)?(?:都)?(?:保持|采用|用|请用|要|应当|设为|设置为)?[：:\s]*(.+?)(?:的(?:方式|风格))?(?:回答|回复|表达)?[。.]?$/u,
      ) ??
      clause.match(
        /^(?:please )?(?:from now on|by default)\s+(?:be|respond|reply)\s+(.+?)\.?$/i,
      );
    const style =
      styleMatch &&
      Object.entries(styleNames).find(([, names]) =>
        names.includes(styleMatch[1]!.toLowerCase().trim()),
      )?.[0];
    if (
      !style ||
      (requested.expressionStyle && requested.expressionStyle !== style)
    )
      return false;
    requested.expressionStyle = style;
  }
  // Every clause must be a supported direct request or its explicit save
  // qualifier. Do not extract an imperative from a quote or another task.
  return (
    clauses.length > 0 &&
    (!savePreference || requested.expressionStyle !== undefined) &&
    (patch.name === undefined || patch.name === requested.name) &&
    (patch.expressionStyle === undefined ||
      patch.expressionStyle === requested.expressionStyle)
  );
}
