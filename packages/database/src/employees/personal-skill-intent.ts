/** Installation is a persistent private binding. Only the user's complete
 * direct request can authorize it; never extract an imperative from documents,
 * quotes, a translation request, or an instruction for this task only. */
export function explicitPersonalSkillInstallIntent(
  text: string,
  fileName: string,
) {
  // Markdown indented code is quoted material, even when its contents are
  // otherwise a valid command. Inspect raw whitespace before trimming it.
  if (/(?:^|\n)(?: {4}| {0,3}\t)/u.test(text)) return false;
  if (
    !text.trim() ||
    text.length > 2_000 ||
    fileName.toLowerCase() !== 'skill.md'
  )
    return false;
  const clauses = text
    .trim()
    .split(/[。；;！!\n]/u)
    .map((s) => s.trim())
    .filter(Boolean);
  let install = false;
  for (const original of clauses) {
    // Quoting the exact attachment name is fine; quoting a command is not.
    const clause = original.replace(/[“「"'`]SKILL\.md[”」"'`]/gi, 'SKILL.md');
    if (
      /^(?:请|麻烦)?(?:帮我|为我)?(?:把|将)?(?:我(?:刚)?上传的|这个|该|附件(?:里|中)的)?\s*(?:SKILL\.md|技能文件)\s*(?:安装|装)(?:到|给)(?:你|当前\s*(?:这个)?(?:AI\s*)?员工)(?:的个人技能)?(?:中|里)?(?:[，,]\s*(?:以后|后续|今后)(?:的任务)?(?:都)?(?:可以|请|需要时)?(?:使用|用它|按它执行))?[.]?$/iu.test(
        clause,
      ) ||
      /^(?:请|麻烦)?(?:帮我|为我)?安装(?:我(?:刚)?上传的|这个|该|附件(?:里|中)的)?\s*(?:SKILL\.md|技能文件)(?:[，,]\s*(?:绑定到|用于)(?:你|当前\s*(?:AI\s*)?员工))?[.]?$/iu.test(
        clause,
      ) ||
      /^(?:please\s+)?install\s+(?:the\s+)?(?:attached\s+)?SKILL\.md(?:\s+(?:for|in)\s+(?:this|the current)\s+(?:AI\s+)?employee)?\.?$/i.test(
        clause,
      )
    ) {
      install = true;
      continue;
    }
    if (
      /^(?:这是|我(?:刚)?上传了?)(?:一份|一个)?(?:个人)?(?:技能文件|SKILL\.md)[.]?$/iu.test(
        clause,
      ) ||
      /^(?:以后|后续|今后)(?:的任务)?(?:都)?(?:可以|请|需要时)?(?:使用这个技能|使用它|用它|按它执行)[.]?$/u.test(
        clause,
      )
    )
      continue;
    return false;
  }
  return install;
}
