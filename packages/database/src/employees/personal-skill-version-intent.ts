/** Match the complete direct request, binding both target and source. Names or
 * source links inside quoted instructions cannot grant persistent authority. */
function clauses(text: string) {
  if (
    !text.trim() ||
    text.length > 2000 ||
    /(?:^|\n)(?: {4}| {0,3}\t)/u.test(text)
  )
    return null;
  return text
    .trim()
    .split(/[。；;！!\n]/u)
    .map((s) => s.trim())
    .filter(Boolean);
}
function bind(text: string, value: string, token: string) {
  if (text.toLowerCase().includes(token.toLowerCase()) || !text.includes(value))
    return null;
  // Quoting a name/link is valid; quoting a command is not.
  for (const [left, right] of [
    ['“', '”'],
    ['「', '」'],
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['<', '>'],
  ])
    text = text.replaceAll(left + value + right, value);
  return text.replaceAll(value, token);
}
export function explicitPersonalSkillUpdateIntent(
  text: string,
  name: string,
  source: string,
  github = false,
) {
  if (github) {
    const urls =
      text.match(/https?:\/\/[^\s<>“”「」"'`()[\]，。；;！!？?]+/giu) ?? [];
    if (urls.length !== 1 || urls[0] !== source) return false;
  }
  const sourced = bind(text, source, '__ALLRICE_VERSION_SOURCE__');
  const bound =
    sourced === null ? null : bind(sourced, name, '__ALLRICE_VERSION_TARGET__');
  if (bound === null) return false;
  const lines = clauses(bound);
  if (!lines) return false;
  let update = false;
  for (const line of lines) {
    if (
      /^(?:请|麻烦)?(?:帮我)?(?:把|将)?\s*(?:个人)?(?:技能)?\s*__ALLRICE_VERSION_TARGET__\s*(?:这个技能)?\s*更新(?:为|到|成)\s*(?:我(?:刚)?上传的|附件(?:中|里)的|这个|该)?\s*__ALLRICE_VERSION_SOURCE__(?:\s*(?:的版本|版本|中的版本))?[.]?$/iu.test(
        line,
      ) ||
      /^(?:please\s+)?update\s+(?:skill\s+)?__ALLRICE_VERSION_TARGET__\s+(?:to|from)\s+(?:the\s+)?(?:attached\s+)?__ALLRICE_VERSION_SOURCE__[.]?$/iu.test(
        line,
      )
    ) {
      update = true;
      continue;
    }
    if (
      /^(?:以后|后续|今后)(?:的?任务)?(?:都)?(?:请|可以)?(?:使用新版本|用新版本|按新版本执行)[.]?$/u.test(
        line,
      )
    )
      continue;
    return false;
  }
  return update;
}
export function explicitPersonalSkillRollbackIntent(
  text: string,
  name: string,
  version: number,
) {
  const bound = bind(text, name, '__ALLRICE_VERSION_TARGET__');
  const lines = bound === null ? null : clauses(bound);
  if (!lines) return false;
  let rollback = false;
  for (const line of lines) {
    const match =
      line.match(
        /^(?:请|麻烦)?(?:帮我)?(?:把|将)?\s*(?:个人)?(?:技能)?\s*__ALLRICE_VERSION_TARGET__\s*(?:回退|恢复)(?:到|为)\s*(?:版本\s*)?v?(\d+)(?:\s*版)?[.]?$/iu,
      ) ??
      line.match(
        /^(?:please\s+)?(?:roll back|restore)\s+(?:skill\s+)?__ALLRICE_VERSION_TARGET__\s+to\s+v?(\d+)[.]?$/iu,
      );
    if (match && Number(match[1]) === version) {
      rollback = true;
      continue;
    }
    if (
      /^(?:以后|后续|今后)(?:的?任务)?(?:都)?(?:请|可以)?(?:使用回退版本|按回退版本执行)[.]?$/u.test(
        line,
      )
    )
      continue;
    return false;
  }
  return rollback;
}
export function skillVersionConfirmation(
  name: string,
  operation: 'update' | 'rollback',
  version: number,
) {
  return `确认将 ${name} ${operation === 'update' ? '更新为刚才展示的固定版本' : `回退到 v${version}`}，应用到所列全部已绑定员工，保持各自启用或停用状态。`;
}
export function explicitPersonalSkillVersionConfirmation(
  text: string,
  expected: string,
) {
  const normalize = (value: string) =>
    value
      .trim()
      .replace(/[。.!！]$/u, '')
      .replace(/[，,]/gu, ',')
      .replace(/\s+/gu, '');
  return !!clauses(text) && normalize(text) === normalize(expected);
}
export function explicitPersonalSkillVersionCancel(text: string, name: string) {
  const bound = bind(text, name, '__ALLRICE_VERSION_TARGET__');
  return (
    bound !== null &&
    !!clauses(bound) &&
    /^(?:请)?取消\s*(?:技能\s*)?__ALLRICE_VERSION_TARGET__\s*(?:的)?(?:更新|回退|版本变更)[。.!！]?$/u.test(
      bound.trim(),
    )
  );
}
export function explicitPersonalSkillBind(text: string, name: string) {
  const bound = bind(text, name, '__ALLRICE_VERSION_TARGET__');
  return (
    bound !== null &&
    !!clauses(bound) &&
    /^(?:请|麻烦)?(?:帮我)?(?:把|将)?\s*(?:个人)?技能\s*__ALLRICE_VERSION_TARGET__\s*(?:启用|绑定)(?:给|到)(?:你|当前\s*(?:AI\s*)?员工)[。.!！]?$/iu.test(
      bound.trim(),
    )
  );
}
