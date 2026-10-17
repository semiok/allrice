const genericTerms = new Set([
  '我的',
  '我们',
  '这个',
  '这些',
  '那个',
  '那些',
  '帮我',
  '请将',
  '请把',
  '请问',
  '是否',
  '哪里',
  '什么',
  '保存',
  '记住',
  '工作',
  '场景',
  '一下',
  '之前',
  '刚才',
]);

function literalPattern(value: string) {
  return `%${value.replace(/[\\%_]/gu, '\\$&')}%`;
}

/** Bounded literal keyword fallback, not authority or fuzzy SQL syntax.
 * Chinese phrases need short overlapping terms; tickers/names stay whole. */
export function memorySearchPatterns(query: string) {
  const text = query.trim().slice(0, 500);
  if (!text) return { exact: '', patterns: [] as string[] };
  const terms = new Set<string>();
  const chunks =
    text
      .toLocaleLowerCase()
      .match(
        /[a-z][a-z0-9._-]{1,39}|[0-9]{2,12}\.[a-z]{1,8}|[\p{Script=Han}]{2,}/gu,
      ) ?? [];
  for (const chunk of chunks) {
    if (!genericTerms.has(chunk)) terms.add(chunk);
    if (/^[\p{Script=Han}]+$/u.test(chunk)) {
      for (let i = 0; i < chunk.length - 1 && terms.size < 24; i++) {
        const term = chunk.slice(i, i + 2);
        if (!genericTerms.has(term)) terms.add(term);
      }
    }
    if (terms.size >= 24) break;
  }
  return {
    exact: literalPattern(text),
    patterns: [
      ...new Set([
        literalPattern(text),
        ...[...terms].slice(0, 24).map(literalPattern),
      ]),
    ],
  };
}
